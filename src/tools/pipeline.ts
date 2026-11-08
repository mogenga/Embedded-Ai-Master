import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { HookOutcome, HookRunner } from "../hooks/types.js";
import { heuristicCountTokens } from "../model/count.js";
import type { PermissionGate, PermissionRequest } from "../permissions/types.js";
import type { SessionHandle } from "../session/session.js";
import type { ToolRegistry } from "./registry.js";
import type { ToolAccess, ToolCtx, ToolDef, ToolResult } from "./types.js";

export interface BatchCall {
  id: string;
  name: string;
  input: unknown;
}

export interface BatchResult {
  id: string;
  result: ToolResult;
}

export interface PermissionOptions {
  gate: PermissionGate;
  onDecision: (call: BatchCall, decision: PermissionRequest) => Promise<void>;
}

interface BatchOptionsCommon {
  signal: AbortSignal;
  artifactDir: string;
  cwd?: string;
  timeoutMs?: number;
  settleGraceMs?: number;
  onToolStarted?: (call: BatchCall, access: ToolAccess) => Promise<void>;
  /**
   * 外部命令钩子。缺省 `undefined` = 零行为变化。
   *
   * 与 `permission` **不同**，这个字段是可选的，不是「必须显式二选一」：没有钩子
   * 配置本来就没有可执行的东西（一个空清单与不存在是同一件事），而「不经权限层」
   * 是另一回事——那仍然必须由调用方显式声明（D-116）。给它一个 `noopHooks` 只会
   * 逼每个调用点写一行没有意义的代码。
   */
  hooks?: HookRunner;
}

/**
 * 权限层**必须二选一**，不允许省略（D-116）。
 *
 * 之前 `permission?` 可省略，省略即静默走无判定路径：直接调用 `executeBatch`
 * 的代码既不经过 gate，也不写 `permission_decision`，而日志上看不出少了什么。
 * 现在要么给 `permission`（真正判定并审计），要么写 `unsafeSkipPermission: true`
 * （明确声明"这批调用故意不经权限层"，例如管线自身的并发/超时/落盘测试）。
 * 类型上互斥，运行时另有守卫兜住 JS 调用方。
 */
export type BatchOptions = BatchOptionsCommon &
  (
    | { permission: PermissionOptions; unsafeSkipPermission?: never }
    | { permission?: never; unsafeSkipPermission: true }
  );

export type PermissionLayerChoiceCode =
  | "permission_choice_required"
  | "permission_choice_conflict";

/** 调用方没有就"是否经过权限层"做出显式选择时抛出，见 `BatchOptions`。 */
export class PermissionLayerChoiceError extends Error {
  readonly code: PermissionLayerChoiceCode;

  constructor(code: PermissionLayerChoiceCode, message: string) {
    super(message);
    this.name = "PermissionLayerChoiceError";
    this.code = code;
  }
}

/** `BatchOptions` / `LoopCtx` 共用的"是否经过权限层"这一对字段。 */
export interface PermissionLayerChoice {
  permission?: unknown;
  unsafeSkipPermission?: unknown;
}

// 类型层已排除"两者都不给"，但 JS 调用方与 `as unknown as` 仍能绕过去。
// 在入口一次性判定：此时任何工具都还没被查询、校验或执行。
export function assertPermissionLayerChoice(
  choice: PermissionLayerChoice,
  where: string,
): void {
  if (choice.permission !== undefined && choice.unsafeSkipPermission === true) {
    throw new PermissionLayerChoiceError(
      "permission_choice_conflict",
      `${where}: permission and unsafeSkipPermission are mutually exclusive`,
    );
  }
  if (choice.permission === undefined && choice.unsafeSkipPermission !== true) {
    throw new PermissionLayerChoiceError(
      "permission_choice_required",
      `${where}: pass permission to enforce the permission layer, or unsafeSkipPermission: true to bypass it explicitly`,
    );
  }
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_SETTLE_GRACE_MS = 2_000;
const MAX_TIMEOUT_MS = 2_147_483_647;
const ARTIFACT_TOKEN_THRESHOLD = 8_000;
const MAX_TEXT_TOKENS = 25_000;
const MAX_TEXT_CHARS = MAX_TEXT_TOKENS * 4;
const MAX_ARTIFACT_ID_CHARS = 100;
const MAX_ARTIFACT_ATTEMPTS = 1_000;
const MAX_NAME_ECHO_CHARS = 200;
const MAX_SCHEMA_MESSAGE_CHARS = 2_000;
const MAX_ERROR_MESSAGE_CHARS = 2_000;
const MAX_ISSUES = 20;
const MAX_ISSUE_MESSAGE_CHARS = 500;
const MAX_ISSUE_CODE_CHARS = 100;
const MAX_ISSUE_PATH_SEGMENTS = 20;
const MAX_ISSUE_PATH_SEGMENT_CHARS = 100;
const MAX_DETAIL_JSON_BYTES = 10_000;
const MAX_UNION_ERRORS = 5;
const MAX_UNION_DEPTH = 5;
const COMPRESSED_ISSUE_MESSAGE_CHARS = 100;
const COMPRESSED_ISSUE_PATH_SEGMENTS = 5;
const COMPRESSED_ISSUE_PATH_SEGMENT_CHARS = 50;
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

class ToolTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`tool timed out after ${timeoutMs}ms`);
    this.name = "ToolTimeoutError";
  }
}

