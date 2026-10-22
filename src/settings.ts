/**
 * Settings model, defaults, and the settings tab.
 */
import { App, Notice, PluginSettingTab, Setting, setIcon } from "obsidian";
import type DshChatPlugin from "./main.ts";
import type { RuntimeStatus } from "./runtime.ts";

export type ToolDisplay = "hidden" | "latest" | "all";

export interface DshChatSettings {
  launcherPath: string;
  dshHome: string;
  provider: string;
  model: string;
  extraArgs: string;
  extraPatchYaml: string;
  mcpServersJson: string;
  includeActiveNote: boolean;
  includeSelection: boolean;
  maxContextChars: number;
  attachResourceLink: boolean;
  autoApproveTools: boolean;
  showReasoning: boolean;
  toolDisplay: ToolDisplay;
  sendOnEnter: boolean;
  autoStartRuntime: boolean;
  debugLog: boolean;
  lastModelValue: string;
  lastReasoningEffort: string;
}

export const DEFAULT_SETTINGS: DshChatSettings = {
  launcherPath: "",
  dshHome: "",
  provider: "",
  model: "",
  extraArgs: "",
  extraPatchYaml: "",
  mcpServersJson: "",
  includeActiveNote: true,
  includeSelection: true,
  maxContextChars: 8000,
  attachResourceLink: true,
  autoApproveTools: false,
  showReasoning: true,
  toolDisplay: "hidden",
  sendOnEnter: true,
  autoStartRuntime: false,
  debugLog: false,
  lastModelValue: "",
  lastReasoningEffort: "",
};

export function normalizeSettings(raw: unknown): DshChatSettings {
  const merged: DshChatSettings = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== "object") return merged;
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof DshChatSettings>) {
    const value = record[key];
    if (value === undefined || value === null) continue;
    const fallback = DEFAULT_SETTINGS[key];
    if (typeof fallback === "boolean" && typeof value === "boolean") {
      merged[key] = value as never;
    } else if (typeof fallback === "number" && typeof value === "number" && Number.isFinite(value)) {
      merged[key] = value as never;
    } else if (typeof fallback === "string" && typeof value === "string") {
      merged[key] = value as never;
    }
  }
  merged.maxContextChars = Math.max(500, Math.min(200_000, Math.floor(merged.maxContextChars)));
  if (
    merged.toolDisplay !== "hidden" &&
    merged.toolDisplay !== "latest" &&
    merged.toolDisplay !== "all"
  ) {
    merged.toolDisplay = DEFAULT_SETTINGS.toolDisplay;
  }
  return merged;
}

type Translate = (key: string, vars?: Record<string, string | number>) => string;

function isValidMcpJson(value: string): boolean {
  const raw = value.trim();
  if (raw.length === 0) return true;
  try {
    return Array.isArray(JSON.parse(raw));
  } catch {
    return false;
  }
}

export class DshChatSettingTab extends PluginSettingTab {
  private readonly plugin: DshChatPlugin;

  constructor(app: App, plugin: DshChatPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("dsh-settings");
    const t: Translate = this.plugin.i18n.t.bind(this.plugin.i18n);

    this.renderHero(containerEl, t);
    this.renderConnection(containerEl, t);
    this.renderContext(containerEl, t);
    this.renderBehavior(containerEl, t);
    this.renderDiagnostics(containerEl, t);
    this.renderAdvanced(containerEl, t);
  }

  // ---------------------------------------------------------------- layout --

  private card(container: HTMLElement, title: string, hint?: string): HTMLElement {
    const card = container.createDiv({ cls: "dsh-settings-card" });
    const head = card.createDiv({ cls: "dsh-settings-card-head" });
    head.createDiv({ cls: "dsh-settings-card-title", text: title });
    if (hint) head.createDiv({ cls: "dsh-settings-card-hint", text: hint });
    return card;
  }

