import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { resolveHarnessHome } from "./config/harness-home.js";
import {
  loadProviders,
  parseProviders,
  resolveModelRef,
  resolveProviderApiKey,
  resolveReasoningEffort,
} from "./config/providers.js";
import { checkBudgetForModel, checkBudgetTokensForModel } from "./context/budget.js";
import { renderEnvironmentSection } from "./context/system-sections.js";
import type { SystemSections } from "./context/system-sections.js";
import {
  assertCompactionRatios,
  assertKeepRecentTurns,
  compactSession,
} from "./context/compact.js";
import { createTokenMeter } from "./context/token-meter.js";
import type { TokenMeter } from "./context/token-meter.js";
import { createHookRunner } from "./hooks/run.js";
import { HookConfigError, loadHookConfig } from "./hooks/config.js";
import type { HookRunner } from "./hooks/types.js";
import type { LoopEvent } from "./loop/events.js";
import { query } from "./loop/query.js";
import type { LoopCtx } from "./loop/query.js";
import { loadMcpConfig } from "./mcp/config.js";
import { McpConfigError } from "./mcp/errors.js";
import { McpManager } from "./mcp/manager.js";
import type { McpStatusEvent } from "./mcp/manager.js";
import type { McpRegistry } from "./mcp/registry.js";
import { createMcpTools } from "./mcp/tools.js";
import type { McpToolAdapterStatus } from "./mcp/tools.js";
import { heuristicCountTokens } from "./model/count.js";
import { createOpenAIProvider } from "./model/openai.js";
import { loadPermissionConfig, parseInlinePermissionConfig } from "./permissions/config.js";
import type { ReasoningEffort } from "./config/providers.js";
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
import { subagentSpendUsd } from "./subagent/runner.js";
import { createSubagentTools } from "./subagent/tools.js";
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
  /** 本次运行的模型调用上限；缺省表示不限制轮数。 */
  maxTurns?: number;
  /** 会话累计成本上限（美元）；缺省表示不限制。 */
  maxCostUsd?: number;
  cwd?: string;
  timeoutMs?: number;
  /**
   * 整跑墙钟上限（毫秒），从本次运行开始算到结束，**不是**单次工具超时（那是
   * `timeoutMs`）。缺省或 `<= 0` 表示不限制（D-189）。
   *
   * 与 `maxTurns` 同一原则：不填默认值。取消默认轮数上限之后，这是无人值守
   * 场景里唯一还能保证「一次 run 不会无限期占着会话锁」的边界。
   */
  deadlineMs?: number;
  /**
   * 本次运行的推理强度覆盖；缺省表示用 `providers.json` 里该模型的默认值。
   *
   * 显式写成 `undefined` 与不写同义。注意它**不能**表达「不发这个字段而忽略
   * 模型配置」——那是两回事，目前也没有调用方需要。
   */
  reasoningEffort?: ReasoningEffort;
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
  /**
   * 外部命令钩子（`hooks.json`）。与 `mcp` 那一组同形，因为两者的信任规则相同。
   *
   * 读配置失败**不阻止运行**（发一条 `status: hooks_config_failed` 就继续）：
   * 钩子是加固，不是运行的前提。一个坏掉的 `hooks.json` 不该让一次诊断跑不起来。
   * 没有配置文件时 `hooks` 为 `undefined`，行为与没有这个字段时逐字节一致。
   */
  hooks?: {
    userConfigPath?: string;
    projectConfigPath?: string;
    trustProjectConfig?: boolean;
  };
  /**
   * 会话级 MCP 连接表（内部接线）。
   *
   * 不传时行为与从前完全一致：本轮自己建 manager、本轮关闭。传了则由表持有，
   * 同一会话的后续 run 复用它，直到调用方 release/closeSession。
   */
  mcpRegistry?: McpRegistry;
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

/**
 * 组装 P0 期唯一的系统提示词节：`environment`（设计稿 v0.2 §8）。
 *
 * 四个字段全部来自运行期，**在会话内恒定**：`workdir` 与会话日期来自会话本身，
 * 平台在进程内是常量，shell 由环境变量给出。日期取会话创建日而不是当前时刻——
 * 时刻每轮都变，写进前缀会让 prompt cache 全部失效（§2.2）。
 *
 * `base` / `tools` / `instructions` / `memory` 属于 P1 之后的分期，措辞是产品
 * 决定，不在本函数内凭空补写（D-221 的教训：不要在未定措辞时先写一段）。
 */
