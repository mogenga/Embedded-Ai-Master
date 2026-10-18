import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { SessionCorruptionError } from "./errors.js";
import type { EventType, SessionEvent, SessionHeader } from "./types.js";

const SESSION_LOG_PATTERN = /^session\.v(\d+)\.jsonl$/;

const EVENT_TYPES: Record<EventType, true> = {
  system: true,
  user: true,
  assistant: true,
  tool_call: true,
  tool_result: true,
  usage: true,
  checkpoint: true,
  status: true,
  interrupted: true,
  compaction: true,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readHeader(dir: string): SessionHeader {
  const file = path.join(dir, "header.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new SessionCorruptionError("invalid_header", `Invalid session header: ${file}`, {
      file: path.basename(file),
      cause: error,
    });
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.id !== "string" ||
    parsed.id.length === 0 ||
    typeof parsed.createdAt !== "string" ||
    (parsed.status !== "open" && parsed.status !== "closed")
  ) {
    throw new SessionCorruptionError("invalid_header", `Invalid session header: ${file}`, {
      file: path.basename(file),
    });
  }
  return parsed as unknown as SessionHeader;
}

function parseGeneration(name: string): number | null {
  const match = SESSION_LOG_PATTERN.exec(name);
  if (match === null) return null;
  const digits = match[1];
  const generation = Number(digits);
  if (!Number.isSafeInteger(generation) || generation < 1) return null;
  return String(generation) === digits ? generation : null;
}

export function listSessionLogFiles(dir: string): string[] {
  return readdirSync(dir)
    .map((name) => ({ name, generation: parseGeneration(name) }))
    .filter((entry): entry is { name: string; generation: number } => entry.generation !== null)
    .sort((left, right) => left.generation - right.generation)
    .map((entry) => entry.name);
}

function readEvents(dir: string, files: string[]): SessionEvent[] {
  const events: SessionEvent[] = [];
  for (const name of files) {
    const file = path.join(dir, name);
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.length === 0) continue;
      const lineNo = index + 1;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (error) {
        throw new SessionCorruptionError("invalid_event_line", `Invalid event line: ${name}:${lineNo}`, {
          file: name,
          line: lineNo,
          cause: error,
        });
      }
      if (!isRecord(parsed)) {
        throw new SessionCorruptionError(
          "invalid_event_line",
          `Invalid event line: ${name}:${lineNo}`,
          { file: name, line: lineNo },
        );
      }
      if (typeof parsed.type !== "string" || !Object.hasOwn(EVENT_TYPES, parsed.type)) {
        throw new SessionCorruptionError(
          "unknown_event_type",
          `Unknown event type at ${name}:${lineNo}`,
          { file: name, line: lineNo, type: parsed.type },
        );
      }
      const expected = events.length;
      if (parsed.seq !== expected) {
        throw new SessionCorruptionError("invalid_seq", `Invalid seq at ${name}:${lineNo}`, {
          file: name,
          line: lineNo,
          expected,
          actual: parsed.seq,
        });
      }
      events.push(parsed as unknown as SessionEvent);
    }
  }
  return events;
}

export function readSessionDir(dir: string): {
  header: SessionHeader;
  events: SessionEvent[];
  logFiles: string[];
} {
  const header = readHeader(dir);
  const files = listSessionLogFiles(dir);
  if (files.length === 0) {
    throw new SessionCorruptionError("invalid_header", `Session has no log files: ${dir}`, {
      dir,
    });
  }
  return { header, events: readEvents(dir, files), logFiles: files };
}