  private renderHero(container: HTMLElement, t: Translate): void {
    const hero = container.createDiv({ cls: "dsh-settings-hero" });

    const head = hero.createDiv({ cls: "dsh-settings-hero-head" });
    const icon = head.createDiv({ cls: "dsh-settings-hero-icon" });
    setIcon(icon, "message-square");
    const copy = head.createDiv({ cls: "dsh-settings-hero-copy" });
    copy.createDiv({ cls: "dsh-settings-hero-title", text: "DSH Agent" });
    copy.createDiv({ cls: "dsh-settings-hero-subtitle", text: t("settings.hero.subtitle") });
    copy.createDiv({
      cls: "dsh-settings-hero-version",
      text: `v${this.plugin.manifest.version}`,
    });

    const statusRow = hero.createDiv({ cls: "dsh-settings-status" });
    const dot = statusRow.createSpan({ cls: "dsh-chat-dot" });
    const label = statusRow.createSpan({ cls: "dsh-settings-status-text" });
    const path = hero.createDiv({ cls: "dsh-settings-status-path" });

    const refresh = (): void => {
      const described = DshChatSettingTab.describeStatus(this.plugin.runtime.status, t);
      label.setText(described.text);
      dot.className = `dsh-chat-dot ${described.dot}`;
      const launcher = this.plugin.runtime.resolveLauncher();
      path.setText(
        launcher
          ? t("settings.status.launcher", { path: launcher.launcher })
          : t("settings.status.noLauncher"),
      );
      path.title = launcher?.launcher ?? "";
    };
    refresh();

    const actions = hero.createDiv({ cls: "dsh-settings-actions" });
    const test = actions.createEl("button", {
      cls: "mod-cta",
      text: t("settings.actions.test"),
    });
    test.addEventListener("click", () => {
      void (async () => {
        test.disabled = true;
        test.setText(t("settings.detecting"));
        const result = await this.plugin.probeRuntime();
        new Notice(
          result.ok
            ? t("settings.detectOk", { detail: result.detail })
            : t("settings.detectFail", { detail: result.detail }),
        );
        test.disabled = false;
        test.setText(t("settings.actions.test"));
        refresh();
      })();
    });
    const restart = actions.createEl("button", { text: t("settings.actions.restart") });
    restart.addEventListener("click", () => {
      void this.plugin.restartRuntime();
    });
    const log = actions.createEl("button", { text: t("settings.actions.log") });
    log.addEventListener("click", () => this.plugin.showLogModal());
  }

  private static describeStatus(
    status: RuntimeStatus,
    t: Translate,
  ): { text: string; dot: string } {
    switch (status.phase) {
      case "probing":
        return { text: t("status.probing"), dot: "is-starting" };
      case "starting":
        return {
          text: status.firstStart ? t("status.firstStart") : t("status.starting"),
          dot: "is-starting",
        };
      case "ready":
        return { text: t("status.ready"), dot: "is-ready" };
      case "error":
        return {
          text: status.detail === "not-found" ? t("status.notFound") : t("status.error"),
          dot: "is-error",
        };
      case "stopped":
        return { text: t("status.stopped"), dot: "is-idle" };
      default:
        return { text: t("status.idle"), dot: "is-idle" };
    }
  }

  // ------------------------------------------------------------- sections --

  private renderConnection(container: HTMLElement, t: Translate): void {
    const card = this.card(
      container,
      t("settings.card.connection.title"),
      t("settings.card.connection.hint"),
    );

    new Setting(card)
      .setName(t("settings.launcher.name"))
      .setDesc(t("settings.launcher.desc"))
      .addText((text) =>
        text
          .setPlaceholder("…\\resources\\runtime\\cli\\bin\\dsh.cmd")
          .setValue(this.plugin.settings.launcherPath)
          .onChange(async (value) => {
            await this.plugin.updateSettings({ launcherPath: value.trim() });
          }),
      );

    new Setting(card)
      .setName(t("settings.home.name"))
      .setDesc(t("settings.home.desc"))
      .addText((text) =>
        text
          .setPlaceholder("~/.dsh")
          .setValue(this.plugin.settings.dshHome)
          .onChange(async (value) => {
            await this.plugin.updateSettings({ dshHome: value.trim() });
          }),
      );

    new Setting(card)
      .setName(t("settings.provider.name"))
      .setDesc(t("settings.provider.desc"))
      .addText((text) =>
        text
          .setPlaceholder("deepseek-account")
          .setValue(this.plugin.settings.provider)
          .onChange(async (value) => {
            await this.plugin.updateSettings({ provider: value.trim() });
          }),
      );

    new Setting(card)
      .setName(t("settings.model.name"))
      .setDesc(t("settings.model.desc"))
      .addText((text) =>
        text
          .setPlaceholder("deepseek-flash")
          .setValue(this.plugin.settings.model)
          .onChange(async (value) => {
            await this.plugin.updateSettings({ model: value.trim() });
          }),
      );
  }

  private renderContext(container: HTMLElement, t: Translate): void {
    const card = this.card(
      container,
      t("settings.card.context.title"),
      t("settings.card.context.hint"),
    );

    new Setting(card)
      .setName(t("settings.includeNote.name"))
      .setDesc(t("settings.includeNote.desc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.includeActiveNote).onChange(async (value) => {
          await this.plugin.updateSettings({ includeActiveNote: value });
        }),
      );

