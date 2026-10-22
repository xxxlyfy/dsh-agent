/**
 * Pure transcript model: turns ACP session updates into chat items.
 *
 * Kept free of Obsidian imports so it can be unit tested with `node --test`.
 */
import { randomUUID } from "node:crypto";
import {
  textOfContent,
  type AcpPermissionOption,
  type AcpPermissionRequest,
  type AcpSessionUpdate,
} from "./acp/protocol.ts";

export type TranscriptItem =
  | UserItem
  | AssistantItem
  | ToolItem
  | PermissionItem
  | NoticeItem;

export interface UserItem {
  id: string;
  type: "user";
  text: string;
  at: number;
  notePath?: string | null;
  hasSelection?: boolean;
}

export interface AssistantItem {
  id: string;
  type: "assistant";
  messageId: string | null;
  thoughts: string[];
  blocks: string[];
  at: number;
  done: boolean;
}

export interface ToolItem {
  id: string;
  type: "tool";
  toolCallId: string;
  title: string;
  kind: string;
  status: string;
  rawInput?: unknown;
  content: string[];
  at: number;
}

export type PermissionDecision = "allowed" | "rejected" | "cancelled" | "auto";

export interface PermissionItem {
  id: string;
  type: "permission";
  toolCallId: string | null;
  options: AcpPermissionOption[];
  decision: PermissionDecision | null;
  at: number;
}

export interface NoticeItem {
  id: string;
  type: "notice";
  level: "info" | "warn" | "error";
  text: string;
  at: number;
}

export interface TranscriptUsage {
  used: number;
  size: number;
}

export interface TranscriptSnapshot {
  version: 1;
  sessionId: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  usage: TranscriptUsage | null;
  items: TranscriptItem[];
}

export interface UserMessageMeta {
  notePath?: string | null;
  hasSelection?: boolean;
}

export interface UpdateResult {
  changed: boolean;
}

const SNAPSHOT_VERSION = 1;

function toolContentTexts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const type = record.type;
    if (type === "content" && record.content) {
      const text = textOfContent(record.content);
      if (text !== null) out.push(text);
      continue;
    }
    if (type === "text" && typeof record.text === "string") {
      out.push(record.text);
      continue;
    }
    if (type === "diff" && typeof record.path === "string") {
      const before = typeof record.oldText === "string" ? record.oldText : "";
      const after = typeof record.newText === "string" ? record.newText : "";
      out.push(`--- ${record.path}\n${before}\n+++ ${after}`);
    }
  }
  return out;
}

function isItem(value: unknown): value is TranscriptItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<TranscriptItem>;
  switch (item.type) {
    case "user":
      return typeof item.text === "string";
    case "assistant":
      return (
        Array.isArray(item.thoughts) &&
        Array.isArray(item.blocks) &&
        item.thoughts.every((entry) => typeof entry === "string") &&
        item.blocks.every((entry) => typeof entry === "string")
      );
    case "tool":
      return (
        typeof item.toolCallId === "string" &&
        typeof item.title === "string" &&
        typeof item.status === "string" &&
        Array.isArray(item.content) &&
        item.content.every((entry) => typeof entry === "string")
      );
    case "permission":
      return Array.isArray(item.options) && (item.decision === null || typeof item.decision === "string");
    case "notice":
      return typeof item.text === "string" && typeof item.level === "string";
    default:
      return false;
  }
}

export class TranscriptBuilder {
  private readonly items: TranscriptItem[] = [];
  private readonly assistantsByMessage = new Map<string, AssistantItem>();
  private readonly toolsByCall = new Map<string, ToolItem>();
  readonly sessionId: string;
  readonly cwd: string;
  private usage: TranscriptUsage | null = null;
  private readonly createdAt: number;
  private draftCounter = 0;

  constructor(sessionId: string, cwd: string, createdAt: number = Date.now()) {
    this.sessionId = sessionId;
    this.cwd = cwd;
    this.createdAt = createdAt;
  }

  get all(): readonly TranscriptItem[] {
    return this.items;
  }

  getUsage(): TranscriptUsage | null {
    return this.usage;
  }

  addUser(text: string, meta: UserMessageMeta = {}): UserItem {
    const item: UserItem = {
      id: randomUUID(),
      type: "user",
      text,
      at: Date.now(),
      notePath: meta.notePath ?? null,
      hasSelection: meta.hasSelection ?? false,
    };
    this.items.push(item);
    return item;
  }

  addNotice(level: NoticeItem["level"], text: string): NoticeItem {
    const item: NoticeItem = { id: randomUUID(), type: "notice", level, text, at: Date.now() };
    this.items.push(item);
    return item;
  }

  addPermission(request: AcpPermissionRequest): PermissionItem {
    const options = Array.isArray(request.options) && request.options.length > 0
      ? request.options
      : [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ];
    const item: PermissionItem = {
      id: randomUUID(),
      type: "permission",
      toolCallId: request.toolCall?.toolCallId ?? null,
      options,
      decision: null,
      at: Date.now(),
    };
    this.items.push(item);
    return item;
  }

