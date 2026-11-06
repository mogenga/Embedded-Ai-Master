import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import {
  isReasoningEffort,
  loadProviders,
  parseProviders,
  resolveModelRef,
  REASONING_EFFORTS,
  supportsReasoning,
} from "../config/providers.js";
import type { ProvidersConfig, ReasoningEffort } from "../config/providers.js";
import type { PermissionPreset } from "../permissions/types.js";
import { runSession } from "../index.js";
import type { RunOptions, RunPermissionOptions } from "../index.js";
import { createMcpRegistry } from "../mcp/registry.js";
import type { McpRegistry } from "../mcp/registry.js";
import { SessionCorruptionError } from "../session/errors.js";
import { isValidSessionId } from "../session/handle.js";
import { readSessionHeader } from "../session/persistence.js";
import type { SessionHandle } from "../session/session.js";
import type { SessionEvent } from "../session/types.js";
import { createApprovalBridge } from "./approvals.js";
import type { ApprovalBridge, DecideOutcome } from "./approvals.js";

const DEFAULT_MAX_TEXT_LENGTH = 8_000;
const DEFAULT_READY_TIMEOUT_MS = 10_000;
const CLOSE_TIMEOUT_MS = 5_000;

export interface ActionInput {
  text: string;
  sessionId?: string;
  /**
   * Permission preset for this run only.
   *
   * The runner's constructor preset is the default; a caller that lets the
   * operator pick a mode (the web UI's mode menu) passes it here. Ignored when
   * the runner was built without permissions and the value is absent.
   */
  mode?: PermissionPreset;
  /**
   * Loop breakers and per-call timeout.
   *
   * `maxTurns: null` means "no turn limit" and is the same as omitting the
   * field; the kernel has no default cap. `maxCostUsd` / `timeoutMs` are
   * unchanged: absent still means the kernel default.
   */
  maxTurns?: number | null;
  maxCostUsd?: number;
  timeoutMs?: number;
  /**
   * 整跑墙钟上限（毫秒）；null / 缺省表示不限。
   *
   * 与 `timeoutMs`（单次工具调用）不是一回事，见 `RunOptions.deadlineMs`。
   */
  deadlineMs?: number | null;
  /**
   * 操作者自己写的系统提示词，作为日志里的 `system` 事件随会话保存。
   *
   * **内核没有内置提示词**：`environment` 等内置节由投影期注入、不写日志。
   * 这个字段只是把用户写的那一段交给内核（D-221）。
   */
  systemPrompt?: string;
  /**
   * 本次运行的推理强度覆盖；`"auto"` 与缺省同义（用模型配置里的默认值）。
   *
   * `auto` 是界面的哨兵值，不是协议取值：协议里只有
   * `none|minimal|low|medium|high`。把它当字面量发上线会得到一个 400，所以
   * 这一层就把它转成「没有覆盖」，而不是让它继续往下走。
   */
  reasoningEffort?: ReasoningEffort | "auto";
  /** 本次运行的工作目录（新会话写入 header.workdir；续聊时内核以 header 为准）。
   *  必须是已存在的绝对路径目录，否则 RunnerError("invalid_cwd")。 */
  cwd?: string;
  /**
   * 本次（新建）会话使用的模型引用，形如 `provider/modelName`。
   *
   * 内核把会话模型固定在 header 里，续聊换模型会抛 `model_mismatch`，所以
   * 这里只在没有 header 的新会话上生效；续聊时以 header 为准，与 `cwd` 同理。
   */
  model?: string;
}

/** The subset of `ActionInput` that has to survive validation. */
interface RunLimits {
  maxTurns?: number;
  maxCostUsd?: number;
  timeoutMs?: number;
  deadlineMs?: number;
  systemPrompt?: string;
  reasoningEffort?: ReasoningEffort;
}

