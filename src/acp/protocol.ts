/**
 * ACP v1 wire types and helpers used by this plugin.
 *
 * The Agent Client Protocol is a JSON-RPC 2.0 protocol carried over
 * newline-delimited JSON on stdio. We implement only the subset DeepSeek
 * Harness exposes through `dsh acp` (ACP v1).
 */

export const ACP_PROTOCOL_VERSION = 1;

export type AcpStopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled"
  | string;

export interface AcpTextBlock {
  type: "text";
  text: string;
}

export interface AcpResourceLinkBlock {
  type: "resource_link";
  uri: string;
  name: string;
  mimeType?: string;
}

/** Blocks this plugin sends. Images and embedded resources are unsupported. */
export type AcpPromptBlock = AcpTextBlock | AcpResourceLinkBlock;

export interface AcpSelectOption {
  value: string;
  name: string;
  description?: string;
}

/** DeepSeek Harness groups model choices by provider. */
export interface AcpSelectGroup {
  group?: string;
  name: string;
  options: AcpSelectOption[];
}

export interface AcpConfigOption {
  id: string;
  name: string;
  description?: string;
  category?: string;
  type: string;
  /** Opaque selector value supplied by the agent. */
  currentValue?: string;
  options?: Array<AcpSelectOption | AcpSelectGroup>;
}

export interface AcpInitializeResult {
  protocolVersion: number;
  agentInfo?: { name?: string; version?: string };
  agentCapabilities?: {
    loadSession?: boolean;
    mcpCapabilities?: { http?: boolean };
    promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
    sessionCapabilities?: { close?: unknown; list?: unknown; resume?: unknown };
  };
  authMethods?: unknown[];
}

export interface AcpSessionNewResult {
  sessionId: string;
  configOptions?: AcpConfigOption[];
}

export interface AcpSessionListEntry {
  sessionId: string;
  cwd?: string;
}

export interface AcpSessionListResult {
  sessions?: AcpSessionListEntry[];
  nextCursor?: string;
}

export interface AcpPromptResult {
  stopReason?: AcpStopReason;
}

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

export interface AcpPermissionRequest {
  sessionId: string;
  toolCall?: { toolCallId?: string };
  options?: AcpPermissionOption[];
}

export type AcpPermissionOutcome =
  | { outcome: { outcome: "selected"; optionId: string } }
  | { outcome: { outcome: "cancelled" } };

export interface AcpContentLike {
  type?: string;
  text?: string;
  name?: string;
  uri?: string;
  [key: string]: unknown;
}

/** A `session/update` payload; individual variants stay loosely typed. */
export interface AcpSessionUpdate {
  sessionUpdate: string;
  messageId?: string;
  content?: AcpContentLike;
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  used?: number;
  size?: number;
  configOptions?: AcpConfigOption[];
  [key: string]: unknown;
}

export interface AcpSessionUpdateParams {
  sessionId: string;
  update?: AcpSessionUpdate;
}

/** Extract plain text from an assistant content block, ignoring non-text ones. */
export function textOfContent(content: unknown): string | null {
  if (!content || typeof content !== "object") return null;
  const block = content as AcpContentLike;
  if (block.type !== "text") return null;
  return typeof block.text === "string" ? block.text : null;
}

/** Flatten a select option that may be grouped, for validation and lookup. */
export function selectOptionValues(option: AcpConfigOption): string[] {
  const values: string[] = [];
  for (const entry of option.options ?? []) {
    if (!entry || typeof entry !== "object") continue;
    if (Array.isArray((entry as AcpSelectGroup).options)) {
      for (const child of (entry as AcpSelectGroup).options) {
        if (child && typeof child.value === "string") values.push(child.value);
      }
    } else if (typeof (entry as AcpSelectOption).value === "string") {
      values.push((entry as AcpSelectOption).value);
    }
  }
  return values;
}

/** Human-readable fallback for an opaque selector value. */
export function prettySelectorValue(value: string | undefined): string {
  if (!value) return "";
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.length === 2) {
      return `${String(parsed[0])} / ${String(parsed[1])}`;
    }
  } catch {
    // Not a JSON selector value: the agent already supplied a readable string.
  }
  return value;
}

/** Validate a raw config-option array from the wire. */
export function normalizeConfigOptions(value: unknown): AcpConfigOption[] {
  if (!Array.isArray(value)) return [];
  const out: AcpConfigOption[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const option = entry as AcpConfigOption;
    if (typeof option.id !== "string" || typeof option.name !== "string") continue;
    out.push({
      ...option,
      options: Array.isArray(option.options) ? option.options : [],
    });
  }
  return out;
}
