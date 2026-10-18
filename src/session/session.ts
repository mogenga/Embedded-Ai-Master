import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, open, rm, stat } from "node:fs/promises";
import path from "node:path";
import { buildMessages } from "../context/build.js";
import { SessionResumeError } from "./errors.js";
import {
  createHandle,
  deepFreeze,
  openSessionHandle,
  resolveGenerationThresholdBytes,
  validateHeader,
  writeHeaderAtomic,
} from "./handle.js";
import type { SessionHandle } from "./handle.js";
import {
  assertRegularEventFile,
  listSessionLogFiles,
  readSessionDir,
} from "./persistence.js";
import type { SessionEvent, SessionHeader } from "./types.js";

export { openSessionHandle } from "./handle.js";
export type { SessionHandle, UsageTotals } from "./handle.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface MissingToolResult {
  id: string;
  parent: number;
}

interface CrashRecoveryPlan {
  missing: MissingToolResult[];
  needsInterrupted: boolean;
}

function crashRecoveryResultPayload(id: string): Record<string, unknown> {
  return {
    id,
    ok: false,
    code: "tool_result_lost",
    text: "result lost due to crash",
    detail: { crashRecovery: true },
  };
}

function isCrashRecoveryResult(event: SessionEvent): boolean {
  return (
    event.type === "tool_result" &&
    isRecord(event.payload) &&
    event.payload.code === "tool_result_lost" &&
    isRecord(event.payload.detail) &&
    event.payload.detail.crashRecovery === true
  );
}

function needsCrashRecoveryInterrupted(events: readonly SessionEvent[]): boolean {
  let lastResult = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (isCrashRecoveryResult(events[index])) {
      lastResult = index;
      break;
    }
  }
  if (lastResult < 0) return false;
  for (let index = lastResult + 1; index < events.length; index += 1) {
    const event = events[index];
    if (
      event.type === "interrupted" &&
      isRecord(event.payload) &&
      event.payload.reason === "crash_recovery"
    ) {
      return false;
    }
  }
  return true;
}

// 只恢复「最后一个 assistant 批次缺 tool_result」这一种崩溃尾部；
// 其余投影错误保持 fail-closed，避免把日志损坏伪装成可恢复状态。
function planCrashRecovery(
  events: readonly SessionEvent[],
): CrashRecoveryPlan | undefined {
  let projectionError: unknown;
  try {
    buildMessages(events);
    return needsCrashRecoveryInterrupted(events)
      ? { missing: [], needsInterrupted: true }
      : undefined;
  } catch (error) {
    projectionError = error;
  }

  let assistantIndex = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].type === "assistant") {
      assistantIndex = index;
      break;
    }
  }
  if (assistantIndex < 0) throw projectionError;
  const assistant = events[assistantIndex];
  for (let index = assistantIndex + 1; index < events.length; index += 1) {
    const type = events[index].type;
    if (type === "user" || type === "system" || type === "assistant") {
      throw projectionError;
    }
  }

  const toolCalls = assistant.payload.toolCalls;
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) throw projectionError;
  const callIds: string[] = [];
  const seen = new Set<string>();
  for (const raw of toolCalls) {
    if (!isRecord(raw) || typeof raw.id !== "string" || seen.has(raw.id)) {
      throw projectionError;
    }
    seen.add(raw.id);
    callIds.push(raw.id);
  }

  const resultIds = new Set<string>();
  for (let index = assistantIndex + 1; index < events.length; index += 1) {
    const event = events[index];
    if (event.type !== "tool_result") continue;
    if (event.parent !== assistant.seq || typeof event.payload.id !== "string") {
      throw projectionError;
    }
    resultIds.add(event.payload.id);
  }

  const missing = callIds.filter((id) => !resultIds.has(id));
  if (missing.length === 0) throw projectionError;

  const repaired: SessionEvent[] = events.slice();
  let nextSeq = events[events.length - 1].seq + 1;
  const ts = new Date().toISOString();
  for (const id of missing) {
    repaired.push({
      seq: nextSeq,
      ts,
      type: "tool_result",
      payload: crashRecoveryResultPayload(id),
      parent: assistant.seq,
    });
    nextSeq += 1;
  }
  repaired.push({
    seq: nextSeq,
    ts,
    type: "interrupted",
    payload: { reason: "crash_recovery" },
  });

  try {
    buildMessages(repaired);
  } catch {
    throw projectionError;
  }

  return {
    missing: missing.map((id) => ({ id, parent: assistant.seq })),
    needsInterrupted: true,
  };
}