function readRunLimits(input: ActionInput): RunLimits {
  const limits: RunLimits = {};
  // null 与 undefined 是同一个意思：不限制轮数。字段必须真的缺席，而不是
  // 传 `null` 下去——那会让 `runSession` 的空值检查与日志都出现一个假值。
  if (input.maxTurns !== undefined && input.maxTurns !== null) {
    if (!Number.isInteger(input.maxTurns) || input.maxTurns < 1) {
      throw new RunnerError("invalid_run_limits", `maxTurns 必须是正整数: ${String(input.maxTurns)}`);
    }
    limits.maxTurns = input.maxTurns;
  }
  if (input.maxCostUsd !== undefined) {
    if (!Number.isFinite(input.maxCostUsd) || input.maxCostUsd <= 0) {
      throw new RunnerError("invalid_run_limits", `maxCostUsd 必须是正数: ${String(input.maxCostUsd)}`);
    }
    limits.maxCostUsd = input.maxCostUsd;
  }
  if (input.timeoutMs !== undefined) {
    if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1) {
      throw new RunnerError("invalid_run_limits", `timeoutMs 必须是正整数: ${String(input.timeoutMs)}`);
    }
    limits.timeoutMs = input.timeoutMs;
  }
  if (input.deadlineMs !== undefined && input.deadlineMs !== null) {
    if (!Number.isInteger(input.deadlineMs) || input.deadlineMs < 1) {
      throw new RunnerError("invalid_run_limits", `deadlineMs 必须是正整数: ${String(input.deadlineMs)}`);
    }
    limits.deadlineMs = input.deadlineMs;
  }
  if (input.systemPrompt !== undefined) {
    if (typeof input.systemPrompt !== "string") {
      throw new RunnerError("invalid_run_limits", "systemPrompt 必须是字符串");
    }
    // An empty string means "use the default", not "send no system prompt":
    // the latter is indistinguishable from a caller who never set one.
    if (input.systemPrompt.trim() !== "") limits.systemPrompt = input.systemPrompt;
  }
  if (input.reasoningEffort !== undefined) {
    // `auto` is the UI's "send nothing" sentinel, not a protocol level. It is
    // accepted here and then dropped, so the field really is absent downstream
    // — passing the literal through would send `reasoning_effort: "auto"`.
    if (input.reasoningEffort === "auto") return limits;
    if (!isReasoningEffort(input.reasoningEffort)) {
      throw new RunnerError(
        "invalid_run_limits",
        `reasoningEffort 非法: ${JSON.stringify(input.reasoningEffort)}；合法值: auto, ${REASONING_EFFORTS.join(", ")}`,
      );
    }
    limits.reasoningEffort = input.reasoningEffort;
  }
  return limits;
}

/**
 * 校验单次运行的 `cwd`，返回可交给 `runSession` 的绝对路径。
 *
 * 校验必须在创建会话之前完成：否则一个拼错的目录会留下一个 header
 * 已经写入错误 workdir 的空会话。只接受已存在的绝对路径目录；相对路径
 * 会被解析成「服务进程自己的 cwd」，那几乎不是调用方想要的。
 */
async function resolveRunCwd(cwd: unknown): Promise<string | undefined> {
  if (cwd === undefined) return undefined;
  if (typeof cwd !== "string") {
    throw new RunnerError("invalid_cwd", "cwd 必须是字符串");
  }
  const trimmed = cwd.trim();
  if (trimmed === "") {
    throw new RunnerError("invalid_cwd", "cwd 不能为空");
  }
  if (trimmed.includes("\0")) {
    throw new RunnerError("invalid_cwd", `cwd 非法: ${cwd}`);
  }
  if (!path.isAbsolute(trimmed)) {
    throw new RunnerError("invalid_cwd", `cwd 必须是绝对路径: ${cwd}`);
  }
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(trimmed);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new RunnerError("invalid_cwd", `cwd 不存在: ${cwd}`);
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new RunnerError("invalid_cwd", `cwd 不可访问: ${cwd}`);
    }
    throw error;
  }
  if (!info.isDirectory()) {
    throw new RunnerError("invalid_cwd", `cwd 不是目录: ${cwd}`);
  }
  return path.resolve(trimmed);
}

