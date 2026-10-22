import test from "node:test";
import assert from "node:assert/strict";
import {
  buildContext,
  buildResourceLink,
  composePrompt,
  truncateText,
} from "../src/context.ts";

const base = {
  notePath: "notes/ideas.md",
  selection: "selected text",
  content: "full note text",
  includeSelection: true,
  includeActiveNote: true,
  maxChars: 8000,
};

test("prefers the selection when enabled", () => {
  const context = buildContext(base);
  assert.ok(context);
  assert.equal(context.usedSelection, true);
  assert.equal(context.truncated, false);
  assert.match(context.text, /note: notes\/ideas\.md/u);
  assert.match(context.text, /selection: yes/u);
  assert.match(context.text, /selected text/u);
  assert.doesNotMatch(context.text, /full note text/u);
});

test("falls back to the note content without a selection", () => {
  const context = buildContext({ ...base, selection: "   " });
  assert.ok(context);
  assert.equal(context.usedSelection, false);
  assert.match(context.text, /selection: no/u);
  assert.match(context.text, /full note text/u);
});

test("respects the include flags and missing note", () => {
  assert.equal(buildContext({ ...base, includeSelection: false, includeActiveNote: false }), null);
  assert.equal(buildContext({ ...base, notePath: null }), null);
  assert.equal(buildContext({ ...base, selection: "", content: "" }), null);
  assert.ok(buildContext({ ...base, includeSelection: false }));
});

test("truncates long content", () => {
  const long = "x".repeat(1200);
  const context = buildContext({ ...base, selection: "", content: long, maxChars: 600 });
  assert.ok(context);
  assert.equal(context.truncated, true);
  assert.match(context.text, /\[truncated\]/u);

  const short = truncateText("abc", 10);
  assert.deepEqual(short, { text: "abc", truncated: false });
  // The minimum clamp keeps a usable window.
  const clamped = truncateText("y".repeat(900), 1);
  assert.equal(clamped.truncated, true);
  assert.match(clamped.text, /\[truncated\]/u);
});

test("composes the prompt with context first", () => {
  const context = buildContext(base);
  const prompt = composePrompt("what is this?", context);
  assert.ok(prompt.startsWith("<obsidian_context>"));
  assert.ok(prompt.endsWith("what is this?"));
  assert.equal(composePrompt("plain", null), "plain");
});

test("builds an encoded file resource link", () => {
  const link = buildResourceLink("C:\\Vault\\笔记 一.md", "笔记 一.md");
  assert.equal(link.type, "resource_link");
  assert.equal(link.name, "笔记 一.md");
  assert.match(link.uri, /^file:\/\/\//u);
  assert.match(link.uri, /%20/u);
});