class ToolAbortedError extends Error {
  constructor() {
    super("tool aborted");
    this.name = "ToolAbortedError";
  }
}

// 按 UTF-16 截断时避免切断代理对,否则 JSON/日志会留下孤立代理字符(D-034)。
function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  let end = Math.max(0, Math.floor(maxChars));
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return value.slice(0, end);
}

function failure(code: string, message: string, detail?: unknown, text = message): ToolResult {
  const result: ToolResult = { isError: true, code, message, text };
  if (detail !== undefined) result.detail = detail;
  return result;
}

export function isWindowsReservedName(name: string): boolean {
  return WINDOWS_RESERVED_NAME.test(name);
}

function safeArtifactId(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, MAX_ARTIFACT_ID_CHARS) || "tool";
  return isWindowsReservedName(safe) ? `_${safe}` : safe;
}

function artifactBaseName(callId: string): string {
  const hash = createHash("sha256").update(callId).digest("hex").slice(0, 16);
  return `${safeArtifactId(callId)}-${hash}`;
}

function isEexist(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "EEXIST";
}

async function writeArtifact(artifactDir: string, baseName: string, text: string): Promise<string> {
  await mkdir(artifactDir, { recursive: true });
  for (let attempt = 0; attempt < MAX_ARTIFACT_ATTEMPTS; attempt += 1) {
    const fileName = attempt === 0 ? `${baseName}.txt` : `${baseName}-${attempt}.txt`;
    const artifactPath = path.join(artifactDir, fileName);
    try {
      await writeFile(artifactPath, text, { encoding: "utf8", flag: "wx" });
      return artifactPath;
    } catch (error) {
      if (!isEexist(error)) throw error;
    }
  }
  throw new Error(`artifact name exhausted: ${baseName}`);
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function normalizeToolResult(value: unknown): ToolResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return failure(
      "tool_protocol_error",
      `invalid ToolResult: expected object, got ${describeType(value)}`,
    );
  }
  const record = value as Record<string, unknown>;
  const problems: string[] = [];
  if (typeof record.isError !== "boolean") {
    problems.push(`isError must be boolean, got ${describeType(record.isError)}`);
  }
  if (typeof record.code !== "string") {
    problems.push(`code must be string, got ${describeType(record.code)}`);
  }
  if (typeof record.message !== "string") {
    problems.push(`message must be string, got ${describeType(record.message)}`);
  }
  if (typeof record.text !== "string") {
    problems.push(`text must be string, got ${describeType(record.text)}`);
  }
  if (problems.length > 0) {
    return failure("tool_protocol_error", `invalid ToolResult: ${problems.join("; ")}`);
  }
  return record as unknown as ToolResult;
}

function mergeArtifactError(detail: unknown, artifactError: string): unknown {
  if (detail !== null && typeof detail === "object" && !Array.isArray(detail)) {
    return { ...(detail as Record<string, unknown>), artifactError };
  }
  if (detail === undefined) return { artifactError };
  return { originalDetail: detail, artifactError };
}

interface SanitizedIssue {
  code?: string;
  path: string[];
  message: string;
  errors?: SanitizedIssue[];
}

function sanitizePath(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, MAX_ISSUE_PATH_SEGMENTS)
    .map((segment) => String(segment))
    .map((segment) => segment.slice(0, MAX_ISSUE_PATH_SEGMENT_CHARS));
}

function sanitizeIssue(value: unknown, depth: number): SanitizedIssue | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const issue: SanitizedIssue = {
    path: sanitizePath(record.path),
    message: String(record.message ?? "").slice(0, MAX_ISSUE_MESSAGE_CHARS),
  };
  if (typeof record.code === "string") {
    issue.code = record.code.slice(0, MAX_ISSUE_CODE_CHARS);
  }
  if (Array.isArray(record.errors) && depth < MAX_UNION_DEPTH) {
    const children: SanitizedIssue[] = [];
    for (const entry of record.errors.slice(0, MAX_UNION_ERRORS)) {
      children.push(...flattenUnionEntry(entry, depth + 1));
      if (children.length >= MAX_UNION_ERRORS) break;
    }
    if (children.length > 0) issue.errors = children.slice(0, MAX_UNION_ERRORS);
  }
  return issue;
}

