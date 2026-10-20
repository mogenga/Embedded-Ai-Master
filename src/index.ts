import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { resolveHarnessHome } from "./config/harness-home.js";
import { loadProviders, parseProviders, resolveModelRef } from "./config/providers.js";
import { checkBudget, checkBudgetTokens } from "./context/budget.js";
import {
  assertCompactionRatios,
  assertKeepRecentTurns,
  compactSession,
} from "./context/compact.js";
import { createTokenMeter } from "./context/token-meter.js";
import type { TokenMeter } from "./context/token-meter.js";
import type { LoopEvent } from "./loop/events.js";
import { query } from "./loop/query.js";
import type { LoopCtx } from "./loop/query.js";
import { loadMcpConfig } from "./mcp/config.js";
import { McpConfigError } from "./mcp/errors.js";
import { McpManager } from "./mcp/manager.js";
import type { McpStatusEvent } from "./mcp/manager.js";
import { createMcpTools } from "./mcp/tools.js";
import type { McpToolAdapterStatus } from "./mcp/tools.js";
import { heuristicCountTokens } from "./model/count.js";
import { createOpenAIProvider } from "./model/openai.js";
import { loadPermissionConfig, parseInlinePermissionConfig } from "./permissions/config.js";
import type { InlinePermissionConfig, LoadedPermissionConfig } from "./permissions/config.js";
import { PermissionConfigError } from "./permissions/errors.js";
import { createPermissionGate } from "./permissions/gate.js";
import type {
  PermissionGate,
  PermissionPreset,
  PermissionPrompter,
  PermissionRule,
} from "./permissions/types.js";
import { SessionResumeError } from "./session/errors.js";
import { readSessionDir } from "./session/persistence.js";
import { createSession, resumeSession } from "./session/session.js";
import type { SessionHandle } from "./session/session.js";
import { MCP_STATUS_PAYLOAD_KINDS } from "./session/types.js";
import type { McpStatusPayload, McpStatusPayloadKind } from "./session/types.js";
import { createBuiltinTools } from "./tools/builtin.js";
import { isWindowsReservedName } from "./tools/pipeline.js";
import { ToolRegistry } from "./tools/registry.js";

export interface RunOptions {
  input: string;
  model: string;
  sessionId?: string;
  sessionDir?: string;
  resume?: boolean;
  providersText?: string;
  systemPrompt?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  maxTurns?: number;
  maxCostUsd?: number;
  cwd?: string;
  timeoutMs?: number;
  home?: string;
  onSession?: (session: SessionHandle) => void;
  compaction?: {
    enabled?: boolean;
    keepRecentTurns?: number;
    keepTailRatio?: number;
    softRatio?: number;
  };
  mcp?: {
    enabled?: boolean;
    userConfigPath?: string;
    projectConfigPath?: string;
    trustProjectConfig?: boolean;
  };
  permissions?: RunPermissionOptions;
}

export interface RunPermissionOptions {
  userConfigPath?: string;
  projectConfigPath?: string;
  trustProjectConfig?: boolean;
  preset?: PermissionPreset;
  rules?: PermissionRule[];
  approvalTimeoutMs?: number;
  prompter?: PermissionPrompter;
}

const PERMISSION_OPTION_KEYS = new Set([
  "userConfigPath",
  "projectConfigPath",
  "trustProjectConfig",
  "preset",
  "rules",
  "approvalTimeoutMs",
  "prompter",
]);

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function permissionTypeError(key: string, expected: string, value: unknown): TypeError {
  return new TypeError(
    `permissions.${key} must be ${expected}; got ${describeValue(value)}`,
  );
}

interface NormalizedPermissionOptions {
  options: RunPermissionOptions;
  inline: InlinePermissionConfig;
}

