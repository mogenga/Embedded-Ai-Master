import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { SessionCorruptionError } from "../session/errors.js";
import { isValidSessionId } from "../session/handle.js";
import {
  assertGenerationsContiguous,
  decodeEventLine,
  listSessionLogFiles,
  parseEventLineText,
  readSessionHeader,
  readSessionSnapshot,
} from "../session/persistence.js";
import type { SessionEvent, SessionHeader } from "../session/types.js";
import { SessionNotFoundError } from "./types.js";
import type {
  SessionEventEnvelope,
  SessionEventSource,
  SessionSnapshot,
} from "./types.js";

const DEFAULT_POLL_MS = 200;

interface FileState {
  offset: number;
  partial: Buffer;
  dedupe: boolean;
  lineCount: number;
}

function normalizeForCompare(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function notFound(sessionId: string): SessionNotFoundError {
  return new SessionNotFoundError(`Session not found: ${JSON.stringify(sessionId)}`);
}

function rethrowMissing(error: unknown, sessionId: string): never {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ENOTDIR") throw notFound(sessionId);
  throw error;
}

function assertSince(since: number): void {
  if (!Number.isSafeInteger(since) || since < -1) {
    throw new TypeError(`since must be a safe integer >= -1: ${String(since)}`);
  }
}

// follow 轮询里读 header 时若目录/文件消失,统一按 NotFound 处理,避免原生 ENOENT
// 或带绝对路径的 corruption 错误泄漏出去。
function readFollowHeader(dir: string, sessionId: string): SessionHeader {
  try {
    return readSessionHeader(dir);
  } catch (error) {
    if (error instanceof SessionCorruptionError) {
      const cause = (error.detail as { cause?: NodeJS.ErrnoException } | undefined)?.cause;
      if (cause?.code === "ENOENT" || cause?.code === "ENOTDIR") throw notFound(sessionId);
    }
    throw error;
  }
}

// 先 realpath 根目录与目标目录,只接受真实根的直接子目录;越界/不存在一律按
// SessionNotFoundError 处理,错误信息里不出现解析后的真实路径。
async function resolveSessionDir(sessionsRoot: string, sessionId: string): Promise<string> {
  if (!isValidSessionId(sessionId)) throw notFound(sessionId);
  let realRoot: string;
  try {
    realRoot = await realpath(sessionsRoot);
  } catch {
    throw notFound(sessionId);
  }
  let realTarget: string;
  try {
    realTarget = await realpath(path.join(realRoot, sessionId));
  } catch {
    // ELOOP/EACCES/ENOENT 等一律视为不可见会话,不暴露真实路径。
    throw notFound(sessionId);
  }
  if (
    normalizeForCompare(path.dirname(realTarget)) !== normalizeForCompare(realRoot) ||
    normalizeForCompare(path.basename(realTarget)) !== normalizeForCompare(sessionId)
  ) {
    throw notFound(sessionId);
  }
  try {
    await stat(path.join(realTarget, "header.json"));
  } catch (error) {
    rethrowMissing(error, sessionId);
  }
  return realTarget;
}

function enrich(event: SessionEvent, sessionId: string): SessionEventEnvelope {
  return { ...event, sessionId };
}

function invalidSeq(file: string, line: number, expected: number, actual: unknown): SessionCorruptionError {
  return new SessionCorruptionError("invalid_seq", `Invalid seq at ${file}:${line}`, {
    file,
    line,
    expected,
    actual,
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}

async function* followImplementation(
  sessionsRoot: string,
  pollMs: number,
  sessionId: string,
  since: number,
  signal: AbortSignal,
): AsyncGenerator<SessionEventEnvelope> {
  const dir = await resolveSessionDir(sessionsRoot, sessionId);
  // follow 必须自己取快照而非调用 read(),否则会丢掉 pendingTail。
  const snapshot: SessionSnapshot = await readSessionSnapshot(dir, { allowTrailingPartial: true });
  if (snapshot.header.id !== sessionId) throw notFound(sessionId);
  const headSeq = snapshot.events.at(-1)?.seq ?? -1;
  const cursor = Math.min(since, headSeq);
  let lastSeq = headSeq;
  for (const event of snapshot.events) {
    if (signal.aborted) return;
    if (event.seq > cursor) yield enrich(event, sessionId);
  }

  const states = new Map<string, FileState>();
  for (const generation of snapshot.generations) {
    states.set(generation.file, {
      offset: generation.offset,
      partial: Buffer.alloc(0),
      dedupe: false,
      lineCount: 0,
    });
  }
  if (snapshot.pendingTail !== undefined) {
    const tail = snapshot.pendingTail;
    const state = states.get(tail.file) ?? {
      offset: tail.offset,
      partial: Buffer.alloc(0),
      dedupe: false,
      lineCount: 0,
    };
    state.offset = tail.offset;
    state.partial = Buffer.from(tail.bytes);
    states.set(tail.file, state);
  }

  const accept = (event: SessionEvent, state: FileState, file: string, line: number): SessionEvent | undefined => {
    if (event.seq <= lastSeq) {
      if (state.dedupe) return undefined;
      throw invalidSeq(file, line, lastSeq + 1, event.seq);
    }
    if (event.seq !== lastSeq + 1) throw invalidSeq(file, line, lastSeq + 1, event.seq);
    lastSeq = event.seq;
    return event;
  };

  const poll = async (): Promise<SessionEvent[]> => {
    const out: SessionEvent[] = [];
    let files: string[];
    try {
      files = listSessionLogFiles(dir);
    } catch (error) {
      rethrowMissing(error, sessionId);
    }
    assertGenerationsContiguous(files, dir);
    for (const name of files) {
      let state = states.get(name);
      if (state === undefined) {
        state = { offset: 0, partial: Buffer.alloc(0), dedupe: false, lineCount: 0 };
        states.set(name, state);
      }
      // 只读 [已消费位置, EOF),不做整文件读取;不足一行的字节留在 partial 里。
      let chunk: Buffer;
      try {
        const handle = await open(path.join(dir, name), "r");
        try {
          const size = (await handle.stat()).size;
          if (size < state.offset + state.partial.length) {
            // 文件被截断:从 0 重扫,重放的事件按 seq 去重而不是报重复。
            state.offset = 0;
            state.partial = Buffer.alloc(0);
            state.dedupe = true;
            state.lineCount = 0;
          }
          const position = state.offset + state.partial.length;
          if (size <= position) {
            if (state.partial.length === 0) state.dedupe = false;
            continue;
          }
          const buffer = Buffer.allocUnsafe(size - position);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
          chunk = buffer.subarray(0, bytesRead);
        } finally {
          await handle.close();
        }
      } catch (error) {
        rethrowMissing(error, sessionId);
      }
      const combined = Buffer.concat([state.partial, chunk]);
      let lineStart = 0;
      for (;;) {
        const newline = combined.indexOf(0x0a, lineStart);
        if (newline < 0) break;
        state.lineCount += 1;
        const text = decodeEventLine(combined.subarray(lineStart, newline));
        if (text.trim().length > 0) {
          const event = parseEventLineText(text, name, state.lineCount);
          const accepted = accept(event, state, name, state.lineCount);
          if (accepted !== undefined) out.push(accepted);
        }
        state.offset += newline + 1 - lineStart;
        lineStart = newline + 1;
      }
      state.partial = Buffer.from(combined.subarray(lineStart));
      // 截断重扫若停在半行上,下一轮补全时仍需按 seq 去重。
      if (state.partial.length === 0) state.dedupe = false;
    }
    return out;
  };

  const finishTrailing = (): SessionEvent[] => {
    const out: SessionEvent[] = [];
    for (const [name, state] of states) {
      if (state.partial.length === 0) continue;
      const text = decodeEventLine(state.partial);
      state.partial = Buffer.alloc(0);
      state.lineCount += 1;
      if (text.trim().length === 0) continue;
      const event = parseEventLineText(text, name, state.lineCount);
      const accepted = accept(event, state, name, state.lineCount);
      if (accepted !== undefined) out.push(accepted);
    }
    return out;
  };

  for (;;) {
    if (signal.aborted) return;
    const events = await poll();
    for (const event of events) {
      if (signal.aborted) return;
      yield enrich(event, sessionId);
    }
    if (signal.aborted) return;
    const header = readFollowHeader(dir, sessionId);
    if (header.status === "closed") {
      // header closed 之后不会再有 append,补扫一次即可确认没有遗漏。
      const finalEvents = await poll();
      for (const event of finalEvents) {
        if (signal.aborted) return;
        yield enrich(event, sessionId);
      }
      const trailingEvents = finishTrailing();
      for (const event of trailingEvents) {
        if (signal.aborted) return;
        yield enrich(event, sessionId);
      }
      return;
    }
    await sleep(pollMs, signal);
  }
}

export interface LogTailEventSourceOptions {
  sessionsRoot: string;
  pollMs?: number;
}

export function createLogTailEventSource(opts: LogTailEventSourceOptions): SessionEventSource {
  const sessionsRoot = opts.sessionsRoot;
  const pollMs = opts.pollMs !== undefined && opts.pollMs > 0 ? opts.pollMs : DEFAULT_POLL_MS;
  return {
    async read(sessionId, since) {
      assertSince(since);
      const dir = await resolveSessionDir(sessionsRoot, sessionId);
      const snapshot = await readSessionSnapshot(dir, { allowTrailingPartial: true });
      if (snapshot.header.id !== sessionId) throw notFound(sessionId);
      const headSeq = snapshot.events.at(-1)?.seq ?? -1;
      const cursor = Math.min(since, headSeq);
      return {
        header: snapshot.header,
        events: snapshot.events
          .filter((event) => event.seq > cursor)
          .map((event) => enrich(event, sessionId)),
        headSeq,
      };
    },
    follow(sessionId, since, signal) {
      assertSince(since);
      return followImplementation(sessionsRoot, pollMs, sessionId, since, signal);
    },
  };
}