  decidePermission(itemId: string, decision: PermissionDecision): PermissionItem | null {
    const item = this.items.find(
      (candidate): candidate is PermissionItem => candidate.type === "permission" && candidate.id === itemId,
    );
    if (!item) return null;
    item.decision = decision;
    return item;
  }

  /** Apply one ACP `session/update`; returns whether anything visible changed. */
  applyUpdate(update: AcpSessionUpdate): UpdateResult {
    if (!update || typeof update !== "object" || typeof update.sessionUpdate !== "string") {
      return { changed: false };
    }
    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = textOfContent(update.content);
        if (text === null) return { changed: false };
        const item = this.assistantFor(update.messageId);
        item.blocks.push(text);
        return { changed: true };
      }
      case "agent_thought_chunk": {
        const text = textOfContent(update.content);
        if (text === null) return { changed: false };
        const item = this.assistantFor(update.messageId);
        item.thoughts.push(text);
        return { changed: true };
      }
      case "tool_call": {
        const item = this.toolFor(update);
        if (typeof update.title === "string") item.title = update.title;
        if (typeof update.kind === "string") item.kind = update.kind;
        if (typeof update.status === "string") item.status = update.status;
        if (update.rawInput !== undefined) item.rawInput = update.rawInput;
        return { changed: true };
      }
      case "tool_call_update": {
        const item = this.toolFor(update);
        if (typeof update.title === "string" && update.title.length > 0) item.title = update.title;
        if (typeof update.status === "string") item.status = update.status;
        if (update.rawInput !== undefined) item.rawInput = update.rawInput;
        const content = toolContentTexts((update as { content?: unknown }).content);
        if (content.length > 0) item.content = content;
        return { changed: true };
      }
      case "usage_update": {
        if (typeof update.used === "number" && typeof update.size === "number") {
          this.usage = { used: update.used, size: update.size };
          return { changed: true };
        }
        return { changed: false };
      }
      default:
        return { changed: false };
    }
  }

  markAssistantDone(): void {
    for (const item of this.items) {
      if (item.type === "assistant") item.done = true;
    }
  }

  snapshot(): TranscriptSnapshot {
    const items = JSON.parse(JSON.stringify(this.items)) as TranscriptItem[];
    return {
      version: SNAPSHOT_VERSION,
      sessionId: this.sessionId,
      cwd: this.cwd,
      createdAt: this.createdAt,
      updatedAt: Date.now(),
      usage: this.usage ? { ...this.usage } : null,
      items,
    };
  }

  static fromSnapshot(snapshot: TranscriptSnapshot | null | undefined): TranscriptBuilder | null {
    if (!snapshot || snapshot.version !== SNAPSHOT_VERSION) return null;
    if (typeof snapshot.sessionId !== "string" || !Array.isArray(snapshot.items)) return null;
    const builder = new TranscriptBuilder(
      snapshot.sessionId,
      typeof snapshot.cwd === "string" ? snapshot.cwd : "",
      typeof snapshot.createdAt === "number" ? snapshot.createdAt : Date.now(),
    );
    for (const item of snapshot.items) {
      if (!isItem(item)) continue;
      if (item.type === "assistant") item.done = true;
      builder.items.push(item);
      if (item.type === "assistant" && item.messageId) {
        builder.assistantsByMessage.set(item.messageId, item);
      }
      if (item.type === "tool") builder.toolsByCall.set(item.toolCallId, item);
    }
    if (
      snapshot.usage &&
      typeof snapshot.usage.used === "number" &&
      typeof snapshot.usage.size === "number"
    ) {
      builder.usage = { used: snapshot.usage.used, size: snapshot.usage.size };
    }
    return builder;
  }

  private assistantFor(messageId: string | undefined): AssistantItem {
    const key = messageId ?? `__draft_${++this.draftCounter}`;
    const existing = this.assistantsByMessage.get(key);
    if (existing) return existing;
    const item: AssistantItem = {
      id: randomUUID(),
      type: "assistant",
      messageId: messageId ?? null,
      thoughts: [],
      blocks: [],
      at: Date.now(),
      done: false,
    };
    this.assistantsByMessage.set(key, item);
    this.items.push(item);
    return item;
  }

  private toolFor(update: AcpSessionUpdate): ToolItem {
    const toolCallId = typeof update.toolCallId === "string" && update.toolCallId.length > 0
      ? update.toolCallId
      : `tool-${this.items.length}`;
    const existing = this.toolsByCall.get(toolCallId);
    if (existing) return existing;
    const item: ToolItem = {
      id: randomUUID(),
      type: "tool",
      toolCallId,
      title: typeof update.title === "string" && update.title.length > 0 ? update.title : toolCallId,
      kind: typeof update.kind === "string" ? update.kind : "other",
      status: typeof update.status === "string" ? update.status : "in_progress",
      rawInput: update.rawInput,
      content: [],
      at: Date.now(),
    };
    this.toolsByCall.set(toolCallId, item);
    this.items.push(item);
    return item;
  }
}