function normalizePermissionOptions(raw: unknown): NormalizedPermissionOptions | undefined {
  if (raw === undefined) return undefined;
  const proto =
    typeof raw === "object" && raw !== null ? Object.getPrototypeOf(raw) : undefined;
  if (
    typeof raw !== "object"
    || raw === null
    || Array.isArray(raw)
    || (proto !== Object.prototype && proto !== null)
  ) {
    throw new TypeError(`permissions must be an object; got ${describeValue(raw)}`);
  }

  const value = raw as Record<string, unknown>;
  // Reflect.ownKeys 覆盖 symbol 键:Object.keys 会静默忽略它们,与“未知键一律拒绝”不符(D-126)。
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !PERMISSION_OPTION_KEYS.has(key)) {
      const label = typeof key === "symbol" ? key.toString() : JSON.stringify(key);
      throw new PermissionConfigError(
        "invalid_schema",
        `权限配置含未知字段 ${label}`,
      );
    }
  }

  if (value.userConfigPath !== undefined && typeof value.userConfigPath !== "string") {
    throw permissionTypeError("userConfigPath", "a string", value.userConfigPath);
  }
  if (value.projectConfigPath !== undefined && typeof value.projectConfigPath !== "string") {
    throw permissionTypeError("projectConfigPath", "a string", value.projectConfigPath);
  }
  if (
    value.trustProjectConfig !== undefined
    && typeof value.trustProjectConfig !== "boolean"
  ) {
    throw permissionTypeError("trustProjectConfig", "a boolean", value.trustProjectConfig);
  }
  if (value.preset !== undefined && typeof value.preset !== "string") {
    throw permissionTypeError("preset", "a string", value.preset);
  }
  if (value.rules !== undefined && !Array.isArray(value.rules)) {
    throw permissionTypeError("rules", "an array", value.rules);
  }
  if (
    value.approvalTimeoutMs !== undefined
    && typeof value.approvalTimeoutMs !== "number"
  ) {
    throw permissionTypeError("approvalTimeoutMs", "a number", value.approvalTimeoutMs);
  }
  if (value.prompter !== undefined) {
    const prompter = value.prompter;
    if (
      typeof prompter !== "object"
      || prompter === null
      || Array.isArray(prompter)
      || typeof (prompter as { request?: unknown }).request !== "function"
    ) {
      throw permissionTypeError("prompter", "an object with a request function", prompter);
    }
  }

  const inline: InlinePermissionConfig = {
    ...(value.preset !== undefined
      ? { preset: value.preset as PermissionPreset }
      : {}),
    ...(value.rules !== undefined
      ? { rules: value.rules as PermissionRule[] }
      : {}),
    ...(value.approvalTimeoutMs !== undefined
      ? { approvalTimeoutMs: value.approvalTimeoutMs as number }
      : {}),
  };
  parseInlinePermissionConfig(inline);
  return { options: value as RunPermissionOptions, inline };
}

export interface McpSessionStatus {
  status:
    | "mcp_connected"
    | "mcp_connect_failed"
    | "mcp_tools_changed"
    | "mcp_tools_refresh_failed"
    | "mcp_tool_invalid_schema"
    | "mcp_tool_name_renamed"
    | "mcp_config_failed"
    | "mcp_config_warning"
    | "mcp_project_config_skipped";
  server?: string;
  tool?: string;
  name?: string;
  originalName?: string;
  scope?: "global";
  toolCount?: number;
  message?: string;
}

const MCP_STATUS_KIND_SET: ReadonlySet<string> = new Set(MCP_STATUS_PAYLOAD_KINDS);

export function toMcpStatusPayload(
  input: McpStatusEvent | McpSessionStatus,
): McpStatusPayload | undefined {
  const source = input as {
    kind?: string;
    status?: string;
    server?: string;
    tool?: string;
    toolCount?: number;
    message?: string;
    attempts?: number;
    name?: string;
    originalName?: string;
    scope?: "global";
  };
  const kind =
    source.kind !== undefined
      ? source.kind
      : source.status?.startsWith("mcp_")
        ? source.status.slice("mcp_".length)
        : source.status;
  // MCP 状态是观测性数据:未知 kind 直接跳过,不能把诊断通道升级为会话错误。
  if (kind === undefined || !MCP_STATUS_KIND_SET.has(kind)) {
    console.error(`[mcp] unknown status event skipped: ${String(kind)}`);
    return undefined;
  }
  const payload: McpStatusPayload = { kind: kind as McpStatusPayloadKind };
  if (source.server !== undefined) payload.server = source.server;
  if (source.tool !== undefined) payload.tool = source.tool;
  if (source.toolCount !== undefined) payload.toolCount = source.toolCount;
  if (source.message !== undefined) payload.message = source.message;
  if (source.attempts !== undefined) payload.attempts = source.attempts;
  if (source.name !== undefined) payload.name = source.name;
  if (source.originalName !== undefined) payload.originalName = source.originalName;
  if (source.scope !== undefined) payload.scope = source.scope;
  return payload;
}

