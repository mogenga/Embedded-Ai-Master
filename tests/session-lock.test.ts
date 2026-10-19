import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionResumeError } from "../src/session/errors.js";
import { acquireSessionLock, SESSION_LOCK_FILE } from "../src/session/lock.js";

const dirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "session-lock-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("会话目录锁", () => {
  it("外部存活进程持锁时拒绝（session_locked）", async () => {
    const dir = makeDir();
    writeFileSync(
      path.join(dir, SESSION_LOCK_FILE),
      `${JSON.stringify({ pid: 4242, createdAt: "2026-10-19T00:00:00.000Z" })}\n`,
      "utf8",
    );

    await expect(
      acquireSessionLock(dir, { isAlive: () => true }),
    ).rejects.toMatchObject({ name: "SessionResumeError", code: "session_locked", detail: { pid: 4242 } });
    expect(existsSync(path.join(dir, SESSION_LOCK_FILE))).toBe(true);
  });

  it("外部进程已退出时回收陈旧锁", async () => {
    const dir = makeDir();
    writeFileSync(
      path.join(dir, SESSION_LOCK_FILE),
      `${JSON.stringify({ pid: 4242, createdAt: "2026-10-19T00:00:00.000Z" })}\n`,
      "utf8",
    );

    const lock = await acquireSessionLock(dir, { isAlive: () => false });
    expect(existsSync(path.join(dir, SESSION_LOCK_FILE))).toBe(true);
    await lock.release();
    expect(existsSync(path.join(dir, SESSION_LOCK_FILE))).toBe(false);
  });

  it("同进程重入:最后一个 handle 释放时才删除锁文件", async () => {
    const dir = makeDir();
    const first = await acquireSessionLock(dir, { isAlive: () => true });
    const second = await acquireSessionLock(dir, { isAlive: () => true });

    await first.release();
    expect(existsSync(path.join(dir, SESSION_LOCK_FILE))).toBe(true);
    await second.release();
    expect(existsSync(path.join(dir, SESSION_LOCK_FILE))).toBe(false);
  });

  it("锁文件内容非法时超过陈旧阈值才回收", async () => {
    const dir = makeDir();
    const lockPath = path.join(dir, SESSION_LOCK_FILE);
    writeFileSync(lockPath, "{oops", "utf8");

    await expect(
      acquireSessionLock(dir, { isAlive: () => true }),
    ).rejects.toMatchObject({ code: "session_locked" });
  });

  it("释放幂等", async () => {
    const dir = makeDir();
    const lock = await acquireSessionLock(dir, { isAlive: () => true });

    await lock.release();
    await lock.release();

    expect(existsSync(path.join(dir, SESSION_LOCK_FILE))).toBe(false);
  });

  it("SessionResumeError 携带 session_locked 代码", () => {
    const error = new SessionResumeError("session_locked", "locked");
    expect(error.code).toBe("session_locked");
  });
});