function flattenUnionEntry(value: unknown, depth: number): SanitizedIssue[] {
  if (Array.isArray(value)) {
    const flattened: SanitizedIssue[] = [];
    for (const entry of value) {
      flattened.push(...flattenUnionEntry(entry, depth));
      if (flattened.length >= MAX_UNION_ERRORS) break;
    }
    return flattened.slice(0, MAX_UNION_ERRORS);
  }
  const issue = sanitizeIssue(value, depth);
  return issue === undefined ? [] : [issue];
}

function fitsBudget(value: unknown, maxJsonBytes: number): boolean {
  return JSON.stringify(value).length <= maxJsonBytes;
}

function compressIssue(issue: SanitizedIssue): SanitizedIssue {
  const compressed: SanitizedIssue = {
    path: issue.path
      .slice(0, COMPRESSED_ISSUE_PATH_SEGMENTS)
      .map((segment) => segment.slice(0, COMPRESSED_ISSUE_PATH_SEGMENT_CHARS)),
    message: issue.message.slice(0, COMPRESSED_ISSUE_MESSAGE_CHARS),
  };
  if (issue.code !== undefined) compressed.code = issue.code;
  if (issue.errors !== undefined) {
    compressed.errors = issue.errors.slice(0, MAX_UNION_ERRORS).map(compressIssue);
  }
  return compressed;
}

export function sanitizeIssues(issues: unknown, maxJsonBytes = MAX_DETAIL_JSON_BYTES): unknown {
  if (!Array.isArray(issues)) return [];

  const sanitized: SanitizedIssue[] = [];
  for (const value of issues) {
    if (sanitized.length >= MAX_ISSUES) break;
    const issue = sanitizeIssue(value, 0);
    if (issue !== undefined) sanitized.push(issue);
  }
  if (fitsBudget(sanitized, maxJsonBytes)) return sanitized;

  const reduced = [...sanitized];
  while (reduced.length > 1 && !fitsBudget(reduced, maxJsonBytes)) {
    reduced.pop();
  }
  if (fitsBudget(reduced, maxJsonBytes)) return reduced;

  const compressed = reduced.map(compressIssue);
  while (compressed.length > 0 && !fitsBudget(compressed, maxJsonBytes)) {
    compressed.pop();
  }
  if (compressed.length > 0 && fitsBudget(compressed, maxJsonBytes)) return compressed;

  return { issues: [], truncated: true };
}

async function finalizeResult(
  value: unknown,
  callId: string,
  artifactDir: string,
): Promise<ToolResult> {
  const result = normalizeToolResult(value);
  const tokens = heuristicCountTokens([{ role: "tool", content: result.text }]);
  if (tokens <= ARTIFACT_TOKEN_THRESHOLD) return result;

  try {
    const artifactPath = await writeArtifact(artifactDir, artifactBaseName(callId), result.text);
    const truncated = result.text.length > MAX_TEXT_CHARS;
    const body = truncated ? truncateText(result.text, MAX_TEXT_CHARS) : result.text;
    const marker = truncated
      ? `\n[truncated; full output at ${artifactPath}]`
      : `\n[full output at ${artifactPath}]`;
    return { ...result, text: `${body}${marker}`, artifactPath };
  } catch (error) {
    const truncated = result.text.length > MAX_TEXT_CHARS;
    const body = truncated ? truncateText(result.text, MAX_TEXT_CHARS) : result.text;
    const marker = truncated
      ? "\n[truncated; artifact write failed]"
      : "\n[artifact write failed; full output retained]";
    const artifactError = error instanceof Error ? error.message : String(error);
    return {
      ...result,
      text: `${body}${marker}`,
      detail: mergeArtifactError(result.detail, artifactError),
    };
  }
}

/**
 * 单次调用的时间预算。
 *
 * 两个来源取较大者：用户为本轮配的 `timeoutMs`（`run.json` 的 `limits`），
 * 与工具自己声明的 `callTimeoutMs`（MCP 工具取自 `mcp.json` 的 server
 * `timeoutMs`）。**用户配的更优先**——那是他为本轮做的决定；工具声明只用来
 * 把「管线缺省 120s」抬高到它真正需要的长度（OPT-13：Keil 构建要 10 分钟）。
 *
 * 内置工具不声明 `callTimeoutMs`，因此仍拿 120s 缺省，行为完全不变。
 */
