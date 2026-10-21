import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSession } from "../../src/session/session.js";
import { isValidSessionId } from "../../src/session/handle.js";
import { SESSION_LOCK_FILE } from "../../src/session/lock.js";
import { SESSION_META_FILE, readSessionMeta } from "../../src/session/metadata.js";
import { readSessionDir, readSessionHeader } from "../../src/session/persistence.js";
import { createSessionAdmin } from "../../src/server/session-admin.js";
import { HttpError } from "../../src/server/http.js";
import type { SessionEvent } from "../../src/session/types.js";

const homes: string[] = [];

function makeHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "eam-session-admin-"));
  homes.push(home);
  return home;
}

function sessionsDir(home: string): string {
  return path.join(home, "sessions");
}

function sessionDir(home: string, id: string): string {
  return path.join(sessionsDir(home), id);
}

function writeEventLine(filePath: string, event: SessionEvent): void {
  writeFileSync(filePath, `${JSON.stringify(event)}\n`, { encoding: "utf8", flag: "a" });
}

/**
 * 直接写一套合法的 header + 日志。用真实句柄太贵：这里的用例只需要一个
 * 可被 `readSessionDir` 读回的会话，不需要锁或句柄生命周期。
 */
function makeSession(home: string, id: string, opts: { status?: "open" | "closed" } = {}): string {
  const dir = sessionDir(home, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "header.json"),
    `${JSON.stringify({
      id,
      createdAt: "2026-10-21T00:00:00.000Z",
      status: opts.status ?? "closed",
      model: "local-gw/flash",
      workdir: "/work",
    })}\n`,
    "utf8",
  );
  const logPath = path.join(dir, "session.v1.jsonl");
  writeFileSync(logPath, "", "utf8");
  writeEventLine(logPath, {
    seq: 0,
    ts: "2026-10-21T00:00:00.000Z",
    type: "user",
    payload: { content: "你好" },
  });
  writeEventLine(logPath, {
    seq: 1,
    ts: "2026-10-21T00:00:01.000Z",
    type: "assistant",
    payload: { content: "收到", toolCalls: [] },
  });
  return dir;
}

async function expectHttpError(
  run: () => Promise<unknown>,
  status: number,
  code: string,
): Promise<HttpError> {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(HttpError);
  const httpError = caught as HttpError;
  expect(httpError.status).toBe(status);
  expect(httpError.code).toBe(code);
  expect(httpError.message.length).toBeGreaterThan(0);
  return httpError;
}

