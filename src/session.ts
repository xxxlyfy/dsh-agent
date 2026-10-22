/**
 * Owns the single active chat session: prompt lifecycle, streaming updates,
 * permission prompts, configuration and transcript persistence.
 */
import type { AcpClient } from "./acp/client.ts";
import {
  normalizeConfigOptions,
  selectOptionValues,
  type AcpConfigOption,
  type AcpPermissionOption,
  type AcpPermissionOutcome,
  type AcpPermissionRequest,
  type AcpPromptBlock,
  type AcpSessionUpdateParams,
} from "./acp/protocol.ts";
import {
  TranscriptBuilder,
  type PermissionDecision,
  type TranscriptItem,
  type TranscriptSnapshot,
  type TranscriptUsage,
  type UserMessageMeta,
} from "./transcript.ts";

export interface SessionMeta {
  id: string;
  title: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
}

export interface SessionViewState {
  sessionId: string | null;
  title: string | null;
  attached: boolean;
  busy: boolean;
  items: readonly TranscriptItem[];
  usage: TranscriptUsage | null;
  configOptions: AcpConfigOption[];
}

export interface SessionHooks {
  cwd: string;
  getAutoApprove: () => boolean;
  getMcpServers: () => unknown[];
  getLastModelValue: () => string;
  getLastEffort: () => string;
  rememberConfig: (configId: string, value: string) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
  persist: (snapshot: TranscriptSnapshot) => void;
  updateMeta: (meta: SessionMeta) => void;
  onChanged: () => void;
}

const PERSIST_DEBOUNCE_MS = 400;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pickAllowOption(options: AcpPermissionOption[]): string {
  const once = options.find((option) => option.kind === "allow_once");
  if (once) return once.optionId;
  const allow = options.find((option) => option.kind.startsWith("allow"));
  return allow?.optionId ?? options[0]?.optionId ?? "allow-once";
}

function pickRejectOption(options: AcpPermissionOption[]): string {
  const once = options.find((option) => option.kind === "reject_once");
  if (once) return once.optionId;
  const reject = options.find((option) => option.kind.startsWith("reject"));
  return reject?.optionId ?? options[options.length - 1]?.optionId ?? "reject-once";
}

function cancelledOutcome(): AcpPermissionOutcome {
  return { outcome: { outcome: "cancelled" } };
}

export class SessionController {
  private client: AcpClient | null = null;
  private builder: TranscriptBuilder | null = null;
  private meta: SessionMeta | null = null;
  private attached = false;
  private busy = false;
  private configOptions: AcpConfigOption[] = [];
  private readonly pendingPermissions = new Map<
    string,
    { resolve: (outcome: AcpPermissionOutcome) => void; options: AcpPermissionOption[] }
  >();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private promptGeneration = 0;
  private readonly hooks: SessionHooks;

  constructor(hooks: SessionHooks) {
    this.hooks = hooks;
  }

  setClient(client: AcpClient | null): void {
    if (this.client === client) return;
    this.client = client;
    this.attached = false;
  }

  get hasSession(): boolean {
    return this.builder !== null && this.sessionId !== null;
  }

  get isAttached(): boolean {
    return this.attached;
  }

  get sessionId(): string | null {
    return this.meta?.id ?? null;
  }

  get state(): SessionViewState {
    return {
      sessionId: this.sessionId,
      title: this.meta?.title ?? null,
      attached: this.attached,
      busy: this.busy,
      items: this.builder?.all ?? [],
      usage: this.builder?.getUsage() ?? null,
      configOptions: this.configOptions,
    };
  }

  async startNew(): Promise<void> {
    const client = this.requireClient();
    if (this.busy) throw new Error("a prompt is already in flight");
    const result = await client.newSession(this.hooks.cwd, this.hooks.getMcpServers());
    const now = Date.now();
    this.meta = {
      id: result.sessionId,
      title: "",
      cwd: this.hooks.cwd,
      createdAt: now,
      updatedAt: now,
    };
    this.builder = new TranscriptBuilder(result.sessionId, this.hooks.cwd, now);
    this.configOptions = result.configOptions ?? [];
    this.attached = true;
    this.hooks.updateMeta({ ...this.meta });
    await this.applyStoredRoute();
    this.notify();
    this.persistNow();
  }

