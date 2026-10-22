/*
 * DSH Agent for Obsidian - generated bundle.
 * Edit src/ and run `node scripts/build.mjs` (or `npm run build`).
 */
"use strict";
var __hostRequire =
  typeof require === "function"
    ? require
    : function () { throw new Error("require is unavailable in this context"); };
var __modules = [
function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AcpClient = void 0;
/**
 * Minimal ACP v1 client for DeepSeek Harness (`dsh acp`).
 *
 * Only the methods this plugin needs are implemented. Unknown server requests
 * are rejected and unknown notifications are ignored, so a newer runtime that
 * adds methods keeps working.
 */
const protocol_ts_1 = require("./protocol.ts");
const transport_ts_1 = require("./transport.ts");
const INITIALIZE_TIMEOUT_MS = 120_000;
const SESSION_TIMEOUT_MS = 120_000;
const CONTROL_TIMEOUT_MS = 30_000;
class AcpClient {
    transport;
    options;
    initialized = null;
    constructor(options) {
        this.options = options;
        this.transport = new transport_ts_1.JsonRpcTransport({
            input: options.input,
            output: options.output,
            onLog: options.onLog,
        });
        this.transport.setServerRequestHandler(async (method, params) => {
            if (method === "session/request_permission") {
                return this.options.onPermission(params);
            }
            throw new transport_ts_1.AcpRpcError(-32601, `unsupported client method: ${method}`);
        });
        this.transport.onNotification((method, params) => {
            if (method !== "session/update")
                return;
            if (!params || typeof params !== "object")
                return;
            this.options.onUpdate(params);
        });
    }
    get isDisposed() {
        return this.transport.isDisposed;
    }
    get sessionCapabilities() {
        const caps = this.initialized?.agentCapabilities?.sessionCapabilities;
        return {
            close: caps?.close !== undefined,
            list: caps?.list !== undefined,
            resume: caps?.resume !== undefined,
        };
    }
    async initialize() {
        const result = await this.transport.request("initialize", {
            protocolVersion: protocol_ts_1.ACP_PROTOCOL_VERSION,
            clientCapabilities: {
                fs: { readTextFile: false, writeTextFile: false },
                terminal: false,
            },
            clientInfo: {
                name: this.options.clientName,
                version: this.options.clientVersion,
            },
        }, { timeoutMs: INITIALIZE_TIMEOUT_MS });
        if (!result || typeof result !== "object" || typeof result.protocolVersion !== "number") {
            throw new transport_ts_1.AcpRpcError(-32003, "invalid initialize response from the ACP agent");
        }
        this.initialized = result;
        return result;
    }
    async newSession(cwd, mcpServers) {
        const result = await this.transport.request("session/new", { cwd, mcpServers }, { timeoutMs: SESSION_TIMEOUT_MS });
        if (!result || typeof result.sessionId !== "string" || result.sessionId.length === 0) {
            throw new transport_ts_1.AcpRpcError(-32003, "the ACP agent returned no session id");
        }
        return { sessionId: result.sessionId, configOptions: (0, protocol_ts_1.normalizeConfigOptions)(result.configOptions) };
    }
    async resumeSession(sessionId, cwd, mcpServers) {
        const result = await this.transport.request("session/resume", { sessionId, cwd, mcpServers }, { timeoutMs: SESSION_TIMEOUT_MS });
        return (0, protocol_ts_1.normalizeConfigOptions)(result?.configOptions);
    }
    async listSessions(cwd, cursor) {
        const params = {};
        if (cwd)
            params.cwd = cwd;
        if (cursor)
            params.cursor = cursor;
        return await this.transport.request("session/list", params, {
            timeoutMs: CONTROL_TIMEOUT_MS,
        });
    }
    async setConfigOption(sessionId, configId, value) {
        const result = await this.transport.request("session/set_config_option", { sessionId, configId, value }, { timeoutMs: CONTROL_TIMEOUT_MS });
        return (0, protocol_ts_1.normalizeConfigOptions)(result?.configOptions);
    }
    async prompt(sessionId, prompt) {
        const result = await this.transport.request("session/prompt", {
            sessionId,
            prompt,
        });
        return result ?? { stopReason: "end_turn" };
    }
    cancel(sessionId) {
        this.transport.notify("session/cancel", { sessionId });
    }
    async closeSession(sessionId) {
        await this.transport.request("session/close", { sessionId }, { timeoutMs: CONTROL_TIMEOUT_MS });
    }
    dispose(reason) {
        this.transport.dispose(reason);
    }
}
exports.AcpClient = AcpClient;

},
function (module, exports, require) {
"use strict";
/**
 * ACP v1 wire types and helpers used by this plugin.
 *
 * The Agent Client Protocol is a JSON-RPC 2.0 protocol carried over
 * newline-delimited JSON on stdio. We implement only the subset DeepSeek
 * Harness exposes through `dsh acp` (ACP v1).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ACP_PROTOCOL_VERSION = void 0;
exports.textOfContent = textOfContent;
exports.selectOptionValues = selectOptionValues;
exports.prettySelectorValue = prettySelectorValue;
exports.normalizeConfigOptions = normalizeConfigOptions;
exports.ACP_PROTOCOL_VERSION = 1;
/** Extract plain text from an assistant content block, ignoring non-text ones. */
function textOfContent(content) {
    if (!content || typeof content !== "object")
        return null;
    const block = content;
    if (block.type !== "text")
        return null;
    return typeof block.text === "string" ? block.text : null;
}
/** Flatten a select option that may be grouped, for validation and lookup. */
function selectOptionValues(option) {
    const values = [];
    for (const entry of option.options ?? []) {
        if (!entry || typeof entry !== "object")
            continue;
        if (Array.isArray(entry.options)) {
            for (const child of entry.options) {
                if (child && typeof child.value === "string")
                    values.push(child.value);
            }
        }
        else if (typeof entry.value === "string") {
            values.push(entry.value);
        }
    }
    return values;
}
/** Human-readable fallback for an opaque selector value. */
function prettySelectorValue(value) {
    if (!value)
        return "";
    try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed) && parsed.length === 2) {
            return `${String(parsed[0])} / ${String(parsed[1])}`;
        }
    }
    catch {
        // Not a JSON selector value: the agent already supplied a readable string.
    }
    return value;
}
/** Validate a raw config-option array from the wire. */
function normalizeConfigOptions(value) {
    if (!Array.isArray(value))
        return [];
    const out = [];
    for (const entry of value) {
        if (!entry || typeof entry !== "object")
            continue;
        const option = entry;
        if (typeof option.id !== "string" || typeof option.name !== "string")
            continue;
        out.push({
            ...option,
            options: Array.isArray(option.options) ? option.options : [],
        });
    }
    return out;
}

},
function (module, exports, require) {
"use strict";
/**
 * Newline-delimited JSON-RPC 2.0 transport for ACP over a child process's stdio.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.JsonRpcTransport = exports.AcpRpcError = void 0;
class AcpRpcError extends Error {
    code;
    data;
    constructor(code, message, data) {
        super(message);
        this.name = "AcpRpcError";
        this.code = code;
        this.data = data;
    }
}
exports.AcpRpcError = AcpRpcError;
const MAX_LOG_CHARS = 4000;
function truncateForLog(value) {
    return value.length > MAX_LOG_CHARS ? `${value.slice(0, MAX_LOG_CHARS)}…[truncated]` : value;
}
class JsonRpcTransport {
    input;
    output;
    onLog;
    nextId = 1;
    buffer = "";
    disposed = false;
    disposeReason = null;
    pending = new Map();
    notificationHandlers = new Set();
    serverRequestHandler = null;
    handleData = (chunk) => {
        this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
        let newline = this.buffer.indexOf("\n");
        while (newline >= 0) {
            const line = this.buffer.slice(0, newline).replace(/\r$/, "");
            this.buffer = this.buffer.slice(newline + 1);
            if (line.trim().length > 0)
                this.handleLine(line);
            newline = this.buffer.indexOf("\n");
        }
    };
    handleEnd = () => {
        this.dispose(new AcpRpcError(-32000, "ACP connection closed"));
    };
    handleStreamError = (error) => {
        this.dispose(new AcpRpcError(-32000, `ACP transport error: ${error.message}`));
    };
    constructor(options) {
        this.input = options.input;
        this.output = options.output;
        this.onLog = options.onLog ?? (() => undefined);
        this.input.on("data", this.handleData);
        this.input.on("end", this.handleEnd);
        this.input.on("close", this.handleEnd);
        this.input.on("error", this.handleStreamError);
    }
    get isDisposed() {
        return this.disposed;
    }
    setServerRequestHandler(handler) {
        this.serverRequestHandler = handler;
    }
    onNotification(handler) {
        this.notificationHandlers.add(handler);
        return () => this.notificationHandlers.delete(handler);
    }
    request(method, params, options = {}) {
        if (this.disposed) {
            return Promise.reject(this.disposeReason ?? new AcpRpcError(-32000, "transport is closed"));
        }
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const pending = {
                method,
                resolve: (value) => resolve(value),
                reject,
            };
            if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
                pending.timer = setTimeout(() => {
                    this.pending.delete(id);
                    this.detachAbort(pending);
                    reject(new AcpRpcError(-32001, `request timed out after ${options.timeoutMs}ms: ${method}`));
                }, options.timeoutMs);
            }
            if (options.signal) {
                const signal = options.signal;
                const onAbort = () => {
                    this.pending.delete(id);
                    this.clearTimer(pending);
                    reject(new AcpRpcError(-32002, `request cancelled: ${method}`));
                };
                if (signal.aborted) {
                    this.clearTimer(pending);
                    reject(new AcpRpcError(-32002, `request cancelled: ${method}`));
                    return;
                }
                signal.addEventListener("abort", onAbort, { once: true });
                pending.detachAbort = () => signal.removeEventListener("abort", onAbort);
            }
            this.pending.set(id, pending);
            try {
                this.send({ jsonrpc: "2.0", id, method, params: params ?? {} });
            }
            catch (error) {
                this.pending.delete(id);
                this.clearTimer(pending);
                this.detachAbort(pending);
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    }
    notify(method, params) {
        if (this.disposed)
            return;
        try {
            this.send({ jsonrpc: "2.0", method, params: params ?? {} });
        }
        catch (error) {
            this.onLog({ direction: "error", text: `failed to send ${method}: ${String(error)}` });
        }
    }
    dispose(reason) {
        if (this.disposed)
            return;
        this.disposed = true;
        this.disposeReason = reason ?? new AcpRpcError(-32000, "transport disposed");
        this.input.removeListener("data", this.handleData);
        this.input.removeListener("end", this.handleEnd);
        this.input.removeListener("close", this.handleEnd);
        this.input.removeListener("error", this.handleStreamError);
        for (const [id, pending] of this.pending) {
            this.clearTimer(pending);
            this.detachAbort(pending);
            pending.reject(this.disposeReason);
            this.pending.delete(id);
        }
        this.notificationHandlers.clear();
        this.serverRequestHandler = null;
    }
    send(frame) {
        if (this.disposed)
            throw this.disposeReason ?? new AcpRpcError(-32000, "transport is closed");
        const line = JSON.stringify(frame);
        this.onLog({ direction: "send", text: truncateForLog(line) });
        this.output.write(`${line}\n`);
    }
    handleLine(line) {
        this.onLog({ direction: "recv", text: truncateForLog(line) });
        let message;
        try {
            message = JSON.parse(line);
        }
        catch {
            this.onLog({ direction: "drop", text: `ignored non-JSON stdout line: ${truncateForLog(line)}` });
            return;
        }
        if (!message || typeof message !== "object" || Array.isArray(message)) {
            this.onLog({ direction: "drop", text: "ignored non-object JSON-RPC frame" });
            return;
        }
        const frame = message;
        const hasId = frame.id !== undefined && frame.id !== null;
        const method = typeof frame.method === "string" ? frame.method : undefined;
        if (method !== undefined && hasId) {
            void this.handleServerRequest(frame.id, method, frame.params);
            return;
        }
        if (method !== undefined) {
            for (const handler of this.notificationHandlers) {
                try {
                    handler(method, frame.params);
                }
                catch (error) {
                    this.onLog({ direction: "error", text: `notification handler failed: ${String(error)}` });
                }
            }
            return;
        }
        if (hasId) {
            this.handleResponse(frame);
            return;
        }
        this.onLog({ direction: "drop", text: "ignored frame without id or method" });
    }
    async handleServerRequest(id, method, params) {
        const handler = this.serverRequestHandler;
        if (!handler) {
            this.trySend({
                jsonrpc: "2.0",
                id,
                error: { code: -32601, message: `unsupported client method: ${method}` },
            });
            return;
        }
        try {
            const result = await handler(method, params);
            this.trySend({ jsonrpc: "2.0", id, result: result ?? {} });
        }
        catch (error) {
            this.trySend({
                jsonrpc: "2.0",
                id,
                error: {
                    code: error instanceof AcpRpcError ? error.code : -32603,
                    message: error instanceof Error ? error.message : String(error),
                },
            });
        }
    }
    handleResponse(frame) {
        const id = Number(frame.id);
        const pending = this.pending.get(id);
        if (!pending) {
            this.onLog({ direction: "drop", text: `no pending request for response id ${String(frame.id)}` });
            return;
        }
        this.pending.delete(id);
        this.clearTimer(pending);
        this.detachAbort(pending);
        if (frame.error && typeof frame.error === "object") {
            const error = frame.error;
            pending.reject(new AcpRpcError(typeof error.code === "number" ? error.code : -32603, typeof error.message === "string" ? error.message : `request failed: ${pending.method}`, error.data));
            return;
        }
        pending.resolve(frame.result);
    }
    trySend(frame) {
        try {
            this.send(frame);
        }
        catch (error) {
            this.onLog({ direction: "error", text: `failed to send frame: ${String(error)}` });
        }
    }
    clearTimer(pending) {
        if (pending.timer !== undefined) {
            clearTimeout(pending.timer);
            pending.timer = undefined;
        }
    }
    detachAbort(pending) {
        pending.detachAbort?.();
        pending.detachAbort = undefined;
    }
}
exports.JsonRpcTransport = JsonRpcTransport;

},
function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.truncateText = truncateText;
exports.buildContext = buildContext;
exports.composePrompt = composePrompt;
exports.buildResourceLink = buildResourceLink;
/**
 * Builds the Obsidian note context prepended to a user prompt.
 * Pure functions only, so it is unit-testable.
 */
const node_url_1 = require("node:url");
const TRUNCATION_SUFFIX = "\n…[truncated]";
function clampChars(value) {
    if (!Number.isFinite(value))
        return 8000;
    return Math.max(500, Math.min(200_000, Math.floor(value)));
}
function truncateText(text, maxChars) {
    const limit = clampChars(maxChars);
    if (text.length <= limit)
        return { text, truncated: false };
    return { text: `${text.slice(0, limit)}${TRUNCATION_SUFFIX}`, truncated: true };
}
function buildContext(input) {
    const notePath = input.notePath?.trim();
    if (!notePath)
        return null;
    const selection = input.selection ?? "";
    const useSelection = input.includeSelection && selection.trim().length > 0;
    if (!useSelection && !input.includeActiveNote)
        return null;
    const body = useSelection ? selection : input.content;
    if (body === null || body.trim().length === 0)
        return null;
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
function composePrompt(userText, context) {
    if (!context)
        return userText;
    return `${context.text}\n\n${userText}`;
}
function buildResourceLink(absolutePath, name) {
    return { type: "resource_link", uri: (0, node_url_1.pathToFileURL)(absolutePath).href, name };
}

},
function (module, exports, require) {
"use strict";
/**
 * Tiny flat-key i18n dictionary. Chinese is the primary UI language for this
 * vault; English is the fallback for other Obsidian locales.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createI18n = createI18n;
const zh = {
    "status.idle": "未连接",
    "status.probing": "检测中…",
    "status.starting": "启动中…",
    "status.firstStart": "首次启动，正在初始化运行时…",
    "status.ready": "就绪",
    "status.error": "错误",
    "status.notFound": "未找到 DeepSeek Harness",
    "status.stopped": "已停止",
    "status.responding": "正在回复…",
    "cmd.open": "打开 DSH 对话面板",
    "cmd.askSelection": "询问选中内容（DSH）",
    "cmd.sendNote": "把当前笔记发给 DSH",
    "cmd.newSession": "新建 DSH 对话",
    "cmd.restart": "重启 DSH 运行时",
    "cmd.showLog": "查看 DSH 运行时日志",
    "ribbon.open": "DSH Agent",
    "menu.sendToDsh": "发送到 DSH",
    "prompt.explainSelection": "解释这段选中内容，并指出可能存在的问题。",
    "prompt.summarizeNote": "请阅读并总结当前笔记，列出要点和待办事项。",
    "view.name": "DSH Agent",
    "header.new": "新对话",
    "header.history": "历史",
    "header.more": "更多",
    "menu.restart": "重启运行时",
    "menu.showLog": "查看日志",
    "menu.closeSession": "关闭当前会话",
    "composer.placeholder": "问点什么…（Enter 发送，Shift+Enter 换行）",
    "composer.connecting": "正在连接 DSH 运行时…",
    "composer.send": "发送",
    "composer.stop": "停止",
    "chip.note": "当前笔记",
    "chip.selection": "选中内容",
    "chip.noteTitle": "把当前笔记内容附在消息前",
    "chip.selectionTitle": "只附上选中的内容",
    "footer.usage": "上下文 {used} / {size}",
    "footer.noUsage": "上下文 —",
    "action.copy": "复制",
    "action.insert": "插入到光标",
    "action.replace": "替换选区",
    "action.copied": "已复制",
    "action.noEditor": "没有可编辑的 Markdown 视图",
    "thinking": "思考过程",
    "role.you": "你",
    "role.dsh": "DSH",
    "role.tool": "工具",
    "role.approval": "审批",
    "tool.details": "查看详情",
    "tool.input": "参数",
    "tool.output": "结果",
    "tool.groupCount": "本回合共 {count} 次工具调用",
    "tool.running": "进行中",
    "tool.completed": "完成",
    "tool.failed": "失败",
    "permission.title": "工具请求执行",
    "permission.tool": "工具调用：{id}",
    "permission.allow": "允许一次",
    "permission.allowAlways": "始终允许",
    "permission.reject": "拒绝",
    "permission.rejectAlways": "始终拒绝",
    "permission.allowed": "已允许",
    "permission.rejected": "已拒绝",
    "permission.cancelled": "已取消",
    "permission.auto": "已自动允许",
    "notice.cancelled": "已取消",
    "notice.maxTokens": "输出达到模型上限，回答可能不完整。",
    "notice.maxTurnRequests": "达到最大轮次上限，任务未完成。",
    "notice.refusal": "模型拒绝了该请求。",
    "notice.promptFailed": "请求失败：{message}",
    "notice.copyFailed": "复制失败",
    "notice.editFailed": "写入笔记失败：{message}",
    "notice.historyUnavailable": "该会话由其他客户端创建，历史记录不在插件内显示。",
    "notice.truncatedContext": "笔记内容过长，已截断。",
    "notice.noActiveNote": "当前没有活动的 Markdown 笔记，已跳过笔记上下文。",
    "notice.noSelection": "没有选中任何文字。",
    "notice.runtimeLost": "DSH 运行时已退出，当前消息已中断。",
    "notice.autoRestarting": "DSH 运行时已退出，正在尝试自动重启…",
    "notice.autoRestartFailed": "自动重启失败，请从菜单手动重启。",
    "notice.runtimeStartFailed": "启动 DSH 运行时失败：{message}",
    "notice.sessionNewFailed": "创建会话失败：{message}",
    "notice.sessionResumeFailed": "恢复会话失败：{message}",
    "notice.configFailed": "切换设置失败：{message}",
    "notice.transcriptCorrupt": "本地会话记录损坏，已忽略。",
    "empty.title": "和 DeepSeek Harness 聊聊",
    "empty.hint": "消息会发送给本机的 DSH 运行时，它可以读取并修改这个 Vault。",
    "empty.example1": "总结当前笔记并列出待办",
    "empty.example2": "检查选中内容里的错误",
    "empty.example3": "为这个 Vault 生成一份目录索引",
    "selectors.model": "模型",
    "selectors.effort": "推理强度",
    "log.title": "DSH 运行时日志",
    "log.copy": "复制",
    "log.close": "关闭",
    "log.empty": "（暂无日志）",
    "history.empty": "本地还没有会话记录。",
    "history.import": "从 DSH 导入会话…",
    "history.importTitle": "DSH 中已持久化的会话",
    "history.importEmpty": "没有可导入的会话。",
    "history.cancel": "取消",
    "history.unknownTitle": "未命名会话",
    "history.open": "打开",
    "settings.hero.subtitle": "侧边栏聊天面板 · 通过 ACP 驱动本机 DeepSeek Harness 运行时",
    "settings.status.launcher": "启动器：{path}",
    "settings.status.noLauncher": "未检测到启动器，首次发送时会自动检测",
    "settings.actions.test": "检测连接",
    "settings.actions.restart": "重启运行时",
    "settings.actions.log": "查看日志",
    "settings.card.connection.title": "连接与模型",
    "settings.card.connection.hint": "运行时启动器与模型路由；留空时自动读取桌面版配置。",
    "settings.card.context.title": "笔记上下文",
    "settings.card.context.hint": "发送消息时附加的笔记内容与文件链接。",
    "settings.card.behavior.title": "面板交互",
    "settings.card.behavior.hint": "输入习惯、思考展示与工具审批。",
    "settings.card.diagnostics.title": "诊断",
    "settings.card.diagnostics.hint": "仅在排查问题时需要打开。",
    "settings.advanced": "高级选项（启动参数 / profile patch / MCP）",
    "settings.launcher.name": "DSH 启动器路径",
    "settings.launcher.desc": "留空自动检测（桌面版安装目录或 PATH 中的 dsh）。",
    "settings.detecting": "检测中…",
    "settings.detectOk": "已找到 DSH：{detail}",
    "settings.detectFail": "未找到可用的 DSH 启动器：{detail}",
    "settings.home.name": "DSH_HOME",
    "settings.home.desc": "留空使用默认的 ~/.dsh。",
    "settings.provider.name": "Provider 覆盖",
    "settings.provider.desc": "留空则读取桌面版配置（通常是 deepseek-account）。",
    "settings.model.name": "Model 覆盖",
    "settings.model.desc": "留空则读取桌面版配置（通常是 deepseek-flash）。",
    "settings.extraArgs.name": "额外启动参数",
    "settings.extraArgs.desc": "追加到 dsh acp 之后的参数，按空格拆分。",
    "settings.extraPatch.name": "额外 profile patch",
    "settings.extraPatch.desc": "YAML 片段，追加到自动生成的 --patch 覆盖文件中（高级）。",
    "settings.mcp.name": "MCP 服务器（JSON）",
    "settings.mcp.desc": "传给 session/new 的 mcpServers 数组，必须是 JSON 数组；留空表示不使用 MCP。",
    "settings.includeNote.name": "默认附带当前笔记",
    "settings.includeNote.desc": "发送消息时把当前笔记内容放进上下文。",
    "settings.includeSelection.name": "优先使用选中内容",
    "settings.includeSelection.desc": "有选区时只发送选区，不发送整篇笔记。",
    "settings.maxChars.name": "上下文最大字符数",
    "settings.maxChars.desc": "超过该长度的笔记内容会被截断。",
    "settings.resourceLink.name": "附带笔记文件链接",
    "settings.resourceLink.desc": "额外发送一个 resource_link，让 agent 可以自行读取整篇笔记。",
    "settings.autoApprove.name": "自动允许工具调用",
    "settings.autoApprove.desc": "危险：不再询问即可执行读写与命令操作。",
    "settings.toolDisplay.name": "工具调用显示",
    "settings.toolDisplay.desc": "控制对话中显示多少条工具调用记录。",
    "settings.toolDisplay.hidden": "不显示",
    "settings.toolDisplay.latest": "只显示最新一条",
    "settings.toolDisplay.all": "显示全部",
    "settings.showReasoning.name": "显示思考过程",
    "settings.showReasoning.desc": "在回答上方显示模型的 reasoning 内容。",
    "settings.sendOnEnter.name": "Enter 发送",
    "settings.sendOnEnter.desc": "关闭后使用 Ctrl/Cmd+Enter 发送。",
    "settings.autoStart.name": "打开 Obsidian 时预启动运行时",
    "settings.autoStart.desc": "关闭时在第一次打开面板或发送消息时才启动。",
    "settings.debugLog.name": "记录协议日志",
    "settings.debugLog.desc": "把 JSON-RPC 报文写入控制台与日志窗口。",
    "settings.invalidNumber": "请输入有效的数字。",
    "settings.invalidMcpJson": "MCP 服务器配置必须是合法的 JSON 数组；当前配置已忽略。",
    "statusbar.toolTip": "DeepSeek Harness 连接状态",
};
const en = {
    "status.idle": "Not connected",
    "status.probing": "Checking…",
    "status.starting": "Starting…",
    "status.firstStart": "First start: initializing runtime…",
    "status.ready": "Ready",
    "status.error": "Error",
    "status.notFound": "DeepSeek Harness not found",
    "status.stopped": "Stopped",
    "status.responding": "Replying…",
    "cmd.open": "Open DSH chat panel",
    "cmd.askSelection": "Ask DSH about selection",
    "cmd.sendNote": "Send current note to DSH",
    "cmd.newSession": "New DSH chat session",
    "cmd.restart": "Restart DSH runtime",
    "cmd.showLog": "Show DSH runtime log",
    "ribbon.open": "DSH Agent",
    "menu.sendToDsh": "Send to DSH",
    "prompt.explainSelection": "Explain this selection and point out possible problems.",
    "prompt.summarizeNote": "Read and summarize the current note; list key points and tasks.",
    "view.name": "DSH Agent",
    "header.new": "New",
    "header.history": "History",
    "header.more": "More",
    "menu.restart": "Restart runtime",
    "menu.showLog": "Show log",
    "menu.closeSession": "Close current session",
    "composer.placeholder": "Ask something… (Enter to send, Shift+Enter for a new line)",
    "composer.connecting": "Connecting to the DSH runtime…",
    "composer.send": "Send",
    "composer.stop": "Stop",
    "chip.note": "Note",
    "chip.selection": "Selection",
    "chip.noteTitle": "Attach the active note content",
    "chip.selectionTitle": "Attach only the selected text",
    "footer.usage": "Context {used} / {size}",
    "footer.noUsage": "Context —",
    "action.copy": "Copy",
    "action.insert": "Insert at cursor",
    "action.replace": "Replace selection",
    "action.copied": "Copied",
    "action.noEditor": "No editable Markdown view",
    "thinking": "Reasoning",
    "role.you": "You",
    "role.dsh": "DSH",
    "role.tool": "Tool",
    "role.approval": "Approval",
    "tool.details": "Show details",
    "tool.input": "Input",
    "tool.output": "Result",
    "tool.groupCount": "Tool calls this turn: {count}",
    "tool.running": "Running",
    "tool.completed": "Completed",
    "tool.failed": "Failed",
    "permission.title": "Tool permission requested",
    "permission.tool": "Tool call: {id}",
    "permission.allow": "Allow once",
    "permission.allowAlways": "Always allow",
    "permission.reject": "Reject",
    "permission.rejectAlways": "Always reject",
    "permission.allowed": "Allowed",
    "permission.rejected": "Rejected",
    "permission.cancelled": "Cancelled",
    "permission.auto": "Auto-allowed",
    "notice.cancelled": "Cancelled",
    "notice.maxTokens": "The model hit its output limit; the answer may be incomplete.",
    "notice.maxTurnRequests": "The maximum number of turns was reached.",
    "notice.refusal": "The model refused this request.",
    "notice.promptFailed": "Request failed: {message}",
    "notice.copyFailed": "Copy failed",
    "notice.editFailed": "Failed to write to the note: {message}",
    "notice.historyUnavailable": "This session was created elsewhere; its history is not available here.",
    "notice.truncatedContext": "The note was too long and was truncated.",
    "notice.noActiveNote": "No active Markdown note; note context was skipped.",
    "notice.noSelection": "No text is selected.",
    "notice.runtimeLost": "The DSH runtime exited; the current message was interrupted.",
    "notice.autoRestarting": "The DSH runtime exited; attempting one automatic restart…",
    "notice.autoRestartFailed": "Automatic restart failed; restart it from the menu.",
    "notice.runtimeStartFailed": "Failed to start the DSH runtime: {message}",
    "notice.sessionNewFailed": "Failed to create a session: {message}",
    "notice.sessionResumeFailed": "Failed to resume the session: {message}",
    "notice.configFailed": "Failed to change configuration: {message}",
    "notice.transcriptCorrupt": "The local transcript was corrupt and was ignored.",
    "empty.title": "Chat with DeepSeek Harness",
    "empty.hint": "Messages go to the local DSH runtime, which can read and modify this vault.",
    "empty.example1": "Summarize this note and list open tasks",
    "empty.example2": "Check the selection for mistakes",
    "empty.example3": "Generate an index of this vault",
    "selectors.model": "Model",
    "selectors.effort": "Reasoning effort",
    "log.title": "DSH runtime log",
    "log.copy": "Copy",
    "log.close": "Close",
    "log.empty": "(no log yet)",
    "history.empty": "No local sessions yet.",
    "history.import": "Import sessions from DSH…",
    "history.importTitle": "Persisted sessions in DSH",
    "history.importEmpty": "Nothing to import.",
    "history.cancel": "Cancel",
    "history.unknownTitle": "Untitled session",
    "history.open": "Open",
    "settings.hero.subtitle": "Side-panel chat · drives the local DeepSeek Harness runtime over ACP",
    "settings.status.launcher": "Launcher: {path}",
    "settings.status.noLauncher": "No launcher detected; it is auto-detected on first use",
    "settings.actions.test": "Test connection",
    "settings.actions.restart": "Restart runtime",
    "settings.actions.log": "View log",
    "settings.card.connection.title": "Connection & model",
    "settings.card.connection.hint": "Runtime launcher and model route; empty fields reuse the desktop app config.",
    "settings.card.context.title": "Note context",
    "settings.card.context.hint": "Note content and file links attached to each message.",
    "settings.card.behavior.title": "Panel behaviour",
    "settings.card.behavior.hint": "Input habits, reasoning display and tool approval.",
    "settings.card.diagnostics.title": "Diagnostics",
    "settings.card.diagnostics.hint": "Only needed while troubleshooting.",
    "settings.advanced": "Advanced (launcher args / profile patch / MCP)",
    "settings.launcher.name": "DSH launcher path",
    "settings.launcher.desc": "Leave empty to auto-detect (desktop install or dsh on PATH).",
    "settings.detecting": "Checking…",
    "settings.detectOk": "Found DSH: {detail}",
    "settings.detectFail": "No usable DSH launcher found: {detail}",
    "settings.home.name": "DSH_HOME",
    "settings.home.desc": "Leave empty to use ~/.dsh.",
    "settings.provider.name": "Provider override",
    "settings.provider.desc": "Empty: reuse the desktop app route (usually deepseek-account).",
    "settings.model.name": "Model override",
    "settings.model.desc": "Empty: reuse the desktop app route (usually deepseek-flash).",
    "settings.extraArgs.name": "Extra launcher args",
    "settings.extraArgs.desc": "Appended after `dsh acp`, split on whitespace.",
    "settings.extraPatch.name": "Extra profile patch",
    "settings.extraPatch.desc": "YAML appended to the generated --patch file (advanced).",
    "settings.mcp.name": "MCP servers (JSON)",
    "settings.mcp.desc": "mcpServers array for session/new; must be a JSON array. Leave empty to disable MCP.",
    "settings.includeNote.name": "Attach the active note by default",
    "settings.includeNote.desc": "Include note content in the prompt.",
    "settings.includeSelection.name": "Prefer the selection",
    "settings.includeSelection.desc": "When text is selected, send only that selection.",
    "settings.maxChars.name": "Max context characters",
    "settings.maxChars.desc": "Note content longer than this is truncated.",
    "settings.resourceLink.name": "Attach a file link",
    "settings.resourceLink.desc": "Also send a resource_link so the agent can read the whole note.",
    "settings.autoApprove.name": "Auto-approve tool calls",
    "settings.autoApprove.desc": "Dangerous: file writes and commands run without asking.",
    "settings.toolDisplay.name": "Tool call display",
    "settings.toolDisplay.desc": "Controls how many tool call records are shown in the chat.",
    "settings.toolDisplay.hidden": "Hide all",
    "settings.toolDisplay.latest": "Latest only",
    "settings.toolDisplay.all": "Show all",
    "settings.showReasoning.name": "Show reasoning",
    "settings.showReasoning.desc": "Render the model's reasoning above answers.",
    "settings.sendOnEnter.name": "Send on Enter",
    "settings.sendOnEnter.desc": "When off, use Ctrl/Cmd+Enter to send.",
    "settings.autoStart.name": "Start the runtime with Obsidian",
    "settings.autoStart.desc": "When off, the runtime starts on first use.",
    "settings.debugLog.name": "Log protocol traffic",
    "settings.debugLog.desc": "Write JSON-RPC frames to the console and log window.",
    "settings.invalidNumber": "Enter a valid number.",
    "settings.invalidMcpJson": "MCP server config must be a valid JSON array; the current value was ignored.",
    "statusbar.toolTip": "DeepSeek Harness connection status",
};
function createI18n(locale) {
    const lang = locale.toLowerCase().startsWith("zh") ? "zh" : "en";
    const dict = lang === "zh" ? zh : en;
    return {
        lang,
        t(key, vars) {
            const template = dict[key] ?? en[key] ?? key;
            if (!vars)
                return template;
            return template.replace(/\{(\w+)\}/g, (match, name) => {
                const value = vars[name];
                return value === undefined ? match : String(value);
            });
        },
    };
}

},
function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Plugin entry point: wiring between the runtime, the session controller, the
 * chat view, commands and persisted state.
 */
const obsidian_1 = require("obsidian");
const node_path_1 = require("node:path");
const context_ts_1 = require("./context.ts");
const i18n_ts_1 = require("./i18n.ts");
const runtime_ts_1 = require("./runtime.ts");
const settings_ts_1 = require("./settings.ts");
const session_ts_1 = require("./session.ts");
const store_ts_1 = require("./store.ts");
const view_ts_1 = require("./view.ts");
function emptySessionState() {
    return {
        sessionId: null,
        title: null,
        attached: false,
        busy: false,
        items: [],
        usage: null,
        configOptions: [],
    };
}
function isSessionMeta(value) {
    if (!value || typeof value !== "object")
        return false;
    const meta = value;
    return (typeof meta.id === "string" &&
        typeof meta.title === "string" &&
        typeof meta.cwd === "string" &&
        typeof meta.createdAt === "number" &&
        typeof meta.updatedAt === "number");
}
class DshChatPlugin extends obsidian_1.Plugin {
    settings = { ...settings_ts_1.DEFAULT_SETTINGS };
    i18n = (0, i18n_ts_1.createI18n)("en");
    store;
    runtime;
    controller = null;
    data = {
        settings: { ...settings_ts_1.DEFAULT_SETTINGS },
        sessions: [],
        lastSessionId: null,
    };
    subscribers = new Set();
    statusBarEl = null;
    chatError = null;
    openViewCount = 0;
    stopping = false;
    restartAttempts = 0;
    chatPromise = null;
    saveTimer = null;
    lastMarkdownView = null;
    async onload() {
        const raw = (await this.loadData());
        this.settings = (0, settings_ts_1.normalizeSettings)(raw?.settings);
        this.data = {
            settings: this.settings,
            sessions: Array.isArray(raw?.sessions) ? raw.sessions.filter(isSessionMeta) : [],
            lastSessionId: typeof raw?.lastSessionId === "string" ? raw.lastSessionId : null,
        };
        this.i18n = (0, i18n_ts_1.createI18n)((0, obsidian_1.getLanguage)());
        this.store = new store_ts_1.PluginStore(this.app, this.pluginDir());
        this.runtime = new runtime_ts_1.DshRuntime({
            vaultPath: this.vaultPath(),
            pluginDir: this.pluginDirAbs(),
            clientVersion: this.manifest.version,
            getSettings: () => this.settings,
            onStatus: (status) => {
                if (status.phase === "ready")
                    this.restartAttempts = 0;
                this.updateStatusBar(status);
                this.notify();
            },
            onLog: (line) => {
                if (this.settings.debugLog)
                    console.debug("[dsh-runtime]", line);
            },
            onUpdate: (params) => this.controller?.onUpdate(params),
            onPermission: (request) => this.handlePermissionRequest(request),
            onExit: (info) => {
                this.controller?.onRuntimeLost();
                if (info.expected || this.stopping)
                    return;
                this.setChatError(this.i18n.t("notice.runtimeLost"));
                this.maybeAutoRestart();
            },
        });
        this.registerView(view_ts_1.VIEW_TYPE_DSH_CHAT, (leaf) => new view_ts_1.DshChatView(leaf, this));
        this.addRibbonIcon("message-square", this.i18n.t("ribbon.open"), () => {
            void this.activateView();
        });
        this.registerCommands();
        this.addSettingTab(new settings_ts_1.DshChatSettingTab(this.app, this));
        this.registerEditorMenu();
        this.setupStatusBar();
        this.registerEvent(this.app.workspace.on("active-leaf-change", () => {
            const view = this.app.workspace.getActiveViewOfType(obsidian_1.MarkdownView);
            if (view)
                this.lastMarkdownView = view;
        }));
        this.app.workspace.onLayoutReady(() => {
            const view = this.app.workspace.getActiveViewOfType(obsidian_1.MarkdownView);
            if (view)
                this.lastMarkdownView = view;
        });
        // Persist normalized settings early and leave a durable load marker.
        await this.saveData(this.data);
        if (this.settings.autoStartRuntime) {
            this.app.workspace.onLayoutReady(() => {
                void this.ensureStarted().catch((error) => {
                    this.setChatError(this.runtimeStartMessage(error));
                });
            });
        }
    }
    async onunload() {
        this.stopping = true;
        this.flushSave();
        this.subscribers.clear();
        try {
            this.controller?.dispose();
        }
        catch {
            // best effort
        }
        try {
            await this.controller?.close();
        }
        catch {
            // best effort
        }
        this.controller = null;
        try {
            await this.runtime.stop("plugin-unload");
        }
        catch {
            // best effort
        }
        this.app.workspace.detachLeavesOfType(view_ts_1.VIEW_TYPE_DSH_CHAT);
    }
    // ---------------------------------------------------------------- state --
    getViewState() {
        return {
            runtime: this.runtime.status,
            session: this.controller?.state ?? emptySessionState(),
            error: this.chatError,
        };
    }
    subscribe(listener) {
        this.subscribers.add(listener);
        return () => this.subscribers.delete(listener);
    }
    notify() {
        for (const listener of this.subscribers) {
            try {
                listener();
            }
            catch (error) {
                console.error("[dsh-chat] subscriber failed", error);
            }
        }
    }
    addOpenView() {
        this.openViewCount += 1;
    }
    removeOpenView() {
        this.openViewCount = Math.max(0, this.openViewCount - 1);
        this.controller?.cancelPendingForHiddenUi();
    }
    get sessionMetas() {
        return this.data.sessions;
    }
    get currentSessionId() {
        return this.controller?.sessionId ?? null;
    }
    // -------------------------------------------------------------- runtime --
    async ensureStarted() {
        const client = await this.runtime.ensure();
        this.chatError = null;
        return client;
    }
    async ensureChat() {
        if (this.stopping)
            return;
        if (this.chatPromise)
            return await this.chatPromise;
        this.chatPromise = this.doEnsureChat().finally(() => {
            this.chatPromise = null;
        });
        return await this.chatPromise;
    }
    async doEnsureChat() {
        try {
            const client = await this.ensureStarted();
            if (!this.controller)
                this.controller = this.createController();
            this.controller.setClient(client);
            try {
                await this.ensureSession();
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.setChatError(this.i18n.t("notice.sessionNewFailed", { message }));
                return;
            }
            this.chatError = null;
        }
        catch (error) {
            this.setChatError(this.runtimeStartMessage(error));
        }
        finally {
            this.notify();
        }
    }
    async ensureSession() {
        const controller = this.controller;
        if (!controller)
            return;
        if (controller.hasSession) {
            if (controller.isAttached)
                return;
            try {
                await controller.reattach();
                return;
            }
            catch {
                // The persisted session may be gone; fall through to a fresh one.
            }
        }
        const lastId = this.data.lastSessionId;
        if (lastId) {
            const meta = this.data.sessions.find((entry) => entry.id === lastId) ?? null;
            const { snapshot, corrupt } = await this.store.readTranscript(lastId);
            if (corrupt)
                new obsidian_1.Notice(this.i18n.t("notice.transcriptCorrupt"));
            if (snapshot) {
                try {
                    await controller.resume(lastId, snapshot, meta);
                    this.setLastSession(lastId);
                    return;
                }
                catch {
                    // Resume can fail when cwd changed or the session is active elsewhere.
                }
            }
        }
        await controller.startNew();
        this.setLastSession(controller.sessionId);
    }
    createController() {
        return new session_ts_1.SessionController({
            cwd: this.vaultPath(),
            getAutoApprove: () => this.settings.autoApproveTools,
            getMcpServers: () => this.parseMcpServers(),
            getLastModelValue: () => this.settings.lastModelValue,
            getLastEffort: () => this.settings.lastReasoningEffort,
            rememberConfig: (configId, value) => {
                if (configId === "model")
                    this.settings.lastModelValue = value;
                if (configId === "reasoning_effort")
                    this.settings.lastReasoningEffort = value;
                this.scheduleSave();
            },
            t: (key, vars) => this.i18n.t(key, vars),
            persist: (snapshot) => {
                void this.store.writeTranscript(snapshot).catch((error) => {
                    console.warn("[dsh-chat] transcript write failed", error);
                });
            },
            updateMeta: (meta) => this.updateSessionMeta(meta),
            onChanged: () => this.notify(),
        });
    }
    runtimeStartMessage(error) {
        const message = error instanceof Error ? error.message : String(error);
        return this.i18n.t("notice.runtimeStartFailed", { message });
    }
    setChatError(message) {
        this.chatError = message;
        this.notify();
    }
    maybeAutoRestart() {
        if (this.restartAttempts >= 1)
            return;
        this.restartAttempts += 1;
        new obsidian_1.Notice(this.i18n.t("notice.autoRestarting"));
        window.setTimeout(() => {
            void this.ensureChat().catch(() => {
                new obsidian_1.Notice(this.i18n.t("notice.autoRestartFailed"));
            });
        }, 1200);
    }
    async restartRuntime() {
        try {
            if (this.controller?.hasSession) {
                try {
                    await this.controller.close();
                }
                catch {
                    // ignore
                }
            }
            await this.runtime.stop("user-restart");
            this.controller?.onRuntimeLost();
            this.chatError = null;
            await this.ensureChat();
        }
        catch (error) {
            this.setChatError(this.runtimeStartMessage(error));
        }
    }
    async probeRuntime() {
        return await this.runtime.probe();
    }
    getLogText() {
        return this.runtime.logText;
    }
    showLogModal() {
        new view_ts_1.LogModal(this.app, this.getLogText(), this.i18n).open();
    }
    // -------------------------------------------------------------- sessions --
    async newSession() {
        try {
            if (!this.controller)
                await this.ensureChat();
            const controller = this.controller;
            if (!controller)
                return;
            await controller.close();
            await controller.startNew();
            this.setLastSession(controller.sessionId);
        }
        catch (error) {
            new obsidian_1.Notice(this.i18n.t("notice.sessionNewFailed", {
                message: error instanceof Error ? error.message : String(error),
            }));
        }
    }
    async resumeSession(sessionId) {
        try {
            if (!this.controller)
                await this.ensureChat();
            const controller = this.controller;
            if (!controller)
                return;
            const meta = this.data.sessions.find((entry) => entry.id === sessionId) ?? null;
            const { snapshot } = await this.store.readTranscript(sessionId);
            await controller.close();
            try {
                await controller.resume(sessionId, snapshot, meta);
            }
            catch (error) {
                new obsidian_1.Notice(this.i18n.t("notice.sessionResumeFailed", {
                    message: error instanceof Error ? error.message : String(error),
                }));
                await controller.startNew();
            }
            this.setLastSession(controller.sessionId);
        }
        catch (error) {
            new obsidian_1.Notice(this.i18n.t("notice.sessionResumeFailed", {
                message: error instanceof Error ? error.message : String(error),
            }));
        }
    }
    async closeSession() {
        try {
            await this.controller?.close();
            this.setLastSession(null);
        }
        catch (error) {
            console.warn("[dsh-chat] close session failed", error);
        }
    }
    async importSessions() {
        try {
            const client = await this.ensureStarted();
            const known = new Set(this.data.sessions.map((entry) => entry.id));
            const found = new Map();
            let cursor;
            for (let page = 0; page < 20; page += 1) {
                const result = await client.listSessions(this.vaultPath(), cursor);
                for (const entry of result.sessions ?? []) {
                    if (!known.has(entry.sessionId))
                        found.set(entry.sessionId, entry);
                }
                cursor = result.nextCursor;
                if (!cursor)
                    break;
            }
            return [...found.values()];
        }
        catch (error) {
            new obsidian_1.Notice(this.i18n.t("notice.sessionResumeFailed", {
                message: error instanceof Error ? error.message : String(error),
            }));
            return [];
        }
    }
    async sendMessage(text, options, snapshot) {
        if (!this.controller || !this.controller.state.attached)
            await this.ensureChat();
        const controller = this.controller;
        if (!controller)
            throw new Error("the DSH runtime is not ready");
        const view = snapshot ? null : this.resolveMarkdownView();
        const notePath = snapshot ? snapshot.notePath : view?.file?.path ?? null;
        const selection = snapshot
            ? snapshot.selection
            : options.includeSelection && view
                ? view.editor.getSelection()
                : "";
        const content = snapshot
            ? snapshot.content
            : options.includeNote && view
                ? view.editor.getValue()
                : null;
        const context = (0, context_ts_1.buildContext)({
            notePath,
            selection,
            content,
            includeSelection: options.includeSelection,
            includeActiveNote: options.includeNote,
            maxChars: this.settings.maxContextChars,
        });
        if (context?.truncated)
            new obsidian_1.Notice(this.i18n.t("notice.truncatedContext"));
        if (options.includeNote && !notePath)
            new obsidian_1.Notice(this.i18n.t("notice.noActiveNote"));
        const blocks = [
            { type: "text", text: (0, context_ts_1.composePrompt)(text, context) },
        ];
        if (context && this.settings.attachResourceLink && notePath) {
            const absolute = (0, node_path_1.join)(this.vaultPath(), notePath);
            const name = notePath.split("/").pop() ?? notePath;
            blocks.push((0, context_ts_1.buildResourceLink)(absolute, name));
        }
        await controller.send(text, blocks, {
            notePath: context?.notePath ?? null,
            hasSelection: context?.usedSelection ?? false,
        });
    }
    /** The active Markdown view, or the most recent one when the panel has focus. */
    resolveMarkdownView() {
        const active = this.app.workspace.getActiveViewOfType(obsidian_1.MarkdownView);
        if (active) {
            this.lastMarkdownView = active;
            return active;
        }
        const last = this.lastMarkdownView;
        return last && last.file ? last : null;
    }
    /** Context-menu action: send the captured selection as a question right away. */
    async sendSelectionToDsh(selection, snapshot) {
        const text = selection.trim();
        if (text.length === 0) {
            new obsidian_1.Notice(this.i18n.t("notice.noSelection"));
            return;
        }
        try {
            const leaf = await this.activateView();
            if (leaf?.view instanceof view_ts_1.DshChatView)
                leaf.view.focusComposer();
            await this.ensureChat();
            if (snapshot && snapshot.notePath) {
                await this.sendMessage(this.i18n.t("prompt.explainSelection"), { includeNote: false, includeSelection: true }, snapshot);
            }
            else {
                await this.sendMessage(`${this.i18n.t("prompt.explainSelection")}\n\n${text}`, { includeNote: false, includeSelection: false });
            }
        }
        catch (error) {
            new obsidian_1.Notice(this.i18n.t("notice.promptFailed", {
                message: error instanceof Error ? error.message : String(error),
            }));
        }
    }
    cancelPrompt() {
        this.controller?.cancel();
    }
    async setConfigOption(configId, value) {
        if (!this.controller)
            await this.ensureChat();
        await this.controller?.setConfigOption(configId, value);
    }
    resolvePermission(itemId, decision, optionId) {
        this.controller?.resolvePermission(itemId, decision, optionId);
    }
    handlePermissionRequest(request) {
        const cancelled = { outcome: { outcome: "cancelled" } };
        const controller = this.controller;
        if (!controller)
            return Promise.resolve(cancelled);
        if (this.openViewCount === 0 && !this.settings.autoApproveTools) {
            return Promise.resolve(cancelled);
        }
        return controller.onPermissionRequest(request);
    }
    updateSessionMeta(meta) {
        const index = this.data.sessions.findIndex((entry) => entry.id === meta.id);
        if (index >= 0) {
            this.data.sessions[index] = { ...this.data.sessions[index], ...meta };
        }
        else {
            this.data.sessions.push({ ...meta });
        }
        this.setLastSession(meta.id);
    }
    setLastSession(sessionId) {
        this.data.lastSessionId = sessionId;
        this.scheduleSave();
        this.notify();
    }
    // -------------------------------------------------------------- settings --
    async updateSettings(patch) {
        this.settings = { ...this.settings, ...patch };
        this.data.settings = this.settings;
        await this.saveData(this.data);
        this.notify();
    }
    scheduleSave() {
        if (this.saveTimer !== null)
            clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            this.flushSave();
        }, 500);
    }
    flushSave() {
        if (this.saveTimer !== null) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        this.data.settings = this.settings;
        void this.saveData(this.data).catch((error) => {
            console.warn("[dsh-chat] saveData failed", error);
        });
    }
    parseMcpServers() {
        const raw = this.settings.mcpServersJson.trim();
        if (raw.length === 0)
            return [];
        try {
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) {
                new obsidian_1.Notice(this.i18n.t("settings.invalidMcpJson"));
                return [];
            }
            return parsed;
        }
        catch {
            new obsidian_1.Notice(this.i18n.t("settings.invalidMcpJson"));
            return [];
        }
    }
    // ----------------------------------------------------------------- paths --
    vaultPath() {
        const adapter = this.app.vault.adapter;
        const maybeFileSystem = adapter;
        if (typeof maybeFileSystem.getBasePath === "function") {
            return maybeFileSystem.getBasePath();
        }
        return this.app.vault.getName();
    }
    pluginDir() {
        return this.manifest.dir ?? `.obsidian/plugins/${this.manifest.id}`;
    }
    pluginDirAbs() {
        return (0, node_path_1.join)(this.vaultPath(), this.pluginDir());
    }
    // -------------------------------------------------------------- commands --
    registerCommands() {
        this.addCommand({
            id: "open-chat",
            name: this.i18n.t("cmd.open"),
            callback: () => {
                void this.activateView();
            },
        });
        this.addCommand({
            id: "ask-selection",
            name: this.i18n.t("cmd.askSelection"),
            editorCallback: (editor) => {
                const selection = editor.getSelection();
                void this.activateView().then((leaf) => {
                    const view = leaf?.view;
                    if (view instanceof view_ts_1.DshChatView) {
                        view.prefill(selection.trim().length > 0 ? this.i18n.t("prompt.explainSelection") : "");
                        view.focusComposer();
                    }
                });
            },
        });
        this.addCommand({
            id: "send-note",
            name: this.i18n.t("cmd.sendNote"),
            callback: () => {
                if (!this.resolveMarkdownView()) {
                    new obsidian_1.Notice(this.i18n.t("notice.noActiveNote"));
                    return;
                }
                void this.activateView().then((leaf) => {
                    const view = leaf?.view;
                    if (view instanceof view_ts_1.DshChatView) {
                        view.prefill(this.i18n.t("prompt.summarizeNote"));
                        view.focusComposer();
                    }
                });
            },
        });
        this.addCommand({
            id: "new-session",
            name: this.i18n.t("cmd.newSession"),
            callback: () => {
                void this.newSession();
            },
        });
        this.addCommand({
            id: "restart-runtime",
            name: this.i18n.t("cmd.restart"),
            callback: () => {
                void this.restartRuntime();
            },
        });
        this.addCommand({
            id: "show-log",
            name: this.i18n.t("cmd.showLog"),
            callback: () => this.showLogModal(),
        });
    }
    registerEditorMenu() {
        this.registerEvent(this.app.workspace.on("editor-menu", (menu, editor) => {
            const selection = editor.getSelection();
            if (selection.trim().length === 0)
                return;
            const view = this.app.workspace.getActiveViewOfType(obsidian_1.MarkdownView);
            const snapshot = view?.file
                ? { notePath: view.file.path, selection, content: view.editor.getValue() }
                : null;
            menu.addItem((item) => item
                .setTitle(this.i18n.t("menu.sendToDsh"))
                .setIcon("message-square")
                .onClick(() => {
                void this.sendSelectionToDsh(selection, snapshot);
            }));
        }));
    }
    setupStatusBar() {
        this.statusBarEl = this.addStatusBarItem();
        this.statusBarEl.addClass("dsh-chat-status-bar");
        this.statusBarEl.setAttribute("aria-label", this.i18n.t("statusbar.toolTip"));
        this.statusBarEl.addEventListener("click", () => {
            void this.activateView();
        });
        this.updateStatusBar(this.runtime.status);
    }
    updateStatusBar(status) {
        if (!this.statusBarEl)
            return;
        const suffix = status.phase === "ready"
            ? ""
            : status.phase === "starting" || status.phase === "probing"
                ? " …"
                : status.phase === "error"
                    ? " !"
                    : "";
        this.statusBarEl.setText(`DSH${suffix}`);
    }
    async activateView() {
        const existing = this.app.workspace.getLeavesOfType(view_ts_1.VIEW_TYPE_DSH_CHAT);
        if (existing.length > 0) {
            this.app.workspace.revealLeaf(existing[0]);
            return existing[0];
        }
        const leaf = this.app.workspace.getRightLeaf(false);
        if (!leaf)
            return null;
        await leaf.setViewState({ type: view_ts_1.VIEW_TYPE_DSH_CHAT, active: true });
        this.app.workspace.revealLeaf(leaf);
        return leaf;
    }
}
exports.default = DshChatPlugin;

},
function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.fillMarkdown = fillMarkdown;
exports.assistantText = assistantText;
exports.thoughtText = thoughtText;
exports.toolInputText = toolInputText;
exports.toolResultText = toolResultText;
exports.toolStatusLabel = toolStatusLabel;
exports.decisionLabel = decisionLabel;
exports.formatCount = formatCount;
exports.usageLabel = usageLabel;
/**
 * Rendering helpers: Markdown through Obsidian's renderer plus small text
 * formatters shared by the chat view.
 */
