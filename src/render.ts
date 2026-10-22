/**
 * Rendering helpers: Markdown through Obsidian's renderer plus small text
 * formatters shared by the chat view.
 */
import { MarkdownRenderer, type App, type Component } from "obsidian";
import type { I18n } from "./i18n.ts";
import type { AssistantItem, PermissionDecision, ToolItem, TranscriptUsage } from "./transcript.ts";

const MAX_TOOL_INPUT_CHARS = 6000;
const MAX_TOOL_RESULT_CHARS = 12000;

export async function fillMarkdown(
  app: App,
  target: HTMLElement,
  markdown: string,
  sourcePath: string,
  component: Component,
): Promise<void> {
  const scratch = document.createElement("div");
  scratch.className = "markdown-rendered";
  try {
    await MarkdownRenderer.render(app, markdown, scratch, sourcePath, component);
  } catch {
    const pre = document.createElement("pre");
    pre.textContent = markdown;
    scratch.appendChild(pre);
  }
  target.empty();
  while (scratch.firstChild) target.appendChild(scratch.firstChild);
}

export function assistantText(item: AssistantItem): string {
  return item.blocks
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .join("\n\n");
}

export function thoughtText(item: AssistantItem): string {
  return item.thoughts
    .map((block) => block.trim())
    .filter((block) => block.length > 0)
    .join("\n\n");
}

export function toolInputText(item: ToolItem): string {
  if (item.rawInput === undefined || item.rawInput === null) return "";
  try {
    const text = typeof item.rawInput === "string"
      ? item.rawInput
      : JSON.stringify(item.rawInput, null, 2);
    return text.length > MAX_TOOL_INPUT_CHARS ? `${text.slice(0, MAX_TOOL_INPUT_CHARS)}\n…` : text;
  } catch {
    return String(item.rawInput);
  }
}

export function toolResultText(item: ToolItem): string {
  const text = item.content.join("\n\n").trim();
  return text.length > MAX_TOOL_RESULT_CHARS ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n…` : text;
}

export function toolStatusLabel(i18n: I18n, status: string): string {
  switch (status) {
    case "completed":
      return i18n.t("tool.completed");
    case "failed":
      return i18n.t("tool.failed");
    case "in_progress":
      return i18n.t("tool.running");
    default:
      return status;
  }
}

export function decisionLabel(i18n: I18n, decision: PermissionDecision): string {
  switch (decision) {
    case "allowed":
      return i18n.t("permission.allowed");
    case "rejected":
      return i18n.t("permission.rejected");
    case "auto":
      return i18n.t("permission.auto");
    default:
      return i18n.t("permission.cancelled");
  }
}

export function formatCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(Math.round(value));
}

export function usageLabel(i18n: I18n, usage: TranscriptUsage | null): string {
  if (!usage) return i18n.t("footer.noUsage");
  return i18n.t("footer.usage", {
    used: formatCount(usage.used),
    size: formatCount(usage.size),
  });
}
