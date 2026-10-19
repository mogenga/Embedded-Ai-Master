import { randomUUID } from "node:crypto";
import { appendFile, lstat, open, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionCorruptionError } from "./errors.js";
import type { SessionLock } from "./lock.js";
import type { SessionEvent, SessionHeader } from "./types.js";

const DEFAULT_GENERATION_THRESHOLD_BYTES = 50 * 1024 * 1024;
const SESSION_LOG_PATTERN = /^session\.v(\d+)\.jsonl$/;
const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function isValidSessionId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    SESSION_ID_PATTERN.test(id) &&
    !WINDOWS_RESERVED_NAME.test(id)
  );
}

export function validateHeader(value: unknown): SessionHeader {
  if (!isRecord(value)) {
    throw new TypeError("session header must be an object");
  }
  if (!isValidSessionId(value.id)) {
    throw new TypeError(`invalid session header id: ${JSON.stringify(value.id)}`);
  }
  if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) {
    throw new TypeError("session header createdAt must be a parseable date string");
  }
  if (value.status !== "open" && value.status !== "closed") {
    throw new TypeError("session header status must be open or closed");
  }
  const provider = value.provider;
  const model = value.model;
  const workdir = value.workdir;
  for (const field of ["provider", "model", "workdir"] as const) {
    if (value[field] !== undefined && typeof value[field] !== "string") {
      throw new TypeError(`session header ${field} must be a string`);
    }
  }
  let forkedFrom: SessionHeader["forkedFrom"];
  if (value.forkedFrom !== undefined) {
    const raw = value.forkedFrom;
    if (
      !isRecord(raw) ||
      !isValidSessionId(raw.sessionId) ||
      typeof raw.seq !== "number" ||
      !Number.isInteger(raw.seq) ||
      raw.seq < 0
    ) {
      throw new TypeError(
        "session header forkedFrom must be { sessionId: string, seq: non-negative integer }",
      );
    }
    forkedFrom = { sessionId: raw.sessionId, seq: raw.seq };
  }
  return {
    id: value.id,
    createdAt: value.createdAt,
    status: value.status,
    ...(typeof provider === "string" ? { provider } : {}),
    ...(typeof model === "string" ? { model } : {}),
    ...(typeof workdir === "string" ? { workdir } : {}),
    ...(forkedFrom === undefined ? {} : { forkedFrom }),
  };
}

export function resolveGenerationThresholdBytes(value: number | undefined): number {
  if (value === undefined) return DEFAULT_GENERATION_THRESHOLD_BYTES;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new TypeError(`generationThresholdBytes must be a positive finite integer: ${String(value)}`);
  }
  return value;
}

function nextGenerationPath(currentPath: string): string | undefined {
  const match = SESSION_LOG_PATTERN.exec(path.basename(currentPath));
  if (match === null) return undefined;
  const generation = Number(match[1]);
  if (!Number.isSafeInteger(generation) || generation < 1) return undefined;
  return path.join(path.dirname(currentPath), `session.v${generation + 1}.jsonl`);
}

