import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { appendFile, lstat, mkdir, open, rm, stat } from "node:fs/promises";
import path from "node:path";
import { buildMessages } from "../context/build.js";
import type { PermissionPreset } from "../permissions/types.js";
import type { ToolAccess } from "../tools/types.js";
import { SessionResumeError } from "./errors.js";
import {
  createHandle,
  deepFreeze,
  openSessionHandle,
  resolveGenerationThresholdBytes,
  validateHeader,
  writeHeaderAtomic,
} from "./handle.js";
import { acquireSessionLock } from "./lock.js";
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

interface PendingApproval {
  callId: string;
  tool: string;
  access?: ToolAccess;
  preset: PermissionPreset;
  paramsDigest: string;
  paramsKeys: string[];
  paramsPreview?: Record<string, unknown>;
}

interface CrashRecoveryPlan {
  missing: MissingToolResult[];
  needsInterrupted: boolean;
  approvals: PendingApproval[];
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

function toPendingApproval(event: SessionEvent): PendingApproval | undefined {
  if (event.type !== "approval_request") return undefined;
  const { callId, tool, preset, paramsDigest, paramsKeys, access, paramsPreview } =
    event.payload;
  if (
    typeof callId !== "string"
    || typeof tool !== "string"
    || typeof preset !== "string"
    || typeof paramsDigest !== "string"
    || !Array.isArray(paramsKeys)
    || !paramsKeys.every((key) => typeof key === "string")
  ) {
    return undefined;
  }
  const approval: PendingApproval = {
    callId,
    tool,
    preset: preset as PermissionPreset,
    paramsDigest,
    paramsKeys: paramsKeys as string[],
  };
  if (access === "read" || access === "write" || access === "unknown") approval.access = access;
  if (isRecord(paramsPreview)) approval.paramsPreview = paramsPreview;
  return approval;
}

function findUnresolvedApprovals(events: readonly SessionEvent[]): PendingApproval[] {
  const decided = new Set<string>();
  for (const event of events) {
    if (event.type !== "permission_decision") continue;
    if (typeof event.payload.callId === "string") decided.add(event.payload.callId);
  }
  const seen = new Set<string>();
  const pending: PendingApproval[] = [];
  for (const event of events) {
    const approval = toPendingApproval(event);
    if (approval === undefined || decided.has(approval.callId) || seen.has(approval.callId)) {
      continue;
    }
    seen.add(approval.callId);
    pending.push(approval);
  }
  return pending;
}

// 只恢复「最后一个 assistant 批次缺 tool_result」这一种崩溃尾部；
// 其余投影错误保持 fail-closed，避免把日志损坏伪装成可恢复状态。
function planCrashRecovery(
  events: readonly SessionEvent[],
): CrashRecoveryPlan | undefined {
  const approvals = findUnresolvedApprovals(events);
  let projectionError: unknown;
  try {
    buildMessages(events);
    const needsInterrupted = needsCrashRecoveryInterrupted(events);
    return needsInterrupted || approvals.length > 0
      ? { missing: [], needsInterrupted, approvals }
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
    approvals,
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
  // create/resume/fork 统一拒绝目录符号链接,避免同一会话经不同路径打开(D-049)。
  if ((await lstat(dir)).isSymbolicLink()) {
    throw new SessionResumeError(
      "invalid_target",
      `Session directory must not be a symbolic link: ${dir}`,
      { dir },
    );
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
  if (dirInfo !== undefined) {
    // create 与 resume 一致:拒绝目录符号链接,避免同一会话经不同路径创建/打开(D-049)。
    const linkInfo = await lstat(dir);
    if (linkInfo.isSymbolicLink()) {
      throw new SessionResumeError(
        "invalid_target",
        `Session directory must not be a symbolic link: ${dir}`,
        { dir },
      );
    }
    if (!dirInfo.isDirectory()) {
      throw new SessionResumeError("invalid_target", `Session path is not a directory: ${dir}`, {
        dir,
      });
    }
  }
  if (dirInfo !== undefined && hasSessionLog(dir)) {
    throw new Error(`Session already exists or initialization failed: existing session log in ${dir}`);
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
  const lock = await acquireSessionLock(dir);
  const headerPath = path.join(dir, "header.json");
  const logPath = path.join(dir, "session.v1.jsonl");
  let headerCreated = false;
  let logCreated = false;
  let handle: SessionHandle | undefined;
  try {
    const headerFile = await open(headerPath, "wx");
    headerCreated = true;
    try {
      await headerFile.writeFile(`${JSON.stringify(header)}\n`, "utf8");
      await headerFile.sync();
    } finally {
      await headerFile.close();
    }
    const logFile = await open(logPath, "wx");
    logCreated = true;
    try {
      await logFile.sync();
    } finally {
      await logFile.close();
    }
    handle = createHandle(dir, header, [], logPath, {
      generationThresholdBytes,
      lock,
    });
    if (opts.systemPrompt !== undefined) {
      await handle.append({ type: "system", payload: { content: opts.systemPrompt } });
    }
    return handle;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (logCreated) await rm(logPath, { force: true });
    if (headerCreated) await rm(headerPath, { force: true });
    await lock.release();
    throw new Error(`Session already exists or initialization failed: ${String(error)}`, { cause: error });
  }
}

function hasSessionLog(dir: string): boolean {
  try {
    return listSessionLogFiles(dir).length > 0;
  } catch {
    return false;
  }
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
  const lock = await acquireSessionLock(dir);
  const appendHandle = createHandle(dir, header, events, lastLogPath, {
    generationThresholdBytes,
    currentBytes: size,
    lock,
  });
  let handedOff = false;
  try {
    // 崩溃恢复前先补齐日志末行换行,避免续写与上一行粘连(D-035)。
    await ensureTrailingNewline(lastLogPath);
    if (recovery !== undefined) {
      // 未决审批先补 deny 审计,再补丢失的 tool_result 与 interrupted,保持事件因果顺序。
      for (const approval of recovery.approvals) {
        await appendHandle.append({
          type: "permission_decision",
          payload: {
            callId: approval.callId,
            tool: approval.tool,
            action: "ask",
            effective: "deny",
            reason: "approval_aborted: crash_recovery",
            preset: approval.preset,
            source: "builtin",
            paramsDigest: approval.paramsDigest,
            paramsKeys: approval.paramsKeys,
            ...(approval.paramsPreview === undefined
              ? {}
              : { paramsPreview: approval.paramsPreview }),
            ...(approval.access === undefined ? {} : { access: approval.access }),
          },
        });
      }
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
    const handle = createHandle(
      dir,
      openHeader,
      appendHandle.events().slice(),
      currentLogPath,
      { generationThresholdBytes, currentBytes, lock },
    );
    handedOff = true;
    return handle;
  } catch (error) {
    if (originalStatus === "closed") {
      await writeHeaderAtomic(headerPath, { ...header, status: originalStatus }).catch(
        () => undefined,
      );
    }
    throw error;
  } finally {
    if (!handedOff) {
      // 失败路径释放本次持有的锁;成功路径由返回的 handle 负责释放。
      await lock.release().catch(() => undefined);
    }
  }
}

// 日志末行缺少换行时补一个,保证后续 append 不会与上一行粘连(D-035)。
async function ensureTrailingNewline(logPath: string): Promise<void> {
  let text: string;
  try {
    text = readFileSync(logPath, "utf8");
  } catch {
    return;
  }
  if (text.length === 0 || text.endsWith("\n")) {
    return;
  }
  await appendFile(logPath, "\n", "utf8");
}

export function readSessionFile(filePath: string): SessionEvent[] {
  assertRegularEventFile(filePath);
  const content = readFileSync(filePath, "utf8");
  return content
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as SessionEvent);
}