// MCP 状态属于观测性事件:写入失败只降级为 false + stderr,不能中止正在进行的诊断。
export async function appendMcpStatus(
  session: SessionHandle,
  payload: McpStatusPayload,
): Promise<boolean> {
  try {
    await session.append({ type: "mcp_status", payload: { ...payload } });
    return true;
  } catch (error) {
    console.error(`[mcp] status event append failed: ${messageOf(error)}`);
    return false;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

function assertSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId) || isWindowsReservedName(sessionId)) {
    throw new TypeError(
      `invalid sessionId: ${JSON.stringify(sessionId)}; must match ${SESSION_ID_PATTERN.source} and not be a Windows reserved name`,
    );
  }
}

interface ResumePlan {
  session: SessionHandle;
  systemPromptToAppend?: string;
  cwd: string;
}

function sameWorkdir(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

async function planResume(sessionDir: string, opts: RunOptions): Promise<ResumePlan> {
  const headerPath = path.join(sessionDir, "header.json");
  try {
    await stat(headerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SessionResumeError(
        "missing_session_dir",
        `Session header not found: ${headerPath}`,
        { dir: sessionDir, file: "header.json" },
      );
    }
    throw error;
  }

  const { header, events } = readSessionDir(sessionDir);

  if (header.model !== undefined && header.model !== opts.model) {
    throw new SessionResumeError(
      "model_mismatch",
      `Session model ${header.model} does not match requested model ${opts.model}`,
      { expected: opts.model, actual: header.model },
    );
  }

  if (opts.sessionId !== undefined && opts.sessionId !== header.id) {
    throw new SessionResumeError(
      "session_id_mismatch",
      `Session id ${header.id} does not match requested sessionId ${opts.sessionId}`,
      { expected: opts.sessionId, actual: header.id },
    );
  }

  if (
    header.workdir !== undefined
    && opts.cwd !== undefined
    && !sameWorkdir(header.workdir, opts.cwd)
  ) {
    throw new SessionResumeError(
      "workdir_mismatch",
      `Session workdir ${header.workdir} does not match requested cwd ${opts.cwd}`,
      { expected: opts.cwd, actual: header.workdir },
    );
  }

  const cwd = path.resolve(opts.cwd ?? header.workdir ?? process.cwd());

  let systemPromptToAppend: string | undefined;
  if (opts.systemPrompt !== undefined) {
    // 多 system 事件时要求**全部**与当前提示一致,避免只校验首条放行不一致历史(D-044)。
    const systemEvents = events.filter((event) => event.type === "system");
    if (systemEvents.length > 0) {
      const mismatched = systemEvents.find(
        (event) => event.payload.content !== opts.systemPrompt,
      );
      if (mismatched !== undefined) {
        throw new SessionResumeError(
          "system_prompt_mismatch",
          "Session system prompt does not match the provided systemPrompt",
          { expected: opts.systemPrompt, actual: mismatched.payload.content },
        );
      }
    } else if (events.length > 0) {
      throw new SessionResumeError(
        "system_prompt_mismatch",
        "Cannot add a system prompt to a non-empty session without a system event",
      );
    } else {
      systemPromptToAppend = opts.systemPrompt;
    }
  }

  const session = await resumeSession(sessionDir);
  return systemPromptToAppend === undefined
    ? { session, cwd }
    : { session, systemPromptToAppend, cwd };
}

export async function* runSession(opts: RunOptions): AsyncGenerator<LoopEvent> {
  if (opts.sessionId !== undefined) assertSessionId(opts.sessionId);
  const permissionOptions = normalizePermissionOptions(opts.permissions);
  const compaction = opts.compaction;
  if (compaction?.enabled !== undefined && typeof compaction.enabled !== "boolean") {
    throw new TypeError(`compaction.enabled must be a boolean; got ${typeof compaction.enabled}`);
  }

  const rawMcp: unknown = opts.mcp;
  if (rawMcp !== undefined) {
    const proto =
      typeof rawMcp === "object" && rawMcp !== null ? Object.getPrototypeOf(rawMcp) : undefined;
    if (
      typeof rawMcp !== "object" ||
      rawMcp === null ||
      Array.isArray(rawMcp) ||
      (proto !== Object.prototype && proto !== null)
    ) {
      throw new TypeError(`mcp must be an object; got ${rawMcp === null ? "null" : typeof rawMcp}`);
    }
  }
  if (opts.mcp?.enabled !== undefined && typeof opts.mcp.enabled !== "boolean") {
    throw new TypeError(`mcp.enabled must be a boolean; got ${typeof opts.mcp.enabled}`);
  }
  if (
    opts.mcp?.trustProjectConfig !== undefined
    && typeof opts.mcp.trustProjectConfig !== "boolean"
  ) {
    throw new TypeError(
      `mcp.trustProjectConfig must be a boolean; got ${typeof opts.mcp.trustProjectConfig}`,
    );
  }
  const compactionEnabled = compaction?.enabled !== false;
  if (compactionEnabled) {
    assertCompactionRatios(compaction?.keepTailRatio ?? 0.16, compaction?.softRatio ?? 0.8);
    assertKeepRecentTurns(compaction?.keepRecentTurns ?? 2);
  }
  if (opts.sessionDir !== undefined) {
    if (opts.sessionDir === "") {
      throw new SessionResumeError("invalid_target", "sessionDir must not be empty", {
        dir: opts.sessionDir,
      });
    }
    try {
      const info = await stat(opts.sessionDir);
      if (!info.isDirectory()) {
        throw new SessionResumeError(
          "invalid_target",
          `Session path is not a directory: ${opts.sessionDir}`,
          { dir: opts.sessionDir },
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const resume = opts.resume === true;
  const resumeDir = opts.sessionDir;
  if (resume && resumeDir === undefined) {
    throw new SessionResumeError(
      "missing_session_dir",
      "resume requires an explicit sessionDir",
    );
  }
  const home = opts.home ?? resolveHarnessHome();
  const providers =
    opts.providersText === undefined ? loadProviders(home) : parseProviders(opts.providersText);
  const { providerName, provider, modelName, model } = resolveModelRef(providers, opts.model);

  const apiKeyEnv = provider.apiKeyEnv;
  const rawApiKey = apiKeyEnv === undefined ? undefined : process.env[apiKeyEnv];
  const apiKey = rawApiKey === undefined ? undefined : rawApiKey.trim();
  const modelProtocol = createOpenAIProvider({
    baseUrl: provider.baseUrl,
    model: modelName,
    fetchImpl: opts.fetchImpl,
    ...(apiKey !== undefined && apiKey !== "" ? { apiKey } : {}),
    ...(provider.requestTimeoutMs !== undefined
      ? { requestTimeoutMs: provider.requestTimeoutMs }
      : {}),
    ...(provider.maxResponseBytes !== undefined
      ? { maxResponseBytes: provider.maxResponseBytes }
      : {}),
  });

  const id = opts.sessionId ?? randomUUID();
  let session: SessionHandle;
  let systemPromptToAppend: string | undefined;
  let runCwd: string;
  let loadedPermissions: LoadedPermissionConfig;
  let permissionGate: PermissionGate;

  const loadPermissions = (workdir: string): LoadedPermissionConfig =>
    loadPermissionConfig({
      home,
      workdir,
      ...(permissionOptions === undefined
        ? {}
        : {
            inline: permissionOptions.inline,
            ...(permissionOptions.options.userConfigPath !== undefined
              ? { userConfigPath: permissionOptions.options.userConfigPath }
              : {}),
            ...(permissionOptions.options.projectConfigPath !== undefined
              ? { projectConfigPath: permissionOptions.options.projectConfigPath }
              : {}),
            ...(permissionOptions.options.trustProjectConfig !== undefined
              ? { trustProjectConfig: permissionOptions.options.trustProjectConfig }
              : {}),
          }),
    });

  const buildPermissionGate = (loaded: LoadedPermissionConfig): PermissionGate =>
    createPermissionGate({
      preset: loaded.preset,
      rules: loaded.rules,
      approvalTimeoutMs: loaded.approvalTimeoutMs,
      ...(permissionOptions?.options.prompter !== undefined
        ? { prompter: permissionOptions.options.prompter }
        : {}),
    });

  if (resume && resumeDir !== undefined) {
    const headerPath = path.join(resumeDir, "header.json");
    try {
      await stat(headerPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new SessionResumeError(
          "missing_session_dir",
          `Session header not found: ${headerPath}`,
          { dir: resumeDir, file: "header.json" },
        );
      }
      throw error;
    }
    // 只读 header 后再加载权限配置；配置失败不得打开 handle、触发 crash recovery 或追加事件。
    const { header } = readSessionDir(resumeDir);
    runCwd = path.resolve(opts.cwd ?? header.workdir ?? process.cwd());
    loadedPermissions = loadPermissions(runCwd);
    permissionGate = buildPermissionGate(loadedPermissions);
    const plan = await planResume(resumeDir, opts);
    session = plan.session;
    systemPromptToAppend = plan.systemPromptToAppend;
    runCwd = plan.cwd;
  } else {
    const sessionDir = resumeDir ?? path.join(home, "sessions", id);
    runCwd = path.resolve(opts.cwd ?? process.cwd());
    loadedPermissions = loadPermissions(runCwd);
    permissionGate = buildPermissionGate(loadedPermissions);
    session = await createSession(sessionDir, {
      id,
      systemPrompt: opts.systemPrompt,
      provider: providerName,
      model: opts.model,
      workdir: runCwd,
    });
  }

  let hasPrimaryError = false;
  let mcpManager: McpManager | undefined;
  let statusQueue: Promise<void> = Promise.resolve();
  const seenMcpStatuses = new Set<string>();
  // 串行化写入,避免并发 append 打乱 seq;helper 内部已决定失败语义(降级、不抛)。
  const enqueueMcpStatus = (status: McpStatusEvent | McpSessionStatus): void => {
    const payload = toMcpStatusPayload(status);
    if (payload === undefined) return;
    statusQueue = statusQueue.then(() => appendMcpStatus(session, payload).then(() => undefined));
  };
  const appendMcpStatusOnce = (key: string, status: McpSessionStatus): void => {
    if (seenMcpStatuses.has(key)) {
      return;
    }
    seenMcpStatuses.add(key);
    enqueueMcpStatus(status);
  };

  try {
    opts.onSession?.(session);
    if (systemPromptToAppend !== undefined) {
      await session.append({ type: "system", payload: { content: systemPromptToAppend } });
    }
    if (loadedPermissions.projectSkipped !== undefined) {
      await session.append({
        type: "status",
        payload: {
          status: "permissions_project_config_skipped",
          message: loadedPermissions.projectSkipped,
        },
      });
    }

    const signal = opts.signal ?? new AbortController().signal;

    let meter: TokenMeter | undefined;
    let budget: LoopCtx["budget"];
    let compactor: LoopCtx["compactor"];

    if (compactionEnabled) {
      const softRatio = compaction?.softRatio ?? 0.8;
      const tokenMeter = createTokenMeter(heuristicCountTokens);
      meter = tokenMeter;
      budget = (messages) =>
        checkBudgetTokens(tokenMeter.measure(messages), model.contextWindow, softRatio);
      compactor = (target) =>
        compactSession({
          session: target,
          model: modelProtocol,
          modelCfg: model,

          signal,
          meter: tokenMeter,
          softRatio,
          ...(compaction?.keepRecentTurns !== undefined
            ? { keepRecentTurns: compaction.keepRecentTurns }
            : {}),
          ...(compaction?.keepTailRatio !== undefined
            ? { keepTailRatio: compaction.keepTailRatio }
            : {}),
        });
    } else {
      budget = (messages) => checkBudget(messages, model.contextWindow);
    }

    const builtinTools = createBuiltinTools();
    const registry = new ToolRegistry(builtinTools);

    if (opts.mcp?.enabled !== false) {
      try {
        const explicitProjectPath = opts.mcp?.projectConfigPath;
        const trustProject =
          opts.mcp?.trustProjectConfig === true || explicitProjectPath !== undefined;
        const defaultProjectPath = path.join(runCwd, ".harness", "mcp.json");
        if (!trustProject && existsSync(defaultProjectPath)) {
          enqueueMcpStatus({
            status: "mcp_project_config_skipped",
            message: defaultProjectPath,
          });
        }
        const servers = loadMcpConfig({
          home,
          workdir: runCwd,
          includeProject: trustProject,
          onWarning: (warning) =>
            appendMcpStatusOnce(
              `config-warning:${warning.file}\u0000${warning.server}\u0000${warning.field}`,
              {
                status: "mcp_config_warning",
                server: warning.server,
                message: `未知 MCP 配置字段 "${warning.field}"（${warning.file}）`,
              },
            ),
          ...(opts.mcp?.userConfigPath !== undefined
            ? { userConfigPath: opts.mcp.userConfigPath }
            : {}),
          ...(explicitProjectPath !== undefined
            ? { projectConfigPath: explicitProjectPath }
            : {}),
        });
        if (servers.length > 0) {
          const manager = new McpManager(servers, {
            logger: (event) => enqueueMcpStatus(event),
          });
          mcpManager = manager;
          const emitAdapterStatus = (status: McpToolAdapterStatus): void => {
            if (status.kind === "mcp_tool_invalid_schema") {
              appendMcpStatusOnce(`invalid:${status.server}\u0000${status.tool}`, {
                status: "mcp_tool_invalid_schema",
                server: status.server,
                tool: status.tool,
                message: status.message,
              });
              return;
            }
            appendMcpStatusOnce(
              `renamed:${status.server}\u0000${status.tool}\u0000${status.name}`,
              {
                status: "mcp_tool_name_renamed",
                server: status.server,
                tool: status.tool,
                name: status.name,
                originalName: status.originalName,
              },
            );
          };
          const rebuildMcpTools = (): void => {
            const pendingStatuses: McpToolAdapterStatus[] = [];
            try {
              const mcpTools = createMcpTools(manager, {
                reservedNames: builtinTools.map((tool) => tool.name),
                onStatus: (status) => pendingStatuses.push(status),
              });

              registry.replace([...builtinTools, ...mcpTools]);
            } catch (error) {
              enqueueMcpStatus({
                status: "mcp_tools_refresh_failed",
                scope: "global",
                message: messageOf(error),
              });
              return;
            }
            for (const status of pendingStatuses) emitAdapterStatus(status);
          };
          manager.onToolsChanged(() => rebuildMcpTools());
          await manager.connectAll();
          rebuildMcpTools();
        }
      } catch (error) {
        if (error instanceof McpConfigError) {
          enqueueMcpStatus({ status: "mcp_config_failed", message: error.message });
        } else {
          throw error;
        }
      }
    }

    const ctx: LoopCtx = {
      session,
      model: modelProtocol,
      modelCfg: model,
      tools: registry,
      budget,
      signal,
      artifactDir: path.join(session.dir, "artifacts"),
      cwd: runCwd,
      timeoutMs: opts.timeoutMs,
      pricePerMillion: provider.pricePerMillion,
      permissionGate,
      ...(meter !== undefined ? { meter } : {}),
      ...(compactor !== undefined ? { compactor } : {}),
    };

    yield* query(ctx, opts.input, {
      maxTurns: opts.maxTurns ?? 10,
      maxCostUsd: opts.maxCostUsd,
    });
  } catch (error) {
    hasPrimaryError = true;
    throw error;
  } finally {
    let closeError: unknown;
    // 先关闭 MCP(停止 list_changed 通知与 refresh),再 flush status 队列,
    // 最后关闭 session;避免 refresh 在 flush 之后写入已关闭的会话(D-101)。
    try {
      await mcpManager?.close();
    } catch (error) {
      if (!hasPrimaryError) closeError = error;
    }
    await statusQueue;
    try {
      await session.close();
    } catch (error) {
      if (!hasPrimaryError && closeError === undefined) closeError = error;
    }
    if (closeError !== undefined && !hasPrimaryError) throw closeError;
  }
}
