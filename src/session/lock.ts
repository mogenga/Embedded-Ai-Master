import { open, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { SessionResumeError } from "./errors.js";

export const SESSION_LOCK_FILE = "session.lock";
const STALE_LOCK_MS = 10 * 60 * 1000;
const MAX_ACQUIRE_ATTEMPTS = 3;

interface LockPayload {
  pid: number;
  createdAt: string;
}

// 同进程内的重入计数:同一进程可能同时持有同一目录的多个 handle
// (例如 create 后立即 resume 做续跑)。锁文件记录进程号,最后一个
// handle 关闭时才删除,避免提前释放其他 handle 的写权。
const heldLocks = new Map<string, { count: number; payload: LockPayload }>();

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
      typeof value === "object" &&
      value !== null &&
      typeof (value as { pid?: unknown }).pid === "number" &&
      Number.isInteger((value as { pid: number }).pid) &&
      (value as { pid: number }).pid > 0 &&
      typeof (value as { createdAt?: unknown }).createdAt === "string"
    ) {
      return value as LockPayload;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function isStale(
  lockPath: string,
  payload: LockPayload | undefined,
  isAlive: (pid: number) => boolean,
): Promise<boolean> {
  if (payload !== undefined) {
    return !isAlive(payload.pid);
  }
  try {
    const info = await stat(lockPath);
    return Date.now() - info.mtimeMs > STALE_LOCK_MS;
  } catch {
    return true;
  }
}

export interface AcquireSessionLockOptions {
  isAlive?: (pid: number) => boolean;
}

export interface SessionLock {
  path: string;
  release(): Promise<void>;
}

// 目录级单写者锁(O_EXCL 锁文件),持有到 handle.close()。
// - 跨进程:锁文件已存在且持有进程存活 → session_locked;
// - 同进程:引用计数重入(create 后立即 resume 是正常用法);
// - 持有者崩溃:按 PID 存活检查回收;内容非法时超过陈旧阈值才回收。
export async function acquireSessionLock(
  dir: string,
  options: AcquireSessionLockOptions = {},
): Promise<SessionLock> {
  const isAlive = options.isAlive ?? isProcessAlive;
  const lockPath = path.join(dir, SESSION_LOCK_FILE);
  const held = heldLocks.get(lockPath);
  if (held !== undefined) {
    held.count += 1;
    return makeHandle(lockPath);
  }

  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
    let handle;
    try {
      handle = await open(lockPath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let existing: LockPayload | undefined;
      try {
        existing = parseLock(await readFile(lockPath, "utf8"));
      } catch {
        existing = undefined;
      }
      if (existing?.pid === process.pid) {
        // 锁文件属于本进程且进程内计数存在,按重入处理。
        heldLocks.set(lockPath, { count: 1, payload: existing });
        return makeHandle(lockPath);
      }
      if (!(await isStale(lockPath, existing, isAlive))) {
        throw new SessionResumeError(
          "session_locked",
          `Session is in use by another process: ${dir}`,
          { dir, pid: existing?.pid },
        );
      }
      await rm(lockPath, { force: true });
      continue;
    }
    const payload: LockPayload = { pid: process.pid, createdAt: new Date().toISOString() };
    try {
      await handle.writeFile(`${JSON.stringify(payload)}\n`, "utf8");
    } finally {
      await handle.close();
    }
    heldLocks.set(lockPath, { count: 1, payload });
    return makeHandle(lockPath);
  }
  throw new SessionResumeError(
    "session_locked",
    `Failed to acquire session lock after ${MAX_ACQUIRE_ATTEMPTS} attempts: ${dir}`,
    { dir },
  );
}

function makeHandle(lockPath: string): SessionLock {
  let released = false;
  return {
    path: lockPath,
    async release() {
      if (released) return;
      released = true;
      const held = heldLocks.get(lockPath);
      if (held !== undefined) {
        held.count -= 1;
        if (held.count > 0) return;
        heldLocks.delete(lockPath);
      }
      await rm(lockPath, { force: true }).catch(() => undefined);
    },
  };
}
