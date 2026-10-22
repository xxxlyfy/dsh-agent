import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { AcpRpcError, JsonRpcTransport } from "../src/acp/transport.ts";

function makeTransport() {
  const input = new PassThrough();
  const output = new PassThrough();
  const transport = new JsonRpcTransport({ input, output });
  return { transport, input, output };
}

function readFrame(stream) {
  return new Promise((resolve) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      stream.off("data", onData);
      resolve(JSON.parse(buffer.slice(0, newline)));
    };
    stream.on("data", onData);
  });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

test("correlates responses with requests and tolerates split chunks", async () => {
  const { transport, input, output } = makeTransport();
  const pending = transport.request("session/list", { cwd: "/vault" });
  const frame = await readFrame(output);
  assert.equal(frame.jsonrpc, "2.0");
  assert.equal(frame.method, "session/list");
  assert.deepEqual(frame.params, { cwd: "/vault" });

  const payload = JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { sessions: [] } });
  input.write(payload.slice(0, 12));
  input.write(`${payload.slice(12)}\n`);
  assert.deepEqual(await pending, { sessions: [] });
});

test("dispatches notifications to registered handlers", async () => {
  const { transport, input } = makeTransport();
  const seen = [];
  const dispose = transport.onNotification((method, params) => seen.push({ method, params }));
  input.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      method: "session/update",
      params: { sessionId: "s", update: { sessionUpdate: "usage_update", used: 1, size: 2 } },
    })}\n`,
  );
  await tick();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].method, "session/update");
  dispose();
  input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "other", params: {} })}\n`);
  await tick();
  assert.equal(seen.length, 1);
});

test("rejects with the JSON-RPC error code and message", async () => {
  const { transport, input, output } = makeTransport();
  const pending = transport.request("session/prompt", {});
  const frame = await readFrame(output);
  input.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: frame.id,
      error: { code: -32602, message: "invalid params", data: { field: "cwd" } },
    })}\n`,
  );
  await assert.rejects(pending, (error) => {
    assert.ok(error instanceof AcpRpcError);
    assert.equal(error.code, -32602);
    assert.equal(error.message, "invalid params");
    assert.deepEqual(error.data, { field: "cwd" });
    return true;
  });
});

test("times out requests that never receive a response", async () => {
  const { transport } = makeTransport();
  await assert.rejects(
    transport.request("session/prompt", {}, { timeoutMs: 20 }),
    (error) => error instanceof AcpRpcError && error.code === -32001,
  );
});

test("answers unknown server requests with -32601 and handles known ones", async () => {
  const { transport, input, output } = makeTransport();

  const unknown = readFrame(output);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 9, method: "io/unknown", params: {} })}\n`);
  const unknownResponse = await unknown;
  assert.equal(unknownResponse.id, 9);
  assert.equal(unknownResponse.error.code, -32601);

  transport.setServerRequestHandler(async (method) => {
    assert.equal(method, "session/request_permission");
    return { outcome: { outcome: "cancelled" } };
  });
  const known = readFrame(output);
  input.write(
    `${JSON.stringify({ jsonrpc: "2.0", id: 10, method: "session/request_permission", params: {} })}\n`,
  );
  const knownResponse = await known;
  assert.deepEqual(knownResponse.result, { outcome: { outcome: "cancelled" } });
});

test("rejects pending requests when disposed", async () => {
  const { transport } = makeTransport();
  const pending = transport.request("session/list", {});
  await tick();
  transport.dispose();
  await assert.rejects(pending, (error) => error instanceof AcpRpcError && error.code === -32000);
  assert.equal(transport.isDisposed, true);
  await assert.rejects(
    transport.request("session/list", {}),
    (error) => error instanceof AcpRpcError && error.code === -32000,
  );
});

test("ignores non-JSON stdout noise", async () => {
  const { transport, input, output } = makeTransport();
  input.write("Warning: something happened\n");
  const pending = transport.request("session/list", {});
  const frame = await readFrame(output);
  input.write(`${JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: {} })}\n`);
  assert.deepEqual(await pending, {});
});