const PERMISSION_PRESETS: readonly PermissionPreset[] = [
  "read-only",
  "workspace-write",
  "diagnose",
  "danger-full-access",
];

function isPermissionPreset(value: unknown): value is PermissionPreset {
  return typeof value === "string" && (PERMISSION_PRESETS as readonly string[]).includes(value);
}

export type ActionOutcome = { sessionId: string; created: boolean };

export type RunnerErrorCode =
  | "invalid_text"
  | "invalid_session_id"
  | "invalid_mode"
  | "invalid_run_limits"
  | "invalid_cwd"
  | "invalid_model"
  | "unknown_session"
  | "session_busy"
  | "session_corrupt"
  | "session_unreadable"
  | "model_unavailable"
  | "session_start_timeout"
  | "runner_unavailable";

export class RunnerError extends Error {
  constructor(
    readonly code: RunnerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "RunnerError";
  }
}

export type RunnerDecideOutcome =
  | DecideOutcome
  | { kind: "unknown_session" }
  | { kind: "runner_unavailable" };

export interface SessionRunner {
  start(input: ActionInput): Promise<ActionOutcome>;
  decide(
    sessionId: string,
    requestId: string,
    decision: "allow" | "deny",
  ): Promise<RunnerDecideOutcome>;
  /** Abort the run in flight. Returns false when there is nothing to abort. */
  abort(sessionId: string): boolean;
  /**
   * Release the MCP connections held for this session.
   *
   * The kernel keeps one MCP connection set per conversation, so a session that
   * is no longer on screen would otherwise hold its probe/serial child
   * processes. A session unknown to this runner is a no-op.
   */
  closeSession(sessionId: string): Promise<void>;
  close(): Promise<void>;
}

export interface SessionRunnerOptions {
  harnessHome: string;
  model?: string;
  providersText?: string;
  fetchImpl?: typeof fetch;
  maxTextLength?: number;
  readyTimeoutMs?: number;
  runSessionImpl?: typeof runSession;
  cwd?: string;
  /**
   * Permission options applied to every run this runner starts. The approval
   * bridge is always the runner's own; a caller cannot replace it.
   */
  permissions?: Omit<RunPermissionOptions, "prompter">;
  /**
   * 进程内事件通道（OPT-15 / D-134）：每条会话事件**落盘之后**立刻回调。
   *
   * 日志仍是唯一事实源：回调在 append 完成之后才触发，所以事件一定已经在
   * 磁盘上；同进程的宿主因此可以少等一个轮询周期，而文件跟随仍负责崩溃恢复、
   * 外部进程写入与重连补播。两条路径按 `seq` 去重（协议层的 `ctx.lastSeq`）。
   *
   * 回调是**尽力而为的加速**：它抛错不会影响主循环，只在第一次记一条 stderr
   * 警告，之后静默——一次渲染失败不能让一整轮诊断停摆。
   */
  onSessionEvent?: (sessionId: string, event: SessionEvent) => void;
}

