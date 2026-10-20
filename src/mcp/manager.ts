import { spawn } from "node:child_process";
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
  evidence?: boolean;
}

export interface McpCallResult {
  isError: boolean;
  code: string;
  message: string;
  detail?: unknown;
  text: string;
  structuredContent?: unknown;
}

export type McpStatusKind =
  | "connected"
  | "connect_failed"
  | "tools_changed"
  | "tools_refresh_failed"
  | "tool_invalid_schema"
  | "listener_failed"
  | "call_failed";

export interface McpStatusEvent {
  kind: McpStatusKind;
  server: string;
  tool?: string;
  toolCount?: number;
  message?: string;
  attempts?: number;
}

const REFRESH_MAX_ATTEMPTS = 3;
const REFRESH_BASE_DELAY_MS = 100;

export interface McpManagerOptions {
  connectTimeoutMs?: number;
  terminateTimeoutMs?: number;
  logger?: (event: McpStatusEvent) => void;
}

interface ServerState {
  config: McpServerConfig;
  client?: Client;
  transport?: StdioClientTransport;
  tools: McpToolInfo[];
  connected: boolean;
  everConnected: boolean;
  everConnectAttempted: boolean;
  closed: boolean;
  uncertain: boolean;
  queue: Promise<unknown>;
  reconnecting?: Promise<boolean>;
  terminating?: Promise<boolean>;
}

type InvokeOutcome =
  | { kind: "value"; value: CallToolResult }
  | { kind: "error"; error: unknown }
  | { kind: "timeout" }
  | { kind: "aborted" };

const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_CALL_TIMEOUT_MS = 15_000;
const MAX_CALL_TIMEOUT_MS = 120_000;
const DEFAULT_TERMINATE_TIMEOUT_MS = 2_000;
const MAX_CONTENT_BYTES = 1024 * 1024;
const MAX_SCHEMA_BYTES = 64 * 1024;
const MAX_DESCRIPTION_CHARS = 4096;
const TRUNCATED_MARKER = "[MCP output truncated at 1 MiB]";
const DEFAULT_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "SystemRoot",
  "SystemDrive",
  "windir",
  "TEMP",
  "TMP",
  "PATHEXT",
  "COMSPEC",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TERM",
];
const CLIENT_INFO = { name: "embedded-ai-master", version: "0.1.0" } as const;

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) return value;
  let end = maxBytes;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString("utf8");
}

