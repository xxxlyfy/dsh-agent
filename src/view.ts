/**
 * The right-sidebar chat panel.
 *
 * Layout follows the Pi Agent plugin: a compact brand header with icon actions,
 * a framed messages card where every message has an uppercase role row plus a
 * content card, and a composer with context badges, a textarea and a run bar
 * that hosts model/effort selectors next to the send button.
 */
import {
  ItemView,
  Menu,
  Modal,
  Notice,
  setIcon,
  type App,
  type WorkspaceLeaf,
} from "obsidian";
import type { AcpConfigOption, AcpSelectGroup, AcpSelectOption } from "./acp/protocol.ts";
import { prettySelectorValue } from "./acp/protocol.ts";
import type { I18n } from "./i18n.ts";
import type DshChatPlugin from "./main.ts";
import type { ChatViewState } from "./main.ts";
import {
  assistantText,
  decisionLabel,
  fillMarkdown,
  toolInputText,
  toolResultText,
  toolStatusLabel,
  thoughtText,
  usageLabel,
} from "./render.ts";
import type {
  AssistantItem,
  NoticeItem,
  PermissionItem,
  ToolItem,
  TranscriptItem,
  UserItem,
} from "./transcript.ts";

export const VIEW_TYPE_DSH_CHAT = "dsh-chat-view";

interface RenderedItem {
  el: HTMLElement;
  key: string;
}

interface AssistantGroup {
  merged: AssistantItem;
  key: string;
}

function itemRenderKey(item: TranscriptItem): string {
  switch (item.type) {
    case "assistant":
      return `a:${item.blocks.map((block) => block.length).join(",")}:${item.thoughts.length}:${item.done}`;
    case "tool":
      return `t:${item.status}:${item.title}:${item.content.map((block) => block.length).join(",")}:${
        item.rawInput === undefined ? 0 : 1
      }`;
    case "permission":
      return `p:${item.decision ?? ""}`;
    default:
      return "s";
  }
}

function optionLabel(i18n: I18n, kind: string, fallback: string): string {
  switch (kind) {
    case "allow_once":
      return i18n.t("permission.allow");
    case "allow_always":
      return i18n.t("permission.allowAlways");
    case "reject_once":
      return i18n.t("permission.reject");
    case "reject_always":
      return i18n.t("permission.rejectAlways");
    default:
      if (kind.startsWith("allow")) return i18n.t("permission.allow");
      if (kind.startsWith("reject")) return i18n.t("permission.reject");
      return fallback;
  }
}

function iconButton(parent: HTMLElement, icon: string, label: string, cls: string): HTMLButtonElement {
  const button = parent.createEl("button", { cls });
  button.setAttribute("aria-label", label);
  button.setAttribute("title", label);
  setIcon(button, icon);
  return button;
}

export class DshChatView extends ItemView {
  private itemsEl!: HTMLElement;
  private messagesEl!: HTMLElement;
  private emptyEl!: HTMLElement;
  private bannerEl!: HTMLElement;
  private jumpButton!: HTMLButtonElement;
  private threadTitleEl!: HTMLElement;
  private textareaEl!: HTMLTextAreaElement;
  private sendButton!: HTMLButtonElement;
  private sendIcon!: HTMLElement;
  private sendLabel!: HTMLElement;
  private statusDot!: HTMLElement;
  private statusText!: HTMLElement;
  private workingEl: HTMLElement | null = null;
  private workingLabelEl: HTMLElement | null = null;
  private modelButton!: HTMLButtonElement;
  private effortButton!: HTMLButtonElement;
  private modelLabelEl!: HTMLElement;
  private effortLabelEl!: HTMLElement;
  private configOptions: AcpConfigOption[] = [];
  private usageEl!: HTMLElement;
  private noteChip!: HTMLButtonElement;
  private selectionChip!: HTMLButtonElement;

  private readonly rendered = new Map<string, RenderedItem>();
  private unsubscribe: (() => void) | null = null;
  private renderScheduled = false;
  private renderTimer: number | null = null;
  private stickToBottom = true;
  private renderedSessionId: string | null = null;
  private includeNote = true;
  private includeSelection = true;
  private busy = false;
  private ready = false;
  private readonly plugin: DshChatPlugin;

  constructor(leaf: WorkspaceLeaf, plugin: DshChatPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_DSH_CHAT;
  }

  getDisplayText(): string {
    return this.plugin.i18n.t("view.name");
  }

  getIcon(): string {
    return "message-square";
  }