const obsidian_1 = require("obsidian");
const MAX_TOOL_INPUT_CHARS = 6000;
const MAX_TOOL_RESULT_CHARS = 12000;
async function fillMarkdown(app, target, markdown, sourcePath, component) {
    const scratch = document.createElement("div");
    scratch.className = "markdown-rendered";
    try {
        await obsidian_1.MarkdownRenderer.render(app, markdown, scratch, sourcePath, component);
    }
    catch {
        const pre = document.createElement("pre");
        pre.textContent = markdown;
        scratch.appendChild(pre);
    }
    target.empty();
    while (scratch.firstChild)
        target.appendChild(scratch.firstChild);
}
function assistantText(item) {
    return item.blocks
        .map((block) => block.trim())
        .filter((block) => block.length > 0)
        .join("\n\n");
}
function thoughtText(item) {
    return item.thoughts
        .map((block) => block.trim())
        .filter((block) => block.length > 0)
        .join("\n\n");
}
function toolInputText(item) {
    if (item.rawInput === undefined || item.rawInput === null)
        return "";
    try {
        const text = typeof item.rawInput === "string"
            ? item.rawInput
            : JSON.stringify(item.rawInput, null, 2);
        return text.length > MAX_TOOL_INPUT_CHARS ? `${text.slice(0, MAX_TOOL_INPUT_CHARS)}\n…` : text;
    }
    catch {
        return String(item.rawInput);
    }
}
function toolResultText(item) {
    const text = item.content.join("\n\n").trim();
    return text.length > MAX_TOOL_RESULT_CHARS ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}\n…` : text;
}
function toolStatusLabel(i18n, status) {
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
function decisionLabel(i18n, decision) {
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
function formatCount(value) {
    if (!Number.isFinite(value) || value < 0)
        return "0";
    if (value >= 1_000_000)
        return `${(value / 1_000_000).toFixed(1)}M`;
    if (value >= 1000)
        return `${(value / 1000).toFixed(1)}k`;
    return String(Math.round(value));
}
function usageLabel(i18n, usage) {
    if (!usage)
        return i18n.t("footer.noUsage");
    return i18n.t("footer.usage", {
        used: formatCount(usage.used),
        size: formatCount(usage.size),
    });
}

},
function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DshRuntime = exports.RuntimeError = void 0;
exports.discoverLaunchers = discoverLaunchers;
exports.deriveDesktopRuntime = deriveDesktopRuntime;
exports.buildSpawnPlan = buildSpawnPlan;
exports.splitArgs = splitArgs;
exports.resolveDshHome = resolveDshHome;
exports.parseDefaultModelPatch = parseDefaultModelPatch;
exports.detectDesktopRoute = detectDesktopRoute;
exports.buildOverrideYaml = buildOverrideYaml;
/**
 * Discovers the DeepSeek Harness launcher, spawns `dsh acp`, and owns its
 * lifecycle. Path/spawn planning is pure and unit-tested; the class performs
 * the actual child-process work.
 */
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const node_os_1 = require("node:os");
const node_path_1 = require("node:path");
const client_ts_1 = require("./acp/client.ts");
const RUNTIME_RELATIVE = ["resources", "runtime", "cli", "bin"];
const CLI_SCRIPT_RELATIVE = [
    "app.asar",
    "dsh",
    "node_modules",
    "@deepseek-ai",
    "dsh-desktop-host",
    "lib",
    "cli.js",
];
const MAX_LOG_LINES = 400;
function pathDirectories(env, platform) {
    const raw = platform === "win32" ? env.Path ?? env.PATH ?? "" : env.PATH ?? "";
    return raw.split(node_path_1.delimiter).map((entry) => entry.trim()).filter((entry) => entry.length > 0);
}
function commandNames(platform) {
    return platform === "win32" ? ["dsh.cmd", "dsh.exe", "dsh.bat"] : ["dsh"];
}
function desktopLauncherCandidates(deps) {
    const { platform, env, home } = deps;
    const candidates = [];
    if (platform === "win32") {
        const roots = [
            env.LOCALAPPDATA,
            env.ProgramFiles,
            env["ProgramFiles(x86)"],
        ].filter((value) => typeof value === "string" && value.length > 0);
        for (const root of roots) {
            candidates.push({
                launcher: (0, node_path_1.join)(root, "Programs", "DeepSeek Harness", ...RUNTIME_RELATIVE, "dsh.cmd"),
                source: "desktop-install",
            });
            candidates.push({
                launcher: (0, node_path_1.join)(root, "DeepSeek Harness", ...RUNTIME_RELATIVE, "dsh.cmd"),
                source: "desktop-install",
            });
        }
    }
    else if (platform === "darwin") {
        for (const root of ["/Applications", (0, node_path_1.join)(home, "Applications")]) {
            candidates.push({
                launcher: (0, node_path_1.join)(root, "DeepSeek Harness.app", "Contents", "Resources", "runtime", "cli", "bin", "dsh"),
                source: "desktop-install",
            });
        }
    }
    else {
        for (const root of [
            "/opt/DeepSeek Harness",
            "/usr/lib/deepseek-harness",
            (0, node_path_1.join)(home, ".local", "share", "deepseek-harness"),
        ]) {
            candidates.push({
                launcher: (0, node_path_1.join)(root, "resources", "runtime", "cli", "bin", "dsh"),
                source: "desktop-install",
            });
        }
    }
    return candidates;
}
/** Ordered launcher candidates: explicit setting, PATH, then desktop installs. */
function discoverLaunchers(settings, deps) {
    const out = [];
    const configured = settings.launcherPath.trim();
    if (configured.length > 0) {
        out.push({ launcher: configured, kind: "cli", source: "setting" });
    }
    for (const directory of pathDirectories(deps.env, deps.platform)) {
        for (const name of commandNames(deps.platform)) {
            const candidate = (0, node_path_1.join)(directory, name);
            if (deps.exists(candidate)) {
                out.push({ launcher: candidate, kind: "cli", source: "path" });
            }
        }
    }
    for (const candidate of desktopLauncherCandidates(deps)) {
        if (deps.exists(candidate.launcher)) {
            out.push({ launcher: candidate.launcher, kind: "desktop", source: candidate.source });
        }
    }
    const unique = [];
    const seen = new Set();
    for (const info of out) {
        const key = deps.platform === "win32" ? info.launcher.toLowerCase() : info.launcher;
        if (seen.has(key))
            continue;
        seen.add(key);
        unique.push(info);
    }
    return unique;
}
/** Derive the packaged Electron executable and CLI script from a desktop launcher path. */
function deriveDesktopRuntime(launcher, platform, exists) {
    const binDir = (0, node_path_1.dirname)(launcher);
    const resourcesDir = (0, node_path_1.resolve)(binDir, "..", "..", "..");
    const archive = (0, node_path_1.join)(resourcesDir, "app.asar");
    const cliScript = (0, node_path_1.join)(resourcesDir, ...CLI_SCRIPT_RELATIVE);
    // Files inside app.asar are virtual to the OS, so accept the archive itself.
    if (!exists(cliScript) && !exists(archive))
        return null;
    if (platform === "darwin") {
        const electronExecutable = (0, node_path_1.resolve)(resourcesDir, "..", "MacOS", "DeepSeek Harness");
        return { electronExecutable, cliScript };
    }
    const installDir = (0, node_path_1.resolve)(resourcesDir, "..");
    const electronExecutable = platform === "win32"
        ? (0, node_path_1.join)(installDir, "DeepSeek Harness.exe")
        : (0, node_path_1.join)(installDir, "deepseek-harness");
    if (platform === "win32" && !exists(electronExecutable))
        return null;
    return { electronExecutable, cliScript };
}
function quoteWindowsCommand(parts) {
    return parts
        .map((part) => (/[\s"]/u.test(part) ? `"${part.replace(/"/g, '""')}"` : part))
        .join(" ");
}
/** Build the concrete spawn plan for a launcher and app arguments. */
function buildSpawnPlan(input) {
    const exists = input.exists ?? node_fs_1.existsSync;
    const env = {};
    for (const [key, value] of Object.entries(input.env)) {
        if (typeof value === "string")
            env[key] = value;
    }
    const desktop = deriveDesktopRuntime(input.launcher.launcher, input.platform, exists);
    if (desktop && input.platform === "win32") {
        return {
            command: desktop.electronExecutable,
            args: ["--expose-internals", desktop.cliScript, ...input.cliArgs],
            env: {
                ...env,
                ELECTRON_RUN_AS_NODE: "1",
                DSH_DESKTOP_NODE_EXECUTABLE: desktop.electronExecutable,
            },
            display: `${desktop.electronExecutable} ${input.cliArgs.join(" ")}`,
            mode: "desktop-electron",
        };
    }
    if (desktop) {
        return {
            command: input.launcher.launcher,
            args: [...input.cliArgs],
            env: { ...env, DSH_DESKTOP_NODE_EXECUTABLE: desktop.electronExecutable },
            display: `${input.launcher.launcher} ${input.cliArgs.join(" ")}`,
            mode: "direct",
        };
    }
    const isWindowsScript = input.platform === "win32" && /\.(cmd|bat)$/iu.test(input.launcher.launcher);
    if (isWindowsScript) {
        // cmd.exe shims must run through the shell. Node wraps this single command
        // string in `cmd.exe /d /s /c "…"` with verbatim argument handling.
        return {
            command: quoteWindowsCommand([input.launcher.launcher, ...input.cliArgs]),
            args: [],
            env: { ...env },
            display: `${input.launcher.launcher} ${input.cliArgs.join(" ")}`,
            mode: "windows-cmd",
            shell: true,
        };
    }
    return {
        command: input.launcher.launcher,
        args: [...input.cliArgs],
        env,
        display: `${input.launcher.launcher} ${input.cliArgs.join(" ")}`,
        mode: "direct",
    };
}
/** Split a user-supplied argument string, honouring simple quoting. */
function splitArgs(input) {
    const args = [];
    let current = "";
    let quote = null;
    let started = false;
    for (const char of input) {
        if (quote !== null) {
            if (char === quote)
                quote = null;
            else
                current += char;
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            started = true;
            continue;
        }
        if (/\s/u.test(char)) {
            if (started || current.length > 0)
                args.push(current);
            current = "";
            started = false;
            continue;
        }
        current += char;
        started = true;
    }
    if (started || current.length > 0)
        args.push(current);
    return args;
}
function resolveDshHome(configured, env, home) {
    const explicit = configured.trim();
    if (explicit.length > 0)
        return explicit;
    const fromEnv = env.DSH_HOME?.trim();
    if (fromEnv)
        return fromEnv;
    return (0, node_path_1.join)(home, ".dsh");
}
function stripYamlScalar(value) {
    let out = value.trim();
    const comment = out.search(/\s+#/u);
    if (comment >= 0)
        out = out.slice(0, comment).trim();
    if ((out.startsWith('"') && out.endsWith('"')) ||
        (out.startsWith("'") && out.endsWith("'"))) {
        out = out.slice(1, -1);
    }
    return out.trim();
}
/** Read the provider/model the desktop profile pins in its user patch layer. */
function parseDefaultModelPatch(text) {
    const lines = text.split(/\r?\n/u);
    let start = -1;
    for (let index = 0; index < lines.length; index += 1) {
        if (/^\s*-\s+id:\s*agent-default-model\b/u.test(lines[index])) {
            start = index;
            break;
        }
    }
    if (start < 0)
        return null;
    let provider = "";
    let model = "";
    for (let index = start + 1; index < lines.length; index += 1) {
        const line = lines[index];
        if (/^\s*-\s+(id|insert|name):/u.test(line) && !/^\s*-\s+id:\s*agent-default-model\b/u.test(line))
            break;
        const providerMatch = /^\s*provider:\s*(.+)$/u.exec(line);
        if (providerMatch)
            provider = stripYamlScalar(providerMatch[1]);
        const modelMatch = /^\s*model:\s*(.+)$/u.exec(line);
        if (modelMatch)
            model = stripYamlScalar(modelMatch[1]);
    }
    if (!provider || !model)
        return null;
    return { provider, model };
}
/** Look for the desktop/web profile's pinned default route. */
function detectDesktopRoute(dshHome, readFile) {
    for (const profile of ["desktop", "web"]) {
        const text = readFile((0, node_path_1.join)(dshHome, "profiles", profile, "cordis.patch.yml"));
        if (!text)
            continue;
        const route = parseDefaultModelPatch(text);
        if (route)
            return route;
    }
    return null;
}
/** YAML text for the generated `--patch` overlay, or null when nothing is needed. */
function buildOverrideYaml(route, extraPatch) {
    const sections = [];
    if (route) {
        sections.push([
            "- id: acp",
            "  name: '@deepseek-ai/dsh-acp'",
            "  config:",
            `    provider: ${JSON.stringify(route.provider)}`,
            `    model: ${JSON.stringify(route.model)}`,
        ].join("\n"));
    }
    const extra = extraPatch.trim();
    if (extra.length > 0)
        sections.push(extra);
    if (sections.length === 0)
        return null;
    return `${sections.join("\n")}\n`;
}
function waitForExit(child, timeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null)
        return Promise.resolve(true);
    return new Promise((resolvePromise) => {
        let settled = false;
        const finish = (exited) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            child.removeListener("exit", onExit);
            child.removeListener("close", onExit);
            resolvePromise(exited);
        };
        const onExit = () => finish(true);
        const timer = setTimeout(() => finish(false), timeoutMs);
        child.once("exit", onExit);
        child.once("close", onExit);
    });
}
class RuntimeError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = "RuntimeError";
        this.code = code;
    }
}
exports.RuntimeError = RuntimeError;
class DshRuntime {
    child = null;
    client = null;
    phase = "idle";
    detail = "";
    firstStart = false;
    logLines = [];
    startPromise = null;
    expectedStop = false;
    launcher = null;
    hooks;
    constructor(hooks) {
        this.hooks = hooks;
    }
    get status() {
        return { phase: this.phase, detail: this.detail, firstStart: this.firstStart };
    }
    get logText() {
        return this.logLines.join("\n");
    }
    discoveryDeps() {
        return {
            platform: process.platform,
            env: process.env,
            home: (0, node_os_1.homedir)(),
            exists: node_fs_1.existsSync,
        };
    }
    resolveLauncher() {
        const found = discoverLaunchers(this.hooks.getSettings(), this.discoveryDeps());
        this.launcher = found[0] ?? null;
        return this.launcher;
    }
    async probe() {
        const previousPhase = this.phase;
        this.phase = "probing";
        this.hooks.onStatus(this.status);
        try {
            const launcher = this.resolveLauncher();
            if (!launcher) {
                this.phase = previousPhase;
                this.hooks.onStatus(this.status);
                return { ok: false, detail: "no launcher found" };
            }
            const plan = this.buildPlan(launcher, ["--version"]);
            this.pushLog(`probe: ${plan.display}`);
            const result = await this.runProbe(plan);
            this.phase = previousPhase;
            this.hooks.onStatus(this.status);
            if (result.ok) {
                this.launcher = launcher;
                return { ok: true, detail: result.detail, launcher: launcher.launcher };
            }
            return result;
        }
        catch (error) {
            this.phase = previousPhase;
            this.hooks.onStatus(this.status);
            return { ok: false, detail: error instanceof Error ? error.message : String(error) };
        }
    }
    async ensure() {
        if (this.client && this.phase === "ready" && !this.client.isDisposed)
            return this.client;
        if (this.startPromise)
            return await this.startPromise;
        this.startPromise = this.start().finally(() => {
            this.startPromise = null;
        });
        return await this.startPromise;
    }
    async restart() {
        await this.stop("restart");
        return await this.ensure();
    }
    async start() {
        if (this.child) {
            throw new RuntimeError("spawn", "the runtime process is already running");
        }
        const settings = this.hooks.getSettings();
        const env = process.env;
        const dshHome = resolveDshHome(settings.dshHome, env, (0, node_os_1.homedir)());
        const launcher = this.resolveLauncher();
        if (!launcher) {
            this.phase = "error";
            this.detail = "not-found";
            this.hooks.onStatus(this.status);
            throw new RuntimeError("not-found", "DeepSeek Harness launcher was not found");
        }
        this.launcher = launcher;
        this.firstStart = !this.profileExists(dshHome, "acp");
        this.phase = "starting";
        this.detail = this.firstStart ? "first-start" : "";
        this.hooks.onStatus(this.status);
        const patchPath = this.writeOverridePatch(settings, dshHome);
        const cliArgs = ["acp"];
        if (patchPath)
            cliArgs.push("--patch", patchPath);
        cliArgs.push(...splitArgs(settings.extraArgs));
        const plan = this.buildPlan(launcher, cliArgs, dshHome);
        this.pushLog(`spawn (${plan.mode}): ${plan.display}`);
        const child = (0, node_child_process_1.spawn)(plan.command, plan.args, {
            cwd: this.hooks.vaultPath,
            env: plan.env,
            stdio: ["pipe", "pipe", "pipe"],
            windowsHide: true,
            shell: plan.shell === true,
        });
        this.child = child;
        const client = new client_ts_1.AcpClient({
            input: child.stdout,
            output: child.stdin,
            clientName: "obsidian-dsh-agent",
            clientVersion: this.hooks.clientVersion,
            onUpdate: this.hooks.onUpdate,
            onPermission: this.hooks.onPermission,
            onLog: (entry) => {
                if (this.hooks.getSettings().debugLog) {
                    this.pushLog(`[${entry.direction}] ${entry.text}`);
                }
            },
        });
        this.client = client;
        child.stderr?.setEncoding("utf8");
        let stderrBuffer = "";
        child.stderr?.on("data", (chunk) => {
            stderrBuffer += chunk;
            let newline = stderrBuffer.indexOf("\n");
            while (newline >= 0) {
                const line = stderrBuffer.slice(0, newline).replace(/\r$/, "");
                stderrBuffer = stderrBuffer.slice(newline + 1);
                if (line.trim().length > 0)
                    this.pushLog(`[stderr] ${stripAnsi(line)}`);
                newline = stderrBuffer.indexOf("\n");
            }
        });
        child.once("error", (error) => {
            this.pushLog(`spawn error: ${error.message}`);
            if (this.phase === "starting") {
                this.phase = "error";
                this.detail = error.message;
                this.hooks.onStatus(this.status);
            }
        });
        child.once("exit", (code, signal) => {
            const expected = this.expectedStop;
            this.expectedStop = false;
            this.pushLog(`runtime exited (code=${String(code)}, signal=${String(signal)})`);
            client.dispose(new RuntimeError("stopped", `runtime exited (code=${String(code)})`));
            this.child = null;
            this.client = null;
            if (this.phase !== "error") {
                this.phase = expected ? "stopped" : "error";
                this.detail = expected ? "" : `exit ${String(code ?? signal)}`;
            }
            this.hooks.onStatus(this.status);
            this.hooks.onExit({ code, signal, expected });
        });
        let rejectSpawn = null;
        const spawnFailure = new Promise((_resolve, reject) => {
            rejectSpawn = reject;
        });
        child.once("error", (error) => {
            rejectSpawn?.(error);
        });
        try {
            const result = await Promise.race([client.initialize(), spawnFailure]);
            rejectSpawn = null;
            if (result.protocolVersion !== 1) {
                this.pushLog(`warning: agent speaks ACP protocol version ${result.protocolVersion}; continuing`);
            }
            this.phase = "ready";
            this.detail = result.agentInfo?.version ?? "";
            this.hooks.onStatus(this.status);
            return client;
        }
        catch (error) {
            this.pushLog(`initialize failed: ${error instanceof Error ? error.message : String(error)}`);
            this.phase = "error";
            this.detail = error instanceof Error ? error.message : String(error);
            this.hooks.onStatus(this.status);
            this.expectedStop = true;
            await this.terminate(child);
            throw new RuntimeError("initialize", error instanceof Error ? error.message : String(error));
        }
    }
    async stop(reason = "stop") {
        this.pushLog(`stop requested (${reason})`);
        this.expectedStop = true;
        const child = this.child;
        this.client?.dispose(new RuntimeError("stopped", "runtime stopped"));
        this.client = null;
        if (!child) {
            if (this.phase !== "stopped") {
                this.phase = "stopped";
                this.detail = "";
                this.hooks.onStatus(this.status);
            }
            return;
        }
        try {
            child.stdin?.end();
        }
        catch {
            // stdin may already be closed
        }
        const exited = await waitForExit(child, 2500);
        if (!exited)
            await this.terminate(child);
        this.child = null;
        if (this.phase !== "stopped" && this.phase !== "error") {
            this.phase = "stopped";
            this.detail = "";
            this.hooks.onStatus(this.status);
        }
    }
    async terminate(child) {
        try {
            child.kill();
        }
        catch {
            // ignore
        }
        const exited = await waitForExit(child, 1500);
        if (exited)
            return;
        if (process.platform === "win32" && child.pid !== undefined) {
            try {
                const killer = (0, node_child_process_1.spawn)("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
                    stdio: "ignore",
                    windowsHide: true,
                });
                killer.on("error", () => undefined);
            }
            catch {
                // best effort
            }
        }
    }
    buildPlan(launcher, cliArgs, dshHome) {
        const env = { ...process.env };
        const home = dshHome ?? resolveDshHome(this.hooks.getSettings().dshHome, env, (0, node_os_1.homedir)());
        env.DSH_HOME = home;
        return buildSpawnPlan({
            launcher,
            platform: process.platform,
            env,
            cliArgs,
            exists: node_fs_1.existsSync,
        });
    }
    profileExists(dshHome, profile) {
        return (0, node_fs_1.existsSync)((0, node_path_1.join)(dshHome, "profiles", profile, "package.json"));
    }
    writeOverridePatch(settings, dshHome) {
        const explicitProvider = settings.provider.trim();
        const explicitModel = settings.model.trim();
        const detected = explicitProvider && explicitModel
            ? null
            : detectDesktopRoute(dshHome, (file) => {
                try {
                    return (0, node_fs_1.readFileSync)(file, "utf8");
                }
                catch {
                    return null;
                }
            });
        let route = null;
        if (explicitProvider || explicitModel) {
            const provider = explicitProvider || detected?.provider || "";
            const model = explicitModel || detected?.model || "";
            if (provider && model)
                route = { provider, model };
        }
        else {
            route = detected;
        }
        const yaml = buildOverrideYaml(route, settings.extraPatchYaml);
        if (!yaml)
            return null;
        if (route)
            this.pushLog(`model route override: ${route.provider}/${route.model}`);
        const dir = (0, node_path_1.join)(this.hooks.pluginDir, "runtime");
        const file = (0, node_path_1.join)(dir, "acp-override.yml");
        try {
            (0, node_fs_1.mkdirSync)(dir, { recursive: true });
            let current = null;
            try {
                current = (0, node_fs_1.readFileSync)(file, "utf8");
            }
            catch {
                current = null;
            }
            if (current !== yaml)
                (0, node_fs_1.writeFileSync)(file, yaml, "utf8");
            return file;
        }
        catch (error) {
            this.pushLog(`failed to write override patch: ${String(error)}`);
            return null;
        }
    }
    async runProbe(plan) {
        return await new Promise((resolvePromise) => {
            let output = "";
            let settled = false;
            const child = (0, node_child_process_1.spawn)(plan.command, plan.args, {
                cwd: this.hooks.vaultPath,
                env: plan.env,
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true,
                shell: plan.shell === true,
            });
            const finish = (result) => {
                if (settled)
                    return;
                settled = true;
                clearTimeout(timer);
                resolvePromise(result);
            };
            const timer = setTimeout(() => {
                try {
                    child.kill();
                }
                catch {
                    // ignore
                }
                finish({ ok: false, detail: "probe timed out" });
            }, 15_000);
            child.stdout?.setEncoding("utf8");
            child.stderr?.setEncoding("utf8");
            child.stdout?.on("data", (chunk) => {
                output += chunk;
            });
            child.stderr?.on("data", (chunk) => {
                output += chunk;
            });
            child.once("error", (error) => finish({ ok: false, detail: error.message }));
            child.once("exit", (code) => {
                const text = stripAnsi(output).trim();
                const firstLine = text.split(/\r?\n/u).find((line) => line.trim().length > 0) ?? "";
                if (code === 0)
                    finish({ ok: true, detail: firstLine || "ok" });
                else
                    finish({ ok: false, detail: firstLine || `exit ${String(code)}` });
            });
        });
    }
    pushLog(line) {
        this.logLines.push(line);
        if (this.logLines.length > MAX_LOG_LINES) {
            this.logLines.splice(0, this.logLines.length - MAX_LOG_LINES);
        }
        this.hooks.onLog(line);
    }
}
exports.DshRuntime = DshRuntime;
function stripAnsi(value) {
    return value.replace(/\u001b\[[0-9;]*m/gu, "");
}

},
function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionController = void 0;
const protocol_ts_1 = require("./acp/protocol.ts");
const transcript_ts_1 = require("./transcript.ts");
const PERSIST_DEBOUNCE_MS = 400;
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function pickAllowOption(options) {
    const once = options.find((option) => option.kind === "allow_once");
    if (once)
        return once.optionId;
    const allow = options.find((option) => option.kind.startsWith("allow"));
    return allow?.optionId ?? options[0]?.optionId ?? "allow-once";
}
function pickRejectOption(options) {
    const once = options.find((option) => option.kind === "reject_once");
    if (once)
        return once.optionId;
    const reject = options.find((option) => option.kind.startsWith("reject"));
    return reject?.optionId ?? options[options.length - 1]?.optionId ?? "reject-once";
}
function cancelledOutcome() {
    return { outcome: { outcome: "cancelled" } };
}
class SessionController {
    client = null;
    builder = null;
    meta = null;
    attached = false;
    busy = false;
    configOptions = [];
    pendingPermissions = new Map();
    persistTimer = null;
    promptGeneration = 0;
    hooks;
    constructor(hooks) {
        this.hooks = hooks;
    }
    setClient(client) {
        if (this.client === client)
            return;
        this.client = client;
        this.attached = false;
    }
    get hasSession() {
        return this.builder !== null && this.sessionId !== null;
    }
    get isAttached() {
        return this.attached;
    }
    get sessionId() {
        return this.meta?.id ?? null;
    }
    get state() {
        return {
            sessionId: this.sessionId,
            title: this.meta?.title ?? null,
            attached: this.attached,
            busy: this.busy,
            items: this.builder?.all ?? [],
            usage: this.builder?.getUsage() ?? null,
            configOptions: this.configOptions,
        };
    }
    async startNew() {
        const client = this.requireClient();
        if (this.busy)
            throw new Error("a prompt is already in flight");
        const result = await client.newSession(this.hooks.cwd, this.hooks.getMcpServers());
        const now = Date.now();
        this.meta = {
            id: result.sessionId,
            title: "",
            cwd: this.hooks.cwd,
            createdAt: now,
            updatedAt: now,
        };
        this.builder = new transcript_ts_1.TranscriptBuilder(result.sessionId, this.hooks.cwd, now);
        this.configOptions = result.configOptions ?? [];
        this.attached = true;
        this.hooks.updateMeta({ ...this.meta });
        await this.applyStoredRoute();
        this.notify();
        this.persistNow();
    }
    async resume(sessionId, snapshot, meta) {
        const client = this.requireClient();
        if (this.busy)
            throw new Error("a prompt is already in flight");
        const configOptions = await client.resumeSession(sessionId, this.hooks.cwd, this.hooks.getMcpServers());
        const now = Date.now();
        this.meta = meta ? { ...meta, cwd: meta.cwd || this.hooks.cwd, updatedAt: now } : {
            id: sessionId,
            title: "",
            cwd: this.hooks.cwd,
            createdAt: now,
            updatedAt: now,
        };
        const restored = snapshot ? transcript_ts_1.TranscriptBuilder.fromSnapshot(snapshot) : null;
        this.builder =
            restored && restored.sessionId === sessionId
                ? restored
                : new transcript_ts_1.TranscriptBuilder(sessionId, this.hooks.cwd, this.meta.createdAt);
        this.configOptions = configOptions;
        this.attached = true;
        this.hooks.updateMeta({ ...this.meta });
        await this.applyStoredRoute();
        if (!snapshot) {
            // A foreign session has no local transcript; say so once.
            this.addNoticeOnce("info", this.hooks.t("notice.historyUnavailable"));
        }
        this.notify();
        this.persistSoon(0);
    }
    /** Reattach the current persisted session after the runtime process restarted. */
    async reattach() {
        const client = this.requireClient();
        const sessionId = this.sessionId;
        if (!sessionId)
            return false;
        const configOptions = await client.resumeSession(sessionId, this.hooks.cwd, this.hooks.getMcpServers());
        this.configOptions = configOptions;
        this.attached = true;
        await this.applyStoredRoute();
        this.notify();
        return true;
    }
    async close() {
        this.cancelPendingPermissions();
        if (this.busy)
            this.cancel();
        this.persistNow();
        this.promptGeneration += 1;
        const client = this.client;
        const sessionId = this.sessionId;
        this.meta = null;
        this.builder = null;
        this.configOptions = [];
        this.attached = false;
        this.busy = false;
        this.notify();
        if (sessionId && client && !client.isDisposed) {
            try {
                await client.closeSession(sessionId);
            }
            catch {
                // Closing is best effort; the runtime may already be gone.
            }
        }
    }
    async send(displayText, promptBlocks, meta = {}) {
        const client = this.requireClient();
        const sessionId = this.sessionId;
        const builder = this.builder;
        if (!sessionId || !builder)
            throw new Error("no active session");
        if (!this.attached)
            throw new Error("session is not attached to the runtime");
        if (this.busy)
            throw new Error("a prompt is already in flight");
        this.busy = true;
        const generation = ++this.promptGeneration;
        builder.addUser(displayText, meta);
        if (this.meta && this.meta.title.length === 0) {
            const title = displayText.replace(/\s+/gu, " ").trim().slice(0, 60);
            if (title.length > 0) {
                this.meta.title = title;
                this.hooks.updateMeta({ ...this.meta });
            }
        }
        this.notify();
        this.persistNow();
        try {
            const result = await client.prompt(sessionId, promptBlocks);
            builder.markAssistantDone();
            this.handleStopReason(result.stopReason);
        }
        catch (error) {
            builder.markAssistantDone();
            builder.addNotice("error", this.hooks.t("notice.promptFailed", { message: errorMessage(error) }));
        }
        finally {
            if (this.promptGeneration === generation) {
                this.busy = false;
                this.notify();
                this.persistSoon(0);
            }
        }
    }
    cancel() {
        const client = this.client;
        const sessionId = this.sessionId;
        if (!client || !sessionId || !this.busy || client.isDisposed)
            return;
        client.cancel(sessionId);
    }
    /** Called when the chat view closes: unanswered permissions must not block the agent. */
    cancelPendingForHiddenUi() {
        if (this.pendingPermissions.size === 0)
            return;
        this.cancelPendingPermissions();
        this.notify();
    }
    async setConfigOption(configId, value) {
        const client = this.requireClient();
        const sessionId = this.sessionId;
        if (!sessionId)
            throw new Error("no active session");
        const options = await client.setConfigOption(sessionId, configId, value);
        this.configOptions = options;
        this.hooks.rememberConfig(configId, value);
        this.notify();
    }
    onUpdate(params) {
        if (!params || params.sessionId !== this.sessionId)
            return;
        const update = params.update;
        if (!update || typeof update !== "object")
            return;
        if (update.sessionUpdate === "config_option_update") {
            this.configOptions = (0, protocol_ts_1.normalizeConfigOptions)(update.configOptions);
            this.notify();
            return;
        }
        if (!this.builder)
            return;
        const changed = this.builder.applyUpdate(update).changed;
        if (!changed)
            return;
        this.notify();
        this.persistSoon();
    }
    onPermissionRequest(request) {
        if (!this.builder || request.sessionId !== this.sessionId) {
            return Promise.resolve(cancelledOutcome());
        }
        const item = this.builder.addPermission(request);
        if (this.hooks.getAutoApprove()) {
            this.builder.decidePermission(item.id, "auto");
            this.notify();
            this.persistSoon(200);
            return Promise.resolve({
                outcome: { outcome: "selected", optionId: pickAllowOption(item.options) },
            });
        }
        this.notify();
        this.persistSoon(200);
        return new Promise((resolve) => {
            this.pendingPermissions.set(item.id, { resolve, options: item.options });
        });
    }
    resolvePermission(itemId, decision, optionId) {
        const pending = this.pendingPermissions.get(itemId);
        if (!pending)
            return false;
        this.pendingPermissions.delete(itemId);
        const explicit = optionId && pending.options.some((option) => option.optionId === optionId)
            ? optionId
            : undefined;
        const chosen = explicit ??
            (decision === "allowed" ? pickAllowOption(pending.options) : pickRejectOption(pending.options));
        const typed = decision;
        this.builder?.decidePermission(itemId, typed);
        pending.resolve({ outcome: { outcome: "selected", optionId: chosen } });
        this.notify();
        this.persistSoon(200);
        return true;
    }
    /** Called when the runtime process exits: keep the transcript but drop the session binding. */
    onRuntimeLost() {
        this.cancelPendingPermissions();
        this.builder?.markAssistantDone();
        this.attached = false;
        this.busy = false;
        this.notify();
    }
    dispose() {
        this.cancelPendingPermissions();
        this.flushPersist();
    }
    /** Add a notice unless the transcript already ends with the exact same one. */
    addNoticeOnce(level, text) {
        if (!this.builder)
            return;
        const items = this.builder.all;
        const last = items[items.length - 1];
        if (last && last.type === "notice" && last.text === text)
            return;
        this.builder.addNotice(level, text);
    }
    requireClient() {
        if (!this.client || this.client.isDisposed) {
            throw new Error("the DSH runtime is not connected");
        }
        return this.client;
    }
    handleStopReason(reason) {
        if (!this.builder)
            return;
        switch (reason) {
            case "cancelled":
                this.builder.addNotice("info", this.hooks.t("notice.cancelled"));
                break;
            case "max_tokens":
                this.builder.addNotice("warn", this.hooks.t("notice.maxTokens"));
                break;
            case "max_turn_requests":
                this.builder.addNotice("warn", this.hooks.t("notice.maxTurnRequests"));
                break;
            case "refusal":
                this.builder.addNotice("warn", this.hooks.t("notice.refusal"));
                break;
            default:
                break;
        }
    }
    async applyStoredRoute() {
        const client = this.requireClient();
        const sessionId = this.sessionId;
        if (!sessionId)
            return;
        const model = this.hooks.getLastModelValue();
        if (model && this.hasSelectValue("model", model)) {
            try {
                this.configOptions = await client.setConfigOption(sessionId, "model", model);
            }
            catch {
                // The remembered model may no longer be available; keep the agent default.
            }
        }
        const effort = this.hooks.getLastEffort();
        if (effort !== "" && this.hasSelectValue("reasoning_effort", effort)) {
            try {
                this.configOptions = await client.setConfigOption(sessionId, "reasoning_effort", effort);
            }
            catch {
                // Same as above: the exact model may not expose that effort.
            }
        }
        this.rememberCurrentConfig();
    }
    rememberCurrentConfig() {
        for (const option of this.configOptions) {
            if (typeof option.currentValue === "string" && option.currentValue.length > 0) {
                this.hooks.rememberConfig(option.id, option.currentValue);
            }
        }
    }
    hasSelectValue(configId, value) {
        const option = this.configOptions.find((candidate) => candidate.id === configId);
        if (!option)
            return false;
        return (0, protocol_ts_1.selectOptionValues)(option).includes(value);
    }
    cancelPendingPermissions() {
        for (const [itemId, pending] of this.pendingPermissions) {
            this.builder?.decidePermission(itemId, "cancelled");
            pending.resolve(cancelledOutcome());
            this.pendingPermissions.delete(itemId);
        }
    }
    notify() {
        this.hooks.onChanged();
    }
    persistSoon(delayMs = PERSIST_DEBOUNCE_MS) {
        if (this.persistTimer !== null)
            clearTimeout(this.persistTimer);
        this.persistTimer = setTimeout(() => {
            this.persistTimer = null;
            this.persistNow();
        }, delayMs);
    }
    flushPersist() {
        if (this.persistTimer !== null) {
            clearTimeout(this.persistTimer);
            this.persistTimer = null;
        }
        this.persistNow();
    }
    persistNow() {
        const builder = this.builder;
        const meta = this.meta;
        if (!builder || !meta)
            return;
        meta.updatedAt = Date.now();
        const snapshot = builder.snapshot();
        snapshot.sessionId = meta.id;
        this.hooks.updateMeta({ ...meta });
        this.hooks.persist(snapshot);
    }
}
exports.SessionController = SessionController;

},
function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DshChatSettingTab = exports.DEFAULT_SETTINGS = void 0;
exports.normalizeSettings = normalizeSettings;
/**
 * Settings model, defaults, and the settings tab.
 */
