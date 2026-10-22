import test from "node:test";
import assert from "node:assert/strict";
import { SessionController } from "../src/session.ts";
import { TranscriptBuilder } from "../src/transcript.ts";

function configOptions(model = "model-a") {
  return [
    {
      id: "model",
      name: "Model",
      type: "select",
      currentValue: model,
      options: [
        { value: "model-a", name: "A" },
        { value: "model-b", name: "B" },
      ],
    },
    {
      id: "reasoning_effort",
      name: "Effort",
      type: "select",
      currentValue: "",
      options: [
        { value: "", name: "Default" },
        { value: "high", name: "High" },
      ],
    },
  ];
}

function makeHarness(overrides = {}) {
  const calls = {
    prompts: [],
    cancels: 0,
    closes: 0,
    config: [],
    metas: [],
    snapshots: [],
    remembered: [],
  };
  let resolvePrompt = null;
  let rejectPrompt = null;
  let autoApprove = false;

  const fake = {
    isDisposed: false,
    async newSession() {
      return { sessionId: "s1", configOptions: configOptions() };
    },
    async resumeSession() {
      return configOptions();
    },
    async setConfigOption(_sessionId, configId, value) {
      calls.config.push([configId, value]);
      return configOptions(configId === "model" ? value : undefined);
    },
    prompt(sessionId, blocks) {
      calls.prompts.push({ sessionId, blocks });
      return new Promise((resolve, reject) => {
        resolvePrompt = resolve;
        rejectPrompt = reject;
      });
    },
    cancel() {
      calls.cancels += 1;
    },
    async closeSession() {
      calls.closes += 1;
    },
  };

  const hooks = {
    cwd: "/vault",
    getAutoApprove: () => autoApprove,
    getMcpServers: () => [],
    getLastModelValue: () => "",
    getLastEffort: () => "",
    rememberConfig: (configId, value) => calls.remembered.push([configId, value]),
    t: (key) => key,
    persist: (snapshot) => calls.snapshots.push(snapshot),
    updateMeta: (meta) => calls.metas.push(meta),
    onChanged: () => undefined,
    ...overrides,
  };

  const controller = new SessionController(hooks);
  controller.setClient(fake);
  return {
    controller,
    fake,
    calls,
    resolvePrompt: (value) => resolvePrompt(value),
    rejectPrompt: (error) => rejectPrompt(error),
    setAutoApprove: (value) => {
      autoApprove = value;
    },
  };
}

test("creates a session, applies stored config and persists metadata", async () => {
  const harness = makeHarness();
  await harness.controller.startNew();
  const state = harness.controller.state;
  assert.equal(state.sessionId, "s1");
  assert.equal(state.attached, true);
  assert.equal(state.busy, false);
  assert.equal(state.configOptions.length, 2);
  assert.equal(harness.calls.metas.at(-1).id, "s1");
  assert.ok(harness.calls.snapshots.some((snapshot) => snapshot.sessionId === "s1"));
  assert.ok(harness.calls.remembered.some(([configId]) => configId === "model"));
});

test("sends a prompt, applies updates and finishes the turn", async () => {
  const harness = makeHarness();
  await harness.controller.startNew();
  const pending = harness.controller.send(
    "hello",
    [{ type: "text", text: "hello" }],
    { notePath: "notes/a.md", hasSelection: true },
  );
  assert.equal(harness.controller.state.busy, true);

  harness.controller.onUpdate({
    sessionId: "s1",
    update: {
      sessionUpdate: "agent_message_chunk",
      messageId: "m1",
      content: { type: "text", text: "hi there" },
    },
  });
  harness.resolvePrompt({ stopReason: "end_turn" });
  await pending;

  assert.equal(harness.controller.state.busy, false);
  const items = harness.controller.state.items;
  assert.equal(items[0].type, "user");
  assert.equal(items[0].text, "hello");
  assert.equal(items[1].type, "assistant");
  assert.deepEqual(items[1].blocks, ["hi there"]);
  assert.equal(items[1].done, true);
  assert.equal(harness.calls.prompts[0].sessionId, "s1");
  assert.deepEqual(harness.calls.prompts[0].blocks, [{ type: "text", text: "hello" }]);
});

test("rejects concurrent prompts", async () => {
  const harness = makeHarness();
  await harness.controller.startNew();
  const pending = harness.controller.send("one", [{ type: "text", text: "one" }]);
  await assert.rejects(
    harness.controller.send("two", [{ type: "text", text: "two" }]),
    /already in flight/u,
  );
  harness.resolvePrompt({ stopReason: "end_turn" });
  await pending;
});

test("reports prompt failures as an error notice", async () => {
  const harness = makeHarness();
  await harness.controller.startNew();
  const pending = harness.controller.send("boom", [{ type: "text", text: "boom" }]);
  harness.rejectPrompt(new Error("network down"));
  await pending;
  const notice = harness.controller.state.items.find((item) => item.type === "notice");
  assert.ok(notice);
  assert.equal(notice.level, "error");
  assert.equal(notice.text, "notice.promptFailed");
  assert.equal(harness.controller.state.busy, false);
});