function truncateDescription(value: string): string {
  if (value.length <= MAX_DESCRIPTION_CHARS) return value;
  let end = MAX_DESCRIPTION_CHARS;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${value.slice(0, end)} [truncated]`;
}

function safeJson(value: unknown): string {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized : String(serialized);
  } catch {
    return "[unserializable content]";
  }
}

function buildEnv(config: McpServerConfig): Record<string, string> {
  const env: Record<string, string> = {};
  if (config.inheritEnv === true) {
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
  } else {
    for (const key of DEFAULT_ENV_ALLOWLIST) {
      const value = process.env[key];
      if (value !== undefined) env[key] = value;
    }
  }
  for (const key of config.envAllowlist ?? []) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(config.env ?? {})) {
    env[key] = value;
  }
  return env;
}

function isObjectSchema(schema: unknown): boolean {
  return (
    typeof schema === "object" &&
    schema !== null &&
    !Array.isArray(schema) &&
    (schema as { type?: unknown }).type === "object"
  );
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
  private readonly terminateTimeoutMs: number;
  private readonly logger?: (event: McpStatusEvent) => void;
  private readonly listeners = new Set<(server: string) => void>();
  private closed = false;

  constructor(servers: McpServerConfig[], options: McpManagerOptions = {}) {
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.terminateTimeoutMs = options.terminateTimeoutMs ?? DEFAULT_TERMINATE_TIMEOUT_MS;
    this.logger = options.logger;
    this.states = new Map(
      servers.map((config) => [
        config.name,
        {
          config,
          tools: [],
          connected: false,
          everConnected: false,
          everConnectAttempted: false,
          closed: false,
          uncertain: false,
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
        await this.disposeClient(state, true);
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
    if (state.terminating !== undefined) {
      await state.terminating;
    }
    if (state.uncertain) {
      return this.failCall(
        state,
        "mcp_uncertain",
        `MCP server 上一调用未能确认终止，拒绝重连: ${state.config.name}`,
      );
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
      this.beginDispose(state);
      return this.failCall(state, "mcp_aborted", "MCP 调用已取消");
    }
    if (outcome.kind === "timeout") {
      this.beginDispose(state);
      return this.failCall(state, "mcp_timeout", `MCP 调用超时（${timeoutMs}ms）`);
    }

    const error = outcome.error;
    if (this.isTimeoutError(error)) {
      this.beginDispose(state);
      return this.failCall(state, "mcp_timeout", `MCP 调用超时（${timeoutMs}ms）`);
    }
    if (this.isConnectionError(error, state)) {
      if (!allowReconnect) {
        this.beginDispose(state);
        return this.failCall(state, "mcp_unavailable", `MCP server 不可用: ${state.config.name}`);
      }
      if (state.tools.find((info) => info.tool === tool)?.destructive === true) {
        this.beginDispose(state);
        return this.failCall(
          state,
          "mcp_uncertain",
          `MCP 破坏性工具连接中断且结果不确定，未自动重试: ${state.config.name}/${tool}`,
        );
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
    let used = 0;
    let truncated = false;
    const push = (part: string): boolean => {
      const separator = parts.length === 0 ? 0 : 1;
      const cost = separator + byteLength(part);
      if (used + cost <= MAX_CONTENT_BYTES) {
        parts.push(part);
        used += cost;
        return true;
      }
      const remaining = MAX_CONTENT_BYTES - used - separator;
      const piece = truncateUtf8(part, remaining);
      if (piece.length > 0) {
        parts.push(piece);
        used += separator + byteLength(piece);
      }
      truncated = true;
      return false;
    };

    for (const block of result.content ?? []) {
      if (!push(block.type === "text" ? block.text : safeJson(block))) break;
    }
    if (parts.length === 0 && result.structuredContent !== undefined) {
      push(safeJson(result.structuredContent));
    }
    const body = parts.join("\n");
    const text = truncated ? `${body}\n${TRUNCATED_MARKER}` : body;
    const structured =
      result.structuredContent === undefined
        ? {}
        : { structuredContent: result.structuredContent };
    if (result.isError === true) {
      return {
        isError: true,
        code: "mcp_tool_error",
        message: text || "MCP 工具返回错误",
        detail: truncated ? { truncated: true } : { content: result.content },
        text,
        ...structured,
      };
    }
    return {
      isError: false,
      code: "ok",
      message: "",
      ...(truncated ? { detail: { truncated: true } } : {}),
      text,
      ...structured,
    };
  }

  private async reconnect(state: ServerState): Promise<boolean> {
    if (state.closed || this.closed || state.uncertain) {
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

    const wasConnected = state.everConnected || state.everConnectAttempted;
    state.everConnectAttempted = true;
    const config = state.config;
    let client: Client | undefined;
    let transport: StdioClientTransport | undefined;
    try {
      transport = new StdioClientTransport({
        command: config.command,
        args: [...(config.args ?? [])],
        env: buildEnv(config),
        cwd: config.cwd,
      });
      state.transport = transport;
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
                  attempts: REFRESH_MAX_ATTEMPTS,
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
      const tools = await this.loadTools(connectedClient, config.name);
      if (this.isClosed(state)) {
        await this.disposeClient(state);
        return false;
      }

      state.tools = tools;
      state.connected = true;
      state.everConnected = true;
      this.emit({ kind: "connected", server: config.name, toolCount: state.tools.length });
      if (wasConnected) {
        this.notifyToolsChanged(state);
      }
      return true;
    } catch (error) {
      if (client && state.client === client) {
        state.client = undefined;
      }
      if (transport !== undefined && state.transport === transport) {
        state.transport = undefined;
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

  private async loadTools(client: Client, server: string): Promise<McpToolInfo[]> {
    const { tools } = await client.listTools(undefined, { timeout: this.connectTimeoutMs });
    const loaded: McpToolInfo[] = [];
    for (const tool of tools) {
      if (!isObjectSchema(tool.inputSchema)) {
        this.emit({
          kind: "tool_invalid_schema",
          server,
          tool: tool.name,
          message: `MCP 工具 inputSchema 根必须是 object: ${server}/${tool.name}`,
        });
        continue;
      }
      if (byteLength(safeJson(tool.inputSchema)) > MAX_SCHEMA_BYTES) {
        this.emit({
          kind: "tool_invalid_schema",
          server,
          tool: tool.name,
          message: `MCP 工具 inputSchema 超过 ${MAX_SCHEMA_BYTES} bytes: ${server}/${tool.name}`,
        });
        continue;
      }
      const info: McpToolInfo = {
        server,
        tool: tool.name,
        description: truncateDescription(
          typeof tool.description === "string" ? tool.description : "",
        ),
        inputSchema: tool.inputSchema,
      };
      if (tool.annotations?.readOnlyHint === true) {
        info.readOnly = true;
      }
      if (tool.annotations?.destructiveHint === true) {
        info.destructive = true;
      }
      if (tool._meta?.evidence === true) {
        info.evidence = true;
      }
      loaded.push(info);
    }
    return loaded;
  }

  private async refreshTools(state: ServerState): Promise<void> {
    const client = state.client;
    if (!client || !state.connected || this.isClosed(state)) {
      return;
    }
    let tools: McpToolInfo[] | undefined;
    let lastError: unknown;
    // list_changed 后工具列表短暂抖动很常见,做有界退避重试(D-104)。
    for (let attempt = 1; attempt <= REFRESH_MAX_ATTEMPTS; attempt += 1) {
      if (this.isClosed(state)) {
        return;
      }
      try {
        tools = await this.loadTools(client, state.config.name);
        break;
      } catch (error) {
        lastError = error;
        if (attempt < REFRESH_MAX_ATTEMPTS) {
          await delay(REFRESH_BASE_DELAY_MS * 2 ** (attempt - 1));
        }
      }
    }
    if (tools === undefined) {
      if (!this.isClosed(state)) {
        this.emit({
          kind: "tools_refresh_failed",
          server: state.config.name,
          message: messageOf(lastError),
          attempts: REFRESH_MAX_ATTEMPTS,
        });
      }
      return;
    }
    if (this.isClosed(state)) {
      return;
    }
    state.tools = tools;
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

  private async terminateAndWait(pid: number | undefined): Promise<boolean> {
    if (pid === undefined) {
      return true;
    }
    if (process.platform === "win32") {
      try {
        const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
        killer.on("error", () => undefined);
        killer.unref();
      } catch {
        void 0;
      }
    } else {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          void 0;
        }
      }
    }
    const deadline = Date.now() + this.terminateTimeoutMs;
    while (Date.now() < deadline) {
      if (!isProcessAlive(pid)) {
        return true;
      }
      await delay(50);
    }
    return !isProcessAlive(pid);
  }

  private beginDispose(state: ServerState, clearTools = false): void {
    const client = state.client;
    const pid = state.transport?.pid ?? undefined;
    state.client = undefined;
    state.transport = undefined;
    state.connected = false;
    if (clearTools) {
      state.tools = [];
    }
    const terminating = this.terminateAndWait(pid).then(async (dead) => {
      if (!dead) {
        state.uncertain = true;
      }
      if (client) {
        await client.close().catch(() => undefined);
      }
      return dead;
    });
    state.terminating = terminating;
    void terminating.then(
      () => {
        if (state.terminating === terminating) {
          state.terminating = undefined;
        }
      },
      () => {
        state.uncertain = true;
        if (state.terminating === terminating) {
          state.terminating = undefined;
        }
      },
    );
  }

  private async disposeClient(state: ServerState, clearTools = false): Promise<void> {
    if (state.terminating !== undefined) {
      await state.terminating;
    }
    const client = state.client;
    state.client = undefined;
    state.transport = undefined;
    state.connected = false;
    if (clearTools) {
      state.tools = [];
    }
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
