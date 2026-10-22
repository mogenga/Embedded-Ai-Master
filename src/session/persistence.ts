import { randomUUID } from "node:crypto";
import { constants, lstatSync, readFileSync, readdirSync } from "node:fs";
import { copyFile, lstat, mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { resolveHarnessHome } from "../config/harness-home.js";
import { buildMessages } from "../context/build.js";
import type { SessionGenerationState, SessionSnapshot } from "../events/types.js";
import { SessionCorruptionError, SessionForkError } from "./errors.js";
import {
  isValidSessionId,
  openSessionHandle,
  resolveGenerationThresholdBytes,
  validateHeader,
  writeHeaderAtomic,
} from "./handle.js";
import { acquireSessionLock } from "./lock.js";
import type { SessionHandle } from "./handle.js";
import type { EventType, SessionEvent, SessionHeader } from "./types.js";

const SESSION_LOG_PATTERN = /^session\.v(\d+)\.jsonl$/;
const MAX_ARTIFACT_COPY_ATTEMPTS = 1_000;

// 读取时的事件类型白名单,**不是**写盘过滤器:写盘不做类型校验,漏登记一项
// 不会让写入失败,而是让下一次读盘抛 unknown_event_type——整份日志(包括其中
// 早先写入的真实工具结果)一起不可用。新增事件类型必须同步加进这里。
//
// `background_result` 由宿主在后台作业结束时写入(不是本轮 query 写的),
// 同样必须在这里登记:漏了它,用户重开一个有后台作业的会话就再也读不出来了。
const EVENT_TYPES: Record<EventType, true> = {
  system: true,
  user: true,
  assistant: true,
  assistant_delta: true,
  tool_call: true,
  tool_result: true,
  tool_started: true,
  mcp_status: true,
  device_status: true,
  usage: true,
  checkpoint: true,
  status: true,
  interrupted: true,
  compaction: true,
  permission_decision: true,
  approval_request: true,
  todos: true,
  background_result: true,
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

/**
 * 只读 `header.json` 并校验，**不检查日志文件是否存在**。
 *
 * 内部实现：`readSessionDir` / `readSessionSnapshot` 自己会补上「至少要有一个
 * 日志文件」的判定，那里再查一次只是白跑一遍 readdir。对外只导出
 * `readSessionHeader`（带日志文件校验的那份），避免两个同名语义混淆。
 */
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

function isPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EACCES" || code === "EPERM";
}

function permissionCause(error: unknown): unknown {
  const cause = (error as { detail?: { cause?: unknown } }).detail?.cause;
  return cause !== undefined && isPermissionError(cause) ? cause : undefined;
}

/**
 * 列表与详情用的 header-only 读取。
 *
 * 与内部 `readHeader` 的区别只有一条：**要求至少存在一个日志文件**。一个只剩
 * `header.json` 的目录（建会话时日志写失败、或日志被外部删掉）读得出 header，
 * 却一条事件也打不开；把它当正常会话列出来，用户点进去只会看到一个空对话。
 *
 * 底层错误会被 `readHeader` 包进 `detail.cause`；权限错误（EACCES/EPERM）在此
 * 还原成原错误上抛，让调用方能把它归入「不可读」而不是「损坏」（D-070 的既有
 * 语义：读不到和内容坏掉是两件事，R3）。
 */
export function readSessionHeader(dir: string): SessionHeader {
  let header: SessionHeader;
  try {
    header = readHeader(dir);
  } catch (error) {
    const cause = permissionCause(error);
    if (cause !== undefined) throw cause;
    throw error;
  }
  if (listSessionLogFiles(dir).length === 0) {
    throw new SessionCorruptionError("invalid_header", `Session has no log files: ${dir}`, {
      dir,
    });
  }
  return header;
}

// 代文件必须从 v1 连续递增;缺档可能是删除、截断或同步失败,静默接受会破坏审计链(D-048)。
export function assertGenerationsContiguous(files: readonly string[], dir: string): void {
  for (let index = 0; index < files.length; index += 1) {
    const expected = index + 1;
    const actual = parseGeneration(files[index]!);
    if (actual !== expected) {
      throw new SessionCorruptionError(
        "invalid_event_line",
        `Session generation gap: expected session.v${expected}.jsonl, found ${files[index]}`,
        { dir, expectedGeneration: expected, actualGeneration: actual },
      );
    }
  }
}

export function decodeEventLine(bytes: Buffer): string {
  let end = bytes.length;
  if (end > 0 && bytes[end - 1] === 0x0d) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

export function parseEventLineText(text: string, file: string, line: number): SessionEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new SessionCorruptionError("invalid_event_line", `Invalid event line: ${file}:${line}`, {
      file,
      line,
      cause: error,
    });
  }
  return parseEventObject(parsed, file, line);
}