interface RunnerEntry {
  controller: AbortController;
  completion: Promise<void>;
  bridge: ApprovalBridge;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function causeOf(error: unknown): unknown {
  return (error as { detail?: { cause?: unknown } } | undefined)?.detail?.cause;
}

function errnoOf(error: unknown): string | undefined {
  const causeCode = (causeOf(error) as NodeJS.ErrnoException | undefined)?.code;
  if (causeCode !== undefined) return causeCode;
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function mapHeaderError(error: unknown, sessionId: string): never {
  const code = errnoOf(error);
  if (code === "ENOENT" || code === "ENOTDIR") {
    throw new RunnerError("unknown_session", `会话不存在: ${sessionId}`);
  }
  if (code === "EACCES" || code === "EPERM") {
    throw new RunnerError("session_unreadable", "会话不可读");
  }
  if (error instanceof SessionCorruptionError) {
    throw new RunnerError("session_corrupt", `会话 header 损坏: ${messageOf(error)}`);
  }
  throw error;
}

function firstReference(providers: ProvidersConfig): string | undefined {
  for (const providerName of Object.keys(providers)) {
    const models = Object.keys(providers[providerName]?.models ?? {});
    const modelName = models[0];
    if (modelName !== undefined) return `${providerName}/${modelName}`;
  }
  return undefined;
}

export function createSessionRunner(opts: SessionRunnerOptions): SessionRunner {
  const maxTextLength = opts.maxTextLength ?? DEFAULT_MAX_TEXT_LENGTH;
  const readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
  const runSessionImpl = opts.runSessionImpl ?? runSession;
  const registry = new Map<string, RunnerEntry>();
  // MCP 连接按会话持有：一个会话的多条消息复用同一份连接（不再每条消息重新
  // 握手），会话切换或被 runner 关闭时释放。惰性创建，没跑过就没有连接表。
  let mcpRegistry: McpRegistry | undefined;
  // sessionId → 会话目录，就是连接表的 key。onSession 是唯一能拿到目录的时机
  // （`start` 的返回值只有 id）。
  const sessionDirs = new Map<string, string>();
  const onSessionEvent = opts.onSessionEvent;
  // 回调失败只提示一次：每个事件都写一行会把 stderr 变成噪音，而"加速通道
  // 一直坏着"这件事只需要说一次。
  let liveEventErrorReported = false;
  let closed = false;

  /**
   * 在会话句柄的 `append` 上加一层进程内转发（OPT-15 / D-134）。
   *
   * 为什么挂在这里而不是消费 `runSession` 生成器：生成器产出的是 `LoopEvent`
   * （`kind` + 正文），没有 `seq`，也不是渲染层的 `SessionEvent` 词汇；按它
   * 转发只能另造一套事件模型，且无法与日志通道按 seq 对齐。`append` 是事件
   * **落盘之后**唯一能拿到完整 `SessionEvent` 的位置——日志仍是唯一事实源，
   * 转发发生在 fsync 之后，不改变任何既有语义。
   *
   * `runSession` 持有的是同一个句柄对象，所以原地替换 `append` 对所有调用方
   * 生效（主循环、增量写入器、压缩）。回调抛错一律吞掉：一次界面推送失败
   * 不能让一整轮诊断停摆，文件通道随后仍会送到。
   */
  function attachLiveEvents(session: SessionHandle, sessionId: string): void {
    if (onSessionEvent === undefined) return;
    const append = session.append.bind(session);
    session.append = async (ev) => {
      const event = await append(ev);
      try {
        onSessionEvent(sessionId, event);
      } catch (error) {
        if (!liveEventErrorReported) {
          liveEventErrorReported = true;
          process.stderr.write(
            `[session-runner] ${sessionId}: 事件回调失败，已降级为日志通道: ${messageOf(error)}\n`,
          );
        }
      }
      return event;
    };
  }

  function ensureMcpRegistry(): McpRegistry {
    mcpRegistry ??= createMcpRegistry();
    return mcpRegistry;
  }

  function assertText(text: unknown): asserts text is string {
    if (typeof text !== "string" || text.trim().length === 0) {
      throw new RunnerError("invalid_text", "text 不能为空");
    }
    if (text.length > maxTextLength) {
      throw new RunnerError("invalid_text", `text 超过 ${maxTextLength} 字符上限`);
    }
  }

  function modelUnavailableMessage(detail: string): string {
    return `${redactHomePath(detail)}；请检查 HARNESS_HOME/providers.json 与 HARNESS_WEB_MODEL`;
  }

  function redactHomePath(text: string): string {
    let result = text;
    const variants = new Set([opts.harnessHome, path.resolve(opts.harnessHome)]);
    for (const variant of variants) {
      if (variant === "") continue;
      result = result.split(variant).join("HARNESS_HOME");
      const posix = variant.split(path.sep).join("/");
      if (posix !== variant) result = result.split(posix).join("HARNESS_HOME");
    }
    return result;
  }

  function resolveProviders(): ProvidersConfig {
    try {
      return opts.providersText ? parseProviders(opts.providersText) : loadProviders(opts.harnessHome);
    } catch (error) {
      throw new RunnerError(
        "model_unavailable",
        modelUnavailableMessage(`providers 不可用: ${messageOf(error)}`),
      );
    }
  }

  function resolveModel(
    providers: ProvidersConfig,
    sessionModel: string | undefined,
    requestedModel: string | undefined,
  ): string {
    const envModel = process.env.HARNESS_WEB_MODEL;
    const fallback = envModel !== undefined && envModel !== "" ? envModel : firstReference(providers);
    // `sessionModel` 是续聊会话 header 里的模型：内核只允许用同一个模型续聊，
    // 所以它的优先级最高；新建会话没有 header 时，本次传入的选择才轮到。
    const modelRef = sessionModel ?? requestedModel ?? opts.model ?? fallback;
    if (modelRef === undefined || modelRef === "") {
      throw new RunnerError(
        "model_unavailable",
        modelUnavailableMessage("没有可用的模型引用"),
      );
    }
    try {
      resolveModelRef(providers, modelRef);
    } catch (error) {
      throw new RunnerError(
        "model_unavailable",
        modelUnavailableMessage(`模型引用无效: ${messageOf(error)}`),
      );
    }
    return modelRef;
  }

  async function start(input: ActionInput): Promise<ActionOutcome> {
    if (closed) throw new RunnerError("runner_unavailable", "runner 已关闭");
    assertText(input?.text);
    if (input?.mode !== undefined && !isPermissionPreset(input.mode)) {
      // A typo must not silently run under the constructor's preset: the
      // operator believes they selected something else.
      throw new RunnerError("invalid_mode", `非法的权限预设: ${String(input.mode)}`);
    }
    if (input?.model !== undefined && typeof input.model !== "string") {
      // 与 `invalid_mode` 同理：类型错是调用方的 bug，不能悄悄退回默认模型。
      throw new RunnerError("invalid_model", `模型引用必须是字符串: ${String(input.model)}`);
    }
    const limits = readRunLimits(input);
    // 先于会话创建：拼错的目录不能留下一个 workdir 已经写错的会话。
    const runCwd = await resolveRunCwd(input?.cwd);

    const requestedId = input?.sessionId;
    if (requestedId !== undefined) {
      if (!isValidSessionId(requestedId)) {
        throw new RunnerError("invalid_session_id", `非法的会话 id: ${requestedId}`);
      }
      if (registry.has(requestedId)) {
        throw new RunnerError("session_busy", `会话正在运行: ${requestedId}`);
      }
    }

    let resumeDir: string | undefined;
    let sessionModel: string | undefined;
    if (requestedId !== undefined) {
      const dir = path.join(opts.harnessHome, "sessions", requestedId);
      try {
        sessionModel = readSessionHeader(dir).model;
        resumeDir = dir;
      } catch (error) {
        mapHeaderError(error, requestedId);
      }
    }

    const providers = resolveProviders();
    const modelRef = resolveModel(providers, sessionModel, input.model);
    const sessionId = requestedId ?? randomUUID();

    const controller = new AbortController();
    const bridge = createApprovalBridge();
    let readySettled = false;
    let readyResolve!: () => void;
    let readyReject!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });

    const runOptions: RunOptions = {
      input: input.text,
      model: modelRef,
      sessionId,
      // 新建会话：单次 cwd 优先于 runner 的默认 cwd。续聊不传 cwd，让内核按
      // header.workdir 恢复——传了反而可能触发 workdir_mismatch。
      ...(resumeDir === undefined
        ? {
            ...(runCwd === undefined && opts.cwd === undefined ? {} : { cwd: runCwd ?? opts.cwd }),
          }
        : { sessionDir: resumeDir, resume: true }),
      home: opts.harnessHome,
      providersText: JSON.stringify(providers),
      signal: controller.signal,
      ...limits,
      // A per-run mode wins over the constructor preset; everything else
      // (rules, timeout, config paths) still comes from the runner.
      permissions: {
        ...(opts.permissions ?? {}),
        ...(input.mode === undefined ? {} : { preset: input.mode }),
        prompter: bridge,
      },
      mcpRegistry: ensureMcpRegistry(),
      onSession: (session) => {
        bridge.bindSession(session);
        // The only place the session's directory is visible; the MCP registry
        // is keyed by it (`closeSession` maps id → dir).
        sessionDirs.set(sessionId, session.dir);
        // 同一个时机会拿到本轮真正写入的那个句柄，进程内事件通道就挂在这里。
        attachLiveEvents(session, sessionId);
        if (readySettled) return;
        readySettled = true;
        readyResolve();
      },
      ...(opts.fetchImpl === undefined ? {} : { fetchImpl: opts.fetchImpl }),
    };

    const entry: RunnerEntry = { controller, bridge, completion: Promise.resolve() };
    registry.set(sessionId, entry);

    const consume = async (): Promise<void> => {
      try {
        for await (const _event of runSessionImpl(runOptions)) {
          // 事件由日志推送通道消费；runner 只负责驱动 generator 跑完。
        }
        if (!readySettled) {
          readySettled = true;
          readyReject(
            new RunnerError("model_unavailable", "会话启动失败: runSession 在会话就绪前结束"),
          );
        }
      } catch (error) {
        if (!readySettled) {
          readySettled = true;
          readyReject(
            controller.signal.aborted
              ? new RunnerError("session_start_timeout", "会话在就绪前被中止")
              : error instanceof RunnerError
                ? error
                : new RunnerError("model_unavailable", `会话启动失败: ${messageOf(error)}`),
          );
        } else if (!controller.signal.aborted) {
          process.stderr.write(`[session-runner] ${sessionId}: ${messageOf(error)}\n`);
        }
      } finally {
        bridge.close();
        registry.delete(sessionId);
      }
    };
    entry.completion = consume();

    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        ready,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new RunnerError(
                "session_start_timeout",
                `会话未创建成功：会话在 ${readyTimeoutMs}ms 内未就绪`,
              ),
            );
          }, readyTimeoutMs);
        }),
      ]);
    } catch (error) {
      if (!readySettled) readySettled = true;
      controller.abort();
      bridge.close();
      throw error instanceof RunnerError
        ? error
        : new RunnerError(
            "session_start_timeout",
            `会话未创建成功：会话启动失败: ${messageOf(error)}`,
          );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    return { sessionId, created: resumeDir === undefined };
  }

  async function decide(
    sessionId: string,
    requestId: string,
    decision: "allow" | "deny",
  ): Promise<RunnerDecideOutcome> {
    // 关闭后注册表已清空;若不先判 closed,「运行器已关闭」会被伪装成「会话不存在」(D-154)。
    if (closed) return { kind: "runner_unavailable" };
    const entry = registry.get(sessionId);
    if (entry === undefined) return { kind: "unknown_session" };
    return entry.bridge.decide(requestId, decision);
  }

  function abort(sessionId: string): boolean {
    // 关闭后注册表为空：返回 false 而不是伪装成“已中止”。
    if (closed) return false;
    const entry = registry.get(sessionId);
    if (entry === undefined) return false;
    entry.controller.abort();
    entry.bridge.close();
    return true;
  }

  async function closeSession(sessionId: string): Promise<void> {
    const dir = sessionDirs.get(sessionId);
    if (dir === undefined || mcpRegistry === undefined) {
      return;
    }
    sessionDirs.delete(sessionId);
    await mcpRegistry.release(dir);
  }

  async function close(): Promise<void> {
    closed = true;
    const entries = [...registry.values()];
    for (const entry of entries) {
      entry.controller.abort();
      entry.bridge.close();
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.allSettled(entries.map((entry) => entry.completion)),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      registry.clear();
      sessionDirs.clear();
    }
    // 会话都结束后才释放连接表：运行中的 run 还在用它们。释放失败照样让
    // close 完成（进程已经在退出路径上），但把第一个错误抛给调用方。
    if (mcpRegistry !== undefined) {
      const releasing = mcpRegistry;
      mcpRegistry = undefined;
      await releasing.releaseAll();
    }
  }

  return { start, decide, abort, closeSession, close };
}