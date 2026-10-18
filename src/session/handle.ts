import { appendFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SessionEvent, SessionHeader } from "./types.js";

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

function toCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

export async function writeHeaderAtomic(
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

export function createHandle(
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
        if (event.type !== "usage" || !isRecord(event.payload)) continue;
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

export function openSessionHandle(
  dir: string,
  header: SessionHeader,
  events: SessionEvent[],
  _opts: { generationThresholdBytes?: number } = {},
): SessionHandle {
  const sessionDir = path.resolve(dir);
  const cloned = structuredClone(events);
  for (const event of cloned) deepFreeze(event);
  return createHandle(sessionDir, header, cloned, path.join(sessionDir, "session.v1.jsonl"));
}