function resolveTimeoutMs(timeoutMs: number | undefined, callTimeoutMs?: number): number {
  const requested = normalizeBudget(timeoutMs);
  const declared = normalizeBudget(callTimeoutMs);
  if (requested === undefined) {
    return declared ?? DEFAULT_TIMEOUT_MS;
  }
  return declared === undefined ? requested : Math.max(requested, declared);
}

function normalizeBudget(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.min(Math.max(Math.floor(value), 1), MAX_TIMEOUT_MS);
}

interface ExecuteOutcome {
  result: unknown;
  pending?: Promise<unknown>;
  /**
   * 本次调用原本主张 `evidence`（工具注解 + 非错误），但 `postToolUse` 往正文里
   * 追加了钩子输出，因此这个主张被撤回。
   *
   * 为什么不是直接写 `result.evidence = false`：`evidence` 由 `runOne` 在
   * `finalizeResult` 之后按工具注解赋值，那里会把它盖回去。撤回必须是一个能被
   * 那一处读到的信号，而不是结果对象上的一个会被覆盖的字段。
   */
  evidenceDropped?: true;
}

interface AuthorizedCall {
  tool: ToolDef<any>;
  input: unknown;
  access: ToolAccess;
}

type AuthorizationOutcome =
  | { kind: "authorized"; authorized: AuthorizedCall }
  | { kind: "rejected"; result: ToolResult };

function permissionDenied(decision: PermissionRequest): ToolResult {
  const detail: Record<string, unknown> = {
    action: decision.action,
    effective: decision.effective,
    reason: decision.reason,
    preset: decision.preset,
    source: decision.source,
  };
  if (decision.ruleIndex !== undefined) detail.ruleIndex = decision.ruleIndex;
  const message = `permission denied: ${decision.reason}`;
  return failure("permission_denied", message, detail, message);
}

// 授权阶段只做查询/校验/权限判定与审计,不得创建执行计时器。
async function authorizeOne(
  tools: ToolRegistry,
  call: BatchCall,
  opts: BatchOptions,
): Promise<AuthorizationOutcome> {
  const tool = tools.lookup(call.name);
  if (!tool) {
    const displayName = truncateText(call.name, MAX_NAME_ECHO_CHARS);
    return {
      kind: "rejected",
      result: failure(
        "tool_not_found",
        `tool not found: ${displayName}`,
        undefined,
        `tool not found: ${displayName}`,
      ),
    };
  }

  const parsed = tool.schema.safeParse(call.input);
  if (!parsed.success) {
    const rawMessage =
      parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ") || "schema validation failed";
    const message = truncateText(rawMessage, MAX_SCHEMA_MESSAGE_CHARS);
    return {
      kind: "rejected",
      result: failure("schema_validation", message, sanitizeIssues(parsed.error.issues)),
    };
  }

  if (opts.signal.aborted) {
    return {
      kind: "rejected",
      result: failure("tool_aborted", "tool aborted before execution"),
    };
  }

  // 授权阶段不预写 tool_started:只有真正进入执行的调用才写,避免留下
  // "已 started 但从未执行"的孤儿事件。
  if (opts.permission !== undefined) {
    const decision = await opts.permission.gate.check({
      callId: call.id,
      tool,
      args: parsed.data,
      signal: opts.signal,
    });
    await opts.permission.onDecision(call, decision);
    if (decision.effective !== "allow") {
      return { kind: "rejected", result: permissionDenied(decision) };
    }
    return {
      kind: "authorized",
      authorized: { tool, input: parsed.data, access: decision.access },
    };
  }

  return {
    kind: "authorized",
    authorized: {
      tool,
      input: parsed.data,
      access: tool.access?.(parsed.data) ?? "unknown",
    },
  };
}

