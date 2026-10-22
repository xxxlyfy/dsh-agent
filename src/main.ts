/**
 * Plugin entry point: wiring between the runtime, the session controller, the
 * chat view, commands and persisted state.
 */
import {
  MarkdownView,
  Menu,
  Notice,
  Plugin,
  getLanguage,
  type Editor,
  type WorkspaceLeaf,
} from "obsidian";
import { join } from "node:path";
import type { AcpClient } from "./acp/client.ts";
import type {
  AcpPermissionOutcome,
  AcpPermissionRequest,
  AcpPromptBlock,
  AcpSessionUpdateParams,
} from "./acp/protocol.ts";
import { buildContext, buildResourceLink, composePrompt } from "./context.ts";
import { createI18n, type I18n } from "./i18n.ts";
import { DshRuntime, type ProbeResult, type RuntimeStatus } from "./runtime.ts";
import {
  DEFAULT_SETTINGS,
  DshChatSettingTab,
  normalizeSettings,
  type DshChatSettings,
} from "./settings.ts";
import { SessionController, type SessionMeta, type SessionViewState } from "./session.ts";
import { PluginStore } from "./store.ts";
import { DshChatView, LogModal, VIEW_TYPE_DSH_CHAT } from "./view.ts";

interface StoredData {
  settings: DshChatSettings;
  sessions: SessionMeta[];
  lastSessionId: string | null;
}

export interface ChatViewState {
  runtime: RuntimeStatus;
  session: SessionViewState;
  error: string | null;
}

interface SendOptions {
  includeNote: boolean;
  includeSelection: boolean;
}

interface NoteContextSnapshot {
  notePath: string;
  selection: string;
  content: string;
}

function emptySessionState(): SessionViewState {
  return {
    sessionId: null,
    title: null,
    attached: false,
    busy: false,
    items: [],
    usage: null,
    configOptions: [],
  };
}

function isSessionMeta(value: unknown): value is SessionMeta {
  if (!value || typeof value !== "object") return false;
  const meta = value as Partial<SessionMeta>;
  return (
    typeof meta.id === "string" &&
    typeof meta.title === "string" &&
    typeof meta.cwd === "string" &&
    typeof meta.createdAt === "number" &&
    typeof meta.updatedAt === "number"
  );
}

export default class DshChatPlugin extends Plugin {
  settings: DshChatSettings = { ...DEFAULT_SETTINGS };
  i18n: I18n = createI18n("en");
  store!: PluginStore;
  runtime!: DshRuntime;
  controller: SessionController | null = null;

  private data: StoredData = {
    settings: { ...DEFAULT_SETTINGS },
    sessions: [],
    lastSessionId: null,
  };
  private readonly subscribers = new Set<() => void>();
  private statusBarEl: HTMLElement | null = null;
  private chatError: string | null = null;
  private openViewCount = 0;
  private stopping = false;
  private restartAttempts = 0;
  private chatPromise: Promise<void> | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private lastMarkdownView: MarkdownView | null = null;

