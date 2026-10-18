import { randomUUID } from "node:crypto";
import { constants, lstatSync, readFileSync, readdirSync } from "node:fs";
import { copyFile, lstat, mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveHarnessHome } from "../config/harness-home.js";
import { buildMessages } from "../context/build.js";
import { SessionCorruptionError, SessionForkError } from "./errors.js";
import {
  isValidSessionId,
  openSessionHandle,
  resolveGenerationThresholdBytes,
  validateHeader,
  writeHeaderAtomic,
} from "./handle.js";
import type { SessionHandle } from "./handle.js";
import type { EventType, SessionEvent, SessionHeader } from "./types.js";

const SESSION_LOG_PATTERN = /^session\.v(\d+)\.jsonl$/;
const MAX_ARTIFACT_COPY_ATTEMPTS = 1_000;

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

type RegularFileKind = "header" | "event";

function regularFileError(
  kind: RegularFileKind,
  file: string,
  cause?: unknown,
): SessionCorruptionError {
  const isHeader = kind === "header";
  return new SessionCorruptionError(
    isHeader ? "invalid_header" : "invalid_event_line",
    `${isHeader ? "Invalid session header" : "Invalid event file"}: ${file}`,
    {
      file: path.basename(file),
      ...(cause === undefined ? {} : { cause }),
    },
  );
}

function assertRegularFile(file: string, kind: RegularFileKind): void {
  let info;
  try {
    info = lstatSync(file);
  } catch (error) {
    throw regularFileError(kind, file, error);
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw regularFileError(kind, file);
  }
}

export function assertRegularEventFile(file: string): void {
  assertRegularFile(file, "event");
}