afterEach(() => {
  // 只清理本用例自己创建的临时 HARNESS_HOME，不做任何系统级删除。
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("会话元数据读写", () => {
  it("缺省返回空元数据，updatedAt 取 header.createdAt", () => {
    const home = makeHome();
    const dir = makeSession(home, "s1");

    const meta = readSessionMeta(dir);

    expect(meta).toEqual({ updatedAt: "2026-10-21T00:00:00.000Z" });
  });

  it("meta.json 损坏时不抛错，按空元数据处理", () => {
    const home = makeHome();
    const dir = makeSession(home, "s1");
    writeFileSync(path.join(dir, SESSION_META_FILE), "{oops", "utf8");

    expect(() => readSessionMeta(dir)).not.toThrow();

    const meta = readSessionMeta(dir);
    expect(meta.title).toBeUndefined();
    expect(meta.updatedAt).toBe("2026-10-21T00:00:00.000Z");
  });

  it("title 去空白、超长截断而不是报错", async () => {
    const home = makeHome();
    const admin = createSessionAdmin({ harnessHome: home });
    makeSession(home, "s1");

    const trimmed = await admin.update("s1", { title: "  调试 UART 初始化  " });
    expect(trimmed.title).toBe("调试 UART 初始化");

    const long = await admin.update("s1", { title: "x".repeat(500) });
    expect(long.title).toHaveLength(200);
  });

  it("title=null 与纯空白都清除标题", async () => {
    const home = makeHome();
    const admin = createSessionAdmin({ harnessHome: home });
    makeSession(home, "s1");

    await admin.update("s1", { title: "有标题" });
    expect(readSessionMeta(sessionDir(home, "s1")).title).toBe("有标题");

    const cleared = await admin.update("s1", { title: null });
    expect(cleared.title).toBe("");
    expect(readSessionMeta(sessionDir(home, "s1")).title).toBeUndefined();

    await admin.update("s1", { title: "又一标题" });
    await admin.update("s1", { title: "   " });
    expect(readSessionMeta(sessionDir(home, "s1")).title).toBeUndefined();
  });
});

describe("update", () => {
  it("返回合并了 header 信息的摘要，并落盘 meta.json", async () => {
    const home = makeHome();
    const admin = createSessionAdmin({ harnessHome: home });
    makeSession(home, "s1");

    const summary = await admin.update("s1", { pinned: true, archived: true });

    expect(summary).toEqual({
      id: "s1",
      title: "",
      pinned: true,
      archived: true,
      status: "closed",
      createdAt: "2026-10-21T00:00:00.000Z",
      workdir: "/work",
      model: "local-gw/flash",
    });
    expect(JSON.parse(readFileSync(path.join(sessionDir(home, "s1"), SESSION_META_FILE), "utf8")))
      .toMatchObject({ pinned: true, archived: true });
  });

  it("不存在的 id → 404 session_not_found", async () => {
    const home = makeHome();
    const admin = createSessionAdmin({ harnessHome: home });
    mkdirSync(sessionsDir(home), { recursive: true });

    await expectHttpError(async () => admin.update("nope", { title: "x" }), 404, "session_not_found");
  });

  it("非法 id → 400 invalid_session_id", async () => {
    const home = makeHome();
    const admin = createSessionAdmin({ harnessHome: home });
    makeSession(home, "s1");

    for (const id of ["../s1", "bad id", "a/b", "", "CON"]) {
      await expectHttpError(async () => admin.update(id, { title: "x" }), 400, "invalid_session_id");
    }
  });

  it.each<[string, unknown]>([
    ["空对象", {}],
    ["title 类型错误", { title: 42 }],
    ["pinned 类型错误", { pinned: "yes" }],
    ["archived 类型错误", { archived: 1 }],
    ["body 不是对象", "x"],
  ])("非法请求体（%s）→ 400 invalid_body 且不写 meta", async (_label, body) => {
    const home = makeHome();
    const admin = createSessionAdmin({ harnessHome: home });
    const dir = makeSession(home, "s1");

    await expectHttpError(async () => admin.update("s1", body), 400, "invalid_body");

    expect(existsSync(path.join(dir, SESSION_META_FILE))).toBe(false);
  });

  it("会话被存活进程锁住 → 409 session_busy", async () => {
    const home = makeHome();
    const admin = createSessionAdmin({ harnessHome: home });
    const dir = makeSession(home, "s1");
    // 本进程的 pid 一定存活，用它模拟「另一个写者正在运行」。
    writeFileSync(
      path.join(dir, SESSION_LOCK_FILE),
      `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
      "utf8",
    );

    await expectHttpError(async () => admin.update("s1", { pinned: true }), 409, "session_busy");
    expect(existsSync(path.join(dir, SESSION_META_FILE))).toBe(false);
  });

  it("锁属于已退出进程时视为不忙", async () => {
    const home = makeHome();
    const admin = createSessionAdmin({ harnessHome: home });
    const dir = makeSession(home, "s1");
    // 999999 超出常见 pid 上限，process.kill 会以 ESRCH 失败。
    writeFileSync(
      path.join(dir, SESSION_LOCK_FILE),
      `${JSON.stringify({ pid: 999_999, createdAt: "2026-10-21T00:00:00.000Z" })}\n`,
      "utf8",
    );

    const summary = await admin.update("s1", { pinned: true });

    expect(summary.pinned).toBe(true);
  });
});

/** Windows 上创建目录符号链接（或联接点）需要开发者模式/管理员；探测失败就跳过。 */
function canLinkDirectories(): boolean {
  const root = mkdtempSync(path.join(tmpdir(), "eam-session-admin-link-"));
  try {
    const target = path.join(root, "target");
    mkdirSync(target);
    symlinkSync(target, path.join(root, "link"), process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const DIRECTORY_LINKS_SUPPORTED = canLinkDirectories();

describe("路径安全", () => {
  it.skipIf(!DIRECTORY_LINKS_SUPPORTED)("会话目录是符号链接/联接点时按非法 id 拒绝，且不删除真实目录", async () => {
    const home = makeHome();
    const admin = createSessionAdmin({ harnessHome: home });
    const realDir = makeSession(home, "real-session");
    symlinkSync(
      realDir,
      sessionDir(home, "alias"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await expectHttpError(async () => admin.remove("alias"), 400, "invalid_session_id");

    expect(existsSync(path.join(realDir, "header.json"))).toBe(true);
  });
});

describe("remove", () => {
  it("删除后目录消失", async () => {
    const home = makeHome();
    const admin = createSessionAdmin({ harnessHome: home });
    const dir = makeSession(home, "s1");

    await admin.remove("s1");

    expect(existsSync(dir)).toBe(false);
  });

  it("删除被锁会话 → 409 session_busy 且目录仍在", async () => {
    const home = makeHome();
    const admin = createSessionAdmin({ harnessHome: home });
    const dir = makeSession(home, "s1");
    writeFileSync(
      path.join(dir, SESSION_LOCK_FILE),
      `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
      "utf8",
    );

    await expectHttpError(async () => admin.remove("s1"), 409, "session_busy");
    expect(existsSync(path.join(dir, "header.json"))).toBe(true);
  });

  it("删除不存在的会话 → 404，且不影响其他会话", async () => {
    const home = makeHome();
    const admin = createSessionAdmin({ harnessHome: home });
    makeSession(home, "s1");

    await expectHttpError(async () => admin.remove("nope"), 404, "session_not_found");
    expect(existsSync(sessionDir(home, "s1"))).toBe(true);
  });
});

describe("fork", () => {
  it("产出新 id，新会话可被 readSessionDir 读回且记录 forkedFrom", async () => {
    const home = makeHome();
    const admin = createSessionAdmin({ harnessHome: home });
    makeSession(home, "s1");

    const { sessionId } = await admin.fork("s1", 1);

    expect(sessionId).not.toBe("s1");
    expect(isValidSessionId(sessionId)).toBe(true);
    const forked = readSessionDir(sessionDir(home, sessionId));
    expect(forked.header.forkedFrom).toEqual({ sessionId: "s1", seq: 1 });
    expect(forked.events.map((event) => event.seq)).toEqual([0, 1]);
    expect(forked.header.model).toBe("local-gw/flash");
  });

  it("fork 结束后释放目标目录锁", async () => {
    const home = makeHome();
    const admin = createSessionAdmin({ harnessHome: home });
    makeSession(home, "s1");

    const { sessionId } = await admin.fork("s1", 1);

    expect(existsSync(path.join(sessionDir(home, sessionId), SESSION_LOCK_FILE))).toBe(false);
    // header 由 handle.close() 落盘为 closed；句柄没关的话这里仍是 open。
    expect(readSessionHeader(sessionDir(home, sessionId)).status).toBe("closed");
  });

  it("atSeq 缺省用日志最后一条 seq", async () => {
    const home = makeHome();
    const admin = createSessionAdmin({ harnessHome: home });
    makeSession(home, "s1");

    const { sessionId } = await admin.fork("s1");

    expect(readSessionDir(sessionDir(home, sessionId)).events).toHaveLength(2);
    expect(readSessionHeader(sessionDir(home, sessionId)).forkedFrom).toEqual({
      sessionId: "s1",
      seq: 1,
    });
  });

  it.each<[string, number]>([
    ["负数", -1],
    ["非整数", 0.5],
    ["越界", 2],
    ["远超上界", 99],
  ])("atSeq %s → 400 invalid_body 且不产生新会话", async (_label, atSeq) => {
    const home = makeHome();
    const admin = createSessionAdmin({ harnessHome: home });
    makeSession(home, "s1");

    await expectHttpError(async () => admin.fork("s1", atSeq), 400, "invalid_body");

    expect(readdirSync(sessionsDir(home))).toEqual(["s1"]);
    expect(readSessionDir(sessionDir(home, "s1")).events).toHaveLength(2);
  });

  it("fork 位置不是可投影前缀 → 400 fork_failed", async () => {
    const home = makeHome();
    const admin = createSessionAdmin({ harnessHome: home });
    makeSession(home, "s1");
    // 追加一条没有 toolCalls 的 assistant 之后的孤立 tool_result，构成不可投影前缀。
    const logPath = path.join(sessionDir(home, "s1"), "session.v1.jsonl");
    writeFileSync(logPath, "", "utf8");
    const assistant: SessionEvent = {
      seq: 0,
      ts: "2026-10-21T00:00:00.000Z",
      type: "assistant",
      payload: { content: "调用工具", toolCalls: [{ id: "c1", name: "echo", arguments: {} }] },
    };
    writeEventLine(logPath, assistant);
    writeEventLine(logPath, {
      seq: 1,
      ts: "2026-10-21T00:00:01.000Z",
      type: "assistant",
      payload: { content: "另一轮", toolCalls: [] },
    });

    await expectHttpError(async () => admin.fork("s1", 1), 400, "fork_failed");
  });

  it("不存在的会话 → 404 session_not_found", async () => {
    const home = makeHome();
    const admin = createSessionAdmin({ harnessHome: home });
    mkdirSync(sessionsDir(home), { recursive: true });

    await expectHttpError(async () => admin.fork("nope"), 404, "session_not_found");
  });
});

describe("真实句柄夹具", () => {
  it("对 createSession 产出的会话 rename 后仍可 resume 读回", async () => {
    const home = makeHome();
    const admin = createSessionAdmin({ harnessHome: home });
    const id = randomUUID();
    const handle = await createSession(sessionDir(home, id), { id });
    await handle.append({ type: "user", payload: { content: "hi" } });
    await handle.close();

    const summary = await admin.update(id, { title: "真实会话" });

    expect(summary.title).toBe("真实会话");
    expect(readSessionMeta(sessionDir(home, id)).title).toBe("真实会话");
    expect(readSessionDir(sessionDir(home, id)).header.id).toBe(id);
  });
});
