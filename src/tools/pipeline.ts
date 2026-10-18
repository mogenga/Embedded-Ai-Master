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
const ARTIFACT_TOKEN_THRESHOLD = 8_000;
const MAX_TEXT_TOKENS = 25_000;
const MAX_TEXT_CHARS = MAX_TEXT_TOKENS * 4;

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

function failure(code: string, message: string, detail?: unknown): ToolResult {
  const result: ToolResult = { isError: true, code, message, text: message };
  if (detail !== undefined) result.detail = detail;
  return result;
}

function safeArtifactId(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return safe.length === 0 ? "tool" : safe;
}

async function persistIfLarge(
  result: ToolResult,
  callId: string,
  artifactDir: string,
): Promise<ToolResult> {
  const tokens = heuristicCountTokens([{ role: "tool", content: result.text }]);
  if (tokens <= ARTIFACT_TOKEN_THRESHOLD) return result;

  const artifactPath = path.join(artifactDir, `${safeArtifactId(callId)}.txt`);
  await mkdir(artifactDir, { recursive: true });
  await writeFile(artifactPath, result.text, "utf8");
  const text = result.text.length > MAX_TEXT_CHARS ? result.text.slice(0, MAX_TEXT_CHARS) : result.text;
  return { ...result, text, artifactPath };
}


async function runOne(
  session: SessionHandle,
  tools: ToolRegistry,
  call: BatchCall,
  opts: BatchOptions,
): Promise<BatchResult> {
  const tool = tools.lookup(call.name);
  if (!tool) {
    return { id: call.id, result: failure("tool_not_found", `tool not found: ${call.name}`) };
  }

  const parsed = tool.schema.safeParse(call.input);
  if (!parsed.success) {
    const message =
      parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ") || "schema validation failed";
    return { id: call.id, result: failure("schema_validation", message, parsed.error.issues) };
  }

  if (opts.signal.aborted) {
    return { id: call.id, result: failure("tool_aborted", "tool aborted before execution") };
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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

  let result: ToolResult;
  try {
    const execution = Promise.resolve().then(() => tool.execute(parsed.data, ctx, signal));
    void execution.catch(() => undefined);
    result = await Promise.race([execution, timeout, aborted]);
  } catch (error) {
    if (error instanceof ToolTimeoutError) {
      return { id: call.id, result: failure("tool_timeout", error.message) };
    }
    if (error instanceof ToolAbortedError) {
      return { id: call.id, result: failure("tool_aborted", error.message) };
    }
    if (timeoutSignal.aborted && !opts.signal.aborted) {
      return { id: call.id, result: failure("tool_timeout", `tool timed out after ${timeoutMs}ms`) };
    }
    if (error instanceof Error && error.name === "AbortError") {
      return { id: call.id, result: failure("tool_aborted", error.message || "tool aborted") };
    }
    return {
      id: call.id,
      result: failure("tool_execution_error", error instanceof Error ? error.message : String(error)),
    };
  } finally {
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    if (abortListener !== undefined) opts.signal.removeEventListener("abort", abortListener);
  }

  try {
    return { id: call.id, result: await persistIfLarge(result, call.id, opts.artifactDir) };
  } catch (error) {
    return {
      id: call.id,
      result: failure(
        "tool_execution_error",
        `artifact write failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    };
  }
}

export async function executeBatch(
  session: SessionHandle,
  tools: ToolRegistry,
  calls: BatchCall[],
  opts: BatchOptions,
): Promise<BatchResult[]> {
  const concurrent = calls.every((call) => tools.lookup(call.name)?.annotations?.readOnly === true);
  if (concurrent) {
    return Promise.all(calls.map((call) => runOne(session, tools, call, opts)));
  }

  const results: BatchResult[] = [];
  for (const call of calls) {
    results.push(await runOne(session, tools, call, opts));
  }
  return results;
}