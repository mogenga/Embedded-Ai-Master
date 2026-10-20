import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
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

export interface BatchOptions {
  signal: AbortSignal;
  artifactDir: string;
  cwd?: string;
  timeoutMs?: number;
  settleGraceMs?: number;
  permission?: PermissionOptions;
  onToolStarted?: (call: BatchCall, access: ToolAccess) => Promise<void>;
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

function resolveTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.min(Math.max(Math.floor(timeoutMs), 1), MAX_TIMEOUT_MS);
}

interface ExecuteOutcome {
  result: unknown;
  pending?: Promise<unknown>;
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

  // 回调失败时直接上抛,该调用不执行;不要在这里吞掉异常或预先写 started。
  if (opts.onToolStarted !== undefined) {
    await opts.onToolStarted(call, authorized.access);
  }

  // started 写入期间调用方可能刚刚中止;abort 监听此时才注册会错过已派发的事件,
  // 因此必须在启动执行前再次同步复查,否则忽略 signal 的工具仍会运行。
  if (opts.signal.aborted) {
    return { result: failure("tool_aborted", "tool aborted before execution") };
  }

  const timeoutMs = resolveTimeoutMs(opts.timeoutMs);
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = AbortSignal.any([opts.signal, timeoutSignal]);
  const ctx: ToolCtx = { sessionId: session.id, cwd: opts.cwd ?? session.dir };

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
  const evidence = tools.lookup(call.name)?.annotations?.evidence === true;
  const authorization = await authorizeOne(tools, call, opts);
  if (authorization.kind === "rejected") {
    const result = await finalizeResult(authorization.result, call.id, opts.artifactDir);
    return { id: call.id, result: { ...result, evidence } };
  }
  const outcome = await executeAuthorized(session, call, authorization.authorized, opts);
  const result = await finalizeResult(outcome.result, call.id, opts.artifactDir);
  return {
    id: call.id,
    result: { ...result, evidence },
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
  tools: ToolRegistry,
): Promise<BatchResult> {
  const evidence = tools.lookup(call.name)?.annotations?.evidence === true;
  const result = await finalizeResult(
    failure(
      "tool_skipped_after_timeout",
      "not executed because the previous tool timed out and may still be running",
    ),
    call.id,
    opts.artifactDir,
  );
  return { id: call.id, result: { ...result, evidence } };
}

// 非字符串 id 会同时绕过重复检测与 artifact 命名假设,在管线入口直接拒绝(D-023)。
async function invalidIdResult(
  call: BatchCall,
  opts: BatchOptions,
  tools: ToolRegistry,
): Promise<RunOutcome> {
  const evidence = tools.lookup(call.name)?.annotations?.evidence === true;
  const result = await finalizeResult(
    failure("tool_protocol_error", `invalid tool call id: ${describeType(call.id)}`),
    "invalid-id",
    opts.artifactDir,
  );
  return { id: String(call.id), result: { ...result, evidence } };
}

async function duplicateResult(
  call: BatchCall,
  opts: BatchOptions,
  tools: ToolRegistry,
): Promise<BatchResult> {
  const message = `duplicate call id: ${truncateText(call.id, MAX_NAME_ECHO_CHARS)}`;
  const evidence = tools.lookup(call.name)?.annotations?.evidence === true;
  const result = await finalizeResult(
    failure("duplicate_call_id", message),
    call.id,
    opts.artifactDir,
  );
  return { id: call.id, result: { ...result, evidence } };
}

export async function executeBatch(
  session: SessionHandle,
  tools: ToolRegistry,
  calls: BatchCall[],
  opts: BatchOptions,
): Promise<BatchResult[]> {
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
      const evidence = tools.lookup(call.name)?.annotations?.evidence === true;
      const authorization = await authorizeOne(tools, call, opts);
      if (authorization.kind === "rejected") {
        const result = await finalizeResult(authorization.result, call.id, opts.artifactDir);
        prepared.push({
          kind: "final",
          result: { id: call.id, result: { ...result, evidence } },
        });
        continue;
      }
      prepared.push({
        kind: "authorized",
        call,
        evidence,
        authorized: authorization.authorized,
      });
    }

    // 第二阶段:全部授权完成后,允许的调用才并发执行。
    return Promise.all(
      prepared.map(async (entry): Promise<BatchResult> => {
        if (entry.kind === "final") return entry.result;
        const outcome = await executeAuthorized(session, entry.call, entry.authorized, opts);
        const result = await finalizeResult(outcome.result, entry.call.id, opts.artifactDir);
        return { id: entry.call.id, result: { ...result, evidence: entry.evidence } };
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