function buildSystemSections(workdir: string, createdAt: string): SystemSections {
  const shell = process.platform === "win32" ? process.env.COMSPEC : process.env.SHELL;
  return {
    environment: renderEnvironmentSection({
      workdir,
      platform: process.platform,
      shell,
      createdDate: createdAt,
    }),
  };
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
  // `hooks` 与 `mcp` 同形：只校验外壳与那个布尔信任开关，两份路径按原样交给
  // `loadHookConfig`（读不到就是「没配」，类型错误留给 fs 报出来）。
  const rawHooks: unknown = opts.hooks;
  if (rawHooks !== undefined) {
    const proto =
      typeof rawHooks === "object" && rawHooks !== null ? Object.getPrototypeOf(rawHooks) : undefined;
    if (
      typeof rawHooks !== "object"
      || rawHooks === null
      || Array.isArray(rawHooks)
      || (proto !== Object.prototype && proto !== null)
    ) {
      throw new TypeError(
        `hooks must be an object; got ${rawHooks === null ? "null" : typeof rawHooks}`,
      );
    }
  }
  if (
    opts.hooks?.trustProjectConfig !== undefined
    && typeof opts.hooks.trustProjectConfig !== "boolean"
  ) {
    throw new TypeError(
      `hooks.trustProjectConfig must be a boolean; got ${typeof opts.hooks.trustProjectConfig}`,
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

  // 密钥来源：配置文件里的明文 `apiKey` 优先，其次是 `apiKeyEnv` 指向的环境变量
  // （见 resolveProviderApiKey）。两者都没有时不传 apiKey，适配器就不发
  // Authorization 头。这里拿到的是密钥原文，只能交给适配器，不得记入日志或事件。
  const apiKey = resolveProviderApiKey(provider);
  // 推理强度：单次覆盖优先，其次是模型配置。两边都没有时是 `undefined`，
  // 适配器就不发 `reasoning_effort`——不是「发默认值」，而是「不提要求」。
  // 校验覆盖值的合法性由调用方负责（runner 会在 start 前拒绝），这里只合并。
  const reasoningEffort = resolveReasoningEffort(model, opts.reasoningEffort);
  const modelProtocol = createOpenAIProvider({
    baseUrl: provider.baseUrl,
    model: modelName,
    fetchImpl: opts.fetchImpl,
    ...(apiKey !== undefined ? { apiKey } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
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

  // 系统提示词只做**投影期注入**，不写会话日志（设计稿 v0.2 §3.1，D-221）：
  // 写日志会让所有历史会话在续聊时撞 `system_prompt_mismatch`，且「改提示词 =
  // 改历史事实」。环境事实全部可从运行期与 `header.createdAt` 重建。
  const systemSections = buildSystemSections(runCwd, session.header.createdAt);

  let hasPrimaryError = false;
  let queryStarted = false;
  let mcpManager: McpManager | undefined;
  // 是否由本轮创建并负责关闭。不能用 `mcpRegistry === undefined` 推断：两种
  // 来源都可能存在，注册表持有的 manager 不该由某一轮关掉。
  let ownsMcpManager = false;
  let unsubscribeMcpTools: (() => void) | undefined;
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

    // 外部命令钩子。与 `permissions` / `mcp` 同一信任门：只有显式信任（或给了
    // 显式项目路径）才读 `<workdir>/.harness/hooks.json`。
    //
    // 读配置失败**不阻止运行**：钩子是加固，不是运行的前提。发一条 status 就够了，
    // 与 `mcp_config_failed` 同一处置；直接抛错会让一个坏掉的 hooks.json 把一次
    // 本来能跑的诊断拦死，而用户此刻最需要的正是那次诊断。
    //
    // 没有配置文件 → `hookRunner` 为 undefined → `LoopCtx.hooks` 整键缺席 →
    // pipeline 的 `executeAuthorized` 完全不进钩子分支，行为与实现前逐字节一致。
    let hookRunner: HookRunner | undefined;
    try {
      const explicitProjectHookPath = opts.hooks?.projectConfigPath;
      const trustProjectHooks =
        opts.hooks?.trustProjectConfig === true || explicitProjectHookPath !== undefined;
      const loadedHooks = loadHookConfig({
        home,
        workdir: runCwd,
        includeProject: trustProjectHooks,
        ...(opts.hooks?.userConfigPath !== undefined
          ? { userConfigPath: opts.hooks.userConfigPath }
          : {}),
        ...(explicitProjectHookPath !== undefined
          ? { projectConfigPath: explicitProjectHookPath }
          : {}),
      });
      if (loadedHooks.projectSkipped !== undefined) {
        await session.append({
          type: "status",
          payload: {
            status: "hooks_project_config_skipped",
            message: loadedHooks.projectSkipped,
          },
        });
      }
      if (loadedHooks.hooks.length > 0) {
        hookRunner = createHookRunner(loadedHooks.hooks);
      }
    } catch (error) {
      if (!(error instanceof HookConfigError)) throw error;
      await session.append({
        type: "status",
        payload: { status: "hooks_config_failed", message: error.message },
      });
    }

    let meter: TokenMeter | undefined;
    let budget: LoopCtx["budget"];
    let compactor: LoopCtx["compactor"];

    if (compactionEnabled) {
      const softRatio = compaction?.softRatio ?? 0.8;
      const tokenMeter = createTokenMeter(heuristicCountTokens);
      meter = tokenMeter;
      budget = (messages) =>
        checkBudgetTokensForModel(tokenMeter.measure(messages), model, softRatio);
      compactor = (target) =>
        compactSession({
          session: target,
          model: modelProtocol,
          modelCfg: model,

          signal,
          meter: tokenMeter,
          softRatio,
          systemSections,
          ...(compaction?.keepRecentTurns !== undefined
            ? { keepRecentTurns: compaction.keepRecentTurns }
            : {}),
          ...(compaction?.keepTailRatio !== undefined
            ? { keepTailRatio: compaction.keepTailRatio }
            : {}),
        });
    } else {
      budget = (messages) => checkBudgetForModel(messages, model);
    }

    // 子代理的开销不在父会话日志里（它的 usage 事件写在子会话），所以父轮次的
    // `maxCostUsd` 看不到它。账本在 `src/subagent/runner.ts` 里按**父会话**累计，
    // 这样同一条会话的后续消息仍然带着它——父会话的 `costUsd` 本来就是整段会话
    // 的累计值，子代理的开销必须跟着同一条时间线。
    const builtinTools = createBuiltinTools();
    // 子代理工具与内置工具并列装配，但**不进** `createBuiltinTools()`：那一份
    // 不接参数，且有断言钉着它返回 13 个纯对象工具（`tests/tools.test.ts`）。
    // `registry` 传给子代理的是取值函数：它要先建出来，MCP 工具再往里装。
    const subagentTools = createSubagentTools({
      model: modelProtocol,
      modelCfg: model,
      registry: () => registry,
      budget,
      cwd: runCwd,
      // 规则直接从这一轮加载的配置里取：`PermissionGate` 只暴露 `check()`，
      // 为子代理去给那个公共接口加字段，改动面比受益大。
      inheritableRules: loadedPermissions.rules,
      systemSections,
      // 账本由 runner 按父会话记，`LoopCtx.externalCostUsd` 从那里读；这个回调
      // 现在没有第二个消费者。它仍是 deps 的必填项——那是「谁来对花费负责」的
      // 接线点，将来界面要显示「本会话子代理花销」时接在这里，而不是再算一遍。
      onSpend: () => undefined,
      // 开跑事件写在**父会话**日志里：子代理的存在必须能从这条时间线上看见，
      // 否则渲染器只在它结束时才知道有过这一件事，无法回答「现在有哪些在跑」。
      // 写失败由 runner 降级为一行 stderr 且不取消子代理（`appendMcpStatus`
      // 的姿态）：那是观测性记录，不是子代理能跑起来的前提。
      onStarted: async (payload) => {
        await session.append({ type: "subagent_started", payload: { ...payload } });
      },
      ...(compactor === undefined ? {} : { compactor }),
      ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
      ...(provider.pricePerMillion === undefined
        ? {}
        : { pricePerMillion: provider.pricePerMillion }),
    });
    const registry = new ToolRegistry([...builtinTools, ...subagentTools]);

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
          let manager: McpManager;
          if (opts.mcpRegistry !== undefined) {
            // 会话级复用：同一会话的后续消息等到的是同一个已连接的 manager。
            // 连接阶段的事件属于触发这次连接的那一轮，所以 logger 在建好后、
            // connectAll 之前就绑上本轮队列；复用轮次在 acquire 返回后重绑。
            manager = await opts.mcpRegistry.acquire(session.dir, async () => {
              const created = new McpManager(servers);
              created.setLogger((event) => enqueueMcpStatus(event));
              await created.connectAll();
              return created;
            });
          } else {
            manager = new McpManager(servers, {
              logger: (event) => enqueueMcpStatus(event),
            });
            mcpManager = manager;
            ownsMcpManager = true;
          }
          // 无论 manager 来自本轮还是注册表，事件都要进"这一轮"的会话日志：
          // 复用旧的闭包会把状态写进上一轮已关闭的 session。
          manager.setLogger((event) => enqueueMcpStatus(event));
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

              // 子代理工具必须一起放回去：漏掉这一处的后果不是「少两个工具」，
              // 而是**一次 MCP 工具刷新就让 `subagent` 从模型视野里消失**。
              registry.replace([...builtinTools, ...subagentTools, ...mcpTools]);
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
          unsubscribeMcpTools = manager.onToolsChanged(() => rebuildMcpTools());
          // 无注册表时沿用原路径（本轮连接、本轮关闭）。有注册表时连接已在
          // acquire 的 factory 里完成；这里再调一次是幂等的（connected 的
          // server 直接跳过），失败过的 server 也会给本轮一次重试机会。
          await manager.connectAll();
          // 复用的 manager 工具表属于上一轮（本轮 registry 是新建的），必须
          // 再填一次，否则模型这一轮看不到任何 MCP 工具。
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
      systemSections,
      // 子代理的开销计入本轮的成本判断（`maxCostUsd`）。**必须无条件给这个
      // 闭包**：ctx 是在任何子代理启动之前组装的，那一刻账本恒为 0——按「当前
      // 是否为零」来决定传不传，等于永远不传。
      externalCostUsd: () => subagentSpendUsd(session.id),
      ...(opts.deadlineMs !== undefined ? { deadlineMs: opts.deadlineMs } : {}),
      ...(meter !== undefined ? { meter } : {}),
      ...(compactor !== undefined ? { compactor } : {}),
      // 没有钩子时整键缺席：把它填成 undefined 也会让 `BatchOptions` 多一个
      // 与实现前不同的字段（形状变了，虽然行为一样）。
      ...(hookRunner !== undefined ? { hooks: hookRunner } : {}),
    };

    queryStarted = true;
    yield* query(ctx, opts.input, {
      // 只在调用方给了上限时才传：缺省表示「不检查轮数」。不要把 undefined
      // 填成一个默认数字——那正是被移除的旧行为（D-183 后续）。
      ...(opts.maxTurns !== undefined ? { maxTurns: opts.maxTurns } : {}),
      ...(opts.maxCostUsd !== undefined ? { maxCostUsd: opts.maxCostUsd } : {}),
    });
  } catch (error) {
    hasPrimaryError = true;
    if (!queryStarted) {
      // 启动阶段失败（如 onSession 抛错）也要留痕；append 失败不得覆盖原始错误。
      try {
        await session.append({ type: "interrupted", payload: { reason: "start_failed" } });
      } catch {}
    }
    throw error;
  } finally {
    let closeError: unknown;
    // 先退订本轮的工具表重建：注册表持有的 manager 活到下一条消息，旧 listener
    // 会继续往已经没人读的 ToolRegistry 里写，并跨 run 累积。
    unsubscribeMcpTools?.();
    try {
      // 先关闭 MCP(停止 list_changed 通知与 refresh),再 flush status 队列,
      // 最后关闭 session;避免 refresh 在 flush 之后写入已关闭的会话(D-101)。
      // 只有本轮自己建的 manager 才关；注册表持有的一直活到 release。
      if (ownsMcpManager) {
        await mcpManager?.close();
      }
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
