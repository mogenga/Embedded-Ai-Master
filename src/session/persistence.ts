import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveHarnessHome } from "../config/harness-home.js";
import { isWindowsReservedName } from "../tools/pipeline.js";
import { SessionCorruptionError, SessionForkError } from "./errors.js";
import { openSessionHandle } from "./handle.js";
import type { SessionHandle } from "./handle.js";
import type { EventType, SessionEvent, SessionHeader } from "./types.js";

const SESSION_LOG_PATTERN = /^session\.v(\d+)\.jsonl$/;
const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

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

function assertForkBoundary(events: SessionEvent[], atSeq: number): void {
  const boundary = Number.isInteger(atSeq) ? events[atSeq] : undefined;
  if (boundary === undefined || (boundary.type !== "tool_result" && boundary.type !== "usage")) {
    throw new SessionForkError(
      "not_turn_boundary",
      `Fork position ${atSeq} is not a turn boundary`,
      { atSeq },
    );
  }
}

function assertForkId(id: string): void {
  if (!SESSION_ID_PATTERN.test(id) || isWindowsReservedName(id)) {
    throw new SessionForkError("invalid_target", `Invalid fork session id: ${JSON.stringify(id)}`, {
      id,
    });
  }
}

async function ensureEmptyTargetDir(targetDir: string): Promise<void> {
  try {
    const entries = await readdir(targetDir);
    if (entries.length > 0) {
      throw new SessionForkError("target_not_empty", `Target directory is not empty: ${targetDir}`, {
        dir: targetDir,
      });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(targetDir, { recursive: true });
  }
}

async function relocateArtifact(
  event: SessionEvent,
  sourceDir: string,
  targetDir: string,
): Promise<void> {
  if (event.type !== "tool_result" || !isRecord(event.payload)) return;
  const artifactPath = event.payload.artifactPath;
  if (typeof artifactPath !== "string") return;
  const sourcePath = path.isAbsolute(artifactPath)
    ? artifactPath
    : path.resolve(sourceDir, artifactPath);
  try {
    await stat(sourcePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const detail = isRecord(event.payload.detail) ? event.payload.detail : {};
    event.payload.detail = { ...detail, artifactMissing: true };
    return;
  }
  const artifactsDir = path.join(targetDir, "artifacts");
  await mkdir(artifactsDir, { recursive: true });
  const targetPath = path.join(artifactsDir, path.basename(sourcePath));
  await copyFile(sourcePath, targetPath);
  event.payload.artifactPath = targetPath;
}

export async function forkSession(
  sourceDir: string,
  atSeq: number,
  opts: { targetDir?: string; id?: string } = {},
): Promise<SessionHandle> {
  const source = readSessionDir(path.resolve(sourceDir));
  assertForkBoundary(source.events, atSeq);
  const id = opts.id ?? randomUUID();
  assertForkId(id);
  const targetDir = path.resolve(
    opts.targetDir ?? path.join(resolveHarnessHome(), "sessions", id),
  );
  await ensureEmptyTargetDir(targetDir);

  const prefix = source.events.slice(0, atSeq + 1).map((event) => structuredClone(event));
  for (const event of prefix) {
    await relocateArtifact(event, path.resolve(sourceDir), targetDir);
  }

  const header: SessionHeader = {
    id,
    createdAt: new Date().toISOString(),
    status: "open",
    ...(source.header.provider === undefined ? {} : { provider: source.header.provider }),
    ...(source.header.model === undefined ? {} : { model: source.header.model }),
    ...(source.header.workdir === undefined ? {} : { workdir: source.header.workdir }),
    forkedFrom: { sessionId: source.header.id, seq: atSeq },
  };

  await writeFile(path.join(targetDir, "header.json"), `${JSON.stringify(header)}\n`, "utf8");
  const logPath = path.join(targetDir, "session.v1.jsonl");
  await writeFile(logPath, `${prefix.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");

  return openSessionHandle(targetDir, header, prefix);
}
