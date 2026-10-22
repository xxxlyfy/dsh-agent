import test from "node:test";
import assert from "node:assert/strict";
import { TranscriptBuilder } from "../src/transcript.ts";

function textUpdate(kind, messageId, text) {
  return { sessionUpdate: kind, messageId, content: { type: "text", text } };
}

test("maps assistant thoughts, message blocks, tools and usage", () => {
  const builder = new TranscriptBuilder("s1", "/vault", 1000);
  builder.addUser("hello", { notePath: "notes/a.md", hasSelection: true });

  assert.equal(builder.applyUpdate(textUpdate("agent_thought_chunk", "m1", "thinking")).changed, true);
  assert.equal(builder.applyUpdate(textUpdate("agent_message_chunk", "m1", "Hello")).changed, true);
  assert.equal(builder.applyUpdate(textUpdate("agent_message_chunk", "m1", "world")).changed, true);
  assert.equal(
    builder.applyUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "call-1",
      title: "bash",
      kind: "other",
      status: "in_progress",
      rawInput: { command: "ls" },
    }).changed,
    true,
  );
  assert.equal(
    builder.applyUpdate({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-1",
      status: "completed",
      content: [
        { type: "content", content: { type: "text", text: "a.txt" } },
        { type: "diff", path: "a.md", oldText: "old", newText: "new" },
      ],
    }).changed,
    true,
  );
  assert.equal(builder.applyUpdate({ sessionUpdate: "usage_update", used: 10, size: 100 }).changed, true);
  assert.equal(builder.applyUpdate({ sessionUpdate: "unexpected/update" }).changed, false);

  const items = builder.all;
  assert.equal(items.length, 3);
  assert.equal(items[0].type, "user");
  assert.equal(items[0].notePath, "notes/a.md");
  assert.equal(items[0].hasSelection, true);

  const assistant = items[1];
  assert.equal(assistant.type, "assistant");
  assert.deepEqual(assistant.thoughts, ["thinking"]);
  assert.deepEqual(assistant.blocks, ["Hello", "world"]);
  assert.equal(assistant.done, false);

  const tool = items[2];
  assert.equal(tool.type, "tool");
  assert.equal(tool.status, "completed");
  assert.deepEqual(tool.content[0], "a.txt");
  assert.match(tool.content[1], /^--- a\.md\nold\n\+\+\+ new$/u);

  builder.markAssistantDone();
  assert.equal(builder.all[1].done, true);
  assert.deepEqual(builder.getUsage(), { used: 10, size: 100 });
});

test("keeps one assistant item per message id and one tool item per call id", () => {
  const builder = new TranscriptBuilder("s1", "/vault");
  builder.applyUpdate(textUpdate("agent_message_chunk", "m1", "a"));
  builder.applyUpdate(textUpdate("agent_message_chunk", "m2", "b"));
  builder.applyUpdate({ sessionUpdate: "tool_call", toolCallId: "c", title: "t" });
  builder.applyUpdate({ sessionUpdate: "tool_call", toolCallId: "c", title: "t2" });
  assert.equal(builder.all.filter((item) => item.type === "assistant").length, 2);
  assert.equal(builder.all.filter((item) => item.type === "tool").length, 1);
  assert.equal(builder.all.find((item) => item.type === "tool").title, "t2");
});

test("records permission items and decisions", () => {
  const builder = new TranscriptBuilder("s1", "/vault");
  const item = builder.addPermission({
    sessionId: "s1",
    toolCall: { toolCallId: "call-9" },
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ],
  });
  assert.equal(item.decision, null);
  builder.decidePermission(item.id, "allowed");
  assert.equal(builder.all[0].decision, "allowed");
  assert.equal(builder.decidePermission("missing", "rejected"), null);

  const fallback = builder.addPermission({ sessionId: "s1" });
  assert.equal(fallback.options.length, 2);
  assert.equal(fallback.toolCallId, null);
});

test("round-trips through snapshots and tolerates garbage", () => {
  const builder = new TranscriptBuilder("s1", "/vault", 500);
  builder.addUser("hello");
  builder.addNotice("warn", "careful");
  builder.applyUpdate(textUpdate("agent_message_chunk", "m1", "answer"));
  builder.applyUpdate({ sessionUpdate: "usage_update", used: 3, size: 30 });
  builder.markAssistantDone();

  const snapshot = builder.snapshot();
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.sessionId, "s1");
  assert.equal(snapshot.createdAt, 500);

  const restored = TranscriptBuilder.fromSnapshot(snapshot);
  assert.ok(restored);
  assert.equal(restored.all.length, 3);
  assert.deepEqual(restored.getUsage(), { used: 3, size: 30 });

  assert.equal(TranscriptBuilder.fromSnapshot(null), null);
  assert.equal(TranscriptBuilder.fromSnapshot({ ...snapshot, version: 2 }), null);
  assert.equal(TranscriptBuilder.fromSnapshot({ ...snapshot, items: "nope" }), null);
  const filtered = TranscriptBuilder.fromSnapshot({
    ...snapshot,
    items: [snapshot.items[0], { type: "bogus" }, null],
  });
  assert.equal(filtered.all.length, 1);

  const unfinished = TranscriptBuilder.fromSnapshot({
    ...snapshot,
    items: [
      ...snapshot.items,
      {
        id: "unfinished",
        type: "assistant",
        messageId: "m2",
        thoughts: [],
        blocks: [],
        at: 1,
        done: false,
      },
    ],
  });
  assert.equal(unfinished.all.at(-1).done, true);

  const malformed = TranscriptBuilder.fromSnapshot({
    ...snapshot,
    items: [
      {
        id: "bad-assistant",
        type: "assistant",
        messageId: "m3",
        thoughts: "not an array",
        blocks: [],
        at: 1,
        done: false,
      },
    ],
  });
  assert.equal(malformed.all.length, 0);
});