async function executeAuthorized(
  session: SessionHandle,
  call: BatchCall,
  authorized: AuthorizedCall,
  opts: BatchOptions,
): Promise<ExecuteOutcome> {
  // 审批期间调用方可能已中止;此时不能再依赖 executeAuthorized 内部注册的 abort
  // 监听(事件已派发),必须在启动执行前同步复查,否则不检查 signal 的工具仍会运行。
  if (opts.signal.aborted) {
    return { result: failure("tool_aborted", "tool aborted before execution") };
  }

  const cwd = opts.cwd ?? session.dir;
  let preHooks: HookOutcome[] = [];

  // preToolUse 挂在这里、`onToolStarted` 之前：
  //
  // - 被权限层拒绝的调用在 `authorizeOne` 就返回了，根本到不了本函数，所以钩子
  //   没有机会把一次 denied 的调用放行——这是结构上的保证，不是约定。
  // - 被钩子拦下的调用不应该留下一条 `tool_started` 事件：那会变成"已 started
  //   但从未执行"，与授权阶段刻意不预写 started 是同一条理由。
  if (opts.hooks !== undefined) {
    preHooks = await opts.hooks.run(
      "preToolUse",
      call.name,
      { callId: call.id, sessionId: session.id, cwd, input: authorized.input },
      opts.signal,
    );
    // 钩子跑在授权之后，调用方在这期间可能已经中止。中止优先于钩子的判词——
    // 否则一次用户取消会被记成「钩子拦截」，那不是这次调用真实发生的事。
    if (opts.signal.aborted) {
      return { result: failure("tool_aborted", "tool aborted before execution") };
    }
    // 多条钩子全部跑完（runner 不短路）：一次调用就能看到所有反对意见。
    // 决定按「任一阻断即阻断」取，不因后面的钩子跑成功而改变。
    const blockedHook = preHooks.find((outcome) => outcome.blocked);
    if (blockedHook !== undefined) {
      return { result: hookBlockedResult(blockedHook, preHooks) };
    }
    // 其它失败（非 0 非 2 / 超时 / 起不来 / 序列化失败）一律 fail-closed：
    // 一个无法求值的闸门不能被当成开着的（与 `evaluatePolicy` 的 catch → deny 同姿态）。
    const failedHook = preHooks.find((outcome) => outcome.failure !== undefined);
    if (failedHook !== undefined) {
      return { result: hookFailedResult(failedHook, preHooks) };
    }
  }

  // 回调失败时直接上抛,该调用不执行;不要在这里吞掉异常或预先写 started。
  if (opts.onToolStarted !== undefined) {
    await opts.onToolStarted(call, authorized.access);
  }

  // started 写入期间调用方可能刚刚中止;abort 监听此时才注册会错过已派发的事件,
  // 因此必须在启动执行前再次同步复查,否则忽略 signal 的工具仍会运行。
  if (opts.signal.aborted) {
    return { result: failure("tool_aborted", "tool aborted before execution") };
  }

  const outcome = await executeToolDef(session, authorized, opts, cwd);
  if (opts.hooks === undefined) return outcome;
  // postToolUse 在拿到结果之后、`finalizeResult` 之前：追加进正文的钩子输出因此
  // 会计入 8000 token 的落盘阈值与 25000 token 的截断，随正文一起进 artifact。
  // 放在 finalizeResult 之后改 `text`，artifact 里就会是旧正文。
  return applyPostToolHooks({
    session,
    call,
    cwd,
    input: authorized.input,
    evidenceTool: authorized.tool.annotations?.evidence === true,
    hooks: opts.hooks,
    signal: opts.signal,
    preHooks,
    outcome,
  });
}

/**
 * `preToolUse` 退出码 2：工具不执行，stderr 回给模型。
 *
 * 用 stderr 作为正文是刻意的——钩子作者想拦一条命令时，他写的理由就是模型唯一
 * 需要的信号，不需要我们替他概括一句。
 */
function hookBlockedResult(blocked: HookOutcome, all: HookOutcome[]): ToolResult {
  const reason = blocked.stderr.trim();
  const text = reason.length > 0
    ? reason
    : `hook blocked this tool call: ${blocked.command} (exit 2, no stderr)`;
  const detail: Record<string, unknown> = { hooks: all };
  const message = `hook blocked this tool call: ${blocked.command}`;
  return { isError: true, code: "hook_blocked", message, detail, text };
}

/**
 * `preToolUse` 求值失败（超时 / 起不来 / 非 0 非 2）：**阻断**（fail-closed）。
 *
 * 一个无法求值的闸门不能被当成开着的。这与 `evaluatePolicy` 的 catch → deny、
 * `permissionDenied` 的同一姿态；区别只在这条是钩子自己坏了，不是权限规则。
 */
function hookFailedResult(failed: HookOutcome, all: HookOutcome[]): ToolResult {
  const reason = failed.failure ?? "unknown failure";
  const stderrText = failed.stderr.trim();
  const message = `hook failed: ${reason}`;
  const text = stderrText.length > 0 ? `${message}\n\n${stderrText}` : message;
  return {
    isError: true,
    code: "hook_failed",
    message: truncateText(message, MAX_ERROR_MESSAGE_CHARS),
    detail: { hooks: all },
    text,
  };
}

/**
 * 把 `postToolUse` 的结果追加进正文并记录进 `detail.hooks`。
 *
 * 三条规则：
 * 1. **追加不是替换**：替换会让日志主张工具返回了它没返回的东西（R3）。
 * 2. **钩子失败不改变结果的成败**：工具确实成功了，是钩子没跑成。`isError`
 *    保持工具自己的值，失败只记进 `detail.hooks`——那不进模型上下文，所以
 *    模型不会因为一条坏钩子以为工具失败了。
 * 3. **`evidence` 降级**：`evidence` 参与压缩保护，主张的是「这是工具的原始
 *    输出」；一段由钩子写进去的话不在这个主张范围内（R3）。
 *
 * 没有匹配的 `postToolUse` 钩子时正文不动，但 `preToolUse` 的结果仍要并进
 * `detail.hooks`——「钩子跑过但没说话」也要留痕，否则日志里看不出它跑过。
 */