const obsidian_1 = require("obsidian");
exports.DEFAULT_SETTINGS = {
    launcherPath: "",
    dshHome: "",
    provider: "",
    model: "",
    extraArgs: "",
    extraPatchYaml: "",
    mcpServersJson: "",
    includeActiveNote: true,
    includeSelection: true,
    maxContextChars: 8000,
    attachResourceLink: true,
    autoApproveTools: false,
    showReasoning: true,
    toolDisplay: "hidden",
    sendOnEnter: true,
    autoStartRuntime: false,
    debugLog: false,
    lastModelValue: "",
    lastReasoningEffort: "",
};
function normalizeSettings(raw) {
    const merged = { ...exports.DEFAULT_SETTINGS };
    if (!raw || typeof raw !== "object")
        return merged;
    const record = raw;
    for (const key of Object.keys(exports.DEFAULT_SETTINGS)) {
        const value = record[key];
        if (value === undefined || value === null)
            continue;
        const fallback = exports.DEFAULT_SETTINGS[key];
        if (typeof fallback === "boolean" && typeof value === "boolean") {
            merged[key] = value;
        }
        else if (typeof fallback === "number" && typeof value === "number" && Number.isFinite(value)) {
            merged[key] = value;
        }
        else if (typeof fallback === "string" && typeof value === "string") {
            merged[key] = value;
        }
    }
    merged.maxContextChars = Math.max(500, Math.min(200_000, Math.floor(merged.maxContextChars)));
    if (merged.toolDisplay !== "hidden" &&
        merged.toolDisplay !== "latest" &&
        merged.toolDisplay !== "all") {
        merged.toolDisplay = exports.DEFAULT_SETTINGS.toolDisplay;
    }
    return merged;
}
function isValidMcpJson(value) {
    const raw = value.trim();
    if (raw.length === 0)
        return true;
    try {
        return Array.isArray(JSON.parse(raw));
    }
    catch {
        return false;
    }
}
class DshChatSettingTab extends obsidian_1.PluginSettingTab {
    plugin;
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }
    display() {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.addClass("dsh-settings");
        const t = this.plugin.i18n.t.bind(this.plugin.i18n);
        this.renderHero(containerEl, t);
        this.renderConnection(containerEl, t);
        this.renderContext(containerEl, t);
        this.renderBehavior(containerEl, t);
        this.renderDiagnostics(containerEl, t);
        this.renderAdvanced(containerEl, t);
    }
    // ---------------------------------------------------------------- layout --
    card(container, title, hint) {
        const card = container.createDiv({ cls: "dsh-settings-card" });
        const head = card.createDiv({ cls: "dsh-settings-card-head" });
        head.createDiv({ cls: "dsh-settings-card-title", text: title });
        if (hint)
            head.createDiv({ cls: "dsh-settings-card-hint", text: hint });
        return card;
    }
    renderHero(container, t) {
        const hero = container.createDiv({ cls: "dsh-settings-hero" });
        const head = hero.createDiv({ cls: "dsh-settings-hero-head" });
        const icon = head.createDiv({ cls: "dsh-settings-hero-icon" });
        (0, obsidian_1.setIcon)(icon, "message-square");
        const copy = head.createDiv({ cls: "dsh-settings-hero-copy" });
        copy.createDiv({ cls: "dsh-settings-hero-title", text: "DSH Agent" });
        copy.createDiv({ cls: "dsh-settings-hero-subtitle", text: t("settings.hero.subtitle") });
        copy.createDiv({
            cls: "dsh-settings-hero-version",
            text: `v${this.plugin.manifest.version}`,
        });
        const statusRow = hero.createDiv({ cls: "dsh-settings-status" });
        const dot = statusRow.createSpan({ cls: "dsh-chat-dot" });
        const label = statusRow.createSpan({ cls: "dsh-settings-status-text" });
        const path = hero.createDiv({ cls: "dsh-settings-status-path" });
        const refresh = () => {
            const described = DshChatSettingTab.describeStatus(this.plugin.runtime.status, t);
            label.setText(described.text);
            dot.className = `dsh-chat-dot ${described.dot}`;
            const launcher = this.plugin.runtime.resolveLauncher();
            path.setText(launcher
                ? t("settings.status.launcher", { path: launcher.launcher })
                : t("settings.status.noLauncher"));
            path.title = launcher?.launcher ?? "";
        };
        refresh();
        const actions = hero.createDiv({ cls: "dsh-settings-actions" });
        const test = actions.createEl("button", {
            cls: "mod-cta",
            text: t("settings.actions.test"),
        });
        test.addEventListener("click", () => {
            void (async () => {
                test.disabled = true;
                test.setText(t("settings.detecting"));
                const result = await this.plugin.probeRuntime();
                new obsidian_1.Notice(result.ok
                    ? t("settings.detectOk", { detail: result.detail })
                    : t("settings.detectFail", { detail: result.detail }));
                test.disabled = false;
                test.setText(t("settings.actions.test"));
                refresh();
            })();
        });
        const restart = actions.createEl("button", { text: t("settings.actions.restart") });
        restart.addEventListener("click", () => {
            void this.plugin.restartRuntime();
        });
        const log = actions.createEl("button", { text: t("settings.actions.log") });
        log.addEventListener("click", () => this.plugin.showLogModal());
    }
    static describeStatus(status, t) {
        switch (status.phase) {
            case "probing":
                return { text: t("status.probing"), dot: "is-starting" };
            case "starting":
                return {
                    text: status.firstStart ? t("status.firstStart") : t("status.starting"),
                    dot: "is-starting",
                };
            case "ready":
                return { text: t("status.ready"), dot: "is-ready" };
            case "error":
                return {
                    text: status.detail === "not-found" ? t("status.notFound") : t("status.error"),
                    dot: "is-error",
                };
            case "stopped":
                return { text: t("status.stopped"), dot: "is-idle" };
            default:
                return { text: t("status.idle"), dot: "is-idle" };
        }
    }
    // ------------------------------------------------------------- sections --
    renderConnection(container, t) {
        const card = this.card(container, t("settings.card.connection.title"), t("settings.card.connection.hint"));
        new obsidian_1.Setting(card)
            .setName(t("settings.launcher.name"))
            .setDesc(t("settings.launcher.desc"))
            .addText((text) => text
            .setPlaceholder("…\\resources\\runtime\\cli\\bin\\dsh.cmd")
            .setValue(this.plugin.settings.launcherPath)
            .onChange(async (value) => {
            await this.plugin.updateSettings({ launcherPath: value.trim() });
        }));
        new obsidian_1.Setting(card)
            .setName(t("settings.home.name"))
            .setDesc(t("settings.home.desc"))
            .addText((text) => text
            .setPlaceholder("~/.dsh")
            .setValue(this.plugin.settings.dshHome)
            .onChange(async (value) => {
            await this.plugin.updateSettings({ dshHome: value.trim() });
        }));
        new obsidian_1.Setting(card)
            .setName(t("settings.provider.name"))
            .setDesc(t("settings.provider.desc"))
            .addText((text) => text
            .setPlaceholder("deepseek-account")
            .setValue(this.plugin.settings.provider)
            .onChange(async (value) => {
            await this.plugin.updateSettings({ provider: value.trim() });
        }));
        new obsidian_1.Setting(card)
            .setName(t("settings.model.name"))
            .setDesc(t("settings.model.desc"))
            .addText((text) => text
            .setPlaceholder("deepseek-flash")
            .setValue(this.plugin.settings.model)
            .onChange(async (value) => {
            await this.plugin.updateSettings({ model: value.trim() });
        }));
    }
    renderContext(container, t) {
        const card = this.card(container, t("settings.card.context.title"), t("settings.card.context.hint"));
        new obsidian_1.Setting(card)
            .setName(t("settings.includeNote.name"))
            .setDesc(t("settings.includeNote.desc"))
            .addToggle((toggle) => toggle.setValue(this.plugin.settings.includeActiveNote).onChange(async (value) => {
            await this.plugin.updateSettings({ includeActiveNote: value });
        }));
        new obsidian_1.Setting(card)
            .setName(t("settings.includeSelection.name"))
            .setDesc(t("settings.includeSelection.desc"))
            .addToggle((toggle) => toggle.setValue(this.plugin.settings.includeSelection).onChange(async (value) => {
            await this.plugin.updateSettings({ includeSelection: value });
        }));
        new obsidian_1.Setting(card)
            .setName(t("settings.maxChars.name"))
            .setDesc(t("settings.maxChars.desc"))
            .addText((text) => {
            text.inputEl.addClass("dsh-settings-number");
            text.setValue(String(this.plugin.settings.maxContextChars)).onChange(async (value) => {
                if (value.trim().length === 0)
                    return;
                const parsed = Number.parseInt(value, 10);
                if (!Number.isFinite(parsed) || parsed <= 0) {
                    new obsidian_1.Notice(t("settings.invalidNumber"));
                    return;
                }
                await this.plugin.updateSettings({
                    maxContextChars: Math.max(500, Math.min(200_000, parsed)),
                });
            });
        });
        new obsidian_1.Setting(card)
            .setName(t("settings.resourceLink.name"))
            .setDesc(t("settings.resourceLink.desc"))
            .addToggle((toggle) => toggle.setValue(this.plugin.settings.attachResourceLink).onChange(async (value) => {
            await this.plugin.updateSettings({ attachResourceLink: value });
        }));
    }
    renderBehavior(container, t) {
        const card = this.card(container, t("settings.card.behavior.title"), t("settings.card.behavior.hint"));
        new obsidian_1.Setting(card)
            .setName(t("settings.autoApprove.name"))
            .setDesc(t("settings.autoApprove.desc"))
            .setClass("dsh-settings-warning")
            .addToggle((toggle) => toggle.setValue(this.plugin.settings.autoApproveTools).onChange(async (value) => {
            await this.plugin.updateSettings({ autoApproveTools: value });
        }));
        new obsidian_1.Setting(card)
            .setName(t("settings.toolDisplay.name"))
            .setDesc(t("settings.toolDisplay.desc"))
            .addDropdown((dropdown) => dropdown
            .addOptions({
            hidden: t("settings.toolDisplay.hidden"),
            latest: t("settings.toolDisplay.latest"),
            all: t("settings.toolDisplay.all"),
        })
            .setValue(this.plugin.settings.toolDisplay)
            .onChange(async (value) => {
            await this.plugin.updateSettings({ toolDisplay: value });
        }));
        new obsidian_1.Setting(card)
            .setName(t("settings.showReasoning.name"))
            .setDesc(t("settings.showReasoning.desc"))
            .addToggle((toggle) => toggle.setValue(this.plugin.settings.showReasoning).onChange(async (value) => {
            await this.plugin.updateSettings({ showReasoning: value });
        }));
        new obsidian_1.Setting(card)
            .setName(t("settings.sendOnEnter.name"))
            .setDesc(t("settings.sendOnEnter.desc"))
            .addToggle((toggle) => toggle.setValue(this.plugin.settings.sendOnEnter).onChange(async (value) => {
            await this.plugin.updateSettings({ sendOnEnter: value });
        }));
        new obsidian_1.Setting(card)
            .setName(t("settings.autoStart.name"))
            .setDesc(t("settings.autoStart.desc"))
            .addToggle((toggle) => toggle.setValue(this.plugin.settings.autoStartRuntime).onChange(async (value) => {
            await this.plugin.updateSettings({ autoStartRuntime: value });
        }));
    }
    renderDiagnostics(container, t) {
        const card = this.card(container, t("settings.card.diagnostics.title"), t("settings.card.diagnostics.hint"));
        new obsidian_1.Setting(card)
            .setName(t("settings.debugLog.name"))
            .setDesc(t("settings.debugLog.desc"))
            .addToggle((toggle) => toggle.setValue(this.plugin.settings.debugLog).onChange(async (value) => {
            await this.plugin.updateSettings({ debugLog: value });
        }));
    }
    renderAdvanced(container, t) {
        const details = container.createEl("details", { cls: "dsh-settings-advanced" });
        details.createEl("summary", { text: t("settings.advanced") });
        const card = details.createDiv({ cls: "dsh-settings-card dsh-settings-advanced-card" });
        new obsidian_1.Setting(card)
            .setName(t("settings.extraArgs.name"))
            .setDesc(t("settings.extraArgs.desc"))
            .addText((text) => text
            .setPlaceholder("--dump-config")
            .setValue(this.plugin.settings.extraArgs)
            .onChange(async (value) => {
            await this.plugin.updateSettings({ extraArgs: value.trim() });
        }));
        new obsidian_1.Setting(card)
            .setName(t("settings.extraPatch.name"))
            .setDesc(t("settings.extraPatch.desc"))
            .addTextArea((area) => {
            area.inputEl.rows = 4;
            area
                .setPlaceholder("- id: deepseek-account\n  config:\n    desktopPlatform: win32")
                .setValue(this.plugin.settings.extraPatchYaml)
                .onChange(async (value) => {
                await this.plugin.updateSettings({ extraPatchYaml: value });
            });
        });
        new obsidian_1.Setting(card)
            .setName(t("settings.mcp.name"))
            .setDesc(t("settings.mcp.desc"))
            .addTextArea((area) => {
            area.inputEl.rows = 4;
            area
                .setPlaceholder('[{"name":"fs","command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","."]}]')
                .setValue(this.plugin.settings.mcpServersJson)
                .onChange(async (value) => {
                await this.plugin.updateSettings({ mcpServersJson: value });
            });
            area.inputEl.addEventListener("blur", () => {
                if (!isValidMcpJson(area.inputEl.value)) {
                    new obsidian_1.Notice(t("settings.invalidMcpJson"));
                }
            });
        });
    }
}
exports.DshChatSettingTab = DshChatSettingTab;

},
function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PluginStore = void 0;
const promises_1 = require("node:fs/promises");
const node_path_1 = require("node:path");
function safeSessionId(sessionId) {
    return sessionId.replace(/[^A-Za-z0-9_-]/gu, "_");
}
class PluginStore {
    adapter;
    pluginDir;
    basePath;
    tempCounter = 0;
    writeChain = Promise.resolve();
    constructor(app, pluginDir) {
        this.adapter = app.vault.adapter;
        this.pluginDir = pluginDir;
        const maybeFileSystem = this.adapter;
        this.basePath =
            typeof maybeFileSystem.getBasePath === "function" ? maybeFileSystem.getBasePath() : null;
    }
    normalizedDir() {
        return this.pluginDir.replace(/\\/gu, "/").replace(/\/+$/u, "");
    }
    transcriptsDir() {
        return `${this.normalizedDir()}/transcripts`;
    }
    transcriptPath(sessionId) {
        return `${this.transcriptsDir()}/${safeSessionId(sessionId)}.json`;
    }
    async ensureDir() {
        const dir = this.transcriptsDir();
        if (await this.adapter.exists(dir))
            return;
        try {
            await this.adapter.mkdir(dir);
        }
        catch (error) {
            if (!(await this.adapter.exists(dir)))
                throw error;
        }
    }
    async readTranscript(sessionId) {
        const path = this.transcriptPath(sessionId);
        try {
            if (!(await this.adapter.exists(path)))
                return { snapshot: null, corrupt: false };
            const text = await this.adapter.read(path);
            const parsed = JSON.parse(text);
            if (!parsed || typeof parsed !== "object")
                return { snapshot: null, corrupt: true };
            const snapshot = parsed;
            if (snapshot.version !== 1 || typeof snapshot.sessionId !== "string" || !Array.isArray(snapshot.items)) {
                return { snapshot: null, corrupt: true };
            }
            return { snapshot, corrupt: false };
        }
        catch {
            return { snapshot: null, corrupt: true };
        }
    }
    async writeTranscript(snapshot) {
        // Serialize writes so a slower older snapshot can never rename last.
        const run = () => this.writeSnapshot(snapshot);
        const next = this.writeChain.then(run, run);
        this.writeChain = next.then(() => undefined, () => undefined);
        return await next;
    }
    async writeSnapshot(snapshot) {
        await this.ensureDir();
        const target = this.transcriptPath(snapshot.sessionId);
        const data = JSON.stringify(snapshot);
        // Write to a sibling temp file first, then rename over the target. A crash
        // mid-write leaves the previous transcript intact instead of a truncated one.
        const temp = `${target}.${Date.now()}-${++this.tempCounter}.tmp`;
        await this.adapter.write(temp, data);
        // Obsidian's adapter.rename refuses to replace an existing destination; the
        // underlying fs rename does replace atomically, so prefer it on local vaults.
        if (this.basePath) {
            try {
                await (0, promises_1.rename)((0, node_path_1.join)(this.basePath, temp), (0, node_path_1.join)(this.basePath, target));
                return;
            }
            catch (error) {
                console.warn("[dsh-chat] atomic transcript rename failed; falling back", error);
            }
        }
        try {
            await this.adapter.rename(temp, target);
        }
        catch (error) {
            // Some platforms/filesystems cannot rename over an existing file.
            try {
                await this.adapter.write(target, data);
            }
            finally {
                try {
                    await this.adapter.remove(temp);
                }
                catch {
                    // best effort
                }
            }
            console.warn("[dsh-chat] atomic transcript rename failed; wrote directly", error);
        }
    }
}
exports.PluginStore = PluginStore;

},
function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TranscriptBuilder = void 0;
/**
 * Pure transcript model: turns ACP session updates into chat items.
 *
 * Kept free of Obsidian imports so it can be unit tested with `node --test`.
 */
