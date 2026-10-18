import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { heuristicCountTokens } from "../model/count.js";
import type { SessionHandle } from "../session/session.js";
import type { ToolRegistry } from "./registry.js";
import type { ToolCtx, ToolResult } from "./types.js";

export interface BatchCall {
  id: string;
  name: string;
  input: unknown;
}

export interface BatchResult {
  id: string;
  result: ToolResult;
}

export interface BatchOptions {
  signal: AbortSignal;
  artifactDir: string;
  cwd?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
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

function truncateText(value: string, maxChars: number): string {
  return value.length > maxChars ? value.slice(0, maxChars) : value;
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
    const body = truncated ? result.text.slice(0, MAX_TEXT_CHARS) : result.text;
    const marker = truncated
      ? `\n[truncated; full output at ${artifactPath}]`
      : `\n[full output at ${artifactPath}]`;
    return { ...result, text: `${body}${marker}`, artifactPath };
  } catch (error) {
    const truncated = result.text.length > MAX_TEXT_CHARS;
    const body = truncated ? result.text.slice(0, MAX_TEXT_CHARS) : result.text;
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

async function executeOne(
  session: SessionHandle,
  tools: ToolRegistry,
  call: BatchCall,
  opts: BatchOptions,
): Promise<unknown> {
  const tool = tools.lookup(call.name);
  if (!tool) {
    const displayName = truncateText(call.name, MAX_NAME_ECHO_CHARS);
    return failure(
      "tool_not_found",
      `tool not found: ${displayName}`,
      undefined,
      `tool not found: ${displayName}`,
    );
  }

  const parsed = tool.schema.safeParse(call.input);
  if (!parsed.success) {
    const rawMessage =
      parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ") || "schema validation failed";
    const message = truncateText(rawMessage, MAX_SCHEMA_MESSAGE_CHARS);
    return failure("schema_validation", message, sanitizeIssues(parsed.error.issues));
  }

  if (opts.signal.aborted) {
    return failure("tool_aborted", "tool aborted before execution");
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

  try {
    const execution = Promise.resolve().then(() => tool.execute(parsed.data, ctx, signal));
    void execution.catch(() => undefined);
    return await Promise.race([execution, timeout, aborted]);
  } catch (error) {
    if (error instanceof ToolTimeoutError) {
      return failure("tool_timeout", error.message);
    }
    if (error instanceof ToolAbortedError) {
      return failure("tool_aborted", error.message);
    }
    if (timeoutSignal.aborted && !opts.signal.aborted) {
      return failure("tool_timeout", `tool timed out after ${timeoutMs}ms`);
    }
    if (error instanceof Error && error.name === "AbortError") {
      return failure("tool_aborted", error.message || "tool aborted");
    }
    const message = error instanceof Error ? error.message : String(error);
    const truncated = truncateText(message, MAX_ERROR_MESSAGE_CHARS);
    return failure(
      "tool_execution_error",
      truncated,
      undefined,
      truncated,
    );
  } finally {
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    if (abortListener !== undefined) opts.signal.removeEventListener("abort", abortListener);
  }
}

async function runOne(
  session: SessionHandle,
  tools: ToolRegistry,
  call: BatchCall,
  opts: BatchOptions,
): Promise<BatchResult> {
  const value = await executeOne(session, tools, call, opts);
  return { id: call.id, result: await finalizeResult(value, call.id, opts.artifactDir) };
}

async function duplicateResult(call: BatchCall, opts: BatchOptions): Promise<BatchResult> {
  const message = `duplicate call id: ${truncateText(call.id, MAX_NAME_ECHO_CHARS)}`;
  return {
    id: call.id,
    result: await finalizeResult(
      failure("duplicate_call_id", message),
      call.id,
      opts.artifactDir,
    ),
  };
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
  const run = (call: BatchCall, duplicate: boolean): Promise<BatchResult> =>
    duplicate ? duplicateResult(call, opts) : runOne(session, tools, call, opts);

  const concurrent = calls.every(
    (call) => tools.lookup(call.name)?.annotations?.readOnly === true,
  );
  if (concurrent) {
    return Promise.all(calls.map((call, index) => run(call, duplicates[index])));
  }

  const results: BatchResult[] = [];
  for (let index = 0; index < calls.length; index += 1) {
    results.push(await run(calls[index], duplicates[index]));
  }
  return results;
}