  async resume(
    sessionId: string,
    snapshot: TranscriptSnapshot | null,
    meta: SessionMeta | null,
  ): Promise<void> {
    const client = this.requireClient();
    if (this.busy) throw new Error("a prompt is already in flight");
    const configOptions = await client.resumeSession(
      sessionId,
      this.hooks.cwd,
      this.hooks.getMcpServers(),
    );
    const now = Date.now();
    this.meta = meta ? { ...meta, cwd: meta.cwd || this.hooks.cwd, updatedAt: now } : {
      id: sessionId,
      title: "",
      cwd: this.hooks.cwd,
      createdAt: now,
      updatedAt: now,
    };
    const restored = snapshot ? TranscriptBuilder.fromSnapshot(snapshot) : null;
    this.builder =
      restored && restored.sessionId === sessionId
        ? restored
        : new TranscriptBuilder(sessionId, this.hooks.cwd, this.meta.createdAt);
    this.configOptions = configOptions;
    this.attached = true;
    this.hooks.updateMeta({ ...this.meta });
    await this.applyStoredRoute();
    if (!snapshot) {
      // A foreign session has no local transcript; say so once.
      this.addNoticeOnce("info", this.hooks.t("notice.historyUnavailable"));
    }
    this.notify();
    this.persistSoon(0);
  }

  /** Reattach the current persisted session after the runtime process restarted. */
  async reattach(): Promise<boolean> {
    const client = this.requireClient();
    const sessionId = this.sessionId;
    if (!sessionId) return false;
    const configOptions = await client.resumeSession(
      sessionId,
      this.hooks.cwd,
      this.hooks.getMcpServers(),
    );
    this.configOptions = configOptions;
    this.attached = true;
    await this.applyStoredRoute();
    this.notify();
    return true;
  }

  async close(): Promise<void> {
    this.cancelPendingPermissions();
    if (this.busy) this.cancel();
    this.persistNow();
    this.promptGeneration += 1;
    const client = this.client;
    const sessionId = this.sessionId;
    this.meta = null;
    this.builder = null;
    this.configOptions = [];
    this.attached = false;
    this.busy = false;
    this.notify();
    if (sessionId && client && !client.isDisposed) {
      try {
        await client.closeSession(sessionId);
      } catch {
        // Closing is best effort; the runtime may already be gone.
      }
    }
  }

  async send(displayText: string, promptBlocks: AcpPromptBlock[], meta: UserMessageMeta = {}): Promise<void> {
    const client = this.requireClient();
    const sessionId = this.sessionId;
    const builder = this.builder;
    if (!sessionId || !builder) throw new Error("no active session");
    if (!this.attached) throw new Error("session is not attached to the runtime");
    if (this.busy) throw new Error("a prompt is already in flight");

    this.busy = true;
    const generation = ++this.promptGeneration;
    builder.addUser(displayText, meta);
    if (this.meta && this.meta.title.length === 0) {
      const title = displayText.replace(/\s+/gu, " ").trim().slice(0, 60);
      if (title.length > 0) {
        this.meta.title = title;
        this.hooks.updateMeta({ ...this.meta });
      }
    }
    this.notify();
    this.persistNow();

    try {
      const result = await client.prompt(sessionId, promptBlocks);
      builder.markAssistantDone();
      this.handleStopReason(result.stopReason);
    } catch (error) {
      builder.markAssistantDone();
      builder.addNotice(
        "error",
        this.hooks.t("notice.promptFailed", { message: errorMessage(error) }),
      );
    } finally {
      if (this.promptGeneration === generation) {
        this.busy = false;
        this.notify();
        this.persistSoon(0);
      }
    }
  }

  cancel(): void {
    const client = this.client;
    const sessionId = this.sessionId;
    if (!client || !sessionId || !this.busy || client.isDisposed) return;
    client.cancel(sessionId);
  }

  /** Called when the chat view closes: unanswered permissions must not block the agent. */
  cancelPendingForHiddenUi(): void {
    if (this.pendingPermissions.size === 0) return;
    this.cancelPendingPermissions();
    this.notify();
  }

  async setConfigOption(configId: string, value: string): Promise<void> {
    const client = this.requireClient();
    const sessionId = this.sessionId;
    if (!sessionId) throw new Error("no active session");
    const options = await client.setConfigOption(sessionId, configId, value);
    this.configOptions = options;
    this.hooks.rememberConfig(configId, value);
    this.notify();
  }

  onUpdate(params: AcpSessionUpdateParams): void {
    if (!params || params.sessionId !== this.sessionId) return;
    const update = params.update;
    if (!update || typeof update !== "object") return;
    if (update.sessionUpdate === "config_option_update") {
      this.configOptions = normalizeConfigOptions(update.configOptions);
      this.notify();
      return;
    }
    if (!this.builder) return;
    const changed = this.builder.applyUpdate(update).changed;
    if (!changed) return;
    this.notify();
    this.persistSoon();
  }