function readHeader(dir: string): SessionHeader {
  const file = path.join(dir, "header.json");
  assertRegularFile(file, "header");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new SessionCorruptionError("invalid_header", `Invalid session header: ${file}`, {
      file: path.basename(file),
      cause: error,
    });
  }
  try {
    return validateHeader(parsed);
  } catch (error) {
    throw new SessionCorruptionError("invalid_header", `Invalid session header: ${file}`, {
      file: path.basename(file),
      cause: error,
    });
  }
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
  const files = readdirSync(dir)
    .map((name) => ({ name, generation: parseGeneration(name) }))
    .filter((entry): entry is { name: string; generation: number } => entry.generation !== null)
    .sort((left, right) => left.generation - right.generation)
    .map((entry) => entry.name);
  for (const name of files) assertRegularFile(path.join(dir, name), "event");
  return files;
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
      if (!isRecord(parsed.payload)) {
        throw new SessionCorruptionError(
          "invalid_event_line",
          `Invalid event payload: ${name}:${lineNo}`,
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

function assertForkBoundary(events: readonly SessionEvent[], atSeq: number): void {
  if (!Number.isInteger(atSeq) || atSeq < 0 || atSeq >= events.length) {
    throw new SessionForkError(
      "not_turn_boundary",
      `Fork position ${atSeq} is not a turn boundary`,
      { atSeq },
    );
  }
  try {
    buildMessages(events.slice(0, atSeq + 1));
  } catch (error) {
    throw new SessionForkError(
      "not_turn_boundary",
      `Fork position ${atSeq} does not form a projectable prefix`,
      {
        atSeq,
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

function assertForkId(id: string): void {
  if (!isValidSessionId(id)) {
    throw new SessionForkError("invalid_target", `Invalid fork session id: ${JSON.stringify(id)}`, {
      id,
    });
  }
}

function normalizePathForCompare(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function isPathInside(parentDir: string, childDir: string): boolean {
  const parent = normalizePathForCompare(path.resolve(parentDir));
  const child = normalizePathForCompare(path.resolve(childDir));
  const relative = path.relative(parent, child);
  if (relative === "") return true;
  if (path.isAbsolute(relative)) return false;
  return relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

async function realpathAllowMissing(value: string): Promise<string> {
  try {
    return await realpath(value);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    const parent = path.dirname(value);
    if (parent === value) return value;
    return path.join(await realpathAllowMissing(parent), path.basename(value));
  }
}

function markArtifactMissing(event: SessionEvent): void {
  if (!isRecord(event.payload)) return;
  const detail = event.payload.detail;
  event.payload.detail = isRecord(detail)
    ? { ...detail, artifactMissing: true }
    : { originalDetail: detail, artifactMissing: true };
}

async function copyArtifactExclusive(sourcePath: string, artifactsDir: string): Promise<string> {
  const baseName = path.basename(sourcePath);
  const extension = path.extname(baseName);
  const stem = baseName.slice(0, baseName.length - extension.length);
  for (let attempt = 0; ; attempt += 1) {
    const name = attempt === 0 ? baseName : `${stem}-${attempt}${extension}`;
    const targetPath = path.join(artifactsDir, name);
    try {
      await copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL);
      return targetPath;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" || attempt >= MAX_ARTIFACT_COPY_ATTEMPTS) throw error;
    }
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
  const sourceRoot = path.resolve(sourceDir);
  const realSourceRoot = await realpath(sourceRoot);
  const sourcePath = path.resolve(sourceRoot, artifactPath);
  const rootPrefix = sourceRoot.endsWith(path.sep) ? sourceRoot : `${sourceRoot}${path.sep}`;
  if (!normalizePathForCompare(sourcePath).startsWith(normalizePathForCompare(rootPrefix))) {
    markArtifactMissing(event);
    return;
  }
  let realSourcePath: string;
  try {
    realSourcePath = await realpath(sourcePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    markArtifactMissing(event);
    return;
  }
  if (!isPathInside(realSourceRoot, realSourcePath)) {
    markArtifactMissing(event);
    return;
  }
  try {
    await stat(sourcePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    markArtifactMissing(event);
    return;
  }
  const artifactsDir = path.join(targetDir, "artifacts");
  await mkdir(artifactsDir, { recursive: true });
  event.payload.artifactPath = await copyArtifactExclusive(sourcePath, artifactsDir);
}

function invalidTargetDir(targetDir: string): SessionForkError {
  return new SessionForkError("invalid_target", `Invalid target directory: ${targetDir}`, {
    dir: targetDir,
  });
}

async function claimTargetDir(targetDir: string): Promise<boolean> {
  try {
    await mkdir(path.dirname(targetDir), { recursive: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOTDIR") throw invalidTargetDir(targetDir);
    throw error;
  }
  try {
    await mkdir(targetDir);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOTDIR") throw invalidTargetDir(targetDir);
    if (code !== "EEXIST") throw error;
    const info = await stat(targetDir).catch(() => undefined);
    if (info === undefined || !info.isDirectory()) throw invalidTargetDir(targetDir);
    throw new SessionForkError("target_not_empty", `Target directory is not empty: ${targetDir}`, {
      dir: targetDir,
    });
  }
}

async function cleanupTargetDir(targetDir: string, created: boolean): Promise<void> {
  if (created) {
    await rm(targetDir, { recursive: true, force: true }).catch(() => undefined);
    return;
  }
  for (const name of ["header.json.tmp", "header.json", "session.v1.jsonl"]) {
    await rm(path.join(targetDir, name), { force: true }).catch(() => undefined);
  }
  await rm(path.join(targetDir, "artifacts"), { recursive: true, force: true }).catch(
    () => undefined,
  );
}

export async function forkSession(
  sourceDir: string,
  atSeq: number,
  opts: { targetDir?: string; id?: string; generationThresholdBytes?: number } = {},
): Promise<SessionHandle> {
  const generationThresholdBytes = resolveGenerationThresholdBytes(
    opts.generationThresholdBytes,
  );
  const resolvedSourceDir = path.resolve(sourceDir);
  let sourceInfo;
  try {
    sourceInfo = await lstat(resolvedSourceDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (sourceInfo?.isSymbolicLink() === true) {
    throw new SessionForkError(
      "invalid_target",
      `Fork source directory must not be a symbolic link: ${resolvedSourceDir}`,
      { dir: resolvedSourceDir },
    );
  }
  const source = readSessionDir(resolvedSourceDir);
  assertForkBoundary(source.events, atSeq);
  const id = opts.id ?? randomUUID();
  assertForkId(id);
  if (opts.id !== undefined && opts.id === source.header.id) {
    throw new SessionForkError(
      "invalid_target",
      `Fork session id must differ from source session id: ${id}`,
      { id },
    );
  }
  const rawTargetDir = opts.targetDir;
  const targetDir = path.resolve(
    rawTargetDir === undefined || rawTargetDir === ""
      ? path.join(resolveHarnessHome(), "sessions", id)
      : rawTargetDir,
  );
  const realSourceDir = await realpathAllowMissing(resolvedSourceDir);
  const realTargetDir = await realpathAllowMissing(targetDir);
  if (isPathInside(realSourceDir, realTargetDir)) {
    throw new SessionForkError(
      "invalid_target",
      `Fork target directory must not be inside the source directory: ${targetDir}`,
      { dir: targetDir },
    );
  }
  const createdTargetDir = await claimTargetDir(targetDir);

  try {
    const prefix = source.events.slice(0, atSeq + 1).map((event) => structuredClone(event));
    for (const event of prefix) {
      await relocateArtifact(event, resolvedSourceDir, targetDir);
    }

    const header = validateHeader({
      id,
      createdAt: new Date().toISOString(),
      status: "open",
      ...(source.header.provider === undefined ? {} : { provider: source.header.provider }),
      ...(source.header.model === undefined ? {} : { model: source.header.model }),
      ...(source.header.workdir === undefined ? {} : { workdir: source.header.workdir }),
      forkedFrom: { sessionId: source.header.id, seq: atSeq },
    });

    await writeHeaderAtomic(path.join(targetDir, "header.json"), header);
    const logPath = path.join(targetDir, "session.v1.jsonl");
    await writeFile(logPath, `${prefix.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
    const { size } = await stat(logPath);

    return openSessionHandle(targetDir, header, prefix, {
      generationThresholdBytes,
      currentBytes: size,
    });
  } catch (error) {
    await cleanupTargetDir(targetDir, createdTargetDir);
    throw error;
  }
}
