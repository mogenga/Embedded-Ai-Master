import { randomUUID } from "node:crypto";
import path from "node:path";
import { loadProviders, parseProviders, resolveModelRef } from "../config/providers.js";
import type { ProvidersConfig } from "../config/providers.js";
import type { PermissionPreset } from "../permissions/types.js";
import { runSession } from "../index.js";
import type { RunOptions, RunPermissionOptions } from "../index.js";
import { SessionCorruptionError } from "../session/errors.js";
import { isValidSessionId } from "../session/handle.js";
import { readSessionHeader } from "../session/persistence.js";
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
  let closed = false;

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

  function resolveModel(providers: ProvidersConfig, sessionModel: string | undefined): string {
    const envModel = process.env.HARNESS_WEB_MODEL;
    const fallback = envModel !== undefined && envModel !== "" ? envModel : firstReference(providers);
    const modelRef = sessionModel ?? opts.model ?? fallback;
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
    const modelRef = resolveModel(providers, sessionModel);
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
      ...(resumeDir === undefined
        ? {
            ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
          }
        : { sessionDir: resumeDir, resume: true }),
      home: opts.harnessHome,
      providersText: JSON.stringify(providers),
      signal: controller.signal,
      // A per-run mode wins over the constructor preset; everything else
      // (rules, timeout, config paths) still comes from the runner.
      permissions: {
        ...(opts.permissions ?? {}),
        ...(input.mode === undefined ? {} : { preset: input.mode }),
        prompter: bridge,
      },
      onSession: (session) => {
        bridge.bindSession(session);
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
    }
  }

  return { start, decide, abort, close };
}