  onPermissionRequest(request: AcpPermissionRequest): Promise<AcpPermissionOutcome> {
    if (!this.builder || request.sessionId !== this.sessionId) {
      return Promise.resolve(cancelledOutcome());
    }
    const item = this.builder.addPermission(request);
    if (this.hooks.getAutoApprove()) {
      this.builder.decidePermission(item.id, "auto");
      this.notify();
      this.persistSoon(200);
      return Promise.resolve({
        outcome: { outcome: "selected", optionId: pickAllowOption(item.options) },
      });
    }
    this.notify();
    this.persistSoon(200);
    return new Promise<AcpPermissionOutcome>((resolve) => {
      this.pendingPermissions.set(item.id, { resolve, options: item.options });
    });
  }

  resolvePermission(
    itemId: string,
    decision: "allowed" | "rejected",
    optionId?: string,
  ): boolean {
    const pending = this.pendingPermissions.get(itemId);
    if (!pending) return false;
    this.pendingPermissions.delete(itemId);
    const explicit = optionId && pending.options.some((option) => option.optionId === optionId)
      ? optionId
      : undefined;
    const chosen =
      explicit ??
      (decision === "allowed" ? pickAllowOption(pending.options) : pickRejectOption(pending.options));
    const typed: PermissionDecision = decision;
    this.builder?.decidePermission(itemId, typed);
    pending.resolve({ outcome: { outcome: "selected", optionId: chosen } });
    this.notify();
    this.persistSoon(200);
    return true;
  }

  /** Called when the runtime process exits: keep the transcript but drop the session binding. */
  onRuntimeLost(): void {
    this.cancelPendingPermissions();
    this.builder?.markAssistantDone();
    this.attached = false;
    this.busy = false;
    this.notify();
  }

  dispose(): void {
    this.cancelPendingPermissions();
    this.flushPersist();
  }

  /** Add a notice unless the transcript already ends with the exact same one. */
  private addNoticeOnce(level: "info" | "warn" | "error", text: string): void {
    if (!this.builder) return;
    const items = this.builder.all;
    const last = items[items.length - 1];
    if (last && last.type === "notice" && last.text === text) return;
    this.builder.addNotice(level, text);
  }

  private requireClient(): AcpClient {
    if (!this.client || this.client.isDisposed) {
      throw new Error("the DSH runtime is not connected");
    }
    return this.client;
  }

  private handleStopReason(reason: string | undefined): void {
    if (!this.builder) return;
    switch (reason) {
      case "cancelled":
        this.builder.addNotice("info", this.hooks.t("notice.cancelled"));
        break;
      case "max_tokens":
        this.builder.addNotice("warn", this.hooks.t("notice.maxTokens"));
        break;
      case "max_turn_requests":
        this.builder.addNotice("warn", this.hooks.t("notice.maxTurnRequests"));
        break;
      case "refusal":
        this.builder.addNotice("warn", this.hooks.t("notice.refusal"));
        break;
      default:
        break;
    }
  }

  private async applyStoredRoute(): Promise<void> {
    const client = this.requireClient();
    const sessionId = this.sessionId;
    if (!sessionId) return;
    const model = this.hooks.getLastModelValue();
    if (model && this.hasSelectValue("model", model)) {
      try {
        this.configOptions = await client.setConfigOption(sessionId, "model", model);
      } catch {
        // The remembered model may no longer be available; keep the agent default.
      }
    }
    const effort = this.hooks.getLastEffort();
    if (effort !== "" && this.hasSelectValue("reasoning_effort", effort)) {
      try {
        this.configOptions = await client.setConfigOption(sessionId, "reasoning_effort", effort);
      } catch {
        // Same as above: the exact model may not expose that effort.
      }
    }
    this.rememberCurrentConfig();
  }

  private rememberCurrentConfig(): void {
    for (const option of this.configOptions) {
      if (typeof option.currentValue === "string" && option.currentValue.length > 0) {
        this.hooks.rememberConfig(option.id, option.currentValue);
      }
    }
  }

  private hasSelectValue(configId: string, value: string): boolean {
    const option = this.configOptions.find((candidate) => candidate.id === configId);
    if (!option) return false;
    return selectOptionValues(option).includes(value);
  }

  private cancelPendingPermissions(): void {
    for (const [itemId, pending] of this.pendingPermissions) {
      this.builder?.decidePermission(itemId, "cancelled");
      pending.resolve(cancelledOutcome());
      this.pendingPermissions.delete(itemId);
    }
  }

  private notify(): void {
    this.hooks.onChanged();
  }

  private persistSoon(delayMs = PERSIST_DEBOUNCE_MS): void {
    if (this.persistTimer !== null) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persistNow();
    }, delayMs);
  }

  private flushPersist(): void {
    if (this.persistTimer !== null) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.persistNow();
  }

  private persistNow(): void {
    const builder = this.builder;
    const meta = this.meta;
    if (!builder || !meta) return;
    meta.updatedAt = Date.now();
    const snapshot = builder.snapshot();
    snapshot.sessionId = meta.id;
    this.hooks.updateMeta({ ...meta });
    this.hooks.persist(snapshot);
  }
}