test("resolves permission prompts with the allow or reject option", async () => {
  const harness = makeHarness();
  await harness.controller.startNew();
  const outcomePromise = harness.controller.onPermissionRequest({
    sessionId: "s1",
    toolCall: { toolCallId: "call-1" },
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ],
  });
  const pendingItem = harness.controller.state.items.find((item) => item.type === "permission");
  assert.ok(pendingItem);
  assert.equal(pendingItem.decision, null);
  assert.equal(harness.controller.resolvePermission(pendingItem.id, "allowed"), true);
  assert.deepEqual(await outcomePromise, {
    outcome: { outcome: "selected", optionId: "allow-once" },
  });
  assert.equal(
    harness.controller.state.items.find((item) => item.type === "permission").decision,
    "allowed",
  );
  assert.equal(harness.controller.resolvePermission(pendingItem.id, "rejected"), false);
});

test("respects the exact permission option the user clicked", async () => {
  const harness = makeHarness();
  await harness.controller.startNew();
  const options = [
    { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
    { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
    { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    { optionId: "reject-always", name: "Always reject", kind: "reject_always" },
  ];
  const first = harness.controller.onPermissionRequest({
    sessionId: "s1",
    toolCall: { toolCallId: "call-a" },
    options,
  });
  const firstItem = harness.controller.state.items.at(-1);
  assert.equal(firstItem.type, "permission");
  assert.equal(
    harness.controller.resolvePermission(firstItem.id, "allowed", "allow-always"),
    true,
  );
  assert.deepEqual(await first, {
    outcome: { outcome: "selected", optionId: "allow-always" },
  });

  const second = harness.controller.onPermissionRequest({
    sessionId: "s1",
    toolCall: { toolCallId: "call-b" },
    options,
  });
  const secondItem = harness.controller.state.items.at(-1);
  assert.equal(secondItem.type, "permission");
  assert.equal(
    harness.controller.resolvePermission(secondItem.id, "rejected", "reject-always"),
    true,
  );
  assert.deepEqual(await second, {
    outcome: { outcome: "selected", optionId: "reject-always" },
  });
});

test("auto-approves tool permissions when configured", async () => {
  const harness = makeHarness();
  harness.setAutoApprove(true);
  await harness.controller.startNew();
  const outcome = await harness.controller.onPermissionRequest({
    sessionId: "s1",
    toolCall: { toolCallId: "call-2" },
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ],
  });
  assert.deepEqual(outcome, { outcome: { outcome: "selected", optionId: "allow-once" } });
  const item = harness.controller.state.items.find((candidate) => candidate.type === "permission");
  assert.equal(item.decision, "auto");
});

test("cancels a running prompt and records the stop reason", async () => {
  const harness = makeHarness();
  await harness.controller.startNew();
  const pending = harness.controller.send("long", [{ type: "text", text: "long" }]);
  harness.controller.cancel();
  assert.equal(harness.calls.cancels, 1);
  harness.resolvePrompt({ stopReason: "cancelled" });
  await pending;
  const notices = harness.controller.state.items.filter((item) => item.type === "notice");
  assert.equal(notices.at(-1).text, "notice.cancelled");
});

test("cancels unanswered permissions when the UI hides or the runtime dies", async () => {
  const harness = makeHarness();
  await harness.controller.startNew();

  const first = harness.controller.onPermissionRequest({ sessionId: "s1" });
  harness.controller.cancelPendingForHiddenUi();
  assert.deepEqual(await first, { outcome: { outcome: "cancelled" } });

  const second = harness.controller.onPermissionRequest({ sessionId: "s1" });
  harness.controller.onRuntimeLost();
  assert.deepEqual(await second, { outcome: { outcome: "cancelled" } });
  assert.equal(harness.controller.isAttached, false);
});

test("resumes with a transcript and records configuration changes", async () => {
  const harness = makeHarness();
  const builder = new TranscriptBuilder("s1", "/vault", 10);
  builder.addUser("earlier");
  const snapshot = builder.snapshot();

  await harness.controller.resume("s1", snapshot, {
    id: "s1",
    title: "earlier",
    cwd: "/vault",
    createdAt: 10,
    updatedAt: 20,
  });
  assert.equal(harness.controller.state.sessionId, "s1");
  assert.equal(harness.controller.state.items[0].text, "earlier");
  assert.equal(harness.controller.state.items.length, 1);

  await harness.controller.setConfigOption("model", "model-b");
  assert.deepEqual(harness.calls.config.at(-1), ["model", "model-b"]);
  assert.deepEqual(harness.calls.remembered.at(-1), ["model", "model-b"]);
  assert.equal(
    harness.controller.state.configOptions.find((option) => option.id === "model").currentValue,
    "model-b",
  );

  await harness.controller.resume("s1", null, null);
  assert.equal(harness.controller.state.items.at(-1).text, "notice.historyUnavailable");
});

test("ignores updates and permissions from other sessions", async () => {
  const harness = makeHarness();
  await harness.controller.startNew();
  harness.controller.onUpdate({
    sessionId: "other",
    update: { sessionUpdate: "agent_message_chunk", messageId: "x", content: { type: "text", text: "nope" } },
  });
  assert.equal(harness.controller.state.items.length, 0);

  const outcome = await harness.controller.onPermissionRequest({ sessionId: "other" });
  assert.deepEqual(outcome, { outcome: { outcome: "cancelled" } });
});
