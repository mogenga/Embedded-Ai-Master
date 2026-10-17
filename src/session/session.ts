import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { appendFile, mkdir, open, rm } from "node:fs/promises";
import path from "node:path";
import type { SessionEvent } from "./types.js";

export interface SessionHandle {
  id: string;
  dir: string;
  header: Record<string, unknown>;
  append(ev: Omit<SessionEvent, "seq" | "ts">): Promise<SessionEvent>;
  events(): readonly SessionEvent[];
  close(): Promise<void>;
}

export async function createSession(
  sessionDir: string,
  opts: { systemPrompt?: string; id?: string } = {},
): Promise<SessionHandle> {
  const id = opts.id ?? randomUUID();
  const dir = path.resolve(sessionDir);
  const header: Record<string, unknown> = {
    id,
    createdAt: new Date().toISOString(),
    status: "open",
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
  const handle: SessionHandle = {
    id,
    dir,
    header,
    append(ev) {
      if (!accepting) return Promise.reject(new Error("Session is closed"));
      const operation = pending.then(async () => {
        const event: SessionEvent = {
          ...ev,
          seq: eventList.length,
          ts: new Date().toISOString(),
        };
        Object.freeze(event.payload);
        Object.freeze(event);
        await appendFile(logPath, `${JSON.stringify(event)}\n`, "utf8");
        eventList.push(event);
        return event;
      });
      pending = operation.then(() => undefined, () => undefined);
      return operation;
    },
    events() {
      return eventList.slice();
    },
    close() {
      if (!closePromise) {
        accepting = false;
        closePromise = pending;
      }
      return closePromise;
    },
  };

  if (opts.systemPrompt !== undefined) {
    await handle.append({ type: "system", payload: { content: opts.systemPrompt } });
  }
  Object.freeze(header);
  return handle;
}

export function readSessionFile(filePath: string): SessionEvent[] {
  const content = readFileSync(filePath, "utf8");
  return content
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as SessionEvent);
}