async function applyPostToolHooks(input: {
  session: SessionHandle;
  call: BatchCall;
  cwd: string;
  input: unknown;
  evidenceTool: boolean;
  hooks: HookRunner;
  signal: AbortSignal;
  /** `preToolUse` 已经跑出的结果；一起并进 `detail.hooks`（第 6 条）。 */
  preHooks: HookOutcome[];
  outcome: ExecuteOutcome;
}): Promise<ExecuteOutcome> {
  const { outcome } = input;
  const base = normalizeToolResult(outcome.result);
  const outcomes = await input.hooks.run(
    "postToolUse",
    input.call.name,
    {
      callId: input.call.id,
      sessionId: input.session.id,
      cwd: input.cwd,
      input: input.input,
      result: {
        isError: base.isError,
        code: base.code,
        message: base.message,
        text: base.text,
      },
    },
    input.signal,
  );
  // 一份结果都没产生的路径（没有匹配的钩子）：pre 的结果仍要进 detail.hooks。
  if (outcomes.length === 0) {
    if (input.preHooks.length === 0) return outcome;
    return {
      ...outcome,
      result: { ...base, detail: mergeHookDetail(base.detail, input.preHooks) },
    };
  }

  // 只追加「退出码 0 且 stdout 非空」的那些。非 0 的钩子它的 stdout 不追加：
  // 那是一次失败运行的半截输出，拼进正文等于让一次没跑成的钩子改写工具结果，
  // 而 `isError` 又保持工具自己的值——模型会得到"工具成功且说了这句话"的错觉。
  const appended = outcomes.filter(
    (entry) => entry.failure === undefined && entry.exitCode === 0 && entry.stdout.length > 0,
  );

  const evidenceDropped = input.evidenceTool && base.isError !== true && appended.length > 0;
  const post: HookOutcome[] = evidenceDropped
    ? outcomes.map((entry) =>
        appended.includes(entry) ? { ...entry, evidenceDropped: true as const } : entry,
      )
    : outcomes;
  // pre 在前、post 在后，与它们的实际执行顺序一致。
  const hooks = [...input.preHooks, ...post];

  const result: ToolResult = {
    ...base,
    detail: mergeHookDetail(base.detail, hooks),
    ...(appended.length === 0
      ? {}
      : {
          text: [base.text, ...appended.map(
            (entry) => `--- hook: ${entry.command} ---\n${entry.stdout}`,
          )].join("\n\n"),
        }),
  };
  // `result.evidence` 由调用方（`runOne` / 并发分支）在 `finalizeResult` 之后
  // 按工具注解赋值，那里会把它盖回去；撤回必须走这个信号，不能写在这里。
  return evidenceDropped ? { ...outcome, result, evidenceDropped: true } : { ...outcome, result };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 把钩子结果并进 `detail`，与 `mergeArtifactError` 同一写法：
 * 已有 `detail` 是普通对象就摊平展开，不是就原样收进 `originalDetail`，两者都
 * 没有时直接给一个新对象。**不覆盖**已有的 `detail`——那里可能有 shell 的
 * `abortEscalated`、并发分支的 `mayStillBeRunning` 等等。
 */
function mergeHookDetail(detail: unknown, hooks: HookOutcome[]): unknown {
  if (isPlainRecord(detail)) return { ...detail, hooks };
  if (detail === undefined) return { hooks };
  return { originalDetail: detail, hooks };
}

async function executeToolDef(
  session: SessionHandle,
  authorized: AuthorizedCall,
  opts: BatchOptions,
  cwd: string,
): Promise<ExecuteOutcome> {
  const timeoutMs = resolveTimeoutMs(opts.timeoutMs, authorized.tool.callTimeoutMs);
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([opts.signal, timeoutSignal]);
  // artifactDir 与 finalizeResult 落盘用的是同一个值：只有同源，artifact 工具
  // 才可能读回本会话写下的产物（不再有第二个来源）。
  const ctx: ToolCtx = {
    sessionId: session.id,
    cwd,
    artifactDir: opts.artifactDir,
  };

  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timeoutTimer = setTimeout(() => reject(new ToolTimeoutError(timeoutMs)), timeoutMs);
  });
  const aborted = new Promise<never>((_, reject) => {
    abortListener = () => reject(new ToolAbortedError());
    opts.signal.addEventListener("abort", abortListener, { once: true });
  });

  let execution: Promise<unknown> | undefined;
  let settled = false;
  const stillPending = (): Pick<ExecuteOutcome, "pending"> =>
    settled || execution === undefined ? {} : { pending: execution };
  try {
    execution = Promise.resolve().then(() =>
      authorized.tool.execute(authorized.input, ctx, signal),
    );
    const tracked = execution;
    void tracked.then(
      () => { settled = true; },
      () => { settled = true; },
    );
    void tracked.catch(() => undefined);
    const value = await Promise.race([tracked, timeout, aborted]);
    return { result: value };
  } catch (error) {
    if (error instanceof ToolTimeoutError) {
      return { result: failure("tool_timeout", error.message), ...stillPending() };
    }
    if (error instanceof ToolAbortedError) {
      return { result: failure("tool_aborted", error.message), ...stillPending() };
    }
    if (timeoutSignal.aborted && !opts.signal.aborted) {
      return {
        result: failure("tool_timeout", `tool timed out after ${timeoutMs}ms`),
        ...stillPending(),
      };
    }
    if (error instanceof Error && error.name === "AbortError") {
      return { result: failure("tool_aborted", error.message || "tool aborted"), ...stillPending() };
    }
    const message = error instanceof Error ? error.message : String(error);
    const truncated = truncateText(message, MAX_ERROR_MESSAGE_CHARS);
    return {
      result: failure(
        "tool_execution_error",
        truncated,
        undefined,
        truncated,
      ),
    };
  } finally {
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    if (abortListener !== undefined) opts.signal.removeEventListener("abort", abortListener);
  }
}