export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 追加后尽力 fsync。同步失败不影响已写入的日志行,否则调用方重试会造成重复行;
// 因此这里吞掉错误,持久化仍由 header 的临时文件 + rename 兜底(D-035)。
async function syncBestEffort(logPath: string): Promise<void> {
  try {
    const handle = await open(logPath, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    void 0;
  }
}

async function appendLineSynced(
  logPath: string,
  line: string,
  flag?: "wx",
): Promise<void> {
  await appendFile(logPath, line, flag === undefined ? "utf8" : { encoding: "utf8", flag });
  await syncBestEffort(logPath);
}

async function assertRegularLogFile(logPath: string): Promise<void> {
  let info;
  try {
    info = await lstat(logPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new SessionCorruptionError(
      "invalid_event_line",
      `Session log is not a regular file: ${logPath}`,
      { file: path.basename(logPath) },
    );
  }
}

export function toTokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

export async function writeHeaderAtomic(
  headerPath: string,
  header: SessionHeader,
): Promise<SessionHeader> {
  const next = deepFreeze({ ...header });
  const tmpPath = `${headerPath}.${randomUUID()}.tmp`;
  try {
    // 先写入临时文件并 fsync,再 rename;断电后要么看到旧 header,要么看到新 header。
    await writeFile(tmpPath, `${JSON.stringify(next)}\n`, { encoding: "utf8", flag: "wx" });
    const file = await open(tmpPath, "r+");
    try {
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(tmpPath, headerPath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return next;
}

export interface UsageTotals {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}

export interface SessionHandle {
  id: string;
  dir: string;
  readonly header: SessionHeader;
  append(ev: Omit<SessionEvent, "seq" | "ts">): Promise<SessionEvent>;
  events(): readonly SessionEvent[];
  usageTotals(): UsageTotals;
  close(): Promise<void>;
}

export interface SessionHandleOptions {
  generationThresholdBytes?: number;
  currentBytes?: number;
  lock?: SessionLock;
}

export function createHandle(
  dir: string,
  header: SessionHeader,
  eventList: SessionEvent[],
  logPath: string,
  opts: SessionHandleOptions = {},
): SessionHandle {
  const headerPath = path.join(dir, "header.json");
  const generationThresholdBytes = resolveGenerationThresholdBytes(
    opts.generationThresholdBytes,
  );
  const lock = opts.lock;
  let currentLogPath = logPath;
  let currentBytes = opts.currentBytes ?? 0;
  let pending = Promise.resolve();
  let accepting = true;
  let closePromise: Promise<void> | undefined;
  let currentHeader = deepFreeze({ ...header });
  return {
    id: currentHeader.id,
    dir,
    get header() {
      return currentHeader;
    },
    append(ev) {
      if (!accepting) return Promise.reject(new Error("Session is closed"));
      const snapshot = structuredClone(ev);
      const operation = pending.then(async () => {
        const event: SessionEvent = {
          ...snapshot,
          seq: eventList.length,
          ts: new Date().toISOString(),
        };
        deepFreeze(event);
        const line = `${JSON.stringify(event)}\n`;
        const lineBytes = Buffer.byteLength(line);
        await assertRegularLogFile(currentLogPath);
        const nextLogPath =
          currentBytes > 0 &&
          lineBytes <= generationThresholdBytes &&
          currentBytes + lineBytes > generationThresholdBytes
            ? nextGenerationPath(currentLogPath)
            : undefined;
        if (nextLogPath === undefined) {
          await appendLineSynced(currentLogPath, line);
          currentBytes += lineBytes;
        } else {
          await appendLineSynced(nextLogPath, line, "wx");
          currentLogPath = nextLogPath;
          currentBytes = lineBytes;
        }
        eventList.push(event);
        return event;
      });
      pending = operation.then(() => undefined, () => undefined);
      return operation;
    },
    events() {
      return Object.freeze(eventList.slice());
    },
    usageTotals() {
      const totals: UsageTotals = { promptTokens: 0, completionTokens: 0, cachedTokens: 0 };
      for (const event of eventList) {
        if (event.type !== "usage" || !isRecord(event.payload)) continue;
        totals.promptTokens += toTokenCount(event.payload.promptTokens);
        totals.completionTokens += toTokenCount(event.payload.completionTokens);
        totals.cachedTokens += toTokenCount(event.payload.cachedTokens);
      }
      return totals;
    },
    close() {
      if (!closePromise) {
        accepting = false;
        closePromise = (async () => {
          try {
            await pending;
            currentHeader = await writeHeaderAtomic(headerPath, {
              ...currentHeader,
              status: "closed",
            });
          } finally {
            // 锁必须在 handle 关闭时释放;释放失败不覆盖主错误。
            await lock?.release().catch(() => undefined);
          }
        })();
      }
      return closePromise;
    },
  };
}

export function openSessionHandle(
  dir: string,
  header: SessionHeader,
  events: SessionEvent[],
  opts: SessionHandleOptions = {},
): SessionHandle {
  const sessionDir = path.resolve(dir);
  const clonedEvents = structuredClone(events);
  for (const event of clonedEvents) deepFreeze(event);
  const clonedHeader = deepFreeze(structuredClone(header));
  return createHandle(
    sessionDir,
    clonedHeader,
    clonedEvents,
    path.join(sessionDir, "session.v1.jsonl"),
    opts,
  );
}
