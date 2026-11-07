import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
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
  /** 该 server 配置的单次调用预算，取自 `mcp.json` 的 `timeoutMs`。 */
  callTimeoutMs?: number;
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
  | "call_failed"
  // 正常关闭时进程树回收未确认（D-225）。与 `call_failed` 分开是因为它既不是
  // 一次调用失败、也不是连接失败：连接已经用完了，只是「关干净了没有」答案是否。
  | "dispose_incomplete";

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
// 单次 MCP 调用的硬顶。原来是 120s，而 `keil` 的构建动作内部允许 10 分钟
// （`buildInIde` 的默认值），于是「按 10min 配置」在 120s 就被掐断——配置
// 与实现对不上，属于 R3 意义上的假承诺（OPT-13）。抬到 10 分钟与构建侧一致；
// 真正的短上限仍由 `mcp.json` 的 `timeoutMs` 与管线层的工具预算各自决定，
// 这里只是不许它们要得比 10 分钟更多。
const MAX_CALL_TIMEOUT_MS = 600_000;
const DEFAULT_TERMINATE_TIMEOUT_MS = 2_000;
/**
 * 等回收器（`taskkill`）发出 spawn 事件或报错的上限。
 *
 * 只用来区分「回收器发出去了」与「根本没起来」（ENOENT 等）——**不**等它跑完。
 * 实测本机 spawn 事件 8–28 ms；给 200 ms 是为了让杀软扫描负载下的慢启动不被
 * 误判成失败。超时按「已发出」处理：慢不等于没起来，把它当失败会是误报。
 */
const REAPER_SPAWN_WAIT_MS = 200;
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
// MCP `initialize` 里报给对端的客户端身份，MCP server 会把它写进自己的日志。
// 版本号与 desktop/package.json 的发布版本保持一致——它不改协议行为，只影响对端
// 日志里「哪个版本的客户端连上来了」这一条，写旧了会让人按错误的版本排查。
const CLIENT_INFO = { name: "embedded-ai-master", version: "0.1.5" } as const;

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

/**
 * 等回收器「发出去了」还是「根本没起来」。
 *
 * 返回 `undefined` 表示进程已创建（或等待超时——慢不等于失败，见
 * `REAPER_SPAWN_WAIT_MS` 的注释）；返回字符串表示确定的启动失败原因
 * （`ENOENT` 等），由调用方上报。
 */
