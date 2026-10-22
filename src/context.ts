/**
 * Builds the Obsidian note context prepended to a user prompt.
 * Pure functions only, so it is unit-testable.
 */
import { pathToFileURL } from "node:url";
import type { AcpResourceLinkBlock } from "./acp/protocol.ts";

export interface ContextInput {
  notePath: string | null;
  selection: string;
  content: string | null;
  includeSelection: boolean;
  includeActiveNote: boolean;
  maxChars: number;
}

export interface BuiltContext {
  text: string;
  notePath: string;
  usedSelection: boolean;
  truncated: boolean;
}

const TRUNCATION_SUFFIX = "\n…[truncated]";

function clampChars(value: number): number {
  if (!Number.isFinite(value)) return 8000;
  return Math.max(500, Math.min(200_000, Math.floor(value)));
}

export function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  const limit = clampChars(maxChars);
  if (text.length <= limit) return { text, truncated: false };
  return { text: `${text.slice(0, limit)}${TRUNCATION_SUFFIX}`, truncated: true };
}

export function buildContext(input: ContextInput): BuiltContext | null {
  const notePath = input.notePath?.trim();
  if (!notePath) return null;

  const selection = input.selection ?? "";
  const useSelection = input.includeSelection && selection.trim().length > 0;
  if (!useSelection && !input.includeActiveNote) return null;

  const body = useSelection ? selection : input.content;
  if (body === null || body.trim().length === 0) return null;

  const limited = truncateText(body, input.maxChars);
  const text = [
    "<obsidian_context>",
    `note: ${notePath}`,
    `selection: ${useSelection ? "yes" : "no"}`,
    "---",
    limited.text,
    "</obsidian_context>",
  ].join("\n");

  return {
    text,
    notePath,
    usedSelection: useSelection,
    truncated: limited.truncated,
  };
}

export function composePrompt(userText: string, context: BuiltContext | null): string {
  if (!context) return userText;
  return `${context.text}\n\n${userText}`;
}

export function buildResourceLink(absolutePath: string, name: string): AcpResourceLinkBlock {
  return { type: "resource_link", uri: pathToFileURL(absolutePath).href, name };
}
