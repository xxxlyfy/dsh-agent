/**
 * In-process mock ACP agent used by the client integration tests.
 *
 * It speaks newline-delimited JSON-RPC over two PassThrough streams, so tests
 * never need to spawn a child process.
 */
export function createMockAgent({ input, output, sessionId = "mock-session" }) {
  const state = {
    requests: [],
    prompts: [],
    permissions: [],
    cancelled: false,
    model: "model-a",
    effort: "",
    closeCount: 0,
    resumeCount: 0,
  };

  let buffer = "";
  let serverRequestId = 1;
  const pendingServerRequests = new Map();
  let activePrompt = null;

  function configOptions(model = state.model, effort = state.effort) {
    return [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: model,
        options: [
          {
            group: "provider-a",
            name: "Provider A",
            options: [
              { value: "model-a", name: "Model A" },
              { value: "model-b", name: "Model B" },
            ],
          },
        ],
      },
      {
        id: "reasoning_effort",
        name: "Reasoning effort",
        category: "thought_level",
        type: "select",
        currentValue: effort,
        options: [
          { value: "", name: "Provider default" },
          { value: "high", name: "High" },
        ],
      },
    ];
  }

  function send(frame) {
    output.write(`${JSON.stringify(frame)}\n`);
  }

  function reply(id, result) {
    send({ jsonrpc: "2.0", id, result });
  }

  function fail(id, code, message) {
    send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  function notify(method, params) {
    send({ jsonrpc: "2.0", method, params });
  }

  function serverRequest(method, params) {
    const id = `srv-${serverRequestId++}`;
    send({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      pendingServerRequests.set(id, { resolve, reject });
    });
  }

  function update(sid, payload) {
    notify("session/update", { sessionId: sid, update: payload });
  }

  async function handlePrompt(frame) {
    const sid = frame.params.sessionId;
    state.prompts.push(frame.params.prompt);
    activePrompt = { id: frame.id };
    update(sid, {
      sessionUpdate: "agent_thought_chunk",
      messageId: "msg-1",
      content: { type: "text", text: "thinking about it" },
    });
    update(sid, {
      sessionUpdate: "agent_message_chunk",
      messageId: "msg-1",
      content: { type: "text", text: "Hello " },
    });
    update(sid, {
      sessionUpdate: "agent_message_chunk",
      messageId: "msg-1",
      content: { type: "text", text: "world" },
    });
    update(sid, {
      sessionUpdate: "tool_call",
      toolCallId: "call-1",
      title: "bash",
      kind: "other",
      status: "in_progress",
      rawInput: { command: "ls" },
    });
    const outcome = await serverRequest("session/request_permission", {
      sessionId: sid,
      toolCall: { toolCallId: "call-1" },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    });
    state.permissions.push(outcome);
    if (state.cancelled) {
      state.cancelled = false;
      activePrompt = null;
      return;
    }
    update(sid, {
      sessionUpdate: "tool_call_update",
      toolCallId: "call-1",
      status: "completed",
      content: [{ type: "content", content: { type: "text", text: "file.txt" } }],
    });
    update(sid, { sessionUpdate: "usage_update", used: 120, size: 1000 });
    activePrompt = null;
    reply(frame.id, { stopReason: "end_turn" });
  }

  async function handleRequest(frame) {
    state.requests.push(frame.method);
    switch (frame.method) {
      case "initialize":
        return reply(frame.id, {
          protocolVersion: 1,
          agentInfo: { name: "mock-agent", version: "0.0.1" },
          agentCapabilities: { sessionCapabilities: { close: {}, list: {}, resume: {} } },
        });
      case "session/new":
        return reply(frame.id, { sessionId, configOptions: configOptions() });
      case "session/resume":
        state.resumeCount += 1;
        return reply(frame.id, { configOptions: configOptions() });
      case "session/list":
        return reply(frame.id, {
          sessions: [
            { sessionId: "other-1", cwd: "/vault" },
            { sessionId: "other-2", cwd: "/elsewhere" },
          ],
        });
      case "session/close":
        state.closeCount += 1;
        return reply(frame.id, {});
      case "session/set_config_option": {
        if (frame.params.configId === "model") state.model = frame.params.value;
        if (frame.params.configId === "reasoning_effort") state.effort = frame.params.value;
        return reply(frame.id, { configOptions: configOptions() });
      }
      case "session/prompt":
        return await handlePrompt(frame);
      default:
        return fail(frame.id, -32601, `unknown method ${frame.method}`);
    }
  }

  function handleNotification(frame) {
    if (frame.method !== "session/cancel") return;
    state.cancelled = true;
    for (const [id, pending] of pendingServerRequests) {
      pending.resolve({ outcome: { outcome: "cancelled" } });
      pendingServerRequests.delete(id);
    }
    if (activePrompt) {
      const prompt = activePrompt;
      activePrompt = null;
      reply(prompt.id, { stopReason: "cancelled" });
    }
  }

  function handleLine(line) {
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    if (frame.method !== undefined && frame.id !== undefined) {
      void handleRequest(frame);
      return;
    }
    if (frame.method !== undefined) {
      handleNotification(frame);
      return;
    }
    const pending = pendingServerRequests.get(frame.id);
    if (!pending) return;
    pendingServerRequests.delete(frame.id);
    if (frame.error) pending.reject(new Error(frame.error.message));
    else pending.resolve(frame.result);
  }

  input.on("data", (chunk) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line.trim().length > 0) handleLine(line);
      newline = buffer.indexOf("\n");
    }
  });

  return { state, configOptions };
}
