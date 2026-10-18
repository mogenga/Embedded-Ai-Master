import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { appendFile, mkdir, open, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { SessionResumeError } from "./errors.js";
import { readSessionDir } from "./persistence.js";
import type { SessionEvent, SessionHeader } from "./types.js";

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function toCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

async function writeHeaderAtomic(
  headerPath: string,
  header: SessionHeader,
): Promise<SessionHeader> {
  const next = deepFreeze({ ...header });
  const tmpPath = `${headerPath}.tmp`;
  try {
    await writeFile(tmpPath, `${JSON.stringify(next)}\n`, "utf8");
    await rename(tmpPath, headerPath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return next;
}

async function assertSessionExists(dir: string, headerPath: string): Promise<void> {
  try {
    await stat(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SessionResumeError("missing_session_dir", `Session directory not found: ${dir}`, {
        dir,
      });
    }
    throw error;
  }
  try {
    await stat(headerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SessionResumeError("missing_session_dir", `Session header not found: ${headerPath}`, {
        dir,
        file: path.basename(headerPath),
      });
    }
    throw error;
  }
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

function createHandle(
  dir: string,
  header: SessionHeader,
  eventList: SessionEvent[],
  logPath: string,
): SessionHandle {
  const headerPath = path.join(dir, "header.json");
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
        await appendFile(logPath, `${JSON.stringify(event)}\n`, "utf8");
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
        if (event.type !== "usage") continue;
        totals.promptTokens += toCount(event.payload.promptTokens);
        totals.completionTokens += toCount(event.payload.completionTokens);
        totals.cachedTokens += toCount(event.payload.cachedTokens);
      }
      return totals;
    },
    close() {
      if (!closePromise) {
        accepting = false;
        closePromise = (async () => {
          await pending;
          currentHeader = await writeHeaderAtomic(headerPath, {
            ...currentHeader,
            status: "closed",
          });
        })();
      }
      return closePromise;
    },
  };
}

export async function createSession(
  sessionDir: string,
  opts: {
    systemPrompt?: string;
    id?: string;
    provider?: string;
    model?: string;
    workdir?: string;
    generationThresholdBytes?: number;
  } = {},
): Promise<SessionHandle> {
  const id = opts.id ?? randomUUID();
  const dir = path.resolve(sessionDir);
  const header: SessionHeader = {
    id,
    createdAt: new Date().toISOString(),
    status: "open",
    ...(opts.provider === undefined ? {} : { provider: opts.provider }),
    ...(opts.model === undefined ? {} : { model: opts.model }),
    ...(opts.workdir === undefined ? {} : { workdir: opts.workdir }),
  };
  await mkdir(dir, { recursive: true });
  const headerPath = path.join(dir, "header.json");
  const logPath = path.join(dir, "session.v1.jsonl");
  let headerCreated = false;
  let logCreated = false;
  try {
    const headerFile = await open(headerPath, "wx");
    headerCreated = true;
    try {
      await headerFile.writeFile(`${JSON.stringify(header)}\n`, "utf8");
    } finally {
      await headerFile.close();
    }
    const logFile = await open(logPath, "wx");
    logCreated = true;
    await logFile.close();
  } catch (error) {
    if (logCreated) await rm(logPath, { force: true });
    if (headerCreated) await rm(headerPath, { force: true });
    throw new Error(`Session already exists or initialization failed: ${String(error)}`, { cause: error });
  }

  const handle = createHandle(dir, header, [], logPath);

  if (opts.systemPrompt !== undefined) {
    await handle.append({ type: "system", payload: { content: opts.systemPrompt } });
  }
  return handle;
}

export async function resumeSession(
  sessionDir: string,
  _opts: { generationThresholdBytes?: number } = {},
): Promise<SessionHandle> {
  const dir = path.resolve(sessionDir);
  const headerPath = path.join(dir, "header.json");
  await assertSessionExists(dir, headerPath);
  const { header, events, logFiles } = readSessionDir(dir);
  const logPath = path.join(dir, logFiles[logFiles.length - 1]);
  const openHeader = await writeHeaderAtomic(headerPath, { ...header, status: "open" });
  for (const event of events) deepFreeze(event);
  return createHandle(dir, openHeader, events, logPath);
}

export function readSessionFile(filePath: string): SessionEvent[] {
  const content = readFileSync(filePath, "utf8");
  return content
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as SessionEvent);
}