interface RunOutcome extends BatchResult {
  pending?: Promise<unknown>;
}

async function runOne(
  session: SessionHandle,
  tools: ToolRegistry,
  call: BatchCall,
  opts: BatchOptions,
): Promise<RunOutcome> {
  const isEvidenceTool = tools.lookup(call.name)?.annotations?.evidence === true;
  const authorization = await authorizeOne(tools, call, opts);
  if (authorization.kind === "rejected") {
    const result = await finalizeResult(authorization.result, call.id, opts.artifactDir);
    return {
      id: call.id,
      result: { ...result, evidence: isEvidenceTool && result.isError !== true },
    };
  }
  const outcome = await executeAuthorized(session, call, authorization.authorized, opts);
  const result = await finalizeResult(outcome.result, call.id, opts.artifactDir);
  return {
    id: call.id,
    result: {
      ...result,
      // `evidenceDropped` = 正文里已经混进了钩子写的话，这个结果不能再主张
      // 「这是工具的原始输出」（R3）。见 `applyPostToolHooks`。
      evidence: isEvidenceTool && result.isError !== true && outcome.evidenceDropped !== true,
    },
    ...(outcome.pending !== undefined ? { pending: outcome.pending } : {}),
  };
}

function resolveSettleGraceMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_SETTLE_GRACE_MS;
  }
  return Math.min(Math.max(Math.floor(value), 1), MAX_TIMEOUT_MS);
}

function waitForSettled(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: boolean): void => {
      if (done) return;
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(value);
    };
    timer = setTimeout(() => finish(false), timeoutMs);
    void promise.then(
      () => finish(true),
      () => finish(true),
    );
  });
}

async function skippedResult(
  call: BatchCall,
  opts: BatchOptions,
  _tools: ToolRegistry,
): Promise<BatchResult> {
  const result = await finalizeResult(
    failure(
      "tool_skipped_after_timeout",
      "not executed because the previous tool timed out and may still be running",
    ),
    call.id,
    opts.artifactDir,
  );
  return { id: call.id, result: { ...result, evidence: false } };
}

// 非字符串 id 会同时绕过重复检测与 artifact 命名假设,在管线入口直接拒绝(D-023)。
async function invalidIdResult(
  call: BatchCall,
  opts: BatchOptions,
  _tools: ToolRegistry,
): Promise<RunOutcome> {
  const result = await finalizeResult(
    failure("tool_protocol_error", `invalid tool call id: ${describeType(call.id)}`),
    "invalid-id",
    opts.artifactDir,
  );
  return { id: String(call.id), result: { ...result, evidence: false } };
}

async function duplicateResult(
  call: BatchCall,
  opts: BatchOptions,
  _tools: ToolRegistry,
): Promise<BatchResult> {
  const message = `duplicate call id: ${truncateText(call.id, MAX_NAME_ECHO_CHARS)}`;
  const result = await finalizeResult(
    failure("duplicate_call_id", message),
    call.id,
    opts.artifactDir,
  );
  return { id: call.id, result: { ...result, evidence: false } };
}