  async onload(): Promise<void> {
    const raw = (await this.loadData()) as Partial<StoredData> | null;
    this.settings = normalizeSettings(raw?.settings);
    this.data = {
      settings: this.settings,
      sessions: Array.isArray(raw?.sessions) ? raw.sessions.filter(isSessionMeta) : [],
      lastSessionId: typeof raw?.lastSessionId === "string" ? raw.lastSessionId : null,
    };
    this.i18n = createI18n(getLanguage());

    this.store = new PluginStore(this.app, this.pluginDir());
    this.runtime = new DshRuntime({
      vaultPath: this.vaultPath(),
      pluginDir: this.pluginDirAbs(),
      clientVersion: this.manifest.version,
      getSettings: () => this.settings,
      onStatus: (status) => {
        if (status.phase === "ready") this.restartAttempts = 0;
        this.updateStatusBar(status);
        this.notify();
      },
      onLog: (line) => {
        if (this.settings.debugLog) console.debug("[dsh-runtime]", line);
      },
      onUpdate: (params: AcpSessionUpdateParams) => this.controller?.onUpdate(params),
      onPermission: (request: AcpPermissionRequest) => this.handlePermissionRequest(request),
      onExit: (info) => {
        this.controller?.onRuntimeLost();
        if (info.expected || this.stopping) return;
        this.setChatError(this.i18n.t("notice.runtimeLost"));
        this.maybeAutoRestart();
      },
    });

    this.registerView(VIEW_TYPE_DSH_CHAT, (leaf: WorkspaceLeaf) => new DshChatView(leaf, this));
    this.addRibbonIcon("message-square", this.i18n.t("ribbon.open"), () => {
      void this.activateView();
    });
    this.registerCommands();
    this.addSettingTab(new DshChatSettingTab(this.app, this));
    this.registerEditorMenu();
    this.setupStatusBar();
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (view) this.lastMarkdownView = view;
      }),
    );
    this.app.workspace.onLayoutReady(() => {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (view) this.lastMarkdownView = view;
    });
    // Persist normalized settings early and leave a durable load marker.
    await this.saveData(this.data);

    if (this.settings.autoStartRuntime) {
      this.app.workspace.onLayoutReady(() => {
        void this.ensureStarted().catch((error) => {
          this.setChatError(this.runtimeStartMessage(error));
        });
      });
    }
  }

  async onunload(): Promise<void> {
    this.stopping = true;
    this.flushSave();
    this.subscribers.clear();
    try {
      this.controller?.dispose();
    } catch {
      // best effort
    }
    try {
      await this.controller?.close();
    } catch {
      // best effort
    }
    this.controller = null;
    try {
      await this.runtime.stop("plugin-unload");
    } catch {
      // best effort
    }
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_DSH_CHAT);
  }

  // ---------------------------------------------------------------- state --

  getViewState(): ChatViewState {
    return {
      runtime: this.runtime.status,
      session: this.controller?.state ?? emptySessionState(),
      error: this.chatError,
    };
  }

  subscribe(listener: () => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  private notify(): void {
    for (const listener of this.subscribers) {
      try {
        listener();
      } catch (error) {
        console.error("[dsh-chat] subscriber failed", error);
      }
    }
  }

  addOpenView(): void {
    this.openViewCount += 1;
  }

  removeOpenView(): void {
    this.openViewCount = Math.max(0, this.openViewCount - 1);
    this.controller?.cancelPendingForHiddenUi();
  }

  get sessionMetas(): SessionMeta[] {
    return this.data.sessions;
  }

  get currentSessionId(): string | null {
    return this.controller?.sessionId ?? null;
  }

  // -------------------------------------------------------------- runtime --

  private async ensureStarted(): Promise<AcpClient> {
    const client = await this.runtime.ensure();
    this.chatError = null;
    return client;
  }

  async ensureChat(): Promise<void> {
    if (this.stopping) return;
    if (this.chatPromise) return await this.chatPromise;
    this.chatPromise = this.doEnsureChat().finally(() => {
      this.chatPromise = null;
    });
    return await this.chatPromise;
  }

  private async doEnsureChat(): Promise<void> {
    try {
      const client = await this.ensureStarted();
      if (!this.controller) this.controller = this.createController();
      this.controller.setClient(client);
      try {
        await this.ensureSession();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.setChatError(this.i18n.t("notice.sessionNewFailed", { message }));
        return;
      }
      this.chatError = null;
    } catch (error) {
      this.setChatError(this.runtimeStartMessage(error));
    } finally {
      this.notify();
    }
  }

  private async ensureSession(): Promise<void> {
    const controller = this.controller;
    if (!controller) return;
    if (controller.hasSession) {
      if (controller.isAttached) return;
      try {
        await controller.reattach();
        return;
      } catch {
        // The persisted session may be gone; fall through to a fresh one.
      }
    }
    const lastId = this.data.lastSessionId;
    if (lastId) {
      const meta = this.data.sessions.find((entry) => entry.id === lastId) ?? null;
      const { snapshot, corrupt } = await this.store.readTranscript(lastId);
      if (corrupt) new Notice(this.i18n.t("notice.transcriptCorrupt"));
      if (snapshot) {
        try {
          await controller.resume(lastId, snapshot, meta);
          this.setLastSession(lastId);
          return;
        } catch {
          // Resume can fail when cwd changed or the session is active elsewhere.
        }
      }
    }
    await controller.startNew();
    this.setLastSession(controller.sessionId);
  }

  private createController(): SessionController {
    return new SessionController({
      cwd: this.vaultPath(),
      getAutoApprove: () => this.settings.autoApproveTools,
      getMcpServers: () => this.parseMcpServers(),
      getLastModelValue: () => this.settings.lastModelValue,
      getLastEffort: () => this.settings.lastReasoningEffort,
      rememberConfig: (configId, value) => {
        if (configId === "model") this.settings.lastModelValue = value;
        if (configId === "reasoning_effort") this.settings.lastReasoningEffort = value;
        this.scheduleSave();
      },
      t: (key, vars) => this.i18n.t(key, vars),
      persist: (snapshot) => {
        void this.store.writeTranscript(snapshot).catch((error) => {
          console.warn("[dsh-chat] transcript write failed", error);
        });
      },
      updateMeta: (meta) => this.updateSessionMeta(meta),
      onChanged: () => this.notify(),
    });
  }

  private runtimeStartMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return this.i18n.t("notice.runtimeStartFailed", { message });
  }

  private setChatError(message: string | null): void {
    this.chatError = message;
    this.notify();
  }

  private maybeAutoRestart(): void {
    if (this.restartAttempts >= 1) return;
    this.restartAttempts += 1;
    new Notice(this.i18n.t("notice.autoRestarting"));
    window.setTimeout(() => {
      void this.ensureChat().catch(() => {
        new Notice(this.i18n.t("notice.autoRestartFailed"));
      });
    }, 1200);
  }

  async restartRuntime(): Promise<void> {
    try {
      if (this.controller?.hasSession) {
        try {
          await this.controller.close();
        } catch {
          // ignore
        }
      }
      await this.runtime.stop("user-restart");
      this.controller?.onRuntimeLost();
      this.chatError = null;
      await this.ensureChat();
    } catch (error) {
      this.setChatError(this.runtimeStartMessage(error));
    }
  }

  async probeRuntime(): Promise<ProbeResult> {
    return await this.runtime.probe();
  }

  getLogText(): string {
    return this.runtime.logText;
  }

  showLogModal(): void {
    new LogModal(this.app, this.getLogText(), this.i18n).open();
  }

  // -------------------------------------------------------------- sessions --

  async newSession(): Promise<void> {
    try {
      if (!this.controller) await this.ensureChat();
      const controller = this.controller;
      if (!controller) return;
      await controller.close();
      await controller.startNew();
      this.setLastSession(controller.sessionId);
    } catch (error) {
      new Notice(
        this.i18n.t("notice.sessionNewFailed", {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  async resumeSession(sessionId: string): Promise<void> {
    try {
      if (!this.controller) await this.ensureChat();
      const controller = this.controller;
      if (!controller) return;
      const meta = this.data.sessions.find((entry) => entry.id === sessionId) ?? null;
      const { snapshot } = await this.store.readTranscript(sessionId);
      await controller.close();
      try {
        await controller.resume(sessionId, snapshot, meta);
      } catch (error) {
        new Notice(
          this.i18n.t("notice.sessionResumeFailed", {
            message: error instanceof Error ? error.message : String(error),
          }),
        );
        await controller.startNew();
      }
      this.setLastSession(controller.sessionId);
    } catch (error) {
      new Notice(
        this.i18n.t("notice.sessionResumeFailed", {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  async closeSession(): Promise<void> {
    try {
      await this.controller?.close();
      this.setLastSession(null);
    } catch (error) {
      console.warn("[dsh-chat] close session failed", error);
    }
  }

  async importSessions(): Promise<Array<{ sessionId: string; cwd?: string }>> {
    try {
      const client = await this.ensureStarted();
      const known = new Set(this.data.sessions.map((entry) => entry.id));
      const found = new Map<string, { sessionId: string; cwd?: string }>();
      let cursor: string | undefined;
      for (let page = 0; page < 20; page += 1) {
        const result = await client.listSessions(this.vaultPath(), cursor);
        for (const entry of result.sessions ?? []) {
          if (!known.has(entry.sessionId)) found.set(entry.sessionId, entry);
        }
        cursor = result.nextCursor;
        if (!cursor) break;
      }
      return [...found.values()];
    } catch (error) {
      new Notice(
        this.i18n.t("notice.sessionResumeFailed", {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return [];
    }
  }

  async sendMessage(
    text: string,
    options: SendOptions,
    snapshot?: NoteContextSnapshot,
  ): Promise<void> {
    if (!this.controller || !this.controller.state.attached) await this.ensureChat();
    const controller = this.controller;
    if (!controller) throw new Error("the DSH runtime is not ready");
    const view = snapshot ? null : this.resolveMarkdownView();
    const notePath = snapshot ? snapshot.notePath : view?.file?.path ?? null;
    const selection = snapshot
      ? snapshot.selection
      : options.includeSelection && view
        ? view.editor.getSelection()
        : "";
    const content = snapshot
      ? snapshot.content
      : options.includeNote && view
        ? view.editor.getValue()
        : null;
    const context = buildContext({
      notePath,
      selection,
      content,
      includeSelection: options.includeSelection,
      includeActiveNote: options.includeNote,
      maxChars: this.settings.maxContextChars,
    });
    if (context?.truncated) new Notice(this.i18n.t("notice.truncatedContext"));
    if (options.includeNote && !notePath) new Notice(this.i18n.t("notice.noActiveNote"));
    const blocks: AcpPromptBlock[] = [
      { type: "text", text: composePrompt(text, context) },
    ];
    if (context && this.settings.attachResourceLink && notePath) {
      const absolute = join(this.vaultPath(), notePath);
      const name = notePath.split("/").pop() ?? notePath;
      blocks.push(buildResourceLink(absolute, name));
    }
    await controller.send(text, blocks, {
      notePath: context?.notePath ?? null,
      hasSelection: context?.usedSelection ?? false,
    });
  }

  /** The active Markdown view, or the most recent one when the panel has focus. */
  resolveMarkdownView(): MarkdownView | null {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active) {
      this.lastMarkdownView = active;
      return active;
    }
    const last = this.lastMarkdownView;
    return last && last.file ? last : null;
  }

  /** Context-menu action: send the captured selection as a question right away. */
  private async sendSelectionToDsh(
    selection: string,
    snapshot: NoteContextSnapshot | null,
  ): Promise<void> {
    const text = selection.trim();
    if (text.length === 0) {
      new Notice(this.i18n.t("notice.noSelection"));
      return;
    }
    try {
      const leaf = await this.activateView();
      if (leaf?.view instanceof DshChatView) leaf.view.focusComposer();
      await this.ensureChat();
      if (snapshot && snapshot.notePath) {
        await this.sendMessage(
          this.i18n.t("prompt.explainSelection"),
          { includeNote: false, includeSelection: true },
          snapshot,
        );
      } else {
        await this.sendMessage(
          `${this.i18n.t("prompt.explainSelection")}\n\n${text}`,
          { includeNote: false, includeSelection: false },
        );
      }
    } catch (error) {
      new Notice(
        this.i18n.t("notice.promptFailed", {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  cancelPrompt(): void {
    this.controller?.cancel();
  }

  async setConfigOption(configId: string, value: string): Promise<void> {
    if (!this.controller) await this.ensureChat();
    await this.controller?.setConfigOption(configId, value);
  }

  resolvePermission(
    itemId: string,
    decision: "allowed" | "rejected",
    optionId?: string,
  ): void {
    this.controller?.resolvePermission(itemId, decision, optionId);
  }

  private handlePermissionRequest(request: AcpPermissionRequest): Promise<AcpPermissionOutcome> {
    const cancelled: AcpPermissionOutcome = { outcome: { outcome: "cancelled" } };
    const controller = this.controller;
    if (!controller) return Promise.resolve(cancelled);
    if (this.openViewCount === 0 && !this.settings.autoApproveTools) {
      return Promise.resolve(cancelled);
    }
    return controller.onPermissionRequest(request);
  }

  private updateSessionMeta(meta: SessionMeta): void {
    const index = this.data.sessions.findIndex((entry) => entry.id === meta.id);
    if (index >= 0) {
      this.data.sessions[index] = { ...this.data.sessions[index], ...meta };
    } else {
      this.data.sessions.push({ ...meta });
    }
    this.setLastSession(meta.id);
  }

  private setLastSession(sessionId: string | null): void {
    this.data.lastSessionId = sessionId;
    this.scheduleSave();
    this.notify();
  }

  // -------------------------------------------------------------- settings --

  async updateSettings(patch: Partial<DshChatSettings>): Promise<void> {
    this.settings = { ...this.settings, ...patch };
    this.data.settings = this.settings;
    await this.saveData(this.data);
    this.notify();
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flushSave();
    }, 500);
  }

  private flushSave(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.data.settings = this.settings;
    void this.saveData(this.data).catch((error) => {
      console.warn("[dsh-chat] saveData failed", error);
    });
  }

  private parseMcpServers(): unknown[] {
    const raw = this.settings.mcpServersJson.trim();
    if (raw.length === 0) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        new Notice(this.i18n.t("settings.invalidMcpJson"));
        return [];
      }
      return parsed;
    } catch {
      new Notice(this.i18n.t("settings.invalidMcpJson"));
      return [];
    }
  }

  // ----------------------------------------------------------------- paths --

  private vaultPath(): string {
    const adapter = this.app.vault.adapter;
    const maybeFileSystem = adapter as { getBasePath?: () => string };
    if (typeof maybeFileSystem.getBasePath === "function") {
      return maybeFileSystem.getBasePath();
    }
    return this.app.vault.getName();
  }

  private pluginDir(): string {
    return this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`;
  }

  private pluginDirAbs(): string {
    return join(this.vaultPath(), this.pluginDir());
  }

  // -------------------------------------------------------------- commands --

  private registerCommands(): void {
    this.addCommand({
      id: "open-chat",
      name: this.i18n.t("cmd.open"),
      callback: () => {
        void this.activateView();
      },
    });
    this.addCommand({
      id: "ask-selection",
      name: this.i18n.t("cmd.askSelection"),
      editorCallback: (editor: Editor) => {
        const selection = editor.getSelection();
        void this.activateView().then((leaf) => {
          const view = leaf?.view;
          if (view instanceof DshChatView) {
            view.prefill(selection.trim().length > 0 ? this.i18n.t("prompt.explainSelection") : "");
            view.focusComposer();
          }
        });
      },
    });
    this.addCommand({
      id: "send-note",
      name: this.i18n.t("cmd.sendNote"),
      callback: () => {
        if (!this.resolveMarkdownView()) {
          new Notice(this.i18n.t("notice.noActiveNote"));
          return;
        }
        void this.activateView().then((leaf) => {
          const view = leaf?.view;
          if (view instanceof DshChatView) {
            view.prefill(this.i18n.t("prompt.summarizeNote"));
            view.focusComposer();
          }
        });
      },
    });
    this.addCommand({
      id: "new-session",
      name: this.i18n.t("cmd.newSession"),
      callback: () => {
        void this.newSession();
      },
    });
    this.addCommand({
      id: "restart-runtime",
      name: this.i18n.t("cmd.restart"),
      callback: () => {
        void this.restartRuntime();
      },
    });
    this.addCommand({
      id: "show-log",
      name: this.i18n.t("cmd.showLog"),
      callback: () => this.showLogModal(),
    });
  }

  private registerEditorMenu(): void {
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor) => {
        const selection = editor.getSelection();
        if (selection.trim().length === 0) return;
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        const snapshot: NoteContextSnapshot | null =
          view?.file
            ? { notePath: view.file.path, selection, content: view.editor.getValue() }
            : null;
        menu.addItem((item) =>
          item
            .setTitle(this.i18n.t("menu.sendToDsh"))
            .setIcon("message-square")
            .onClick(() => {
              void this.sendSelectionToDsh(selection, snapshot);
            }),
        );
      }),
    );
  }

  private setupStatusBar(): void {
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("dsh-chat-status-bar");
    this.statusBarEl.setAttribute("aria-label", this.i18n.t("statusbar.toolTip"));
    this.statusBarEl.addEventListener("click", () => {
      void this.activateView();
    });
    this.updateStatusBar(this.runtime.status);
  }

  private updateStatusBar(status: RuntimeStatus): void {
    if (!this.statusBarEl) return;
    const suffix =
      status.phase === "ready"
        ? ""
        : status.phase === "starting" || status.phase === "probing"
          ? " …"
          : status.phase === "error"
            ? " !"
            : "";
    this.statusBarEl.setText(`DSH${suffix}`);
  }

  async activateView(): Promise<WorkspaceLeaf | null> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_DSH_CHAT);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return existing[0];
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return null;
    await leaf.setViewState({ type: VIEW_TYPE_DSH_CHAT, active: true });
    this.app.workspace.revealLeaf(leaf);
    return leaf;
  }
}
