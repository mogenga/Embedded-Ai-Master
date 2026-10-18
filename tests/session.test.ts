import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSession, readSessionFile } from "../src/session/session.js";
import {
  SessionCorruptionError,
  SessionForkError,
  SessionResumeError,
} from "../src/session/errors.js";
import type { SessionEvent } from "../src/session/types.js";

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