const node_crypto_1 = require("node:crypto");
const protocol_ts_1 = require("./acp/protocol.ts");
const SNAPSHOT_VERSION = 1;
function toolContentTexts(value) {
    if (!Array.isArray(value))
        return [];
    const out = [];
    for (const entry of value) {
        if (!entry || typeof entry !== "object")
            continue;
        const record = entry;
        const type = record.type;
        if (type === "content" && record.content) {
            const text = (0, protocol_ts_1.textOfContent)(record.content);
            if (text !== null)
                out.push(text);
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
function isItem(value) {
    if (!value || typeof value !== "object")
        return false;
    const item = value;
    switch (item.type) {
        case "user":
            return typeof item.text === "string";
        case "assistant":
            return (Array.isArray(item.thoughts) &&
                Array.isArray(item.blocks) &&
                item.thoughts.every((entry) => typeof entry === "string") &&
                item.blocks.every((entry) => typeof entry === "string"));
        case "tool":
            return (typeof item.toolCallId === "string" &&
                typeof item.title === "string" &&
                typeof item.status === "string" &&
                Array.isArray(item.content) &&
                item.content.every((entry) => typeof entry === "string"));
        case "permission":
            return Array.isArray(item.options) && (item.decision === null || typeof item.decision === "string");
        case "notice":
            return typeof item.text === "string" && typeof item.level === "string";
        default:
            return false;
    }
}
class TranscriptBuilder {
    items = [];
    assistantsByMessage = new Map();
    toolsByCall = new Map();
    sessionId;
    cwd;
    usage = null;
    createdAt;
    draftCounter = 0;
    constructor(sessionId, cwd, createdAt = Date.now()) {
        this.sessionId = sessionId;
        this.cwd = cwd;
        this.createdAt = createdAt;
    }
    get all() {
        return this.items;
    }
    getUsage() {
        return this.usage;
    }
    addUser(text, meta = {}) {
        const item = {
            id: (0, node_crypto_1.randomUUID)(),
            type: "user",
            text,
            at: Date.now(),
            notePath: meta.notePath ?? null,
            hasSelection: meta.hasSelection ?? false,
        };
        this.items.push(item);
        return item;
    }
    addNotice(level, text) {
        const item = { id: (0, node_crypto_1.randomUUID)(), type: "notice", level, text, at: Date.now() };
        this.items.push(item);
        return item;
    }
    addPermission(request) {
        const options = Array.isArray(request.options) && request.options.length > 0
            ? request.options
            : [
                { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
                { optionId: "reject-once", name: "Reject", kind: "reject_once" },
            ];
        const item = {
            id: (0, node_crypto_1.randomUUID)(),
            type: "permission",
            toolCallId: request.toolCall?.toolCallId ?? null,
            options,
            decision: null,
            at: Date.now(),
        };
        this.items.push(item);
        return item;
    }
    decidePermission(itemId, decision) {
        const item = this.items.find((candidate) => candidate.type === "permission" && candidate.id === itemId);
        if (!item)
            return null;
        item.decision = decision;
        return item;
    }
    /** Apply one ACP `session/update`; returns whether anything visible changed. */
    applyUpdate(update) {
        if (!update || typeof update !== "object" || typeof update.sessionUpdate !== "string") {
            return { changed: false };
        }
        switch (update.sessionUpdate) {
            case "agent_message_chunk": {
                const text = (0, protocol_ts_1.textOfContent)(update.content);
                if (text === null)
                    return { changed: false };
                const item = this.assistantFor(update.messageId);
                item.blocks.push(text);
                return { changed: true };
            }
            case "agent_thought_chunk": {
                const text = (0, protocol_ts_1.textOfContent)(update.content);
                if (text === null)
                    return { changed: false };
                const item = this.assistantFor(update.messageId);
                item.thoughts.push(text);
                return { changed: true };
            }
            case "tool_call": {
                const item = this.toolFor(update);
                if (typeof update.title === "string")
                    item.title = update.title;
                if (typeof update.kind === "string")
                    item.kind = update.kind;
                if (typeof update.status === "string")
                    item.status = update.status;
                if (update.rawInput !== undefined)
                    item.rawInput = update.rawInput;
                return { changed: true };
            }
            case "tool_call_update": {
                const item = this.toolFor(update);
                if (typeof update.title === "string" && update.title.length > 0)
                    item.title = update.title;
                if (typeof update.status === "string")
                    item.status = update.status;
                if (update.rawInput !== undefined)
                    item.rawInput = update.rawInput;
                const content = toolContentTexts(update.content);
                if (content.length > 0)
                    item.content = content;
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
    markAssistantDone() {
        for (const item of this.items) {
            if (item.type === "assistant")
                item.done = true;
        }
    }
    snapshot() {
        const items = JSON.parse(JSON.stringify(this.items));
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
    static fromSnapshot(snapshot) {
        if (!snapshot || snapshot.version !== SNAPSHOT_VERSION)
            return null;
        if (typeof snapshot.sessionId !== "string" || !Array.isArray(snapshot.items))
            return null;
        const builder = new TranscriptBuilder(snapshot.sessionId, typeof snapshot.cwd === "string" ? snapshot.cwd : "", typeof snapshot.createdAt === "number" ? snapshot.createdAt : Date.now());
        for (const item of snapshot.items) {
            if (!isItem(item))
                continue;
            if (item.type === "assistant")
                item.done = true;
            builder.items.push(item);
            if (item.type === "assistant" && item.messageId) {
                builder.assistantsByMessage.set(item.messageId, item);
            }
            if (item.type === "tool")
                builder.toolsByCall.set(item.toolCallId, item);
        }
        if (snapshot.usage &&
            typeof snapshot.usage.used === "number" &&
            typeof snapshot.usage.size === "number") {
            builder.usage = { used: snapshot.usage.used, size: snapshot.usage.size };
        }
        return builder;
    }
    assistantFor(messageId) {
        const key = messageId ?? `__draft_${++this.draftCounter}`;
        const existing = this.assistantsByMessage.get(key);
        if (existing)
            return existing;
        const item = {
            id: (0, node_crypto_1.randomUUID)(),
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
    toolFor(update) {
        const toolCallId = typeof update.toolCallId === "string" && update.toolCallId.length > 0
            ? update.toolCallId
            : `tool-${this.items.length}`;
        const existing = this.toolsByCall.get(toolCallId);
        if (existing)
            return existing;
        const item = {
            id: (0, node_crypto_1.randomUUID)(),
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
exports.TranscriptBuilder = TranscriptBuilder;

},
function (module, exports, require) {
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LogModal = exports.DshChatView = exports.VIEW_TYPE_DSH_CHAT = void 0;
/**
 * The right-sidebar chat panel.
 *
 * Layout follows the Pi Agent plugin: a compact brand header with icon actions,
 * a framed messages card where every message has an uppercase role row plus a
 * content card, and a composer with context badges, a textarea and a run bar
 * that hosts model/effort selectors next to the send button.
 */
const obsidian_1 = require("obsidian");
const protocol_ts_1 = require("./acp/protocol.ts");
const render_ts_1 = require("./render.ts");
exports.VIEW_TYPE_DSH_CHAT = "dsh-chat-view";
function itemRenderKey(item) {
    switch (item.type) {
        case "assistant":
            return `a:${item.blocks.map((block) => block.length).join(",")}:${item.thoughts.length}:${item.done}`;
        case "tool":
            return `t:${item.status}:${item.title}:${item.content.map((block) => block.length).join(",")}:${item.rawInput === undefined ? 0 : 1}`;
        case "permission":
            return `p:${item.decision ?? ""}`;
        default:
            return "s";
    }
}
function optionLabel(i18n, kind, fallback) {
    switch (kind) {
        case "allow_once":
            return i18n.t("permission.allow");
        case "allow_always":
            return i18n.t("permission.allowAlways");
        case "reject_once":
            return i18n.t("permission.reject");
        case "reject_always":
            return i18n.t("permission.rejectAlways");
        default:
            if (kind.startsWith("allow"))
                return i18n.t("permission.allow");
            if (kind.startsWith("reject"))
                return i18n.t("permission.reject");
            return fallback;
    }
}
function iconButton(parent, icon, label, cls) {
    const button = parent.createEl("button", { cls });
    button.setAttribute("aria-label", label);
    button.setAttribute("title", label);
    (0, obsidian_1.setIcon)(button, icon);
    return button;
}
class DshChatView extends obsidian_1.ItemView {
    itemsEl;
    messagesEl;
    emptyEl;
    bannerEl;
    jumpButton;
    threadTitleEl;
    textareaEl;
    sendButton;
    sendIcon;
    sendLabel;
    statusDot;
    statusText;
    workingEl = null;
    workingLabelEl = null;
    modelButton;
    effortButton;
    modelLabelEl;
    effortLabelEl;
    configOptions = [];
    usageEl;
    noteChip;
    selectionChip;
    rendered = new Map();
    unsubscribe = null;
    renderScheduled = false;
    renderTimer = null;
    stickToBottom = true;
    renderedSessionId = null;
    includeNote = true;
    includeSelection = true;
    busy = false;
    ready = false;
    plugin;
    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;
    }
    getViewType() {
        return exports.VIEW_TYPE_DSH_CHAT;
    }
    getDisplayText() {
        return this.plugin.i18n.t("view.name");
    }
    getIcon() {
        return "message-square";
    }
    async onOpen() {
        this.includeNote = this.plugin.settings.includeActiveNote;
        this.includeSelection = this.plugin.settings.includeSelection;
        this.buildUi();
        this.unsubscribe = this.plugin.subscribe(() => this.scheduleRender());
        this.plugin.addOpenView();
        this.scheduleRender();
        void this.plugin.ensureChat();
    }
    async onClose() {
        this.unsubscribe?.();
        this.unsubscribe = null;
        if (this.renderTimer !== null) {
            window.clearTimeout(this.renderTimer);
            this.renderTimer = null;
        }
        this.renderScheduled = false;
        this.rendered.clear();
        this.plugin.removeOpenView();
    }
    /** Insert text into the composer (used by commands). */
    prefill(text) {
        this.textareaEl.value = text;
        this.autoGrow();
        this.textareaEl.focus();
        this.textareaEl.setSelectionRange(this.textareaEl.value.length, this.textareaEl.value.length);
    }
    focusComposer() {
        this.textareaEl.focus();
    }
    buildUi() {
        const t = this.plugin.i18n.t.bind(this.plugin.i18n);
        this.contentEl.empty();
        this.contentEl.addClass("dsh-chat-container");
        const root = this.contentEl.createDiv({ cls: "dsh-chat-root" });
        // Header: brand + thread title + icon actions.
        const header = root.createDiv({ cls: "dsh-chat-header" });
        const brand = header.createDiv({ cls: "dsh-chat-brand" });
        const brandIcon = brand.createSpan({ cls: "dsh-chat-brand-icon" });
        (0, obsidian_1.setIcon)(brandIcon, "message-square");
        this.threadTitleEl = brand.createSpan({ cls: "dsh-chat-thread-title" });
        const actions = header.createDiv({ cls: "dsh-chat-header-actions" });
        const newButton = iconButton(actions, "plus", t("header.new"), "dsh-chat-header-action");
        const historyButton = iconButton(actions, "history", t("header.history"), "dsh-chat-header-action");
        const moreButton = iconButton(actions, "ellipsis", t("header.more"), "dsh-chat-header-action");
        const statusLine = root.createDiv({ cls: "dsh-chat-statusline" });
        this.statusDot = statusLine.createSpan({ cls: "dsh-chat-dot" });
        this.statusText = statusLine.createSpan({ cls: "dsh-chat-status-text" });
        this.bannerEl = root.createDiv({ cls: "dsh-chat-banner" });
        this.bannerEl.style.display = "none";
        // Messages: framed card; empty state and items live inside.
        const messagesWrap = root.createDiv({ cls: "dsh-chat-messages-wrap" });
        this.messagesEl = messagesWrap.createDiv({ cls: "dsh-chat-messages" });
        this.emptyEl = this.messagesEl.createDiv({ cls: "dsh-chat-empty" });
        this.buildEmptyState();
        this.itemsEl = this.messagesEl.createDiv({ cls: "dsh-chat-items" });
        this.jumpButton = messagesWrap.createEl("button", { cls: "dsh-chat-jump", text: "↓" });
        this.jumpButton.style.display = "none";
        // Composer: context toggles stay on the left, context usage sits on the
        // right of the same row, then the input and the run bar.
        const composer = root.createDiv({ cls: "dsh-chat-composer" });
        const composerTop = composer.createDiv({ cls: "dsh-chat-composer-top" });
        const badges = composerTop.createDiv({ cls: "dsh-chat-context-badges" });
        this.noteChip = badges.createEl("button", { cls: "dsh-chat-context-badge" });
        this.noteChip.title = t("chip.noteTitle");
        this.noteChip.createSpan({ cls: "dsh-chat-context-badge-icon" });
        (0, obsidian_1.setIcon)(this.noteChip.firstElementChild, "file-text");
        this.noteChip.createSpan({ cls: "dsh-chat-context-badge-label", text: t("chip.note") });
        this.selectionChip = badges.createEl("button", { cls: "dsh-chat-context-badge" });
        this.selectionChip.title = t("chip.selectionTitle");
        this.selectionChip.createSpan({ cls: "dsh-chat-context-badge-icon" });
        (0, obsidian_1.setIcon)(this.selectionChip.firstElementChild, "text-select");
        this.selectionChip.createSpan({ cls: "dsh-chat-context-badge-label", text: t("chip.selection") });
        this.usageEl = composerTop.createSpan({ cls: "dsh-chat-usage" });
        this.textareaEl = composer.createEl("textarea", { cls: "dsh-chat-input" });
        this.textareaEl.rows = 3;
        this.textareaEl.placeholder = t("composer.placeholder");
        const bar = composer.createDiv({ cls: "dsh-chat-composer-bar" });
        const modelSetting = this.createRunSetting(bar, "dsh-chat-model", t("selectors.model"));
        this.modelButton = modelSetting.button;
        this.modelLabelEl = modelSetting.label;
        const effortSetting = this.createRunSetting(bar, "dsh-chat-effort", t("selectors.effort"));
        this.effortButton = effortSetting.button;
        this.effortLabelEl = effortSetting.label;
        this.sendButton = bar.createEl("button", { cls: "dsh-chat-send" });
        this.sendIcon = this.sendButton.createSpan({ cls: "dsh-chat-send-icon" });
        (0, obsidian_1.setIcon)(this.sendIcon, "send");
        this.sendLabel = this.sendButton.createSpan({ cls: "dsh-chat-send-label", text: t("composer.send") });
        this.registerDomEvent(newButton, "click", () => void this.plugin.newSession());
        this.registerDomEvent(historyButton, "click", () => this.openHistoryMenu(historyButton));
        this.registerDomEvent(moreButton, "click", () => this.openMoreMenu(moreButton));
        this.registerDomEvent(this.sendButton, "click", () => {
            if (this.busy)
                this.plugin.cancelPrompt();
            else
                void this.submit();
        });
        this.registerDomEvent(this.textareaEl, "keydown", (event) => {
            if (event.key !== "Enter")
                return;
            const sendOnEnter = this.plugin.settings.sendOnEnter;
            const withModifier = event.metaKey || event.ctrlKey;
            if (event.shiftKey)
                return;
            if (event.isComposing || event.keyCode === 229)
                return;
            if (sendOnEnter === withModifier)
                return;
            event.preventDefault();
            void this.submit();
        });
        this.registerDomEvent(this.textareaEl, "input", () => this.autoGrow());
        this.registerDomEvent(this.messagesEl, "scroll", () => this.onMessagesScroll());
        // Own the wheel over the whole message area: native chaining is unreliable
        // in Obsidian side leaves and dead zones (jump button, card padding).
        this.registerDomEvent(messagesWrap, "wheel", (event) => this.onWheel(event), {
            passive: false,
        });
        this.registerDomEvent(this.jumpButton, "click", () => {
            this.stickToBottom = true;
            this.jumpButton.style.display = "none";
            this.autoScroll();
        });
        this.registerDomEvent(this.noteChip, "click", () => {
            this.includeNote = !this.includeNote;
            this.syncChips();
        });
        this.registerDomEvent(this.selectionChip, "click", () => {
            this.includeSelection = !this.includeSelection;
            this.syncChips();
        });
        this.registerDomEvent(this.modelButton, "click", () => this.openConfigMenu("model", this.modelButton));
        this.registerDomEvent(this.effortButton, "click", () => this.openConfigMenu("reasoning_effort", this.effortButton));
        this.syncChips();
        this.autoGrow();
    }
    buildEmptyState() {
        const t = this.plugin.i18n.t.bind(this.plugin.i18n);
        this.emptyEl.empty();
        const icon = this.emptyEl.createDiv({ cls: "dsh-chat-empty-icon" });
        (0, obsidian_1.setIcon)(icon, "message-square");
        this.emptyEl.createEl("div", { cls: "dsh-chat-empty-title", text: t("empty.title") });
        this.emptyEl.createEl("div", { cls: "dsh-chat-empty-hint", text: t("empty.hint") });
        const examples = this.emptyEl.createDiv({ cls: "dsh-chat-empty-examples" });
        for (const key of ["empty.example1", "empty.example2", "empty.example3"]) {
            const button = examples.createEl("button", { cls: "dsh-chat-example", text: t(key) });
            this.registerDomEvent(button, "click", () => {
                this.textareaEl.value = t(key);
                this.autoGrow();
                this.textareaEl.focus();
            });
        }
    }
    syncChips() {
        this.noteChip.toggleClass("is-active", this.includeNote);
        this.selectionChip.toggleClass("is-active", this.includeSelection);
        this.noteChip.setAttribute("aria-pressed", String(this.includeNote));
        this.selectionChip.setAttribute("aria-pressed", String(this.includeSelection));
    }
    scheduleRender() {
        if (this.renderScheduled)
            return;
        this.renderScheduled = true;
        // A timer (not requestAnimationFrame): Obsidian window rendering is
        // throttled/paused while the window is hidden or occluded, but the panel
        // must still catch up when it becomes visible.
        this.renderTimer = window.setTimeout(() => {
            this.renderTimer = null;
            this.renderScheduled = false;
            try {
                this.render();
            }
            catch (error) {
                console.error("[dsh-chat] render failed", error);
            }
        }, 0);
    }
    render() {
        const state = this.plugin.getViewState();
        const t = this.plugin.i18n.t.bind(this.plugin.i18n);
        // Composer state first: it must stay correct even if timeline rendering fails.
        this.busy = state.session.busy;
        this.ready = Boolean(state.session.sessionId && state.session.attached);
        this.threadTitleEl.setText(state.session.title?.trim() || t("view.name"));
        this.threadTitleEl.title = state.session.title?.trim() || t("view.name");
        this.sendLabel.setText(this.busy ? t("composer.stop") : t("composer.send"));
        (0, obsidian_1.setIcon)(this.sendIcon, this.busy ? "square" : "send");
        this.sendButton.toggleClass("is-stopping", this.busy);
        this.sendButton.disabled = !this.busy && !this.ready;
        this.textareaEl.placeholder = this.ready
            ? t("composer.placeholder")
            : t("composer.connecting");
        this.modelButton.disabled = this.busy;
        this.effortButton.disabled = this.busy;
        this.renderStatus(state);
        this.renderRunSettings(state.session.configOptions);
        this.renderTimeline(state.session.items, state.session.sessionId, state.session.busy);
        this.renderWorkingIndicator(state.session.busy);
        this.usageEl.setText((0, render_ts_1.usageLabel)(this.plugin.i18n, state.session.usage));
        if (state.error) {
            this.bannerEl.style.display = "";
            this.bannerEl.setText(state.error);
        }
        else {
            this.bannerEl.style.display = "none";
            this.bannerEl.setText("");
        }
        const hasItems = state.session.items.some((item) => item.type !== "notice");
        this.emptyEl.style.display = hasItems ? "none" : "";
        this.autoScroll();
    }
    renderStatus(state) {
        const t = this.plugin.i18n.t.bind(this.plugin.i18n);
        const busy = state.session.busy;
        if (busy) {
            this.statusText.setText(t("status.responding"));
            this.statusDot.className = "dsh-chat-dot is-busy";
            return;
        }
        const { phase, detail, firstStart } = state.runtime;
        let label = t("status.idle");
        let dot = "is-idle";
        if (phase === "probing") {
            label = t("status.probing");
            dot = "is-starting";
        }
        else if (phase === "starting") {
            label = firstStart ? t("status.firstStart") : t("status.starting");
            dot = "is-starting";
        }
        else if (phase === "ready") {
            label = t("status.ready");
            dot = "is-ready";
        }
        else if (phase === "error") {
            label = detail === "not-found" ? t("status.notFound") : t("status.error");
            dot = "is-error";
        }
        else if (phase === "stopped") {
            label = t("status.stopped");
            dot = "is-idle";
        }
        this.statusText.setText(label);
        this.statusDot.className = `dsh-chat-dot ${dot}`;
    }
    createRunSetting(parent, cls, title) {
        const button = parent.createEl("button", { cls: `dsh-chat-run-setting ${cls}` });
        button.title = title;
        const label = button.createSpan({ cls: "dsh-chat-run-setting-label" });
        const chevron = button.createSpan({ cls: "dsh-chat-run-setting-chevron" });
        (0, obsidian_1.setIcon)(chevron, "chevron-down");
        return { button, label };
    }
    renderRunSettings(options) {
        this.configOptions = options;
        this.updateRunSetting(this.modelButton, this.modelLabelEl, options.find((option) => option.id === "model"), this.plugin.i18n.t("selectors.model"));
        this.updateRunSetting(this.effortButton, this.effortLabelEl, options.find((option) => option.id === "reasoning_effort"), this.plugin.i18n.t("selectors.effort"));
    }
    updateRunSetting(button, label, option, fallback) {
        if (!option) {
            button.style.display = "none";
            return;
        }
        button.style.display = "";
        const name = this.configDisplayName(option) || fallback;
        label.setText(name);
        button.title = `${fallback}: ${name}`;
    }
    configDisplayName(option) {
        const current = option.currentValue ?? "";
        for (const entry of option.options ?? []) {
            if (Array.isArray(entry.options)) {
                const match = entry.options.find((child) => child.value === current);
                if (match)
                    return match.name;
            }
            else if (entry.value === current) {
                return entry.name;
            }
        }
        return (0, protocol_ts_1.prettySelectorValue)(current);
    }
    /** Themed dropdown for one ACP config option (native selects render a white popup). */
    openConfigMenu(configId, anchor) {
        const option = this.configOptions.find((entry) => entry.id === configId);
        if (!option)
            return;
        const menu = new obsidian_1.Menu();
        const current = option.currentValue ?? "";
        let added = false;
        const addChoice = (value, name) => {
            added = true;
            menu.addItem((item) => item
                .setTitle(name)
                .setChecked(value === current)
                .onClick(() => {
                void this.applyConfig(configId, value);
            }));
        };
        for (const entry of option.options ?? []) {
            if (Array.isArray(entry.options)) {
                const group = entry;
                if (added)
                    menu.addSeparator();
                menu.addItem((item) => item.setTitle(group.name).setIsLabel(true));
                for (const child of group.options)
                    addChoice(child.value, child.name);
            }
            else {
                addChoice(entry.value, entry.name);
            }
        }
        if (!added)
            return;
        const rect = anchor.getBoundingClientRect();
        menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
    }
    async applyConfig(configId, value) {
        try {
            await this.plugin.setConfigOption(configId, value);
        }
        catch (error) {
            new obsidian_1.Notice(this.plugin.i18n.t("notice.configFailed", {
                message: error instanceof Error ? error.message : String(error),
            }));
        }
    }
    renderTimeline(items, sessionId, busy) {
        if (this.renderedSessionId !== sessionId) {
            this.renderedSessionId = sessionId;
            this.rendered.clear();
            this.itemsEl.empty();
            this.stickToBottom = true;
        }
        let lastUserIndex = -1;
        for (let index = items.length - 1; index >= 0; index -= 1) {
            if (items[index].type === "user") {
                lastUserIndex = index;
                break;
            }
        }
        const toolGroups = this.toolGroups(items);
        const assistantGroups = this.assistantGroups(items);
        const toolDisplay = this.plugin.settings.toolDisplay;
        const live = new Set();
        for (let index = 0; index < items.length; index += 1) {
            const item = items[index];
            // While the current turn is still running, show only the status row;
            // the full reply card appears once the turn is complete.
            if (busy && item.type === "assistant" && index > lastUserIndex)
                continue;
            let renderItem = item;
            let assistantKey = "";
            if (item.type === "assistant") {
                const group = assistantGroups.get(item.id);
                if (!group)
                    continue;
                renderItem = group.merged;
                assistantKey = `:a${group.key}`;
            }
            // hidden: drop every tool card; latest: keep only the newest per turn.
            if (item.type === "tool") {
                if (toolDisplay === "hidden")
                    continue;
                if (toolDisplay === "latest" && !toolGroups.has(item.id))
                    continue;
            }
            live.add(item.id);
            let record = this.rendered.get(item.id);
            if (!record) {
                const el = this.itemsEl.createDiv({ cls: `dsh-chat-message is-${item.type}` });
                el.dataset.itemId = item.id;
                record = { el, key: "" };
                this.rendered.set(item.id, record);
            }
            const groupCount = item.type === "tool" ? toolGroups.get(item.id) : undefined;
            const key = `${itemRenderKey(renderItem)}${assistantKey}${groupCount ? `:g${groupCount}` : ""}`;
            if (record.key !== key) {
                record.key = key;
                this.renderItem(renderItem, record.el, groupCount);
            }
        }
        for (const [id, record] of this.rendered) {
            if (!live.has(id)) {
                record.el.remove();
                this.rendered.delete(id);
            }
        }
    }
    /** One assistant card per user turn, merging every streamed assistant message. */
    assistantGroups(items) {
        const groups = new Map();
        let current = [];
        const flush = () => {
            if (current.length === 0)
                return;
            const last = current[current.length - 1];
            groups.set(last.id, {
                merged: current.length === 1
                    ? last
                    : {
                        ...last,
                        id: last.id,
                        thoughts: current.flatMap((item) => item.thoughts),
                        blocks: current.flatMap((item) => item.blocks),
                        done: current.every((item) => item.done),
                    },
                key: current.map(itemRenderKey).join("|"),
            });
            current = [];
        };
        for (const item of items) {
            if (item.type === "user") {
                flush();
            }
            else if (item.type === "assistant") {
                current.push(item);
            }
        }
        flush();
        return groups;
    }
    /** Latest-tool-only mode: count the tools of each user turn. */
    toolGroups(items) {
        const groups = new Map();
        if (this.plugin.settings.toolDisplay !== "latest")
            return groups;
        let current = [];
        const flush = () => {
            if (current.length > 0)
                groups.set(current[current.length - 1].id, current.length);
            current = [];
        };
        for (const item of items) {
            if (item.type === "user") {
                flush();
            }
            else if (item.type === "tool") {
                current.push(item);
            }
        }
        flush();
        return groups;
    }
    /** Transient "working" row below the latest message: DSH + pi-agent-style shimmer. */
    renderWorkingIndicator(busy) {
        const t = this.plugin.i18n.t.bind(this.plugin.i18n);
        if (!busy) {
            this.workingEl?.remove();
            this.workingEl = null;
            this.workingLabelEl = null;
            return;
        }
        if (this.workingEl && !this.workingEl.isConnected) {
            this.workingEl = null;
            this.workingLabelEl = null;
        }
        if (!this.workingEl) {
            const row = this.itemsEl.createDiv({ cls: "dsh-chat-working" });
            row.title = t("status.responding");
            row.setAttribute("aria-label", t("status.responding"));
            const icon = row.createSpan({ cls: "dsh-chat-working-icon" });
            (0, obsidian_1.setIcon)(icon, "sparkles");
            row.createSpan({ cls: "dsh-chat-working-title", text: t("role.dsh") });
            this.workingLabelEl = row.createSpan({ cls: "dsh-chat-working-label" });
            this.workingEl = row;
        }
        this.workingLabelEl?.setText(t("status.responding"));
        // Always keep it after the newest message.
        this.itemsEl.appendChild(this.workingEl);
        this.autoScroll();
    }
    renderItem(item, el, groupCount) {
        el.empty();
        switch (item.type) {
            case "user":
                this.renderUser(item, el);
                return;
            case "assistant":
                this.renderAssistant(item, el);
                return;
            case "tool":
                this.renderTool(item, el, groupCount);
                return;
            case "permission":
                this.renderPermission(item, el);
                return;
            case "notice":
                this.renderNotice(item, el);
                return;
            default:
                return;
        }
    }
    renderRole(el, icon, title, extra) {
        const role = el.createDiv({ cls: "dsh-chat-message-role" });
        const iconEl = role.createSpan({ cls: "dsh-chat-role-icon" });
        (0, obsidian_1.setIcon)(iconEl, icon);
        const titleEl = role.createSpan({ cls: "dsh-chat-message-role-title" });
        titleEl.createSpan({ text: title.toUpperCase() });
        if (extra)
            extra(role);
        return role;
    }
    renderUser(item, el) {
        this.renderRole(el, "user", this.plugin.i18n.t("role.you"));
        const content = el.createDiv({ cls: "dsh-chat-message-content" });
        content.createDiv({ cls: "dsh-chat-user-text", text: item.text });
        if (item.notePath || item.hasSelection) {
            const meta = content.createDiv({ cls: "dsh-chat-user-meta" });
            if (item.notePath)
                meta.createSpan({ cls: "dsh-chat-tag", text: item.notePath });
            if (item.hasSelection) {
                meta.createSpan({ cls: "dsh-chat-tag", text: this.plugin.i18n.t("chip.selection") });
            }
        }
    }
    renderAssistant(item, el) {
        const t = this.plugin.i18n.t.bind(this.plugin.i18n);
        const markdown = (0, render_ts_1.assistantText)(item);
        this.renderRole(el, "sparkles", t("role.dsh"), (role) => {
            const actions = role.createDiv({ cls: "dsh-chat-message-actions" });
            const copy = iconButton(actions, "copy", t("action.copy"), "dsh-chat-message-action");
            copy.disabled = markdown.length === 0;
            copy.addEventListener("click", () => {
                void navigator.clipboard
                    .writeText(markdown)
                    .then(() => {
                    new obsidian_1.Notice(t("action.copied"));
                })
                    .catch(() => {
                    new obsidian_1.Notice(t("notice.copyFailed"));
                });
            });
            const insert = iconButton(actions, "arrow-down-to-line", t("action.insert"), "dsh-chat-message-action");
            insert.disabled = markdown.length === 0;
            insert.addEventListener("click", () => {
                const target = this.plugin.resolveMarkdownView();
                if (!target) {
                    new obsidian_1.Notice(t("action.noEditor"));
                    return;
                }
                const text = markdown.endsWith("\n") ? markdown : `${markdown}\n`;
                try {
                    const editor = target.editor;
                    editor.replaceRange(text, editor.getCursor("to"));
                }
                catch (error) {
                    new obsidian_1.Notice(t("notice.editFailed", {
                        message: error instanceof Error ? error.message : String(error),
                    }));
                }
            });
            const replace = iconButton(actions, "text-cursor-input", t("action.replace"), "dsh-chat-message-action");
            replace.disabled = markdown.length === 0;
            replace.addEventListener("click", () => {
                const target = this.plugin.resolveMarkdownView();
                if (!target) {
                    new obsidian_1.Notice(t("action.noEditor"));
                    return;
                }
                if (!target.editor.somethingSelected()) {
                    new obsidian_1.Notice(t("notice.noSelection"));
                    return;
                }
                try {
                    target.editor.replaceSelection(markdown);
                }
                catch (error) {
                    new obsidian_1.Notice(t("notice.editFailed", {
                        message: error instanceof Error ? error.message : String(error),
                    }));
                }
            });
        });
        const content = el.createDiv({ cls: "dsh-chat-message-content" });
        if (this.plugin.settings.showReasoning) {
            const thoughts = (0, render_ts_1.thoughtText)(item);
            if (thoughts) {
                const details = content.createEl("details", { cls: "dsh-chat-thinking" });
                const summary = details.createEl("summary");
                const chevron = summary.createSpan({ cls: "dsh-chat-thinking-chevron" });
                (0, obsidian_1.setIcon)(chevron, "chevron-right");
                summary.createSpan({ cls: "dsh-chat-thinking-label", text: t("thinking").toUpperCase() });
                const body = details.createDiv({ cls: "dsh-chat-thinking-content" });
                void (0, render_ts_1.fillMarkdown)(this.app, body, thoughts, this.sourcePath(), this);
            }
        }
        const body = content.createDiv({ cls: "dsh-chat-markdown" });
        if (markdown) {
            void (0, render_ts_1.fillMarkdown)(this.app, body, markdown, this.sourcePath(), this).then(() => this.autoScroll());
        }
        else if (!item.done) {
            const typing = body.createDiv({ cls: "dsh-chat-typing" });
            typing.createSpan({ cls: "dsh-chat-working-label", text: t("status.responding") });
        }
    }
    renderTool(item, el, groupCount) {
        const t = this.plugin.i18n.t.bind(this.plugin.i18n);
        this.renderRole(el, "wrench", item.title || t("role.tool"), (role) => {
            if (groupCount && groupCount > 1) {
                const badge = role.createSpan({ cls: "dsh-chat-tool-count", text: `×${groupCount}` });
                badge.title = t("tool.groupCount", { count: groupCount });
            }
            role.createSpan({
                cls: `dsh-chat-tool-status is-${item.status}`,
                text: (0, render_ts_1.toolStatusLabel)(this.plugin.i18n, item.status),
            });
        });
        const content = el.createDiv({ cls: "dsh-chat-message-content dsh-chat-tool-content" });
        const input = (0, render_ts_1.toolInputText)(item);
        const result = (0, render_ts_1.toolResultText)(item);
        if (!input && !result) {
            content.createDiv({ cls: "dsh-chat-tool-empty", text: "…" });
            return;
        }
        const details = content.createEl("details", { cls: "dsh-chat-tool-details" });
        details.createEl("summary", { text: t("tool.details") });
        if (input) {
            details.createDiv({ cls: "dsh-chat-tool-label", text: t("tool.input") });
            details.createEl("pre", { cls: "dsh-chat-tool-input", text: input });
        }
        if (result) {
            details.createDiv({ cls: "dsh-chat-tool-label", text: t("tool.output") });
            const body = details.createDiv({ cls: "dsh-chat-markdown" });
            void (0, render_ts_1.fillMarkdown)(this.app, body, result, this.sourcePath(), this);
        }
    }
    renderPermission(item, el) {
        const t = this.plugin.i18n.t.bind(this.plugin.i18n);
        this.renderRole(el, "shield-alert", t("role.approval"));
        const content = el.createDiv({ cls: "dsh-chat-message-content dsh-chat-approval" });
        content.createDiv({ cls: "dsh-chat-permission-title", text: t("permission.title") });
        if (item.toolCallId) {
            content.createDiv({
                cls: "dsh-chat-permission-tool",
                text: t("permission.tool", { id: item.toolCallId }),
            });
        }
        if (item.decision) {
            content.createSpan({
                cls: `dsh-chat-permission-decision is-${item.decision}`,
                text: (0, render_ts_1.decisionLabel)(this.plugin.i18n, item.decision),
            });
            return;
        }
        const row = content.createDiv({ cls: "dsh-chat-permission-actions" });
        for (const option of item.options) {
            const kind = typeof option.kind === "string" ? option.kind : "";
            const allow = kind.startsWith("allow");
            const button = row.createEl("button", {
                cls: allow ? "mod-cta" : "",
                text: optionLabel(this.plugin.i18n, kind, option.name),
            });
            button.addEventListener("click", () => {
                this.plugin.resolvePermission(item.id, allow ? "allowed" : "rejected", option.optionId);
            });
        }
    }
    renderNotice(item, el) {
        el.dataset.level = item.level;
        el.createSpan({ cls: "dsh-chat-notice-text", text: item.text });
    }
    sourcePath() {
        return this.plugin.resolveMarkdownView()?.file?.path ?? "";
    }
    async submit() {
        const text = this.textareaEl.value.trim();
        if (text.length === 0 || this.busy || !this.ready)
            return;
        this.textareaEl.value = "";
        this.autoGrow();
        this.stickToBottom = true;
        try {
            await this.plugin.sendMessage(text, {
                includeNote: this.includeNote,
                includeSelection: this.includeSelection,
            });
        }
        catch (error) {
            this.textareaEl.value = text;
            this.autoGrow();
            new obsidian_1.Notice(this.plugin.i18n.t("notice.promptFailed", {
                message: error instanceof Error ? error.message : String(error),
            }));
        }
    }
    autoGrow() {
        this.textareaEl.style.height = "auto";
        this.textareaEl.style.height = `${Math.min(this.textareaEl.scrollHeight + 2, 240)}px`;
    }
    onMessagesScroll() {
        const nearBottom = this.messagesEl.scrollHeight - this.messagesEl.scrollTop - this.messagesEl.clientHeight < 96;
        this.stickToBottom = nearBottom;
        this.jumpButton.style.display = nearBottom ? "none" : "";
    }
    /** Scroll the transcript ourselves so wheel input works over every dead zone. */
    onWheel(event) {
        if (event.defaultPrevented || event.ctrlKey || event.metaKey)
            return;
        if (Math.abs(event.deltaX) > Math.abs(event.deltaY))
            return;
        const messages = this.messagesEl;
        const max = messages.scrollHeight - messages.clientHeight;
        if (max <= 0)
            return;
        if (this.hasInnerScrollable(event.target, event.deltaY))
            return;
        const next = Math.max(0, Math.min(max, messages.scrollTop + event.deltaY));
        if (Math.abs(next - messages.scrollTop) < 1)
            return;
        event.preventDefault();
        messages.scrollTop = next;
        this.onMessagesScroll();
    }
    /** Whether the wheel should scroll a nested element (code block, table, tool result) first. */
    hasInnerScrollable(target, deltaY) {
        let node = target;
        while (node && node !== this.messagesEl) {
            const overflowY = window.getComputedStyle(node).overflowY;
            if (overflowY === "auto" || overflowY === "scroll") {
                const max = node.scrollHeight - node.clientHeight;
                if (max > 0) {
                    if (deltaY < 0 && node.scrollTop > 0)
                        return true;
                    if (deltaY > 0 && node.scrollTop < max - 1)
                        return true;
                }
            }
            node = node.parentElement;
        }
        return false;
    }
    autoScroll() {
        if (!this.stickToBottom)
            return;
        this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    }
    openHistoryMenu(anchor) {
        const t = this.plugin.i18n.t.bind(this.plugin.i18n);
        const menu = new obsidian_1.Menu();
        const sessions = [...this.plugin.sessionMetas].sort((left, right) => right.updatedAt - left.updatedAt);
        if (sessions.length === 0) {
            menu.addItem((item) => item.setTitle(t("history.empty")).setDisabled(true));
        }
        for (const meta of sessions) {
            menu.addItem((item) => item
                .setTitle(meta.title || t("history.unknownTitle"))
                .setChecked(meta.id === this.plugin.currentSessionId)
                .onClick(() => {
                void this.plugin.resumeSession(meta.id);
            }));
        }
        menu.addSeparator();
        menu.addItem((item) => item.setTitle(t("history.import")).onClick(() => {
            void this.openImportModal();
        }));
        const rect = anchor.getBoundingClientRect();
        menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
    }
    async openImportModal() {
        const entries = await this.plugin.importSessions();
        if (entries.length === 0) {
            new obsidian_1.Notice(this.plugin.i18n.t("history.importEmpty"));
            return;
        }
        new SessionPickerModal(this.app, entries, this.plugin.i18n, (entry) => {
            void this.plugin.resumeSession(entry.sessionId);
        }).open();
    }
    openMoreMenu(anchor) {
        const t = this.plugin.i18n.t.bind(this.plugin.i18n);
        const menu = new obsidian_1.Menu();
        menu.addItem((item) => item.setTitle(t("menu.restart")).onClick(() => {
            void this.plugin.restartRuntime();
        }));
        menu.addItem((item) => item.setTitle(t("menu.showLog")).onClick(() => {
            new LogModal(this.app, this.plugin.getLogText(), this.plugin.i18n).open();
        }));
        menu.addSeparator();
        menu.addItem((item) => item.setTitle(t("menu.closeSession")).onClick(() => {
            void this.plugin.closeSession();
        }));
        const rect = anchor.getBoundingClientRect();
        menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
    }
}
exports.DshChatView = DshChatView;
class LogModal extends obsidian_1.Modal {
    text;
    i18n;
    constructor(app, text, i18n) {
        super(app);
        this.text = text;
        this.i18n = i18n;
    }
    onOpen() {
        this.titleEl.setText(this.i18n.t("log.title"));
        const pre = this.contentEl.createEl("pre", { cls: "dsh-chat-log" });
        pre.setText(this.text.length > 0 ? this.text : this.i18n.t("log.empty"));
        const actions = this.contentEl.createDiv({ cls: "dsh-chat-modal-actions" });
        const copy = actions.createEl("button", { text: this.i18n.t("log.copy") });
        copy.addEventListener("click", () => {
            void navigator.clipboard.writeText(this.text).catch(() => {
                new obsidian_1.Notice(this.i18n.t("notice.copyFailed"));
            });
        });
        const close = actions.createEl("button", { text: this.i18n.t("log.close") });
        close.addEventListener("click", () => this.close());
    }
    onClose() {
        this.contentEl.empty();
    }
}
exports.LogModal = LogModal;
class SessionPickerModal extends obsidian_1.Modal {
    entries;
    i18n;
    onPick;
    constructor(app, entries, i18n, onPick) {
        super(app);
        this.entries = entries;
        this.i18n = i18n;
        this.onPick = onPick;
    }
    onOpen() {
        this.titleEl.setText(this.i18n.t("history.importTitle"));
        const list = this.contentEl.createDiv({ cls: "dsh-chat-session-list" });
        for (const entry of this.entries) {
            const row = list.createDiv({ cls: "dsh-chat-session-row" });
            row.createSpan({ cls: "dsh-chat-session-id", text: entry.sessionId.slice(0, 8) });
            if (entry.cwd) {
                row.createSpan({ cls: "dsh-chat-session-cwd", text: entry.cwd });
            }
            const open = row.createEl("button", { text: this.i18n.t("history.open") });
            open.addEventListener("click", () => {
                this.close();
                this.onPick(entry);
            });
        }
        const actions = this.contentEl.createDiv({ cls: "dsh-chat-modal-actions" });
        const cancel = actions.createEl("button", { text: this.i18n.t("history.cancel") });
        cancel.addEventListener("click", () => this.close());
    }
    onClose() {
        this.contentEl.empty();
    }
}

}
];
var __deps = [{"./protocol.ts":1,"./transport.ts":2},{},{},{},{},{"./context.ts":3,"./i18n.ts":4,"./runtime.ts":7,"./settings.ts":9,"./session.ts":8,"./store.ts":10,"./view.ts":12},{},{"./acp/client.ts":0},{"./acp/protocol.ts":1,"./transcript.ts":11},{},{},{"./acp/protocol.ts":1},{"./acp/protocol.ts":1,"./render.ts":6}];
var __cache = Object.create(null);
function __load(id) {
  var cached = __cache[id];
  if (cached) return cached.exports;
  var module = { exports: {} };
  __cache[id] = module;
  var local = __deps[id] || {};
  __modules[id](module, module.exports, function (spec) {
    if (Object.prototype.hasOwnProperty.call(local, spec)) return __load(local[spec]);
    return __hostRequire(spec);
  });
  return module.exports;
}
var __entry = __load(5);
module.exports =
  __entry && __entry.__esModule && __entry.default !== undefined ? __entry.default : __entry;