    new Setting(card)
      .setName(t("settings.includeSelection.name"))
      .setDesc(t("settings.includeSelection.desc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.includeSelection).onChange(async (value) => {
          await this.plugin.updateSettings({ includeSelection: value });
        }),
      );

    new Setting(card)
      .setName(t("settings.maxChars.name"))
      .setDesc(t("settings.maxChars.desc"))
      .addText((text) => {
        text.inputEl.addClass("dsh-settings-number");
        text.setValue(String(this.plugin.settings.maxContextChars)).onChange(async (value) => {
          if (value.trim().length === 0) return;
          const parsed = Number.parseInt(value, 10);
          if (!Number.isFinite(parsed) || parsed <= 0) {
            new Notice(t("settings.invalidNumber"));
            return;
          }
          await this.plugin.updateSettings({
            maxContextChars: Math.max(500, Math.min(200_000, parsed)),
          });
        });
      });

    new Setting(card)
      .setName(t("settings.resourceLink.name"))
      .setDesc(t("settings.resourceLink.desc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.attachResourceLink).onChange(async (value) => {
          await this.plugin.updateSettings({ attachResourceLink: value });
        }),
      );
  }

  private renderBehavior(container: HTMLElement, t: Translate): void {
    const card = this.card(
      container,
      t("settings.card.behavior.title"),
      t("settings.card.behavior.hint"),
    );

    new Setting(card)
      .setName(t("settings.autoApprove.name"))
      .setDesc(t("settings.autoApprove.desc"))
      .setClass("dsh-settings-warning")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoApproveTools).onChange(async (value) => {
          await this.plugin.updateSettings({ autoApproveTools: value });
        }),
      );

    new Setting(card)
      .setName(t("settings.toolDisplay.name"))
      .setDesc(t("settings.toolDisplay.desc"))
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({
            hidden: t("settings.toolDisplay.hidden"),
            latest: t("settings.toolDisplay.latest"),
            all: t("settings.toolDisplay.all"),
          })
          .setValue(this.plugin.settings.toolDisplay)
          .onChange(async (value) => {
            await this.plugin.updateSettings({ toolDisplay: value as ToolDisplay });
          }),
      );

    new Setting(card)
      .setName(t("settings.showReasoning.name"))
      .setDesc(t("settings.showReasoning.desc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showReasoning).onChange(async (value) => {
          await this.plugin.updateSettings({ showReasoning: value });
        }),
      );

    new Setting(card)
      .setName(t("settings.sendOnEnter.name"))
      .setDesc(t("settings.sendOnEnter.desc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.sendOnEnter).onChange(async (value) => {
          await this.plugin.updateSettings({ sendOnEnter: value });
        }),
      );

    new Setting(card)
      .setName(t("settings.autoStart.name"))
      .setDesc(t("settings.autoStart.desc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoStartRuntime).onChange(async (value) => {
          await this.plugin.updateSettings({ autoStartRuntime: value });
        }),
      );
  }

  private renderDiagnostics(container: HTMLElement, t: Translate): void {
    const card = this.card(
      container,
      t("settings.card.diagnostics.title"),
      t("settings.card.diagnostics.hint"),
    );

    new Setting(card)
      .setName(t("settings.debugLog.name"))
      .setDesc(t("settings.debugLog.desc"))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.debugLog).onChange(async (value) => {
          await this.plugin.updateSettings({ debugLog: value });
        }),
      );
  }

  private renderAdvanced(container: HTMLElement, t: Translate): void {
    const details = container.createEl("details", { cls: "dsh-settings-advanced" });
    details.createEl("summary", { text: t("settings.advanced") });
    const card = details.createDiv({ cls: "dsh-settings-card dsh-settings-advanced-card" });

    new Setting(card)
      .setName(t("settings.extraArgs.name"))
      .setDesc(t("settings.extraArgs.desc"))
      .addText((text) =>
        text
          .setPlaceholder("--dump-config")
          .setValue(this.plugin.settings.extraArgs)
          .onChange(async (value) => {
            await this.plugin.updateSettings({ extraArgs: value.trim() });
          }),
      );

    new Setting(card)
      .setName(t("settings.extraPatch.name"))
      .setDesc(t("settings.extraPatch.desc"))
      .addTextArea((area) => {
        area.inputEl.rows = 4;
        area
          .setPlaceholder("- id: deepseek-account\n  config:\n    desktopPlatform: win32")
          .setValue(this.plugin.settings.extraPatchYaml)
          .onChange(async (value) => {
            await this.plugin.updateSettings({ extraPatchYaml: value });
          });
      });

    new Setting(card)
      .setName(t("settings.mcp.name"))
      .setDesc(t("settings.mcp.desc"))
      .addTextArea((area) => {
        area.inputEl.rows = 4;
        area
          .setPlaceholder(
            '[{"name":"fs","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","."]}]',
          )
          .setValue(this.plugin.settings.mcpServersJson)
          .onChange(async (value) => {
            await this.plugin.updateSettings({ mcpServersJson: value });
          });
        area.inputEl.addEventListener("blur", () => {
          if (!isValidMcpJson(area.inputEl.value)) {
            new Notice(t("settings.invalidMcpJson"));
          }
        });
      });
  }
}