  async onOpen(): Promise<void> {
    this.includeNote = this.plugin.settings.includeActiveNote;
    this.includeSelection = this.plugin.settings.includeSelection;
    this.buildUi();
    this.unsubscribe = this.plugin.subscribe(() => this.scheduleRender());
    this.plugin.addOpenView();
    this.scheduleRender();
    void this.plugin.ensureChat();
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.renderTimer !== null) {
      window.clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }
    this.renderScheduled = false;
    this.rendered.clear();
    this.plugin.removeOpenView();
  }

  /** Insert text into the composer (used by commands). */
  prefill(text: string): void {
    this.textareaEl.value = text;
    this.autoGrow();
    this.textareaEl.focus();
    this.textareaEl.setSelectionRange(this.textareaEl.value.length, this.textareaEl.value.length);
  }

  focusComposer(): void {
    this.textareaEl.focus();
  }

  private buildUi(): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    this.contentEl.empty();
    this.contentEl.addClass("dsh-chat-container");

    const root = this.contentEl.createDiv({ cls: "dsh-chat-root" });

    // Header: brand + thread title + icon actions.
    const header = root.createDiv({ cls: "dsh-chat-header" });
    const brand = header.createDiv({ cls: "dsh-chat-brand" });
    const brandIcon = brand.createSpan({ cls: "dsh-chat-brand-icon" });
    setIcon(brandIcon, "message-square");
    this.threadTitleEl = brand.createSpan({ cls: "dsh-chat-thread-title" });

    const actions = header.createDiv({ cls: "dsh-chat-header-actions" });
    const newButton = iconButton(actions, "plus", t("header.new"), "dsh-chat-header-action");
    const historyButton = iconButton(actions, "history", t("header.history"), "dsh-chat-header-action");
    const moreButton = iconButton(actions, "ellipsis", t("header.more"), "dsh-chat-header-action");

    const statusLine = root.createDiv({ cls: "dsh-chat-statusline" });
    this.statusDot = statusLine.createSpan({ cls: "dsh-chat-dot" });
    this.statusText = statusLine.createSpan({ cls: "dsh-chat-status-text" });

    this.bannerEl = root.createDiv({ cls: "dsh-chat-banner" });
    this.bannerEl.style.display = "none";

    // Messages: framed card; empty state and items live inside.
    const messagesWrap = root.createDiv({ cls: "dsh-chat-messages-wrap" });
    this.messagesEl = messagesWrap.createDiv({ cls: "dsh-chat-messages" });
    this.emptyEl = this.messagesEl.createDiv({ cls: "dsh-chat-empty" });
    this.buildEmptyState();
    this.itemsEl = this.messagesEl.createDiv({ cls: "dsh-chat-items" });
    this.jumpButton = messagesWrap.createEl("button", { cls: "dsh-chat-jump", text: "↓" });
    this.jumpButton.style.display = "none";

    // Composer: context toggles stay on the left, context usage sits on the
    // right of the same row, then the input and the run bar.
    const composer = root.createDiv({ cls: "dsh-chat-composer" });
    const composerTop = composer.createDiv({ cls: "dsh-chat-composer-top" });
    const badges = composerTop.createDiv({ cls: "dsh-chat-context-badges" });
    this.noteChip = badges.createEl("button", { cls: "dsh-chat-context-badge" });
    this.noteChip.title = t("chip.noteTitle");
    this.noteChip.createSpan({ cls: "dsh-chat-context-badge-icon" });
    setIcon(this.noteChip.firstElementChild as HTMLElement, "file-text");
    this.noteChip.createSpan({ cls: "dsh-chat-context-badge-label", text: t("chip.note") });

    this.selectionChip = badges.createEl("button", { cls: "dsh-chat-context-badge" });
    this.selectionChip.title = t("chip.selectionTitle");
    this.selectionChip.createSpan({ cls: "dsh-chat-context-badge-icon" });
    setIcon(this.selectionChip.firstElementChild as HTMLElement, "text-select");
    this.selectionChip.createSpan({ cls: "dsh-chat-context-badge-label", text: t("chip.selection") });
    this.usageEl = composerTop.createSpan({ cls: "dsh-chat-usage" });

    this.textareaEl = composer.createEl("textarea", { cls: "dsh-chat-input" });
    this.textareaEl.rows = 3;
    this.textareaEl.placeholder = t("composer.placeholder");

    const bar = composer.createDiv({ cls: "dsh-chat-composer-bar" });
    const modelSetting = this.createRunSetting(bar, "dsh-chat-model", t("selectors.model"));
    this.modelButton = modelSetting.button;
    this.modelLabelEl = modelSetting.label;
    const effortSetting = this.createRunSetting(bar, "dsh-chat-effort", t("selectors.effort"));
    this.effortButton = effortSetting.button;
    this.effortLabelEl = effortSetting.label;

    this.sendButton = bar.createEl("button", { cls: "dsh-chat-send" });
    this.sendIcon = this.sendButton.createSpan({ cls: "dsh-chat-send-icon" });
    setIcon(this.sendIcon, "send");
    this.sendLabel = this.sendButton.createSpan({ cls: "dsh-chat-send-label", text: t("composer.send") });

    this.registerDomEvent(newButton, "click", () => void this.plugin.newSession());
    this.registerDomEvent(historyButton, "click", () => this.openHistoryMenu(historyButton));
    this.registerDomEvent(moreButton, "click", () => this.openMoreMenu(moreButton));
    this.registerDomEvent(this.sendButton, "click", () => {
      if (this.busy) this.plugin.cancelPrompt();
      else void this.submit();
    });
    this.registerDomEvent(this.textareaEl, "keydown", (event: KeyboardEvent) => {
      if (event.key !== "Enter") return;
      const sendOnEnter = this.plugin.settings.sendOnEnter;
      const withModifier = event.metaKey || event.ctrlKey;
      if (event.shiftKey) return;
      if (event.isComposing || event.keyCode === 229) return;
      if (sendOnEnter === withModifier) return;
      event.preventDefault();
      void this.submit();
    });
    this.registerDomEvent(this.textareaEl, "input", () => this.autoGrow());
    this.registerDomEvent(this.messagesEl, "scroll", () => this.onMessagesScroll());
    // Own the wheel over the whole message area: native chaining is unreliable
    // in Obsidian side leaves and dead zones (jump button, card padding).
    this.registerDomEvent(messagesWrap, "wheel", (event: WheelEvent) => this.onWheel(event), {
      passive: false,
    });
    this.registerDomEvent(this.jumpButton, "click", () => {
      this.stickToBottom = true;
      this.jumpButton.style.display = "none";
      this.autoScroll();
    });
    this.registerDomEvent(this.noteChip, "click", () => {
      this.includeNote = !this.includeNote;
      this.syncChips();
    });
    this.registerDomEvent(this.selectionChip, "click", () => {
      this.includeSelection = !this.includeSelection;
      this.syncChips();
    });
    this.registerDomEvent(this.modelButton, "click", () =>
      this.openConfigMenu("model", this.modelButton),
    );
    this.registerDomEvent(this.effortButton, "click", () =>
      this.openConfigMenu("reasoning_effort", this.effortButton),
    );

    this.syncChips();
    this.autoGrow();
  }

  private buildEmptyState(): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    this.emptyEl.empty();
    const icon = this.emptyEl.createDiv({ cls: "dsh-chat-empty-icon" });
    setIcon(icon, "message-square");
    this.emptyEl.createEl("div", { cls: "dsh-chat-empty-title", text: t("empty.title") });
    this.emptyEl.createEl("div", { cls: "dsh-chat-empty-hint", text: t("empty.hint") });
    const examples = this.emptyEl.createDiv({ cls: "dsh-chat-empty-examples" });
    for (const key of ["empty.example1", "empty.example2", "empty.example3"]) {
      const button = examples.createEl("button", { cls: "dsh-chat-example", text: t(key) });
      this.registerDomEvent(button, "click", () => {
        this.textareaEl.value = t(key);
        this.autoGrow();
        this.textareaEl.focus();
      });
    }
  }

  private syncChips(): void {
    this.noteChip.toggleClass("is-active", this.includeNote);
    this.selectionChip.toggleClass("is-active", this.includeSelection);
    this.noteChip.setAttribute("aria-pressed", String(this.includeNote));
    this.selectionChip.setAttribute("aria-pressed", String(this.includeSelection));
  }

  private scheduleRender(): void {
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    // A timer (not requestAnimationFrame): Obsidian window rendering is
    // throttled/paused while the window is hidden or occluded, but the panel
    // must still catch up when it becomes visible.
    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = null;
      this.renderScheduled = false;
      try {
        this.render();
      } catch (error) {
        console.error("[dsh-chat] render failed", error);
      }
    }, 0);
  }

  private render(): void {
    const state = this.plugin.getViewState();
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);

    // Composer state first: it must stay correct even if timeline rendering fails.
    this.busy = state.session.busy;
    this.ready = Boolean(state.session.sessionId && state.session.attached);
    this.threadTitleEl.setText(state.session.title?.trim() || t("view.name"));
    this.threadTitleEl.title = state.session.title?.trim() || t("view.name");
    this.sendLabel.setText(this.busy ? t("composer.stop") : t("composer.send"));
    setIcon(this.sendIcon, this.busy ? "square" : "send");
    this.sendButton.toggleClass("is-stopping", this.busy);
    this.sendButton.disabled = !this.busy && !this.ready;
    this.textareaEl.placeholder = this.ready
      ? t("composer.placeholder")
      : t("composer.connecting");
    this.modelButton.disabled = this.busy;
    this.effortButton.disabled = this.busy;

    this.renderStatus(state);
    this.renderRunSettings(state.session.configOptions);
    this.renderTimeline(state.session.items, state.session.sessionId, state.session.busy);
    this.renderWorkingIndicator(state.session.busy);

    this.usageEl.setText(usageLabel(this.plugin.i18n, state.session.usage));

    if (state.error) {
      this.bannerEl.style.display = "";
      this.bannerEl.setText(state.error);
    } else {
      this.bannerEl.style.display = "none";
      this.bannerEl.setText("");
    }

    const hasItems = state.session.items.some((item) => item.type !== "notice");
    this.emptyEl.style.display = hasItems ? "none" : "";
    this.autoScroll();
  }

  private renderStatus(state: ChatViewState): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const busy = state.session.busy;
    if (busy) {
      this.statusText.setText(t("status.responding"));
      this.statusDot.className = "dsh-chat-dot is-busy";
      return;
    }
    const { phase, detail, firstStart } = state.runtime;
    let label = t("status.idle");
    let dot = "is-idle";
    if (phase === "probing") {
      label = t("status.probing");
      dot = "is-starting";
    } else if (phase === "starting") {
      label = firstStart ? t("status.firstStart") : t("status.starting");
      dot = "is-starting";
    } else if (phase === "ready") {
      label = t("status.ready");
      dot = "is-ready";
    } else if (phase === "error") {
      label = detail === "not-found" ? t("status.notFound") : t("status.error");
      dot = "is-error";
    } else if (phase === "stopped") {
      label = t("status.stopped");
      dot = "is-idle";
    }
    this.statusText.setText(label);
    this.statusDot.className = `dsh-chat-dot ${dot}`;
  }

  private createRunSetting(
    parent: HTMLElement,
    cls: string,
    title: string,
  ): { button: HTMLButtonElement; label: HTMLElement } {
    const button = parent.createEl("button", { cls: `dsh-chat-run-setting ${cls}` });
    button.title = title;
    const label = button.createSpan({ cls: "dsh-chat-run-setting-label" });
    const chevron = button.createSpan({ cls: "dsh-chat-run-setting-chevron" });
    setIcon(chevron, "chevron-down");
    return { button, label };
  }

  private renderRunSettings(options: AcpConfigOption[]): void {
    this.configOptions = options;
    this.updateRunSetting(
      this.modelButton,
      this.modelLabelEl,
      options.find((option) => option.id === "model"),
      this.plugin.i18n.t("selectors.model"),
    );
    this.updateRunSetting(
      this.effortButton,
      this.effortLabelEl,
      options.find((option) => option.id === "reasoning_effort"),
      this.plugin.i18n.t("selectors.effort"),
    );
  }

  private updateRunSetting(
    button: HTMLButtonElement,
    label: HTMLElement,
    option: AcpConfigOption | undefined,
    fallback: string,
  ): void {
    if (!option) {
      button.style.display = "none";
      return;
    }
    button.style.display = "";
    const name = this.configDisplayName(option) || fallback;
    label.setText(name);
    button.title = `${fallback}: ${name}`;
  }

  private configDisplayName(option: AcpConfigOption): string {
    const current = option.currentValue ?? "";
    for (const entry of option.options ?? []) {
      if (Array.isArray((entry as AcpSelectGroup).options)) {
        const match = (entry as AcpSelectGroup).options.find((child) => child.value === current);
        if (match) return match.name;
      } else if ((entry as AcpSelectOption).value === current) {
        return (entry as AcpSelectOption).name;
      }
    }
    return prettySelectorValue(current);
  }

  /** Themed dropdown for one ACP config option (native selects render a white popup). */
  private openConfigMenu(configId: "model" | "reasoning_effort", anchor: HTMLElement): void {
    const option = this.configOptions.find((entry) => entry.id === configId);
    if (!option) return;
    const menu = new Menu();
    const current = option.currentValue ?? "";
    let added = false;
    const addChoice = (value: string, name: string): void => {
      added = true;
      menu.addItem((item) =>
        item
          .setTitle(name)
          .setChecked(value === current)
          .onClick(() => {
            void this.applyConfig(configId, value);
          }),
      );
    };
    for (const entry of option.options ?? []) {
      if (Array.isArray((entry as AcpSelectGroup).options)) {
        const group = entry as AcpSelectGroup;
        if (added) menu.addSeparator();
        menu.addItem((item) => item.setTitle(group.name).setIsLabel(true));
        for (const child of group.options) addChoice(child.value, child.name);
      } else {
        addChoice((entry as AcpSelectOption).value, (entry as AcpSelectOption).name);
      }
    }
    if (!added) return;
    const rect = anchor.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
  }

  private async applyConfig(configId: string, value: string): Promise<void> {
    try {
      await this.plugin.setConfigOption(configId, value);
    } catch (error) {
      new Notice(
        this.plugin.i18n.t("notice.configFailed", {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  private renderTimeline(
    items: readonly TranscriptItem[],
    sessionId: string | null,
    busy: boolean,
  ): void {
    if (this.renderedSessionId !== sessionId) {
      this.renderedSessionId = sessionId;
      this.rendered.clear();
      this.itemsEl.empty();
      this.stickToBottom = true;
    }
    let lastUserIndex = -1;
    for (let index = items.length - 1; index >= 0; index -= 1) {
      if (items[index].type === "user") {
        lastUserIndex = index;
        break;
      }
    }
    const toolGroups = this.toolGroups(items);
    const assistantGroups = this.assistantGroups(items);
    const toolDisplay = this.plugin.settings.toolDisplay;
    const live = new Set<string>();
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      // While the current turn is still running, show only the status row;
      // the full reply card appears once the turn is complete.
      if (busy && item.type === "assistant" && index > lastUserIndex) continue;
      let renderItem = item;
      let assistantKey = "";
      if (item.type === "assistant") {
        const group = assistantGroups.get(item.id);
        if (!group) continue;
        renderItem = group.merged;
        assistantKey = `:a${group.key}`;
      }
      // hidden: drop every tool card; latest: keep only the newest per turn.
      if (item.type === "tool") {
        if (toolDisplay === "hidden") continue;
        if (toolDisplay === "latest" && !toolGroups.has(item.id)) continue;
      }
      live.add(item.id);
      let record = this.rendered.get(item.id);
      if (!record) {
        const el = this.itemsEl.createDiv({ cls: `dsh-chat-message is-${item.type}` });
        el.dataset.itemId = item.id;
        record = { el, key: "" };
        this.rendered.set(item.id, record);
      }
      const groupCount = item.type === "tool" ? toolGroups.get(item.id) : undefined;
      const key = `${itemRenderKey(renderItem)}${assistantKey}${groupCount ? `:g${groupCount}` : ""}`;
      if (record.key !== key) {
        record.key = key;
        this.renderItem(renderItem, record.el, groupCount);
      }
    }
    for (const [id, record] of this.rendered) {
      if (!live.has(id)) {
        record.el.remove();
        this.rendered.delete(id);
      }
    }
  }

  /** One assistant card per user turn, merging every streamed assistant message. */
  private assistantGroups(items: readonly TranscriptItem[]): Map<string, AssistantGroup> {
    const groups = new Map<string, AssistantGroup>();
    let current: AssistantItem[] = [];
    const flush = () => {
      if (current.length === 0) return;
      const last = current[current.length - 1];
      groups.set(last.id, {
        merged:
          current.length === 1
            ? last
            : {
                ...last,
                id: last.id,
                thoughts: current.flatMap((item) => item.thoughts),
                blocks: current.flatMap((item) => item.blocks),
                done: current.every((item) => item.done),
              },
        key: current.map(itemRenderKey).join("|"),
      });
      current = [];
    };
    for (const item of items) {
      if (item.type === "user") {
        flush();
      } else if (item.type === "assistant") {
        current.push(item);
      }
    }
    flush();
    return groups;
  }

  /** Latest-tool-only mode: count the tools of each user turn. */
  private toolGroups(items: readonly TranscriptItem[]): Map<string, number> {
    const groups = new Map<string, number>();
    if (this.plugin.settings.toolDisplay !== "latest") return groups;
    let current: ToolItem[] = [];
    const flush = () => {
      if (current.length > 0) groups.set(current[current.length - 1].id, current.length);
      current = [];
    };
    for (const item of items) {
      if (item.type === "user") {
        flush();
      } else if (item.type === "tool") {
        current.push(item);
      }
    }
    flush();
    return groups;
  }

  /** Transient "working" row below the latest message: DSH + pi-agent-style shimmer. */
  private renderWorkingIndicator(busy: boolean): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    if (!busy) {
      this.workingEl?.remove();
      this.workingEl = null;
      this.workingLabelEl = null;
      return;
    }
    if (this.workingEl && !this.workingEl.isConnected) {
      this.workingEl = null;
      this.workingLabelEl = null;
    }
    if (!this.workingEl) {
      const row = this.itemsEl.createDiv({ cls: "dsh-chat-working" });
      row.title = t("status.responding");
      row.setAttribute("aria-label", t("status.responding"));
      const icon = row.createSpan({ cls: "dsh-chat-working-icon" });
      setIcon(icon, "sparkles");
      row.createSpan({ cls: "dsh-chat-working-title", text: t("role.dsh") });
      this.workingLabelEl = row.createSpan({ cls: "dsh-chat-working-label" });
      this.workingEl = row;
    }
    this.workingLabelEl?.setText(t("status.responding"));
    // Always keep it after the newest message.
    this.itemsEl.appendChild(this.workingEl);
    this.autoScroll();
  }

  private renderItem(item: TranscriptItem, el: HTMLElement, groupCount?: number): void {
    el.empty();
    switch (item.type) {
      case "user":
        this.renderUser(item, el);
        return;
      case "assistant":
        this.renderAssistant(item, el);
        return;
      case "tool":
        this.renderTool(item, el, groupCount);
        return;
      case "permission":
        this.renderPermission(item, el);
        return;
      case "notice":
        this.renderNotice(item, el);
        return;
      default:
        return;
    }
  }

  private renderRole(
    el: HTMLElement,
    icon: string,
    title: string,
    extra?: (role: HTMLElement) => void,
  ): HTMLElement {
    const role = el.createDiv({ cls: "dsh-chat-message-role" });
    const iconEl = role.createSpan({ cls: "dsh-chat-role-icon" });
    setIcon(iconEl, icon);
    const titleEl = role.createSpan({ cls: "dsh-chat-message-role-title" });
    titleEl.createSpan({ text: title.toUpperCase() });
    if (extra) extra(role);
    return role;
  }

  private renderUser(item: UserItem, el: HTMLElement): void {
    this.renderRole(el, "user", this.plugin.i18n.t("role.you"));
    const content = el.createDiv({ cls: "dsh-chat-message-content" });
    content.createDiv({ cls: "dsh-chat-user-text", text: item.text });
    if (item.notePath || item.hasSelection) {
      const meta = content.createDiv({ cls: "dsh-chat-user-meta" });
      if (item.notePath) meta.createSpan({ cls: "dsh-chat-tag", text: item.notePath });
      if (item.hasSelection) {
        meta.createSpan({ cls: "dsh-chat-tag", text: this.plugin.i18n.t("chip.selection") });
      }
    }
  }

  private renderAssistant(item: AssistantItem, el: HTMLElement): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const markdown = assistantText(item);
    this.renderRole(el, "sparkles", t("role.dsh"), (role) => {
      const actions = role.createDiv({ cls: "dsh-chat-message-actions" });
      const copy = iconButton(actions, "copy", t("action.copy"), "dsh-chat-message-action");
      copy.disabled = markdown.length === 0;
      copy.addEventListener("click", () => {
        void navigator.clipboard
          .writeText(markdown)
          .then(() => {
            new Notice(t("action.copied"));
          })
          .catch(() => {
            new Notice(t("notice.copyFailed"));
          });
      });
      const insert = iconButton(
        actions,
        "arrow-down-to-line",
        t("action.insert"),
        "dsh-chat-message-action",
      );
      insert.disabled = markdown.length === 0;
      insert.addEventListener("click", () => {
        const target = this.plugin.resolveMarkdownView();
        if (!target) {
          new Notice(t("action.noEditor"));
          return;
        }
        const text = markdown.endsWith("\n") ? markdown : `${markdown}\n`;
        try {
          const editor = target.editor;
          editor.replaceRange(text, editor.getCursor("to"));
        } catch (error) {
          new Notice(
            t("notice.editFailed", {
              message: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      });
      const replace = iconButton(
        actions,
        "text-cursor-input",
        t("action.replace"),
        "dsh-chat-message-action",
      );
      replace.disabled = markdown.length === 0;
      replace.addEventListener("click", () => {
        const target = this.plugin.resolveMarkdownView();
        if (!target) {
          new Notice(t("action.noEditor"));
          return;
        }
        if (!target.editor.somethingSelected()) {
          new Notice(t("notice.noSelection"));
          return;
        }
        try {
          target.editor.replaceSelection(markdown);
        } catch (error) {
          new Notice(
            t("notice.editFailed", {
              message: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      });
    });

    const content = el.createDiv({ cls: "dsh-chat-message-content" });

    if (this.plugin.settings.showReasoning) {
      const thoughts = thoughtText(item);
      if (thoughts) {
        const details = content.createEl("details", { cls: "dsh-chat-thinking" });
        const summary = details.createEl("summary");
        const chevron = summary.createSpan({ cls: "dsh-chat-thinking-chevron" });
        setIcon(chevron, "chevron-right");
        summary.createSpan({ cls: "dsh-chat-thinking-label", text: t("thinking").toUpperCase() });
        const body = details.createDiv({ cls: "dsh-chat-thinking-content" });
        void fillMarkdown(this.app, body, thoughts, this.sourcePath(), this);
      }
    }

    const body = content.createDiv({ cls: "dsh-chat-markdown" });
    if (markdown) {
      void fillMarkdown(this.app, body, markdown, this.sourcePath(), this).then(() =>
        this.autoScroll(),
      );
    } else if (!item.done) {
      const typing = body.createDiv({ cls: "dsh-chat-typing" });
      typing.createSpan({ cls: "dsh-chat-working-label", text: t("status.responding") });
    }
  }

  private renderTool(item: ToolItem, el: HTMLElement, groupCount?: number): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    this.renderRole(el, "wrench", item.title || t("role.tool"), (role) => {
      if (groupCount && groupCount > 1) {
        const badge = role.createSpan({ cls: "dsh-chat-tool-count", text: `×${groupCount}` });
        badge.title = t("tool.groupCount", { count: groupCount });
      }
      role.createSpan({
        cls: `dsh-chat-tool-status is-${item.status}`,
        text: toolStatusLabel(this.plugin.i18n, item.status),
      });
    });
    const content = el.createDiv({ cls: "dsh-chat-message-content dsh-chat-tool-content" });
    const input = toolInputText(item);
    const result = toolResultText(item);
    if (!input && !result) {
      content.createDiv({ cls: "dsh-chat-tool-empty", text: "…" });
      return;
    }
    const details = content.createEl("details", { cls: "dsh-chat-tool-details" });
    details.createEl("summary", { text: t("tool.details") });
    if (input) {
      details.createDiv({ cls: "dsh-chat-tool-label", text: t("tool.input") });
      details.createEl("pre", { cls: "dsh-chat-tool-input", text: input });
    }
    if (result) {
      details.createDiv({ cls: "dsh-chat-tool-label", text: t("tool.output") });
      const body = details.createDiv({ cls: "dsh-chat-markdown" });
      void fillMarkdown(this.app, body, result, this.sourcePath(), this);
    }
  }

  private renderPermission(item: PermissionItem, el: HTMLElement): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    this.renderRole(el, "shield-alert", t("role.approval"));
    const content = el.createDiv({ cls: "dsh-chat-message-content dsh-chat-approval" });
    content.createDiv({ cls: "dsh-chat-permission-title", text: t("permission.title") });
    if (item.toolCallId) {
      content.createDiv({
        cls: "dsh-chat-permission-tool",
        text: t("permission.tool", { id: item.toolCallId }),
      });
    }
    if (item.decision) {
      content.createSpan({
        cls: `dsh-chat-permission-decision is-${item.decision}`,
        text: decisionLabel(this.plugin.i18n, item.decision),
      });
      return;
    }
    const row = content.createDiv({ cls: "dsh-chat-permission-actions" });
    for (const option of item.options) {
      const kind = typeof option.kind === "string" ? option.kind : "";
      const allow = kind.startsWith("allow");
      const button = row.createEl("button", {
        cls: allow ? "mod-cta" : "",
        text: optionLabel(this.plugin.i18n, kind, option.name),
      });
      button.addEventListener("click", () => {
        this.plugin.resolvePermission(
          item.id,
          allow ? "allowed" : "rejected",
          option.optionId,
        );
      });
    }
  }

  private renderNotice(item: NoticeItem, el: HTMLElement): void {
    el.dataset.level = item.level;
    el.createSpan({ cls: "dsh-chat-notice-text", text: item.text });
  }

  private sourcePath(): string {
    return this.plugin.resolveMarkdownView()?.file?.path ?? "";
  }

  private async submit(): Promise<void> {
    const text = this.textareaEl.value.trim();
    if (text.length === 0 || this.busy || !this.ready) return;
    this.textareaEl.value = "";
    this.autoGrow();
    this.stickToBottom = true;
    try {
      await this.plugin.sendMessage(text, {
        includeNote: this.includeNote,
        includeSelection: this.includeSelection,
      });
    } catch (error) {
      this.textareaEl.value = text;
      this.autoGrow();
      new Notice(
        this.plugin.i18n.t("notice.promptFailed", {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  private autoGrow(): void {
    this.textareaEl.style.height = "auto";
    this.textareaEl.style.height = `${Math.min(this.textareaEl.scrollHeight + 2, 240)}px`;
  }

  private onMessagesScroll(): void {
    const nearBottom =
      this.messagesEl.scrollHeight - this.messagesEl.scrollTop - this.messagesEl.clientHeight < 96;
    this.stickToBottom = nearBottom;
    this.jumpButton.style.display = nearBottom ? "none" : "";
  }

  /** Scroll the transcript ourselves so wheel input works over every dead zone. */
  private onWheel(event: WheelEvent): void {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey) return;
    if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    const messages = this.messagesEl;
    const max = messages.scrollHeight - messages.clientHeight;
    if (max <= 0) return;
    if (this.hasInnerScrollable(event.target as HTMLElement | null, event.deltaY)) return;
    const next = Math.max(0, Math.min(max, messages.scrollTop + event.deltaY));
    if (Math.abs(next - messages.scrollTop) < 1) return;
    event.preventDefault();
    messages.scrollTop = next;
    this.onMessagesScroll();
  }

  /** Whether the wheel should scroll a nested element (code block, table, tool result) first. */
  private hasInnerScrollable(target: HTMLElement | null, deltaY: number): boolean {
    let node: HTMLElement | null = target;
    while (node && node !== this.messagesEl) {
      const overflowY = window.getComputedStyle(node).overflowY;
      if (overflowY === "auto" || overflowY === "scroll") {
        const max = node.scrollHeight - node.clientHeight;
        if (max > 0) {
          if (deltaY < 0 && node.scrollTop > 0) return true;
          if (deltaY > 0 && node.scrollTop < max - 1) return true;
        }
      }
      node = node.parentElement;
    }
    return false;
  }

  private autoScroll(): void {
    if (!this.stickToBottom) return;
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }

  private openHistoryMenu(anchor: HTMLElement): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const menu = new Menu();
    const sessions = [...this.plugin.sessionMetas].sort((left, right) => right.updatedAt - left.updatedAt);
    if (sessions.length === 0) {
      menu.addItem((item) => item.setTitle(t("history.empty")).setDisabled(true));
    }
    for (const meta of sessions) {
      menu.addItem((item) =>
        item
          .setTitle(meta.title || t("history.unknownTitle"))
          .setChecked(meta.id === this.plugin.currentSessionId)
          .onClick(() => {
            void this.plugin.resumeSession(meta.id);
          }),
      );
    }
    menu.addSeparator();
    menu.addItem((item) =>
      item.setTitle(t("history.import")).onClick(() => {
        void this.openImportModal();
      }),
    );
    const rect = anchor.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
  }

  private async openImportModal(): Promise<void> {
    const entries = await this.plugin.importSessions();
    if (entries.length === 0) {
      new Notice(this.plugin.i18n.t("history.importEmpty"));
      return;
    }
    new SessionPickerModal(this.app, entries, this.plugin.i18n, (entry) => {
      void this.plugin.resumeSession(entry.sessionId);
    }).open();
  }

  private openMoreMenu(anchor: HTMLElement): void {
    const t = this.plugin.i18n.t.bind(this.plugin.i18n);
    const menu = new Menu();
    menu.addItem((item) =>
      item.setTitle(t("menu.restart")).onClick(() => {
        void this.plugin.restartRuntime();
      }),
    );
    menu.addItem((item) =>
      item.setTitle(t("menu.showLog")).onClick(() => {
        new LogModal(this.app, this.plugin.getLogText(), this.plugin.i18n).open();
      }),
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item.setTitle(t("menu.closeSession")).onClick(() => {
        void this.plugin.closeSession();
      }),
    );
    const rect = anchor.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
  }
}

export class LogModal extends Modal {
  private readonly text: string;
  private readonly i18n: I18n;

  constructor(app: App, text: string, i18n: I18n) {
    super(app);
    this.text = text;
    this.i18n = i18n;
  }

  onOpen(): void {
    this.titleEl.setText(this.i18n.t("log.title"));
    const pre = this.contentEl.createEl("pre", { cls: "dsh-chat-log" });
    pre.setText(this.text.length > 0 ? this.text : this.i18n.t("log.empty"));
    const actions = this.contentEl.createDiv({ cls: "dsh-chat-modal-actions" });
    const copy = actions.createEl("button", { text: this.i18n.t("log.copy") });
    copy.addEventListener("click", () => {
      void navigator.clipboard.writeText(this.text).catch(() => {
        new Notice(this.i18n.t("notice.copyFailed"));
      });
    });
    const close = actions.createEl("button", { text: this.i18n.t("log.close") });
    close.addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

interface ImportEntry {
  sessionId: string;
  cwd?: string;
}

class SessionPickerModal extends Modal {
  private readonly entries: ImportEntry[];
  private readonly i18n: I18n;
  private readonly onPick: (entry: ImportEntry) => void;

  constructor(
    app: App,
    entries: ImportEntry[],
    i18n: I18n,
    onPick: (entry: ImportEntry) => void,
  ) {
    super(app);
    this.entries = entries;
    this.i18n = i18n;
    this.onPick = onPick;
  }

  onOpen(): void {
    this.titleEl.setText(this.i18n.t("history.importTitle"));
    const list = this.contentEl.createDiv({ cls: "dsh-chat-session-list" });
    for (const entry of this.entries) {
      const row = list.createDiv({ cls: "dsh-chat-session-row" });
      row.createSpan({ cls: "dsh-chat-session-id", text: entry.sessionId.slice(0, 8) });
      if (entry.cwd) {
        row.createSpan({ cls: "dsh-chat-session-cwd", text: entry.cwd });
      }
      const open = row.createEl("button", { text: this.i18n.t("history.open") });
      open.addEventListener("click", () => {
        this.close();
        this.onPick(entry);
      });
    }
    const actions = this.contentEl.createDiv({ cls: "dsh-chat-modal-actions" });
    const cancel = actions.createEl("button", { text: this.i18n.t("history.cancel") });
    cancel.addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
