import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readSessionDir } from "../src/session/persistence.js";
import {
  createSession,
  openSessionHandle,
  readSessionFile,
  resumeSession,
} from "../src/session/session.js";
import {
  SessionCorruptionError,
  SessionForkError,
  SessionResumeError,
} from "../src/session/errors.js";
import type { SessionEvent, SessionHeader } from "../src/session/types.js";

const fsFaults = vi.hoisted(() => ({ rename: null as Error | null }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (oldPath: string, newPath: string): Promise<void> => {
      if (fsFaults.rename !== null) throw fsFaults.rename;
      return actual.rename(oldPath, newPath);
    },
  };
});

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "session-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("会话持久化", () => {
  it("有 systemPrompt 时以 system 事件为首条", async () => {
    const session = await createSession(makeTempDir(), { systemPrompt: "诊断助手" });

    expect(session.events()[0]).toMatchObject({
      seq: 0,
      type: "system",
      payload: { content: "诊断助手" },
    });
  });

  it("追加事件的 seq 从 0 开始并递增", async () => {
    const session = await createSession(makeTempDir());
    const first = await session.append({ type: "user", payload: { content: "一" } });
    const second = await session.append({ type: "user", payload: { content: "二" } });

    expect([first.seq, second.seq]).toEqual([0, 1]);
    expect(session.events().map((event) => event.payload.content)).toEqual(["一", "二"]);
  });

  it("单事件写入 JSONL 后可 round-trip", async () => {
    const dir = makeTempDir();
    const session = await createSession(dir);
    const event = await session.append({ type: "user", payload: { content: "hello" } });
    await session.close();

    const jsonl = readFileSync(path.join(dir, "session.v1.jsonl"), "utf8");
    expect(jsonl.trimEnd().split("\n")).toHaveLength(1);
    expect(readSessionFile(path.join(dir, "session.v1.jsonl"))).toEqual([event]);
  });

  it("JSONL 中存在坏 JSON 行时 fail-closed", () => {
    const file = path.join(makeTempDir(), "session.v1.jsonl");
    writeFileSync(file, '{"seq":0}\n{oops}\n', "utf8");

    expect(() => readSessionFile(file)).toThrow();
  });

  it("目标会话已存在时拒绝创建且不覆盖原始数据", async () => {
    const dir = makeTempDir();
    const existing = await createSession(dir);
    await existing.append({ type: "user", payload: { content: "保留" } });
    const headerBefore = readFileSync(path.join(dir, "header.json"), "utf8");
    const logBefore = readFileSync(path.join(dir, "session.v1.jsonl"), "utf8");

    await expect(createSession(dir)).rejects.toThrow(/already exists|已存在/i);

    expect(readFileSync(path.join(dir, "header.json"), "utf8")).toBe(headerBefore);
    expect(readFileSync(path.join(dir, "session.v1.jsonl"), "utf8")).toBe(logBefore);
  });

  it("Promise.all 追加顺序与 JSONL 持久化顺序一致", async () => {
    const dir = makeTempDir();
    const session = await createSession(dir);
    const writes = Array.from({ length: 20 }, (_, index) =>
      session.append({ type: "user", payload: { content: String(index) } }),
    );

    const appended = await Promise.all(writes);
    const persisted = readSessionFile(path.join(dir, "session.v1.jsonl"));

    expect(appended.map((event) => event.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(persisted).toEqual(appended);
  });

  it("close 等待已排队 append 完成并拒绝后续 append", async () => {
    const dir = makeTempDir();
    const session = await createSession(dir);
    const writes = Array.from({ length: 20 }, (_, index) =>
      session.append({ type: "user", payload: { content: String(index) } }),
    );
    const closing = session.close();
    const appended = await Promise.all(writes);
    await closing;

    expect(session.events()).toEqual(appended);
    expect(readSessionFile(path.join(dir, "session.v1.jsonl"))).toEqual(appended);
    await expect(session.append({ type: "user", payload: { content: "late" } })).rejects.toThrow(/closed|关闭/i);
  });

  it("append 深拷贝并冻结事件数据而不冻结调用方 payload", async () => {
    const session = await createSession(makeTempDir());
    const payload = { content: "before", nested: { values: [1] } };
    const event = await session.append({ type: "user", payload });

    expect(Object.isFrozen(payload)).toBe(false);
    expect(Object.isFrozen(payload.nested)).toBe(false);
    expect(Object.isFrozen(payload.nested.values)).toBe(false);
    payload.nested.values.push(2);
    payload.content = "after";

    expect(event.payload).toEqual({ content: "before", nested: { values: [1] } });
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.payload)).toBe(true);
    expect(Object.isFrozen(event.payload.nested)).toBe(true);
    expect(Object.isFrozen((event.payload.nested as { values: number[] }).values)).toBe(true);
    expect(() => {
      event.payload.content = "changed";
    }).toThrow();
    expect(() => {
      (event.payload.nested as { values: number[] }).values.push(3);
    }).toThrow();
    expect(event.payload.content).toBe("before");
    expect((event.payload.nested as { values: number[] }).values).toEqual([1]);
  });

  it("append 在入队前快照 payload", async () => {
    const session = await createSession(makeTempDir());
    const payload = { content: "before", nested: { values: [1] } };
    const appended = session.append({ type: "user", payload });
    payload.content = "after";
    payload.nested.values.push(2);

    const event = await appended;

    expect(event.payload).toEqual({ content: "before", nested: { values: [1] } });
    expect(readSessionFile(path.join(session.dir, "session.v1.jsonl"))).toEqual([event]);
  });

  it("append 入队后修改事件信封不影响落盘", async () => {
    const dir = makeTempDir();
    const session = await createSession(dir);
    const draft = { type: "user" as "user" | "assistant", payload: { content: "before" } };
    const appended = session.append(draft);
    draft.type = "assistant";
    draft.payload.content = "after";

    const event = await appended;

    expect(event.type).toBe("user");
    expect(event.payload).toEqual({ content: "before" });
    expect(readSessionFile(path.join(dir, "session.v1.jsonl"))).toEqual([event]);
  });

  it("events() 返回只读视图,外部 push 会抛错", async () => {
    const session = await createSession(makeTempDir());
    await session.append({ type: "user", payload: { content: "a" } });

    expect(() => (session.events() as SessionEvent[]).push({} as SessionEvent)).toThrow();
    expect(session.events()).toHaveLength(1);
  });

  it("初始化中途失败时回滚已建文件", async () => {
    const dir = makeTempDir();
    mkdirSync(path.join(dir, "session.v1.jsonl"));

    await expect(createSession(dir)).rejects.toThrow(/initialization failed/i);

    expect(existsSync(path.join(dir, "header.json"))).toBe(false);
    expect(existsSync(path.join(dir, "session.v1.jsonl"))).toBe(true);
  });

  it("createSession 写入 header 元数据且状态 open", async () => {
    const dir = makeTempDir();
    const session = await createSession(dir, {
      provider: "gw",
      model: "flash",
      workdir: "/w",
    });

    expect(session.header).toMatchObject({
      id: session.id,
      status: "open",
      provider: "gw",
      model: "flash",
      workdir: "/w",
    });
    const onDisk = JSON.parse(readFileSync(path.join(dir, "header.json"), "utf8")) as {
      status: string;
      provider: string;
      model: string;
      workdir: string;
    };
    expect(onDisk).toMatchObject({
      status: "open",
      provider: "gw",
      model: "flash",
      workdir: "/w",
    });
  });

  it("openSessionHandle 以 v1 日志构造可写句柄", async () => {
    const dir = makeTempDir();
    const header: SessionHeader = {
      id: "sess-open",
      createdAt: "2026-10-18T00:00:00.000Z",
      status: "open",
    };
    writeFileSync(path.join(dir, "header.json"), `${JSON.stringify(header)}\n`, "utf8");
    writeFileSync(path.join(dir, "session.v1.jsonl"), "", "utf8");

    const handle = openSessionHandle(dir, header, []);
    const event = await handle.append({ type: "user", payload: { content: "a" } });
    await handle.close();

    expect(event.seq).toBe(0);
    expect(readSessionFile(path.join(dir, "session.v1.jsonl"))).toEqual([event]);
    expect(
      (JSON.parse(readFileSync(path.join(dir, "header.json"), "utf8")) as { status: string }).status,
    ).toBe("closed");
  });

  it("openSessionHandle 克隆传入事件且深冻结", async () => {
    const dir = makeTempDir();
    const header: SessionHeader = {
      id: "sess-clone",
      createdAt: "2026-10-18T00:00:00.000Z",
      status: "open",
    };
    writeFileSync(path.join(dir, "header.json"), `${JSON.stringify(header)}\n`, "utf8");
    writeFileSync(path.join(dir, "session.v1.jsonl"), "", "utf8");
    const event: SessionEvent = {
      seq: 0,
      ts: "2026-10-18T00:00:00.000Z",
      type: "user",
      payload: { content: "a", nested: { x: 1 } },
    };

    const handle = openSessionHandle(dir, header, [event]);
    event.payload.content = "mutated";
    (event.payload.nested as { x: number }).x = 2;

    const loaded = handle.events()[0];
    expect(handle.events()).toHaveLength(1);
    expect(loaded).not.toBe(event);
    expect(loaded?.payload.content).toBe("a");
    expect(loaded?.payload.nested).toEqual({ x: 1 });
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(Object.isFrozen(loaded?.payload)).toBe(true);
    expect(Object.isFrozen(loaded?.payload.nested)).toBe(true);
  });

  it("openSessionHandle 克隆 header 后冻结", async () => {
    const dir = makeTempDir();
    const header: SessionHeader = {
      id: "sess-header-clone",
      createdAt: "2026-10-18T00:00:00.000Z",
      status: "open",
      forkedFrom: { sessionId: "source", seq: 1 },
    };
    writeFileSync(path.join(dir, "header.json"), `${JSON.stringify(header)}\n`, "utf8");
    writeFileSync(path.join(dir, "session.v1.jsonl"), "", "utf8");

    const handle = openSessionHandle(dir, header, []);
    header.forkedFrom!.seq = 9;
    header.id = "mutated";

    expect(handle.header).not.toBe(header);
    expect(handle.header.id).toBe("sess-header-clone");
    expect(handle.header.forkedFrom).toEqual({ sessionId: "source", seq: 1 });
    expect(Object.isFrozen(handle.header)).toBe(true);
    expect(Object.isFrozen(handle.header.forkedFrom)).toBe(true);
  });

  it("close 原子更新 status 为 closed 且幂等", async () => {
    const dir = makeTempDir();
    const session = await createSession(dir);

    const firstClose = session.close();
    const secondClose = session.close();
    expect(firstClose).toBe(secondClose);
    await firstClose;

    const onDisk = JSON.parse(readFileSync(path.join(dir, "header.json"), "utf8")) as {
      status: string;
    };
    expect(onDisk.status).toBe("closed");
    expect(session.header.status).toBe("closed");
  });

  it("close 原子写失败时拒绝且磁盘与内存 header 保持 open", async () => {
    const dir = makeTempDir();
    const session = await createSession(dir);
    const headerBefore = readFileSync(path.join(dir, "header.json"), "utf8");

    fsFaults.rename = new Error("rename boom");
    try {
      await expect(session.close()).rejects.toThrow("rename boom");
    } finally {
      fsFaults.rename = null;
    }

    expect(readFileSync(path.join(dir, "header.json"), "utf8")).toBe(headerBefore);
    expect((JSON.parse(headerBefore) as { status: string }).status).toBe("open");
    expect(session.header.status).toBe("open");
    expect(existsSync(path.join(dir, "header.json.tmp"))).toBe(false);
  });

  it("close 后 append 拒绝", async () => {
    const session = await createSession(makeTempDir());
    await session.close();

    await expect(session.append({ type: "user", payload: { content: "x" } })).rejects.toThrow();
  });

  it("resume 恢复事件并续写 seq", async () => {
    const dir = makeTempDir();
    const session = await createSession(dir);
    await session.append({ type: "user", payload: { content: "a" } });
    await session.close();

    const resumed = await resumeSession(dir);

    expect(resumed.id).toBe(session.id);
    expect(resumed.dir).toBe(dir);
    expect(resumed.events().map((event) => event.seq)).toEqual([0]);
    expect(Object.isFrozen(resumed.events()[0])).toBe(true);
    const appended = await resumed.append({ type: "user", payload: { content: "b" } });
    expect(appended.seq).toBe(1);
    expect(readSessionFile(path.join(dir, "session.v1.jsonl")).map((event) => event.seq)).toEqual([
      0, 1,
    ]);
  });

  it("resume closed 目录后 header 改回 open", async () => {
    const dir = makeTempDir();
    const session = await createSession(dir);
    await session.close();

    const resumed = await resumeSession(dir);

    expect(resumed.header.status).toBe("open");
    expect(
      (JSON.parse(readFileSync(path.join(dir, "header.json"), "utf8")) as { status: string }).status,
    ).toBe("open");
    await resumed.close();
    expect(resumed.header.status).toBe("closed");
  });

  it("resume 追加到最后一个代文件", async () => {
    const dir = makeTempDir();
    const session = await createSession(dir);
    await session.append({ type: "user", payload: { content: "a" } });
    await session.close();
    appendFileSync(
      path.join(dir, "session.v2.jsonl"),
      `${JSON.stringify({
        seq: 1,
        ts: "2026-10-18T00:00:00.000Z",
        type: "user",
        payload: { content: "b" },
      })}\n`,
      "utf8",
    );

    const resumed = await resumeSession(dir);
    const appended = await resumed.append({ type: "user", payload: { content: "c" } });

    expect(appended.seq).toBe(2);
    expect(
      readSessionFile(path.join(dir, "session.v2.jsonl")).map((event) => event.payload.content),
    ).toEqual(["b", "c"]);
    expect(readSessionFile(path.join(dir, "session.v1.jsonl")).map((event) => event.seq)).toEqual([
      0,
    ]);
  });

  it("resume 空目录抛 missing_session_dir", async () => {
    await expect(resumeSession(makeTempDir())).rejects.toMatchObject({
      name: "SessionResumeError",
      code: "missing_session_dir",
    });
  });

  it("resume 目录不存在抛 missing_session_dir", async () => {
    const missing = path.join(makeTempDir(), "absent");

    await expect(resumeSession(missing)).rejects.toMatchObject({
      name: "SessionResumeError",
      code: "missing_session_dir",
    });
  });

  it("resume 目录存在但 header 缺失抛 missing_session_dir", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "session.v1.jsonl"), "", "utf8");

    await expect(resumeSession(dir)).rejects.toMatchObject({
      name: "SessionResumeError",
      code: "missing_session_dir",
      detail: { dir, file: "header.json" },
    });
  });

  it("resume 内容损坏仍抛 SessionCorruptionError", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "header.json"), "{bad", "utf8");
    writeFileSync(path.join(dir, "session.v1.jsonl"), "", "utf8");

    await expect(resumeSession(dir)).rejects.toMatchObject({
      name: "SessionCorruptionError",
      code: "invalid_header",
      detail: { file: "header.json" },
    });
  });

  it("resume 有 header 但无日志仍抛 SessionCorruptionError", async () => {
    const dir = makeTempDir();
    writeFileSync(
      path.join(dir, "header.json"),
      `${JSON.stringify({ id: "s", createdAt: "2026-10-18T00:00:00.000Z", status: "closed" })}\n`,
      "utf8",
    );

    await expect(resumeSession(dir)).rejects.toMatchObject({
      name: "SessionCorruptionError",
      code: "invalid_header",
      detail: { dir },
    });
  });

  it("resume 改回 open 的原子写失败时拒绝且磁盘保持 closed", async () => {
    const dir = makeTempDir();
    const session = await createSession(dir);
    await session.close();

    fsFaults.rename = new Error("rename boom");
    try {
      await expect(resumeSession(dir)).rejects.toThrow("rename boom");
    } finally {
      fsFaults.rename = null;
    }

    expect(
      (JSON.parse(readFileSync(path.join(dir, "header.json"), "utf8")) as { status: string }).status,
    ).toBe("closed");
    expect(existsSync(path.join(dir, "header.json.tmp"))).toBe(false);
  });

  it("usageTotals 累加并忽略缺失字段、非有限值与负值", async () => {
    const session = await createSession(makeTempDir());
    await session.append({
      type: "usage",
      payload: { promptTokens: 10, completionTokens: 5, cachedTokens: 2 },
    });
    await session.append({ type: "usage", payload: { promptTokens: 3 } });
    await session.append({
      type: "usage",
      payload: {
        promptTokens: -1,
        completionTokens: Number.POSITIVE_INFINITY,
        cachedTokens: Number.NaN,
      },
    });
    await session.append({ type: "user", payload: { content: "x" } });

    expect(session.usageTotals()).toEqual({
      promptTokens: 13,
      completionTokens: 5,
      cachedTokens: 2,
    });
  });

  it("resume 后 usageTotals 包含历史用量", async () => {
    const dir = makeTempDir();
    const session = await createSession(dir);
    await session.append({
      type: "usage",
      payload: { promptTokens: 4, completionTokens: 1, cachedTokens: 0 },
    });
    await session.close();

    const resumed = await resumeSession(dir);
    await resumed.append({ type: "usage", payload: { promptTokens: 6, completionTokens: 1 } });

    expect(resumed.usageTotals()).toEqual({
      promptTokens: 10,
      completionTokens: 2,
      cachedTokens: 0,
    });
  });

  it("usageTotals 跳过 payload 为 null 或缺失的 usage 事件", async () => {
    const dir = makeTempDir();
    writeFileSync(
      path.join(dir, "header.json"),
      `${JSON.stringify({
        id: "sess-null-usage",
        createdAt: "2026-10-18T00:00:00.000Z",
        status: "closed",
      })}\n`,
      "utf8",
    );
    writeFileSync(
      path.join(dir, "session.v1.jsonl"),
      `${JSON.stringify({
        seq: 0,
        ts: "2026-10-18T00:00:00.000Z",
        type: "usage",
        payload: null,
      })}\n${JSON.stringify({
        seq: 1,
        ts: "2026-10-18T00:00:00.000Z",
        type: "usage",
      })}\n`,
      "utf8",
    );

    const read = readSessionDir(dir);
    expect(read.events).toHaveLength(2);

    const resumed = await resumeSession(dir);
    expect(resumed.events()).toHaveLength(2);
    expect(() => resumed.usageTotals()).not.toThrow();
    expect(resumed.usageTotals()).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
    });
  });

  it("closed 会话末行缺换行时 resume 仍成功续写（当前行为，D-035 扩展）", async () => {
    const dir = makeTempDir();
    const session = await createSession(dir);
    await session.append({ type: "user", payload: { content: "a" } });
    await session.close();
    const logPath = path.join(dir, "session.v1.jsonl");
    const before = readFileSync(logPath, "utf8").trimEnd();
    writeFileSync(logPath, before, "utf8");

    const resumed = await resumeSession(dir);
    const appended = await resumed.append({ type: "user", payload: { content: "b" } });

    expect(appended.seq).toBe(1);
    expect(readFileSync(logPath, "utf8")).toBe(`${before}${JSON.stringify(appended)}\n`);
    expect(() => readSessionDir(dir)).toThrow(SessionCorruptionError);
  });

  it("结构化会话错误保留 name、code 与 detail", () => {
    const corruption = new SessionCorruptionError("invalid_seq", "seq broken", { line: 3 });
    const fork = new SessionForkError("not_turn_boundary", "not boundary");
    const resume = new SessionResumeError("model_mismatch", "model differs");

    expect(corruption).toBeInstanceOf(Error);
    expect(corruption.name).toBe("SessionCorruptionError");
    expect(corruption.code).toBe("invalid_seq");
    expect(corruption.detail).toEqual({ line: 3 });
    expect(fork.name).toBe("SessionForkError");
    expect(fork.code).toBe("not_turn_boundary");
    expect(resume.name).toBe("SessionResumeError");
    expect(resume.code).toBe("model_mismatch");
  });

  it("header 深层冻结且不能修改会话元数据", async () => {
    const session = await createSession(makeTempDir());

    expect(Object.isFrozen(session.header)).toBe(true);
    expect(() => {
      session.header.status = "closed";
    }).toThrow();
    expect(session.header.status).toBe("open");
    expect(() => {
      session.header.createdAt = "changed";
    }).toThrow();
    expect(typeof session.header.createdAt).toBe("string");
  });
});