function waitForSpawnOrError(killer: ChildProcess): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(undefined), REAPER_SPAWN_WAIT_MS);
    timer.unref?.();
    killer.once("spawn", () => finish(undefined));
    killer.once("error", (error: Error) => finish(error.message));
  });
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
  // 非 readonly：会话级复用时，每条消息所属的会话日志不同，logger 必须能重绑
  // （否则第二条消息的 mcp_status 会写进上一条已关闭的会话）。
  private logger?: (event: McpStatusEvent) => void;
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

  /** 重绑状态事件的去处；会话级复用时每条消息换一个会话句柄。 */
  setLogger(logger: (event: McpStatusEvent) => void): void {
    this.logger = logger;
  }

  /** 返回取消订阅函数：跨消息复用时旧 listener 会累积，并写进已经没人读的注册表。 */
  onToolsChanged(listener: (server: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
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
        await this.disposeClient(state, true, true);
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
      const tools = await this.loadTools(connectedClient, config);
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

  private async loadTools(client: Client, config: McpServerConfig): Promise<McpToolInfo[]> {
    const server = config.name;
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
        // 把 server 配的预算带给管线。不写死常量：`mcp.json` 里用户写的
        // `timeoutMs` 必须真的生效，否则那条配置就是假的（OPT-13）。
        callTimeoutMs: config.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
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
        tools = await this.loadTools(client, state.config);
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

  /**
   * 收掉一个 server 的客户端与进程树。
   *
   * `reportIncomplete` 只在**终态关闭**（`close()`）时为真。重连路径也走这里
   * （`connectServer` 先收旧的再建新的），但那里「树没回收干净」既不影响语义、
   * 也不该在会话日志里刷警告——下一条连接马上就会建起来。把它一并上报会让每次
   * 断线重连都多一条 warn，读者很快学会忽略这一行，R3 的信号就废了。
   */
  private async disposeClient(
    state: ServerState,
    clearTools = false,
    reportIncomplete = false,
  ): Promise<void> {
    if (state.terminating !== undefined) {
      await state.terminating;
    }
    const client = state.client;
    const pid = state.transport?.pid ?? undefined;
    state.client = undefined;
    state.transport = undefined;
    state.connected = false;
    if (clearTools) {
      state.tools = [];
    }
    const failure = await this.reapProcessTree(pid, client);
    if (failure !== undefined && reportIncomplete) {
      // 「没确认回收」必须说出来（R3）。`state.uncertain` 只在异常路径上生效：
      // 那时连接还会被复用，下一次调用要据此拒绝重连。正常关闭这条路上没有
      // 「下一次调用」了，所以它需要一个能被宿主与日志看见的去处——状态事件
      // 会经 `toMcpStatusPayload` 写进会话日志，桌面端渲染成一条 warn。
      this.emit({ kind: "dispose_incomplete", server: state.config.name, message: failure });
    }
  }

  /**
   * 正常关闭时的进程树回收。成功（或无可回收）返回 `undefined`；没确认时返回
   * 一条人能读的原因。
   *
   * ## 实测事实（2026-11-07，本机，全部为本任务重测）
   *
   * 1. **Windows 上非 detached 的后代已经由 OS 自动回收**。Node/libuv 给每个
   *    `spawn` 出来的直接子进程建了 kill-on-close 的 Job Object，后代继承它；
   *    实测三层链（宿主 → server → 孙 → 曾孙）只杀最上层，孙与曾孙全灭
   *    （2/2）。仓库里所有领域 server 的 `spawn` 都**没有** `detached`
   *    （`probe/renode.ts`、`serial/serial.ts`、`keil/uvsock.ts`），所以正常
   *    关闭本来就收得干净——**D-225 描述的「Renode/OpenOCD 孙进程活过宿主」
   *    在默认 spawn 姿态下没有复现**。
   * 2. **只有 `detached` 的后代能活过父进程**（实测：非 detached 0/6 存活，
   *    detached 6/6 存活；父进程正常退出与被 TerminateProcess 结果一致）。
   *    这类后代**没有**父子关联可用，`taskkill /T` 也无法枚举：`/T` 依赖活着的
   *    父进程。
   * 3. **`taskkill /T /F` 从 spawn 到真正枚举要约 1 s**。本机对**不存在的 pid**
   *    也要 1.2–1.3 s——这 1 s 是进程启动成本（杀软扫描），不是遍历。真正的
   *    「枚举 + 终止」发生在约 1 s 处。
   * 4. **真实 MCP server 收到 stdin EOF 后 0–109 ms 就退出**（实测
   *    `StdioServerTransport` 在 stdin end 时 `onclose`，进程随即结束；持句柄的
   *    也要到 SDK 的 2 s SIGTERM 才走）。所以「起 taskkill → 等 spawn → 关
   *    client」这种姿态，taskkill 开始枚举时父进程早已不在，**必然漏掉
   *    detached 后代**（实测 0/10/25/50/100/200 ms 头程全漏，250 ms 起才稳定）。
   * 5. 任何外部枚举手段都 ≥ 800 ms（`tasklist /FI` 800–1225 ms、
   *    `[Diagnostics.Process]::GetProcesses()` 654–789 ms、`Get-CimInstance`
   *    1764–3646 ms），远超「关闭额外开销 ≤ 50 ms」的预算，所以「先快照后代
   *    pid、关完再补刀」也不可行。
   *
   * ## 因此这里做的是什么
   *
   * 在**不延长父进程生命、不增加关闭时延**的前提下，Windows 上唯一能起的作用
   * 是把回收器发出去：起 `taskkill /T /F` 并 `unref`，不等它的退出（等它就是
   * D-225 记的「26 s → 49 s」）。它对「父进程此刻还活着且持有子进程」的场景
   * 有效（例如异常路径上 `beginDispose` 已经等在 pid 上；或 server 自己握着
   * 管道没退），对「父进程已随 stdin EOF 退出」的场景**不保证**——那种场景由
   * 上面第 1 条的 Job Object 负责，而第 2 条的 detached 后代谁都收不了。
   *
   * 所以返回值区分的是**「回收器有没有真的发出去」**，不是「树一定没了」：
   * 这正是 R3 的要求——能证明的说能证明，不能证明的如实说不确定。
   *
   * ## 为什么不做在 transport 构造处（D-225 的修复建议）
   *
   * `StdioServerParameters` 只有 `command/args/env/stderr/cwd/maxBufferSize`，
   * 没有 `detached` 之类的 spawn 选项（SDK 自己 `spawn(..., shell:false,
   * windowsHide)`，见 `node_modules/@modelcontextprotocol/client/dist/stdio.mjs:74`）。
   * 要在构造处拿到 Job Object / 进程组，只能自己 spawn 再把管道塞给 SDK，或自造
   * transport 子类——两者都要复制 SDK 的缓冲、协议版本协商与 close 语义，契约
   * 风险远大于本批次收益。真正想要「父死子随」的正确落点是 **server 侧**：
   * 领域 server 自己 `spawn` 子进程时不要 `detached`（它们现在都没用），别再
   * 给后代脱离 Job Object 的机会。
   *
   * ## POSIX
   *
   * `StdioClientTransport` 不传 `detached: true`，父进程因此不是进程组组长，
   * `kill(-pid)` 指向的是一个不存在的组（ESRCH）。这里退化为「只保证直接子进程
   * 收到 SIGKILL」——与 SDK 自己的 close 等价，**不声称**回收整棵树。要做到进程
   * 组必须在 spawn 时 `detached: true`，那正是上面论证过不可行的位置，所以这里
   * 如实返回「未确认」，而不是假装成功。
   */
  private async reapProcessTree(
    pid: number | undefined,
    client: Client | undefined,
  ): Promise<string | undefined> {
    if (pid === undefined) {
      // 没连上过（或已断）：没有子进程可回收，不算失败。
      if (client) {
        await client.close().catch(() => undefined);
      }
      return undefined;
    }

    if (process.platform !== "win32") {
      // POSIX：进程组不可用（见方法注释）。先让 SDK 关掉直接子进程，再如实
      // 报「未确认整树回收」——不能因为「直接子进程没了」就说树收干净了。
      if (client) {
        await client.close().catch(() => undefined);
      }
      return isProcessAlive(pid)
        ? "POSIX 下 MCP 子进程不是进程组组长，无法按组回收后代"
        : "POSIX 下只保证直接子进程退出，后代是否回收未确认";
    }

    let killer: ReturnType<typeof spawn>;
    try {
      // `detached` 不能让回收器活过宿主退出（实测：宿主退出后它照样被 Job
      // Object 带走），所以不设——保持与既有 terminateAndWait 同一姿态。
      killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } catch (error) {
      if (client) {
        await client.close().catch(() => undefined);
      }
      return `taskkill 启动失败：${messageOf(error)}`;
    }

    const spawned = await waitForSpawnOrError(killer);
    if (spawned !== undefined) {
      // 回收器根本没起来（ENOENT 等）。此时父进程仍要被 SDK 收掉，但整棵树
      // 没有回收器可用——如实上报。
      if (client) {
        await client.close().catch(() => undefined);
      }
      return `taskkill 未能启动：${spawned}`;
    }

    // 父进程交给 SDK 关闭；回收器在后台自己跑完，不等它的退出。
    if (client) {
      await client.close().catch(() => undefined);
    }
    killer.unref();
    return undefined;
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