async function assertSessionExists(dir: string, headerPath: string): Promise<void> {
  let info;
  try {
    info = await stat(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SessionResumeError("missing_session_dir", `Session directory not found: ${dir}`, {
        dir,
      });
    }
    throw error;
  }
  if (!info.isDirectory()) {
    throw new SessionResumeError("invalid_target", `Session path is not a directory: ${dir}`, {
      dir,
    });
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
  const generationThresholdBytes = resolveGenerationThresholdBytes(
    opts.generationThresholdBytes,
  );
  if (sessionDir === "") {
    throw new SessionResumeError("invalid_target", "sessionDir must not be empty", {
      dir: sessionDir,
    });
  }
  const dir = path.resolve(sessionDir);
  let dirInfo;
  try {
    dirInfo = await stat(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (dirInfo !== undefined && !dirInfo.isDirectory()) {
    throw new SessionResumeError("invalid_target", `Session path is not a directory: ${dir}`, {
      dir,
    });
  }
  const id = opts.id ?? randomUUID();
  const header = validateHeader({
    id,
    createdAt: new Date().toISOString(),
    status: "open",
    ...(opts.provider === undefined ? {} : { provider: opts.provider }),
    ...(opts.model === undefined ? {} : { model: opts.model }),
    ...(opts.workdir === undefined ? {} : { workdir: opts.workdir }),
  });
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

  const handle = openSessionHandle(dir, header, [], {
    generationThresholdBytes,
  });

  if (opts.systemPrompt !== undefined) {
    await handle.append({ type: "system", payload: { content: opts.systemPrompt } });
  }
  return handle;
}

export async function resumeSession(
  sessionDir: string,
  opts: { generationThresholdBytes?: number } = {},
): Promise<SessionHandle> {
  if (sessionDir === "") {
    throw new SessionResumeError("invalid_target", "sessionDir must not be empty", {
      dir: sessionDir,
    });
  }
  const generationThresholdBytes = resolveGenerationThresholdBytes(
    opts.generationThresholdBytes,
  );
  const dir = path.resolve(sessionDir);
  const headerPath = path.join(dir, "header.json");
  await assertSessionExists(dir, headerPath);
  const { header, events, logFiles } = readSessionDir(dir);
  const recovery = planCrashRecovery(events);
  const originalStatus = header.status;
  const lastLog = logFiles[logFiles.length - 1];
  const lastLogPath = path.join(dir, lastLog);
  const { size } = await stat(lastLogPath);
  for (const event of events) deepFreeze(event);
  const appendHandle = createHandle(dir, header, events, lastLogPath, {
    generationThresholdBytes,
    currentBytes: size,
  });
  try {
    if (recovery !== undefined) {
      for (const missing of recovery.missing) {
        await appendHandle.append({
          type: "tool_result",
          payload: crashRecoveryResultPayload(missing.id),
          parent: missing.parent,
        });
      }
      if (recovery.needsInterrupted) {
        await appendHandle.append({
          type: "interrupted",
          payload: { reason: "crash_recovery" },
        });
      }
    }
    const currentLog = listSessionLogFiles(dir).at(-1) ?? lastLog;
    const currentLogPath = path.join(dir, currentLog);
    const { size: currentBytes } = await stat(currentLogPath);
    const openHeader = await writeHeaderAtomic(headerPath, { ...header, status: "open" });
    return createHandle(
      dir,
      openHeader,
      appendHandle.events().slice(),
      currentLogPath,
      { generationThresholdBytes, currentBytes },
    );
  } catch (error) {
    if (originalStatus === "closed") {
      await writeHeaderAtomic(headerPath, { ...header, status: originalStatus }).catch(
        () => undefined,
      );
    }
    throw error;
  }
}

export function readSessionFile(filePath: string): SessionEvent[] {
  assertRegularEventFile(filePath);
  const content = readFileSync(filePath, "utf8");
  return content
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as SessionEvent);
}
