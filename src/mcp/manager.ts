import { Client, SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { McpServerConfig } from "./config.js";

export interface McpToolInfo {
  server: string;
  tool: string;
  description: string;
  inputSchema: unknown;
  readOnly?: boolean;
  destructive?: boolean;
}

export interface McpCallResult {
  isError: boolean;
  code: string;
  message: string;
  detail?: unknown;
  text: string;
}

export type McpStatusKind =
  | "connected"
  | "connect_failed"
  | "tools_changed"
  | "tools_refresh_failed"
  | "listener_failed"
  | "call_failed";

export interface McpStatusEvent {
  kind: McpStatusKind;
  server: string;
  toolCount?: number;
  message?: string;
}

export interface McpManagerOptions {
  connectTimeoutMs?: number;
  logger?: (event: McpStatusEvent) => void;
}

interface ServerState {
  config: McpServerConfig;
  client?: Client;
  tools: McpToolInfo[];
  connected: boolean;
  everConnected: boolean;
  closed: boolean;
  queue: Promise<unknown>;
  reconnecting?: Promise<boolean>;
}

type InvokeOutcome =
  | { kind: "value"; value: CallToolResult }
  | { kind: "error"; error: unknown }
  | { kind: "timeout" }
  | { kind: "aborted" };

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_CALL_TIMEOUT_MS = 15_000;
const MAX_CALL_TIMEOUT_MS = 120_000;
const CLIENT_INFO = { name: "embedded-ai-master", version: "0.1.0" } as const;

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export class McpManager {
  private readonly states: Map<string, ServerState>;
  private readonly connectTimeoutMs: number;
  private readonly logger?: (event: McpStatusEvent) => void;
  private readonly listeners = new Set<(server: string) => void>();
  private closed = false;

  constructor(servers: McpServerConfig[], options: McpManagerOptions = {}) {
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.logger = options.logger;
    this.states = new Map(
      servers.map((config) => [
        config.name,
        {
          config,
          tools: [],
          connected: false,
          everConnected: false,
          closed: false,
          queue: Promise.resolve(),
        } satisfies ServerState,
      ]),
    );
  }

  async connectAll(): Promise<void> {
    if (this.closed) {
      return;
    }
    await Promise.allSettled(
      [...this.states.values()].map(async (state) => {
        if (state.connected) {
          return;
        }
        await this.reconnect(state);
      }),
    );
  }

  tools(): McpToolInfo[] {
    return [...this.states.values()].flatMap((state) =>
      state.tools.map((tool) => ({ ...tool })),
    );
  }

  onToolsChanged(listener: (server: string) => void): void {
    this.listeners.add(listener);
  }

  async call(
    server: string,
    tool: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<McpCallResult> {
    const state = this.states.get(server);
    if (!state || state.closed || this.closed) {
      return this.failCallFor(server, "mcp_unavailable", `MCP server 不可用: ${server}`);
    }
    return this.enqueue(state, () => this.callOnce(state, tool, args, signal));
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.listeners.clear();
    await Promise.allSettled(
      [...this.states.values()].map(async (state) => {
        state.closed = true;
        await this.disposeClient(state);
      }),
    );
  }

  private enqueue<T>(state: ServerState, task: () => Promise<T>): Promise<T> {
    const run = state.queue.then(task, task);
    state.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async callOnce(
    state: ServerState,
    tool: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<McpCallResult> {
    if (state.closed || this.closed) {
      return this.failCall(state, "mcp_unavailable", `MCP server 不可用: ${state.config.name}`);
    }
    if (signal?.aborted) {
      return this.failCall(state, "mcp_aborted", "MCP 调用已取消");
    }
    if (!state.connected || !state.client) {
      const reconnected = await this.reconnect(state);
      if (!reconnected || !state.client) {
        return this.failCall(state, "mcp_unavailable", `MCP server 不可用: ${state.config.name}`);
      }
    }
    if (!state.tools.some((info) => info.tool === tool)) {
      return this.failCall(
        state,
        "mcp_tool_error",
        `未知 MCP 工具: ${state.config.name}/${tool}`,
      );
    }
    return this.performCall(state, tool, args, signal, true);
  }

  private async performCall(
    state: ServerState,
    tool: string,
    args: unknown,
    signal: AbortSignal | undefined,
    allowReconnect: boolean,
  ): Promise<McpCallResult> {
    const client = state.client;
    if (!client || !state.connected) {
      if (allowReconnect && (await this.reconnect(state))) {
        return this.performCall(state, tool, args, signal, false);
      }
      return this.failCall(state, "mcp_unavailable", `MCP server 不可用: ${state.config.name}`);
    }

    const timeoutMs = Math.min(
      state.config.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
      MAX_CALL_TIMEOUT_MS,
    );
    const outcome = await this.invoke(client, tool, args, timeoutMs, signal);

    if (outcome.kind === "value") {
      return this.toResult(outcome.value);
    }
    if (outcome.kind === "aborted") {
      return this.failCall(state, "mcp_aborted", "MCP 调用已取消");
    }
    if (outcome.kind === "timeout") {
      return this.failCall(state, "mcp_timeout", `MCP 调用超时（${timeoutMs}ms）`);
    }

    const error = outcome.error;
    if (this.isTimeoutError(error)) {
      return this.failCall(state, "mcp_timeout", `MCP 调用超时（${timeoutMs}ms）`);
    }
    if (this.isConnectionError(error, state)) {
      if (!allowReconnect) {
        return this.failCall(state, "mcp_unavailable", `MCP server 不可用: ${state.config.name}`);
      }
      if (!(await this.reconnect(state))) {
        return this.failCall(state, "mcp_unavailable", `MCP server 不可用: ${state.config.name}`);
      }
      return this.performCall(state, tool, args, signal, false);
    }
    return this.failCall(state, "mcp_tool_error", messageOf(error));
  }

  private async invoke(
    client: Client,
    tool: string,
    args: unknown,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<InvokeOutcome> {
    const call = (async (): Promise<InvokeOutcome> => {
      try {
        const value = await client.callTool(
          { name: tool, arguments: (args ?? {}) as Record<string, unknown> },
          { timeout: timeoutMs },
        );
        return { kind: "value", value };
      } catch (error) {
        return { kind: "error", error };
      }
    })();

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<InvokeOutcome>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs + 50);
    });

    let onAbort: (() => void) | undefined;
    const aborted = new Promise<InvokeOutcome>((resolve) => {
      if (!signal) {
        return;
      }
      if (signal.aborted) {
        resolve({ kind: "aborted" });
        return;
      }
      onAbort = () => resolve({ kind: "aborted" });
      signal.addEventListener("abort", onAbort, { once: true });
    });

    try {
      return await Promise.race([call, timeout, aborted]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
      if (onAbort && signal) {
        signal.removeEventListener("abort", onAbort);
      }
    }
  }

  private toResult(result: CallToolResult): McpCallResult {
    const parts: string[] = [];
    for (const block of result.content ?? []) {
      if (block.type === "text") {
        parts.push(block.text);
      } else {
        parts.push(JSON.stringify(block));
      }
    }
    if (parts.length === 0 && result.structuredContent !== undefined) {
      parts.push(JSON.stringify(result.structuredContent));
    }
    const text = parts.join("\n");
    if (result.isError === true) {
      return {
        isError: true,
        code: "mcp_tool_error",
        message: text || "MCP 工具返回错误",
        detail: { content: result.content },
        text,
      };
    }
    return { isError: false, code: "ok", message: "", text };
  }

  private async reconnect(state: ServerState): Promise<boolean> {
    if (state.closed || this.closed) {
      return false;
    }
    if (state.reconnecting) {
      return state.reconnecting;
    }
    state.reconnecting = this.connectServer(state);
    try {
      return await state.reconnecting;
    } finally {
      state.reconnecting = undefined;
    }
  }

  private async connectServer(state: ServerState): Promise<boolean> {
    await this.disposeClient(state);
    if (this.isClosed(state)) {
      return false;
    }

    const wasConnected = state.everConnected;
    const config = state.config;
    let client: Client | undefined;
    try {
      const transport = new StdioClientTransport({
        command: config.command,
        args: [...(config.args ?? [])],
        env: { ...process.env, ...config.env } as Record<string, string>,
        cwd: config.cwd,
      });
      client = new Client(CLIENT_INFO, {
        listChanged: {
          tools: {
            autoRefresh: false,
            debounceMs: 0,
            onChanged: () => {
              void this.enqueue(state, () => this.refreshTools(state)).catch((error) => {
                if (this.isClosed(state)) {
                  return;
                }
                this.emit({
                  kind: "tools_refresh_failed",
                  server: state.config.name,
                  message: messageOf(error),
                });
              });
            },
          },
        },
      });
      const connectedClient = client;
      connectedClient.onclose = () => {
        if (state.client === connectedClient) {
          state.connected = false;
        }
      };
      state.client = connectedClient;
      state.connected = false;

      await withTimeout(
        connectedClient.connect(transport),
        this.connectTimeoutMs,
        `MCP 连接超时（${this.connectTimeoutMs}ms）`,
      );
      if (this.isClosed(state)) {
        await this.disposeClient(state);
        return false;
      }
      await this.loadTools(state, connectedClient);
      if (this.isClosed(state)) {
        await this.disposeClient(state);
        return false;
      }

      state.connected = true;
      state.everConnected = true;
      if (this.isClosed(state)) {
        state.connected = false;
        await this.disposeClient(state);
        return false;
      }
      this.emit({ kind: "connected", server: config.name, toolCount: state.tools.length });
      if (wasConnected) {
        this.notifyToolsChanged(state);
      }
      return true;
    } catch (error) {
      if (client && state.client === client) {
        state.client = undefined;
      }
      if (client) {
        await client.close().catch(() => undefined);
      }
      state.connected = false;
      if (!this.isClosed(state)) {
        this.emit({ kind: "connect_failed", server: config.name, message: messageOf(error) });
      }
      return false;
    }
  }

  private async loadTools(state: ServerState, client: Client): Promise<void> {
    const { tools } = await client.listTools();
    state.tools = tools.map((tool) => {
      const info: McpToolInfo = {
        server: state.config.name,
        tool: tool.name,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema,
      };
      if (tool.annotations?.readOnlyHint === true) {
        info.readOnly = true;
      }
      if (tool.annotations?.destructiveHint === true) {
        info.destructive = true;
      }
      return info;
    });
  }

  private async refreshTools(state: ServerState): Promise<void> {
    const client = state.client;
    if (!client || !state.connected || this.isClosed(state)) {
      return;
    }
    try {
      await this.loadTools(state, client);
    } catch (error) {
      this.emit({
        kind: "tools_refresh_failed",
        server: state.config.name,
        message: messageOf(error),
      });
      return;
    }
    this.notifyToolsChanged(state);
  }

  private notifyToolsChanged(state: ServerState): void {
    if (this.isClosed(state)) {
      return;
    }
    this.emit({
      kind: "tools_changed",
      server: state.config.name,
      toolCount: state.tools.length,
    });
    for (const listener of this.listeners) {
      try {
        listener(state.config.name);
      } catch (error) {
        this.emit({
          kind: "listener_failed",
          server: state.config.name,
          message: messageOf(error),
        });
      }
    }
  }

  private isClosed(state: ServerState): boolean {
    return state.closed || this.closed;
  }

  private async disposeClient(state: ServerState): Promise<void> {
    const client = state.client;
    state.client = undefined;
    state.connected = false;
    state.tools = [];
    if (client) {
      await client.close().catch(() => undefined);
    }
  }

  private isTimeoutError(error: unknown): boolean {
    return error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout;
  }

  private isConnectionError(error: unknown, state: ServerState): boolean {
    if (!state.connected) {
      return true;
    }
    if (error instanceof SdkError) {
      return (
        error.code === SdkErrorCode.NotConnected ||
        error.code === SdkErrorCode.ConnectionClosed ||
        error.code === SdkErrorCode.SendFailed
      );
    }
    return /\b(econnreset|epipe|broken pipe|not connected|connection (?:closed|lost))\b/i.test(
      messageOf(error),
    );
  }

  private failCall(
    state: ServerState,
    code: string,
    message: string,
    detail?: unknown,
  ): McpCallResult {
    return this.failCallFor(state.config.name, code, message, detail);
  }

  private failCallFor(
    server: string,
    code: string,
    message: string,
    detail?: unknown,
  ): McpCallResult {
    this.emit({ kind: "call_failed", server, message });
    return {
      isError: true,
      code,
      message,
      ...(detail !== undefined ? { detail } : {}),
      text: message,
    };
  }

  private emit(event: McpStatusEvent): void {
    if (!this.logger) {
      return;
    }
    try {
      this.logger(event);
    } catch {
      // status 日志失败不得影响 MCP 主流程
    }
  }
}
