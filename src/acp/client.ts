/**
 * Minimal ACP v1 client for DeepSeek Harness (`dsh acp`).
 *
 * Only the methods this plugin needs are implemented. Unknown server requests
 * are rejected and unknown notifications are ignored, so a newer runtime that
 * adds methods keeps working.
 */
import {
  ACP_PROTOCOL_VERSION,
  normalizeConfigOptions,
  type AcpConfigOption,
  type AcpInitializeResult,
  type AcpPermissionOutcome,
  type AcpPermissionRequest,
  type AcpPromptBlock,
  type AcpPromptResult,
  type AcpSessionListResult,
  type AcpSessionNewResult,
  type AcpSessionUpdateParams,
} from "./protocol.ts";
import { AcpRpcError, JsonRpcTransport, type TransportLogEntry } from "./transport.ts";

export interface AcpClientOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  clientName: string;
  clientVersion: string;
  onUpdate: (params: AcpSessionUpdateParams) => void;
  onPermission: (request: AcpPermissionRequest) => Promise<AcpPermissionOutcome>;
  onLog?: (entry: TransportLogEntry) => void;
}

export interface AcpSessionCapabilities {
  close: boolean;
  list: boolean;
  resume: boolean;
}

const INITIALIZE_TIMEOUT_MS = 120_000;
const SESSION_TIMEOUT_MS = 120_000;
const CONTROL_TIMEOUT_MS = 30_000;

export class AcpClient {
  readonly transport: JsonRpcTransport;
  private readonly options: AcpClientOptions;
  private initialized: AcpInitializeResult | null = null;

  constructor(options: AcpClientOptions) {
    this.options = options;
    this.transport = new JsonRpcTransport({
      input: options.input,
      output: options.output,
      onLog: options.onLog,
    });
    this.transport.setServerRequestHandler(async (method, params) => {
      if (method === "session/request_permission") {
        return this.options.onPermission(params as AcpPermissionRequest);
      }
      throw new AcpRpcError(-32601, `unsupported client method: ${method}`);
    });
    this.transport.onNotification((method, params) => {
      if (method !== "session/update") return;
      if (!params || typeof params !== "object") return;
      this.options.onUpdate(params as AcpSessionUpdateParams);
    });
  }

  get isDisposed(): boolean {
    return this.transport.isDisposed;
  }

  get sessionCapabilities(): AcpSessionCapabilities {
    const caps = this.initialized?.agentCapabilities?.sessionCapabilities;
    return {
      close: caps?.close !== undefined,
      list: caps?.list !== undefined,
      resume: caps?.resume !== undefined,
    };
  }

  async initialize(): Promise<AcpInitializeResult> {
    const result = await this.transport.request<AcpInitializeResult>(
      "initialize",
      {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: {
          name: this.options.clientName,
          version: this.options.clientVersion,
        },
      },
      { timeoutMs: INITIALIZE_TIMEOUT_MS },
    );
    if (!result || typeof result !== "object" || typeof result.protocolVersion !== "number") {
      throw new AcpRpcError(-32003, "invalid initialize response from the ACP agent");
    }
    this.initialized = result;
    return result;
  }

  async newSession(cwd: string, mcpServers: unknown[]): Promise<AcpSessionNewResult> {
    const result = await this.transport.request<AcpSessionNewResult>(
      "session/new",
      { cwd, mcpServers },
      { timeoutMs: SESSION_TIMEOUT_MS },
    );
    if (!result || typeof result.sessionId !== "string" || result.sessionId.length === 0) {
      throw new AcpRpcError(-32003, "the ACP agent returned no session id");
    }
    return { sessionId: result.sessionId, configOptions: normalizeConfigOptions(result.configOptions) };
  }

  async resumeSession(
    sessionId: string,
    cwd: string,
    mcpServers: unknown[],
  ): Promise<AcpConfigOption[]> {
    const result = await this.transport.request<{ configOptions?: unknown }>(
      "session/resume",
      { sessionId, cwd, mcpServers },
      { timeoutMs: SESSION_TIMEOUT_MS },
    );
    return normalizeConfigOptions(result?.configOptions);
  }

  async listSessions(cwd?: string, cursor?: string): Promise<AcpSessionListResult> {
    const params: Record<string, unknown> = {};
    if (cwd) params.cwd = cwd;
    if (cursor) params.cursor = cursor;
    return await this.transport.request<AcpSessionListResult>("session/list", params, {
      timeoutMs: CONTROL_TIMEOUT_MS,
    });
  }

  async setConfigOption(
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<AcpConfigOption[]> {
    const result = await this.transport.request<{ configOptions?: unknown }>(
      "session/set_config_option",
      { sessionId, configId, value },
      { timeoutMs: CONTROL_TIMEOUT_MS },
    );
    return normalizeConfigOptions(result?.configOptions);
  }

  async prompt(sessionId: string, prompt: AcpPromptBlock[]): Promise<AcpPromptResult> {
    const result = await this.transport.request<AcpPromptResult>("session/prompt", {
      sessionId,
      prompt,
    });
    return result ?? { stopReason: "end_turn" };
  }

  cancel(sessionId: string): void {
    this.transport.notify("session/cancel", { sessionId });
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.transport.request("session/close", { sessionId }, { timeoutMs: CONTROL_TIMEOUT_MS });
  }

  dispose(reason?: Error): void {
    this.transport.dispose(reason);
  }
}
