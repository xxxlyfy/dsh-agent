import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { AcpClient } from "../src/acp/client.ts";
import { createMockAgent } from "./mock-agent.mjs";

function connect(permissionOutcome) {
  const toAgent = new PassThrough();
  const toClient = new PassThrough();
  const agent = createMockAgent({ input: toAgent, output: toClient });
  const updates = [];
  const permissions = [];
  const client = new AcpClient({
    input: toClient,
    output: toAgent,
    clientName: "test-client",
    clientVersion: "0.0.0",
    onUpdate: (params) => updates.push(params),
    onPermission: async (request) => {
      const outcome = permissionOutcome ?? {
        outcome: { outcome: "selected", optionId: "allow-once" },
      };
      permissions.push({ request, outcome });
      return outcome;
    },
  });
  return { client, agent, updates, permissions };
}

test("initializes and creates a session with config options", async () => {
  const { client } = connect();
  const init = await client.initialize();
  assert.equal(init.protocolVersion, 1);
  assert.equal(init.agentInfo.name, "mock-agent");
  assert.deepEqual(client.sessionCapabilities, { close: true, list: true, resume: true });

  const session = await client.newSession("/vault", []);
  assert.equal(session.sessionId, "mock-session");
  assert.equal(session.configOptions.length, 2);
  const model = session.configOptions.find((option) => option.id === "model");
  assert.equal(model.currentValue, "model-a");
  assert.equal(model.options[0].group, "provider-a");
});

test("streams session updates and answers permission requests", async () => {
  const { client, agent, updates, permissions } = connect();
  await client.initialize();
  await client.newSession("/vault", []);
  const result = await client.prompt("mock-session", [{ type: "text", text: "hi" }]);

  assert.equal(result.stopReason, "end_turn");
  assert.equal(permissions.length, 1);
  assert.equal(permissions[0].request.toolCall.toolCallId, "call-1");
  assert.deepEqual(permissions[0].outcome, {
    outcome: { outcome: "selected", optionId: "allow-once" },
  });
  assert.deepEqual(
    updates.map((entry) => entry.update.sessionUpdate),
    [
      "agent_thought_chunk",
      "agent_message_chunk",
      "agent_message_chunk",
      "tool_call",
      "tool_call_update",
      "usage_update",
    ],
  );
  assert.equal(updates[0].sessionId, "mock-session");
  assert.deepEqual(agent.state.prompts[0], [{ type: "text", text: "hi" }]);
  assert.equal(agent.state.permissions.length, 1);
});

test("forwards a cancelled permission outcome", async () => {
  const { client, permissions } = connect({ outcome: { outcome: "cancelled" } });
  await client.initialize();
  await client.newSession("/vault", []);
  const result = await client.prompt("mock-session", [{ type: "text", text: "hi" }]);
  assert.equal(result.stopReason, "end_turn");
  assert.deepEqual(permissions[0].outcome, { outcome: { outcome: "cancelled" } });
});

test("cancels an in-flight prompt", async () => {
  // A never-resolving permission keeps the prompt in flight until cancel.
  const { client } = connect(new Promise(() => undefined));
  await client.initialize();
  await client.newSession("/vault", []);
  const pending = client.prompt("mock-session", [{ type: "text", text: "long task" }]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  client.cancel("mock-session");
  const result = await pending;
  assert.equal(result.stopReason, "cancelled");
});

test("changes configuration, lists, resumes and closes sessions", async () => {
  const { client, agent } = connect();
  await client.initialize();
  await client.newSession("/vault", []);

  const options = await client.setConfigOption("mock-session", "model", "model-b");
  const model = options.find((option) => option.id === "model");
  assert.equal(model.currentValue, "model-b");

  const list = await client.listSessions("/vault");
  assert.equal(list.sessions.length, 2);

  const resumed = await client.resumeSession("mock-session", "/vault", []);
  assert.equal(resumed.length, 2);
  await client.closeSession("mock-session");
  assert.equal(agent.state.resumeCount, 1);
  assert.equal(agent.state.closeCount, 1);
});
