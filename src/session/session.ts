import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { appendFile, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SessionEvent, SessionHeader } from "./types.js";

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export interface SessionHandle {
  id: string;
  dir: string;
  readonly header: SessionHeader;
  append(ev: Omit<SessionEvent, "seq" | "ts">): Promise<SessionEvent>;
  events(): readonly SessionEvent[];
  close(): Promise<void>;
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

  const eventList: SessionEvent[] = [];
  let pending = Promise.resolve();
  let accepting = true;
  let closePromise: Promise<void> | undefined;
  let currentHeader = header;
  const handle: SessionHandle = {
    id,
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
    close() {
      if (!closePromise) {
        accepting = false;
        closePromise = (async () => {
          await pending;
          const closedHeader: SessionHeader = { ...currentHeader, status: "closed" };
          const tmpPath = `${headerPath}.tmp`;
          try {
            await writeFile(tmpPath, `${JSON.stringify(closedHeader)}\n`, "utf8");
            await rename(tmpPath, headerPath);
          } catch (error) {
            await rm(tmpPath, { force: true }).catch(() => undefined);
            throw error;
          }
          currentHeader = deepFreeze(closedHeader);
        })();
      }
      return closePromise;
    },
  };

  if (opts.systemPrompt !== undefined) {
    await handle.append({ type: "system", payload: { content: opts.systemPrompt } });
  }
  deepFreeze(header);
  return handle;
}

export function readSessionFile(filePath: string): SessionEvent[] {
  const content = readFileSync(filePath, "utf8");
  return content
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as SessionEvent);
}