export function parseEventObject(parsed: unknown, file: string, line: number): SessionEvent {
  if (!isRecord(parsed)) {
    throw new SessionCorruptionError(
      "invalid_event_line",
      `Invalid event line: ${file}:${line}`,
      { file, line },
    );
  }
  if (!isRecord(parsed.payload)) {
    throw new SessionCorruptionError(
      "invalid_event_line",
      `Invalid event payload: ${file}:${line}`,
      { file, line },
    );
  }
  if (typeof parsed.type !== "string" || !Object.hasOwn(EVENT_TYPES, parsed.type)) {
    throw new SessionCorruptionError(
      "unknown_event_type",
      `Unknown event type at ${file}:${line}`,
      { file, line, type: parsed.type },
    );
  }
  return parsed as unknown as SessionEvent;
}

export function parseEventLine(
  text: string,
  file: string,
  line: number,
  expectedSeq: number,
): SessionEvent {
  const event = parseEventLineText(text, file, line);
  if (event.seq !== expectedSeq) {
    throw new SessionCorruptionError("invalid_seq", `Invalid seq at ${file}:${line}`, {
      file,
      line,
      expected: expectedSeq,
      actual: event.seq,
    });
  }
  return event;
}

function readEvents(dir: string, files: string[]): SessionEvent[] {
  const events: SessionEvent[] = [];
  for (const name of files) {
    const file = path.join(dir, name);
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.length === 0) continue;
      events.push(parseEventLine(line, name, index + 1, events.length));
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
  assertGenerationsContiguous(files, dir);
  return { header, events: readEvents(dir, files), logFiles: files };
}

export interface ReadSessionSnapshotOptions {
  allowTrailingPartial?: boolean;
}

// 容错快照:完整行必须合法;尾部无换行的一段若自身是完整 JSON 则按事件处理,
// 否则仅在 open 会话的最后一代理容为 pendingTail(按字节保留,避免截断多字节字符)。
export async function readSessionSnapshot(
  dir: string,
  opts: ReadSessionSnapshotOptions = {},
): Promise<SessionSnapshot> {
  const header = readHeader(dir);
  const files = listSessionLogFiles(dir);
  if (files.length === 0) {
    throw new SessionCorruptionError("invalid_header", `Session has no log files: ${dir}`, {
      dir,
    });
  }
  assertGenerationsContiguous(files, dir);
  const events: SessionEvent[] = [];
  const generations: SessionGenerationState[] = [];
  let pendingTail: SessionSnapshot["pendingTail"];
  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    const name = files[fileIndex]!;
    const bytes = readFileSync(path.join(dir, name));
    let start = 0;
    let lineNo = 0;
    for (;;) {
      const newline = bytes.indexOf(0x0a, start);
      if (newline < 0) break;
      lineNo += 1;
      const text = decodeEventLine(bytes.subarray(start, newline));
      start = newline + 1;
      if (text.trim().length === 0) continue;
      events.push(parseEventLine(text, name, lineNo, events.length));
    }
    if (start < bytes.length) {
      const tail = bytes.subarray(start);
      const text = decodeEventLine(tail);
      if (text.trim().length > 0) {
        let jsonParsed = true;
        try {
          JSON.parse(text);
        } catch {
          jsonParsed = false;
        }
        if (jsonParsed) {
          events.push(parseEventLine(text, name, lineNo + 1, events.length));
          start = bytes.length;
        } else {
          const isLastGeneration = fileIndex === files.length - 1;
          if (opts.allowTrailingPartial === true && header.status === "open" && isLastGeneration) {
            pendingTail = { bytes: Buffer.from(tail), file: name, offset: start };
          } else {
            throw new SessionCorruptionError(
              "invalid_event_line",
              `Invalid event line: ${name}:${lineNo + 1}`,
              { file: name, line: lineNo + 1 },
            );
          }
        }
      }
    }
    generations.push({ file: name, offset: start });
  }
  return pendingTail === undefined
    ? { header, events, generations }
    : { header, events, generations, pendingTail };
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

type ArtifactIssue = "missing" | "rejected";

function markArtifactMissing(event: SessionEvent, issue: ArtifactIssue = "missing"): void {
  if (!isRecord(event.payload)) return;
  const detail = event.payload.detail;
  const marker = issue === "rejected"
    ? { artifactRejected: true }
    : { artifactMissing: true };
  event.payload.detail = isRecord(detail)
    ? { ...detail, ...marker }
    : { originalDetail: detail, ...marker };
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
    markArtifactMissing(event, "rejected");
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
    markArtifactMissing(event, "rejected");
    return;
  }
  let sourceInfo;
  try {
    sourceInfo = await stat(sourcePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    markArtifactMissing(event);
    return;
  }
  if (!sourceInfo.isFile()) {
    // 目录或特殊文件无法复制,按不支持跳过而不是让整个 fork 失败(D-042)。
    markArtifactMissing(event, "rejected");
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
  const lock = await acquireSessionLock(targetDir);

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

    const handle = openSessionHandle(targetDir, header, prefix, {
      generationThresholdBytes,
      currentBytes: size,
      lock,
    });
    return handle;
  } catch (error) {
    await lock.release();
    await cleanupTargetDir(targetDir, createdTargetDir);
    throw error;
  }
}
