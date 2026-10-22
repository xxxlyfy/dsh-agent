/**
 * Newline-delimited JSON-RPC 2.0 transport for ACP over a child process's stdio.
 */

export type TransportDirection = "send" | "recv" | "drop" | "error";

export interface TransportLogEntry {
  direction: TransportDirection;
  text: string;
}

export class AcpRpcError extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "AcpRpcError";
    this.code = code;
    this.data = data;
  }
}

export interface JsonRpcTransportOptions {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  onLog?: (entry: TransportLogEntry) => void;
}

export interface AcpRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface PendingRequest {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  detachAbort?: () => void;
}

type ServerRequestHandler = (method: string, params: unknown) => Promise<unknown> | unknown;
type NotificationHandler = (method: string, params: unknown) => void;

const MAX_LOG_CHARS = 4000;

function truncateForLog(value: string): string {
  return value.length > MAX_LOG_CHARS ? `${value.slice(0, MAX_LOG_CHARS)}…[truncated]` : value;
}

export class JsonRpcTransport {
  private readonly input: NodeJS.ReadableStream;
  private readonly output: NodeJS.WritableStream;
  private readonly onLog: (entry: TransportLogEntry) => void;

  private nextId = 1;
  private buffer = "";
  private disposed = false;
  private disposeReason: Error | null = null;

  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationHandlers = new Set<NotificationHandler>();
  private serverRequestHandler: ServerRequestHandler | null = null;

  private readonly handleData = (chunk: Buffer | string): void => {
    this.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim().length > 0) this.handleLine(line);
      newline = this.buffer.indexOf("\n");
    }
  };

  private readonly handleEnd = (): void => {
    this.dispose(new AcpRpcError(-32000, "ACP connection closed"));
  };

  private readonly handleStreamError = (error: Error): void => {
    this.dispose(new AcpRpcError(-32000, `ACP transport error: ${error.message}`));
  };

  constructor(options: JsonRpcTransportOptions) {
    this.input = options.input;
    this.output = options.output;
    this.onLog = options.onLog ?? (() => undefined);
    this.input.on("data", this.handleData);
    this.input.on("end", this.handleEnd);
    this.input.on("close", this.handleEnd);
    this.input.on("error", this.handleStreamError);
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  setServerRequestHandler(handler: ServerRequestHandler): void {
    this.serverRequestHandler = handler;
  }

  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  request<T>(method: string, params: unknown, options: AcpRequestOptions = {}): Promise<T> {
    if (this.disposed) {
      return Promise.reject(this.disposeReason ?? new AcpRpcError(-32000, "transport is closed"));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const pending: PendingRequest = {
        method,
        resolve: (value) => resolve(value as T),
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
        const onAbort = (): void => {
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
      } catch (error) {
        this.pending.delete(id);
        this.clearTimer(pending);
        this.detachAbort(pending);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params: unknown): void {
    if (this.disposed) return;
    try {
      this.send({ jsonrpc: "2.0", method, params: params ?? {} });
    } catch (error) {
      this.onLog({ direction: "error", text: `failed to send ${method}: ${String(error)}` });
    }
  }

  dispose(reason?: Error): void {
    if (this.disposed) return;
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

  private send(frame: unknown): void {
    if (this.disposed) throw this.disposeReason ?? new AcpRpcError(-32000, "transport is closed");
    const line = JSON.stringify(frame);
    this.onLog({ direction: "send", text: truncateForLog(line) });
    this.output.write(`${line}\n`);
  }

  private handleLine(line: string): void {
    this.onLog({ direction: "recv", text: truncateForLog(line) });
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.onLog({ direction: "drop", text: `ignored non-JSON stdout line: ${truncateForLog(line)}` });
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      this.onLog({ direction: "drop", text: "ignored non-object JSON-RPC frame" });
      return;
    }
    const frame = message as Record<string, unknown>;
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
        } catch (error) {
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

  private async handleServerRequest(id: unknown, method: string, params: unknown): Promise<void> {
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
    } catch (error) {
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

  private handleResponse(frame: Record<string, unknown>): void {
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
      const error = frame.error as { code?: unknown; message?: unknown; data?: unknown };
      pending.reject(
        new AcpRpcError(
          typeof error.code === "number" ? error.code : -32603,
          typeof error.message === "string" ? error.message : `request failed: ${pending.method}`,
          error.data,
        ),
      );
      return;
    }
    pending.resolve(frame.result);
  }

  private trySend(frame: unknown): void {
    try {
      this.send(frame);
    } catch (error) {
      this.onLog({ direction: "error", text: `failed to send frame: ${String(error)}` });
    }
  }

  private clearTimer(pending: PendingRequest): void {
    if (pending.timer !== undefined) {
      clearTimeout(pending.timer);
      pending.timer = undefined;
    }
  }

  private detachAbort(pending: PendingRequest): void {
    pending.detachAbort?.();
    pending.detachAbort = undefined;
  }
}
