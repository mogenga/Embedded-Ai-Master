import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { lstat, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { isValidSessionId } from "../session/handle.js";
import { SESSION_LOCK_FILE } from "../session/lock.js";
import { readSessionMeta, writeSessionMeta } from "../session/metadata.js";
import { SessionForkError } from "../session/errors.js";
import { forkSession, readSessionDir, readSessionHeader } from "../session/persistence.js";
import type { SessionHeader } from "../session/types.js";
import { HttpError } from "./errors.js";

/**
 * 会话管理（重命名 / 置顶 / 归档 / 删除 / fork）。
 *
 * 与只读的 files-api 分开：这里有删除与写盘，必须先把目标路径钉死在
 * `$HARNESS_HOME/sessions` 之内（realpath + relative），再检查单写者锁。
 * 锁检查只**读**锁文件，不调用 acquireSessionLock——那会真的把会话锁住，
 * 让一个管理操作变成写者。
 */

export interface SessionAdminSummary {
  id: string;
  title: string;
  pinned: boolean;
  archived: boolean;
  status: "open" | "closed";
  createdAt: string;
  workdir?: string;
  model?: string;
}

export interface SessionAdmin {
  update(id: string, body: unknown): Promise<SessionAdminSummary>;
  remove(id: string): Promise<void>;
  fork(id: string, atSeq?: number): Promise<{ sessionId: string }>;
}

export interface SessionAdminOptions {
  harnessHome: string;
}

interface LockPayload {
  pid: number;
  createdAt: string;
}

// 与 src/session/lock.ts 的陈旧阈值一致：内容非法且超过该时长才视为不忙。
const STALE_LOCK_MS = 10 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeForCompare(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(normalizeForCompare(parent), normalizeForCompare(child));
  if (relative === "") return true;
  if (path.isAbsolute(relative)) return false;
  return relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

function invalidSessionId(): HttpError {
  return new HttpError(400, "invalid_session_id", "非法的会话 id");
}

function sessionNotFound(): HttpError {
  return new HttpError(404, "session_not_found", "会话不存在");
}

function sessionBusy(): HttpError {
  return new HttpError(409, "session_busy", "会话正在运行，不能修改或删除");
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parseLock(text: string): LockPayload | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    if (
      isRecord(value)
      && typeof value.pid === "number"
      && Number.isInteger(value.pid)
      && value.pid > 0
    ) {
      return { pid: value.pid, createdAt: typeof value.createdAt === "string" ? value.createdAt : "" };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

// 只有「锁文件确实属于一个存活进程」才算忙。内容非法时按 mtime 判陈旧——
// 与 acquireSessionLock 的回收规则一致，避免刚崩溃的写者被立刻顶掉。
async function isSessionBusy(dir: string): Promise<boolean> {
  const lockPath = path.join(dir, SESSION_LOCK_FILE);
  let text: string;
  try {
    text = await readFile(lockPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return false;
    // 锁文件存在但读不了：不能断言安全，按忙处理（fail-closed）。
    return true;
  }
  const payload = parseLock(text);
  if (payload !== undefined) return isProcessAlive(payload.pid);
  try {
    return Date.now() - statSync(lockPath).mtimeMs <= STALE_LOCK_MS;
  } catch {
    return false;
  }
}

async function realpathOrNull(value: string): Promise<string | null> {
  try {
    return await realpath(value);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

export function createSessionAdmin(opts: SessionAdminOptions): SessionAdmin {
  const sessionsDir = path.join(opts.harnessHome, "sessions");

  // 解析并校验目标目录：id 先过白名单，拒绝链接条目，再把 realpath 钉在会话根内。
  async function resolveSessionDir(id: unknown): Promise<{ id: string; dir: string }> {
    if (!isValidSessionId(id)) throw invalidSessionId();
    const rawDir = path.join(sessionsDir, id);
    let rawInfo;
    try {
      rawInfo = await lstat(rawDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw sessionNotFound();
      throw error;
    }
    // 符号链接/联接点会让同一会话有两条路径：删除一个「别名」会删掉真会话，
    // 而且 realpath 之后就无法再分辨，只能在解析前拒绝。
    if (rawInfo.isSymbolicLink()) throw invalidSessionId();
    if (!rawInfo.isDirectory()) throw sessionNotFound();
    const realRoot = await realpathOrNull(sessionsDir);
    if (realRoot === null) throw sessionNotFound();
    const realTarget = await realpathOrNull(rawDir);
    if (realTarget === null) throw sessionNotFound();
    if (!isInside(realRoot, realTarget)) throw invalidSessionId();
    return { id, dir: realTarget };
  }

  function summaryOf(id: string, header: SessionHeader, dir: string): SessionAdminSummary {
    const meta = readSessionMeta(dir);
    return {
      id,
      title: meta.title ?? "",
      pinned: meta.pinned === true,
      archived: meta.archived === true,
      status: header.status,
      createdAt: header.createdAt,
      ...(header.workdir === undefined ? {} : { workdir: header.workdir }),
      ...(header.model === undefined ? {} : { model: header.model }),
    };
  }

  return {
    async update(id, body) {
      const target = await resolveSessionDir(id);
      if (!isRecord(body)) {
        throw new HttpError(400, "invalid_body", "请求体必须是对象");
      }
      const hasTitle = body.title !== undefined;
      const hasPinned = body.pinned !== undefined;
      const hasArchived = body.archived !== undefined;
      if (!hasTitle && !hasPinned && !hasArchived) {
        throw new HttpError(400, "invalid_body", "至少提供 title、pinned 或 archived 之一");
      }
      if (hasTitle && body.title !== null && typeof body.title !== "string") {
        throw new HttpError(400, "invalid_body", "title 必须是字符串或 null");
      }
      if (hasPinned && typeof body.pinned !== "boolean") {
        throw new HttpError(400, "invalid_body", "pinned 必须是布尔值");
      }
      if (hasArchived && typeof body.archived !== "boolean") {
        throw new HttpError(400, "invalid_body", "archived 必须是布尔值");
      }
      if (await isSessionBusy(target.dir)) throw sessionBusy();

      let header: SessionHeader;
      try {
        header = readSessionHeader(target.dir);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw sessionNotFound();
        throw error;
      }
      await writeSessionMeta(target.dir, {
        ...(hasTitle ? { title: body.title as string | null } : {}),
        ...(hasPinned ? { pinned: body.pinned as boolean } : {}),
        ...(hasArchived ? { archived: body.archived as boolean } : {}),
      });
      return summaryOf(target.id, header, target.dir);
    },

    async remove(id) {
      const target = await resolveSessionDir(id);
      if (await isSessionBusy(target.dir)) throw sessionBusy();
      try {
        // 产品的删除功能：用户在 UI 里显式确认过，不是测试用的破坏性命令。
        await rm(target.dir, { recursive: true, force: false });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw sessionNotFound();
        throw error;
      }
    },

    async fork(id, atSeq) {
      const target = await resolveSessionDir(id);
      if (await isSessionBusy(target.dir)) throw sessionBusy();

      let events;
      try {
        events = readSessionDir(target.dir).events;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw sessionNotFound();
        throw error;
      }
      const maxSeq = events.length === 0 ? undefined : events[events.length - 1].seq;
      const position = atSeq ?? maxSeq;
      if (position === undefined) {
        throw new HttpError(400, "invalid_body", "会话没有可 fork 的事件");
      }
      if (
        typeof position !== "number"
        || !Number.isInteger(position)
        || position < 0
        || maxSeq === undefined
        || position > maxSeq
      ) {
        throw new HttpError(
          400,
          "invalid_body",
          `atSeq 必须是 0..${maxSeq ?? -1} 之间的整数`,
        );
      }

      const newId = randomUUID();
      let handle;
      try {
        handle = await forkSession(target.dir, position, {
          id: newId,
          targetDir: path.join(sessionsDir, newId),
        });
      } catch (error) {
        if (error instanceof SessionForkError) {
          throw new HttpError(400, "fork_failed", error.message);
        }
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw sessionNotFound();
        throw error;
      }
      // forkSession 返回的 handle 持有目标目录的写锁；不关闭会一直占着。
      await handle.close();
      return { sessionId: newId };
    },
  };
}