export async function executeBatch(
  session: SessionHandle,
  tools: ToolRegistry,
  calls: BatchCall[],
  opts: BatchOptions,
): Promise<BatchResult[]> {
  assertPermissionLayerChoice(
    { permission: opts.permission, unsafeSkipPermission: opts.unsafeSkipPermission },
    "executeBatch",
  );
  const seen = new Set<string>();
  const duplicates = calls.map((call) => {
    if (typeof call.id !== "string") return false;
    if (seen.has(call.id)) return true;
    seen.add(call.id);
    return false;
  });
  const run = (call: BatchCall, duplicate: boolean): Promise<RunOutcome> =>
    typeof call.id !== "string"
      ? invalidIdResult(call, opts, tools)
      : duplicate
        ? duplicateResult(call, opts, tools)
        : runOne(session, tools, call, opts);

  const concurrent = calls.every(
    (call) => tools.lookup(call.name)?.annotations?.readOnly === true,
  );
  if (concurrent) {
    // 第一阶段:按输入顺序串行授权并审计;gate/onDecision 抛错直接上抛,
    // 此时第二阶段尚未开始,任何工具都不会执行。
    type Prepared =
      | { kind: "final"; result: BatchResult }
      | {
          kind: "authorized";
          call: BatchCall;
          evidence: boolean;
          authorized: AuthorizedCall;
        };
    const prepared: Prepared[] = [];
    for (let index = 0; index < calls.length; index += 1) {
      const call = calls[index]!;
      if (typeof call.id !== "string") {
        prepared.push({ kind: "final", result: await invalidIdResult(call, opts, tools) });
        continue;
      }
      if (duplicates[index]) {
        prepared.push({ kind: "final", result: await duplicateResult(call, opts, tools) });
        continue;
      }
      const isEvidenceTool = tools.lookup(call.name)?.annotations?.evidence === true;
      const authorization = await authorizeOne(tools, call, opts);
      if (authorization.kind === "rejected") {
        const result = await finalizeResult(authorization.result, call.id, opts.artifactDir);
        prepared.push({
          kind: "final",
          result: {
            id: call.id,
            result: { ...result, evidence: isEvidenceTool && result.isError !== true },
          },
        });
        continue;
      }
      prepared.push({
        kind: "authorized",
        call,
        evidence: isEvidenceTool,
        authorized: authorization.authorized,
      });
    }

    // 第二阶段:全部授权完成后,允许的调用才并发执行。
    return Promise.all(
      prepared.map(async (entry): Promise<BatchResult> => {
        if (entry.kind === "final") return entry.result;
        const outcome = await executeAuthorized(session, entry.call, entry.authorized, opts);
        const result = await finalizeResult(outcome.result, entry.call.id, opts.artifactDir);
        // 并发分支落地不了串行屏障(所有调用已经同时启动,没有「后续」可跳),
        // 但超时/中止后仍在跑的调用必须让调用方看得见,不能静默丢掉 pending。
        // 用既有的 detail 通道披露:query 原样写进 tool_result 事件,与 shell 的
        // abortEscalated/terminateFailed 同一个先例。措辞是 may 而非 is——它可能
        // 在这批其它调用收尾期间结束。带 pending 的结果必然是 executeAuthorized
        // 直接构造的 tool_timeout/tool_aborted 失败,本身不携带 detail,故直接赋值。
        //
        // 唯一的例外是 `detail.hooks`：钩子在超时前已经跑过，它们的结果是事实，
        // 被这一行覆盖掉就等于「钩子跑过但日志里看不出来」。没有钩子时这一支与
        // 从前逐字段相同。
        const disclosed =
          outcome.pending === undefined
            ? result
            : {
                ...result,
                detail: isPlainRecord(result.detail) && result.detail.hooks !== undefined
                  ? { ...result.detail, mayStillBeRunning: true }
                  : { mayStillBeRunning: true },
              };
        return {
          id: entry.call.id,
          result: {
            ...disclosed,
            // `evidenceDropped` 与串行分支同一判据：钩子往正文里加了话，
            // 这个结果就不再是「工具的原始输出」（R3）。
            evidence:
              entry.evidence
              && disclosed.isError !== true
              && outcome.evidenceDropped !== true,
          },
        };
      }),
    );
  }

  const settleGraceMs = resolveSettleGraceMs(opts.settleGraceMs);
  const results: BatchResult[] = [];
  for (let index = 0; index < calls.length; index += 1) {
    const outcome = await run(calls[index], duplicates[index]);
    results.push({ id: outcome.id, result: outcome.result });
    if (outcome.pending === undefined) {
      continue;
    }
    const settled = await waitForSettled(outcome.pending, settleGraceMs);
    if (settled) {
      continue;
    }
    for (let rest = index + 1; rest < calls.length; rest += 1) {
      results.push(await skippedResult(calls[rest], opts, tools));
    }
    break;
  }
  return results;
}
