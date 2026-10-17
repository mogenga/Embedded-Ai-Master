import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
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
  await writeFile(path.join(dir, "header.json"), `${JSON.stringify(header)}\n`, "utf8");
  const logPath = path.join(dir, "session.v1.jsonl");
  await writeFile(logPath, "", "utf8");

  const eventList: SessionEvent[] = [];
  let pending = Promise.resolve();
  let closed = false;
  const handle: SessionHandle = {
    id,
    dir,
    header,
    append(ev) {
      const operation = pending.then(async () => {
        if (closed) throw new Error("Session is closed");
        const event: SessionEvent = {
          ...ev,
          seq: eventList.length,
          ts: new Date().toISOString(),
        };
        await appendFile(logPath, `${JSON.stringify(event)}\n`, "utf8");
        eventList.push(event);
        return event;
      });
      pending = operation.then(() => undefined, () => undefined);
      return operation;
    },
    events() {
      return eventList;
    },
    async close() {
      await pending;
      closed = true;
    },
  };

  if (opts.systemPrompt !== undefined) {
    await handle.append({ type: "system", payload: { content: opts.systemPrompt } });
  }
  return handle;
}

export function readSessionFile(filePath: string): SessionEvent[] {
  const content = readFileSync(filePath, "utf8");
  return content
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as SessionEvent);
}
