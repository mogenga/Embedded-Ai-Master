import { afterEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildMessages } from "../src/context/build.js";
import { SessionCorruptionError } from "../src/session/errors.js";
import {
  forkSession,
  readSessionDir,
  readSessionSnapshot,
} from "../src/session/persistence.js";
import { createSession, resumeSession } from "../src/session/session.js";
import type { EventType, SessionEvent, SessionHeader } from "../src/session/types.js";

const fsFaults = vi.hoisted(() => ({
  writeFile: null as ((file: string) => boolean) | null,
  rename: null as Error | null,
  copyFile: null as Error | null,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: async (
      file: Parameters<typeof actual.writeFile>[0],
      data: Parameters<typeof actual.writeFile>[1],
      options?: Parameters<typeof actual.writeFile>[2],
    ): Promise<void> => {
      if (fsFaults.writeFile?.(String(file))) throw new Error("write boom");
      return actual.writeFile(file, data, options);
    },
    rename: async (oldPath: string, newPath: string): Promise<void> => {
      if (fsFaults.rename !== null) throw fsFaults.rename;
      return actual.rename(oldPath, newPath);
    },
    copyFile: async (source: string, destination: string, mode?: number): Promise<void> => {
      if (fsFaults.copyFile !== null) throw fsFaults.copyFile;
      return actual.copyFile(source, destination, mode);
    },
  };
});

const tempDirs: string[] = [];

function detectFileSymlinkSupport(): boolean {
  const dir = mkdtempSync(path.join(tmpdir(), "session-persistence-symlink-probe-"));
  try {
    const target = path.join(dir, "target.txt");
    writeFileSync(target, "probe", "utf8");
    symlinkSync(target, path.join(dir, "link.txt"), "file");
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") return false;
    throw error;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const symlinkSupported = detectFileSymlinkSupport();

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "session-persistence-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  fsFaults.writeFile = null;
  fsFaults.rename = null;
  fsFaults.copyFile = null;
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeHeader(dir: string, header: SessionHeader): void {
  writeFileSync(path.join(dir, "header.json"), `${JSON.stringify(header)}\n`, "utf8");
}

function defaultHeader(): SessionHeader {
  return { id: "sess-1", createdAt: "2026-10-18T00:00:00.000Z", status: "open" };
}

function makeEvent(seq: number, type: EventType = "user"): SessionEvent {
  return { seq, ts: "2026-10-18T00:00:00.000Z", type, payload: { seq } };
}

function writeLines(dir: string, name: string, lines: string[]): void {
  writeFileSync(path.join(dir, name), `${lines.join("\n")}\n`, "utf8");
}

function captureCorruption(fn: () => unknown): SessionCorruptionError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(SessionCorruptionError);
    return error as SessionCorruptionError;
  }
  throw new Error("expected SessionCorruptionError");
}

describe("readSessionDir", () => {
  it("读取单代事件并按 seq 校验", async () => {
    const dir = makeTempDir();
    const session = await createSession(dir);
    const first = await session.append({ type: "user", payload: { content: "a" } });
    const second = await session.append({ type: "assistant", payload: { content: "b" } });

    const result = readSessionDir(dir);

    expect(result.header).toMatchObject({ id: session.id, status: "open" });
    expect(result.events).toEqual([first, second]);
  });

  it("跨代按数字顺序合并并跳过空行", () => {
    const dir = makeTempDir();
    writeHeader(dir, defaultHeader());
    writeLines(dir, "session.v3.jsonl", [JSON.stringify(makeEvent(2))]);
    writeLines(dir, "session.v2.jsonl", [JSON.stringify(makeEvent(1))]);
    writeLines(dir, "session.v1.jsonl", ["", JSON.stringify(makeEvent(0)), ""]);

    const result = readSessionDir(dir);

    expect(result.events.map((event) => event.seq)).toEqual([0, 1, 2]);
  });

  it.each([
    { label: "只有 v2", files: { "session.v2.jsonl": [JSON.stringify(makeEvent(0))] }, expected: 1 },
    { label: "v1 + v3", files: {
      "session.v1.jsonl": [JSON.stringify(makeEvent(0))],
      "session.v3.jsonl": [JSON.stringify(makeEvent(1))],
    }, expected: 2 },
  ])("代文件缺档（$label）→ invalid_event_line", ({ files, expected }) => {
    const dir = makeTempDir();
    writeHeader(dir, defaultHeader());
    for (const [name, lines] of Object.entries(files)) {
      writeLines(dir, name, lines);
    }

    const error = captureCorruption(() => readSessionDir(dir));

    expect(error.code).toBe("invalid_event_line");
    expect(error.detail).toMatchObject({ expectedGeneration: expected });
  });

  it("坏 header → invalid_header", () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "header.json"), "{bad", "utf8");
    writeLines(dir, "session.v1.jsonl", [JSON.stringify(makeEvent(0))]);

    const error = captureCorruption(() => readSessionDir(dir));

    expect(error.code).toBe("invalid_header");
    expect(error.detail).toMatchObject({ file: "header.json" });
  });

  it("header 字段缺失 → invalid_header", () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "header.json"), '{"id":"sess-1"}\n', "utf8");
    writeLines(dir, "session.v1.jsonl", [JSON.stringify(makeEvent(0))]);

    expect(captureCorruption(() => readSessionDir(dir)).code).toBe("invalid_header");
  });

  it.skipIf(!symlinkSupported)("header 为符号链接 → invalid_header 且不跟随", () => {
    const dir = makeTempDir();
    const realHeader = path.join(makeTempDir(), "real-header.json");
    writeFileSync(realHeader, `${JSON.stringify(defaultHeader())}\n`, "utf8");
    symlinkSync(realHeader, path.join(dir, "header.json"), "file");
    writeLines(dir, "session.v1.jsonl", [JSON.stringify(makeEvent(0))]);

    const error = captureCorruption(() => readSessionDir(dir));

    expect(error.code).toBe("invalid_header");
    expect(error.detail).toMatchObject({ file: "header.json" });
  });

  it("header 为目录 → invalid_header", () => {
    const dir = makeTempDir();
    mkdirSync(path.join(dir, "header.json"));
    writeLines(dir, "session.v1.jsonl", [JSON.stringify(makeEvent(0))]);

    const error = captureCorruption(() => readSessionDir(dir));

    expect(error.code).toBe("invalid_header");
    expect(error.detail).toMatchObject({ file: "header.json" });
  });

  it.skipIf(!symlinkSupported)("日志为符号链接 → invalid_event_line 且不跟随", () => {
    const dir = makeTempDir();
    const realLog = path.join(makeTempDir(), "real-log.jsonl");
    writeFileSync(realLog, `${JSON.stringify(makeEvent(0))}\n`, "utf8");
    writeHeader(dir, defaultHeader());
    symlinkSync(realLog, path.join(dir, "session.v1.jsonl"), "file");

    const error = captureCorruption(() => readSessionDir(dir));

    expect(error.code).toBe("invalid_event_line");
    expect(error.detail).toMatchObject({ file: "session.v1.jsonl" });
  });

  it("日志为目录 → invalid_event_line", () => {
    const dir = makeTempDir();
    writeHeader(dir, defaultHeader());
    mkdirSync(path.join(dir, "session.v1.jsonl"));

    const error = captureCorruption(() => readSessionDir(dir));

    expect(error.code).toBe("invalid_event_line");
    expect(error.detail).toMatchObject({ file: "session.v1.jsonl" });
  });

  it.each([
    ["空 id", { id: "" }],
    ["非法字符 id", { id: "bad id" }],
    ["Windows 保留 id", { id: "CON" }],
    ["createdAt 不可解析", { createdAt: "not-a-date" }],
    ["createdAt 非字符串", { createdAt: 1 }],
    ["status 非法", { status: "paused" }],
    ["provider 非字符串", { provider: 1 }],
    ["model 非字符串", { model: {} }],
    ["workdir 非字符串", { workdir: [] }],
    ["forkedFrom 非对象", { forkedFrom: "x" }],
    ["forkedFrom.sessionId 非字符串", { forkedFrom: { sessionId: 1, seq: 0 } }],
    ["forkedFrom.sessionId 空串", { forkedFrom: { sessionId: "", seq: 0 } }],
    ["forkedFrom.sessionId 非法字符", { forkedFrom: { sessionId: "bad id", seq: 0 } }],
    ["forkedFrom.sessionId Windows 保留名", { forkedFrom: { sessionId: "CON", seq: 0 } }],
    ["forkedFrom.seq 为负", { forkedFrom: { sessionId: "s", seq: -1 } }],
    ["forkedFrom.seq 非整数", { forkedFrom: { sessionId: "s", seq: 1.5 } }],
  ])("header %s → invalid_header", (_name, patch) => {
    const dir = makeTempDir();
    writeHeader(dir, { ...defaultHeader(), ...patch } as unknown as SessionHeader);
    writeLines(dir, "session.v1.jsonl", [JSON.stringify(makeEvent(0))]);

    const error = captureCorruption(() => readSessionDir(dir));

    expect(error.code).toBe("invalid_header");
    expect(error.detail).toMatchObject({ file: "header.json" });
  });

  it("合法 forkedFrom 通过校验", () => {
    const dir = makeTempDir();
    writeHeader(dir, {
      ...defaultHeader(),
      forkedFrom: { sessionId: "source", seq: 0 },
    });
    writeLines(dir, "session.v1.jsonl", [JSON.stringify(makeEvent(0))]);

    expect(readSessionDir(dir).header.forkedFrom).toEqual({ sessionId: "source", seq: 0 });
  });

  it("坏行 → invalid_event_line 且 detail 含文件与行号", () => {
    const dir = makeTempDir();
    writeHeader(dir, defaultHeader());
    writeLines(dir, "session.v1.jsonl", [JSON.stringify(makeEvent(0)), "{oops}"]);

    const error = captureCorruption(() => readSessionDir(dir));

    expect(error.code).toBe("invalid_event_line");
    expect(error.detail).toMatchObject({ file: "session.v1.jsonl", line: 2 });
  });

  it("纯空白行 → invalid_event_line（readSessionDir 保持严格语义）", () => {
    const dir = makeTempDir();
    writeHeader(dir, defaultHeader());
    writeLines(dir, "session.v1.jsonl", ["   "]);

    expect(captureCorruption(() => readSessionDir(dir)).code).toBe("invalid_event_line");
  });

  it("JSON 合法但非对象 → invalid_event_line", () => {
    const dir = makeTempDir();
    writeHeader(dir, defaultHeader());
    writeLines(dir, "session.v1.jsonl", ["null"]);

    expect(captureCorruption(() => readSessionDir(dir)).code).toBe("invalid_event_line");
  });

  it.each([
    ["null", null],
    ["数组", []],
    ["字符串", "payload"],
    ["缺失", undefined],
  ])("payload 为 %s → invalid_event_line", (_name, payload) => {
    const dir = makeTempDir();
    writeHeader(dir, defaultHeader());
    const event: Record<string, unknown> = {
      seq: 0,
      ts: "2026-10-18T00:00:00.000Z",
      type: "user",
    };
    if (payload !== undefined) event.payload = payload;
    writeLines(dir, "session.v1.jsonl", [JSON.stringify(event)]);

    const error = captureCorruption(() => readSessionDir(dir));

    expect(error.code).toBe("invalid_event_line");
    expect(error.detail).toMatchObject({ file: "session.v1.jsonl", line: 1 });
  });

  it("seq 跳号 → invalid_seq", () => {
    const dir = makeTempDir();
    writeHeader(dir, defaultHeader());
    writeLines(dir, "session.v1.jsonl", [
      JSON.stringify(makeEvent(0)),
      JSON.stringify(makeEvent(2)),
    ]);

    const error = captureCorruption(() => readSessionDir(dir));

    expect(error.code).toBe("invalid_seq");
    expect(error.detail).toMatchObject({ file: "session.v1.jsonl", line: 2, expected: 1, actual: 2 });
  });

  it("跨代重复 seq → invalid_seq", () => {
    const dir = makeTempDir();
    writeHeader(dir, defaultHeader());
    writeLines(dir, "session.v1.jsonl", [JSON.stringify(makeEvent(0))]);
    writeLines(dir, "session.v2.jsonl", [JSON.stringify(makeEvent(0))]);

    const error = captureCorruption(() => readSessionDir(dir));

    expect(error.code).toBe("invalid_seq");
    expect(error.detail).toMatchObject({ file: "session.v2.jsonl", line: 1, expected: 1, actual: 0 });
  });

  it("未知 type → unknown_event_type", () => {
    const dir = makeTempDir();
    writeHeader(dir, defaultHeader());
    writeLines(dir, "session.v1.jsonl", [JSON.stringify({ ...makeEvent(0), type: "bogus" })]);

    const error = captureCorruption(() => readSessionDir(dir));

    expect(error.code).toBe("unknown_event_type");
    expect(error.detail).toMatchObject({ file: "session.v1.jsonl", line: 1 });
  });

  it("空目录 → invalid_header（通用读取语义；resumeSession 另行判定 missing_session_dir）", () => {
    expect(captureCorruption(() => readSessionDir(makeTempDir())).code).toBe("invalid_header");
  });

  it("有 header 但无日志 → invalid_header", () => {
    const dir = makeTempDir();
    writeHeader(dir, defaultHeader());

    expect(captureCorruption(() => readSessionDir(dir)).code).toBe("invalid_header");
  });

  it("非规范代文件名不参与读取", () => {
    const dir = makeTempDir();
    writeHeader(dir, defaultHeader());
    writeLines(dir, "session.v01.jsonl", ["{oops}"]);
    writeLines(dir, "session.v0.jsonl", ["{oops}"]);
    writeLines(dir, "session.v1.jsonl", [JSON.stringify(makeEvent(0))]);

    const result = readSessionDir(dir);

    expect(result.events.map((event) => event.seq)).toEqual([0]);
    expect(result.logFiles).toEqual(["session.v1.jsonl"]);
  });
});

describe("permission_decision 事件", () => {
  it("写一条 permission_decision 事件后可读", async () => {
    const dir = makeTempDir();
    const session = await createSession(dir);
    const appended = await session.append({
      type: "permission_decision",
      payload: {
        callId: "c1",
        tool: "echo",
        action: "allow",
        effective: "allow",
        reason: "test:allow",
        preset: "read-only",
        source: "builtin",
        ruleIndex: 0,
        paramsDigest: "digest",
        paramsKeys: ["text"],
        paramsPreview: { text: "hi" },
        access: "read",
      },
    });
    await session.close();

    const result = readSessionDir(dir);

    expect(result.events).toEqual([appended]);
    expect(result.events[0]?.payload).toMatchObject({ callId: "c1", effective: "allow" });
  });

  it("旧日志不含 permission_decision 时读取正常", () => {
    const dir = makeTempDir();
    writeHeader(dir, defaultHeader());
    writeLines(dir, "session.v1.jsonl", [
      JSON.stringify(makeEvent(0, "user")),
      JSON.stringify(makeEvent(1, "usage")),
    ]);

    const result = readSessionDir(dir);

    expect(result.events.map((event) => event.type)).toEqual(["user", "usage"]);
    expect(result.events.some((event) => event.type === "permission_decision")).toBe(false);
  });
});

describe("approval_request 事件", () => {
  it("写入 approval_request 后可读,readSessionSnapshot 不抛 unknown_event_type", async () => {
    const dir = makeTempDir();
    const session = await createSession(dir);
    const appended = await session.append({
      type: "approval_request",
      payload: {
        requestId: "req-1",
        callId: "c1",
        tool: "shell",
        action: "ask",
        access: "write",
        reason: "test:ask",
        preset: "read-only",
        paramsDigest: "digest",
        paramsKeys: ["command"],
        paramsPreview: { command: "ls" },
        deadlineAt: "2026-10-20T00:01:00.000Z",
      },
    });
    await session.close();

    const result = readSessionDir(dir);
    expect(result.events).toEqual([appended]);

    const snapshot = await readSessionSnapshot(dir);
    expect(snapshot.events.map((event) => event.type)).toEqual(["approval_request"]);
  });

  it("resume 为崩溃遗留的未决审批补 deny 审计", async () => {
    const dir = makeTempDir();
    const session = await createSession(dir);
    await session.append({
      type: "assistant",
      payload: {
        content: "calling",
        toolCalls: [{ id: "call-1", name: "shell", arguments: { command: "ls" } }],
      },
    });
    await session.append({
      type: "approval_request",
      payload: {
        requestId: "req-1",
        callId: "call-1",
        tool: "shell",
        action: "ask",
        access: "write",
        reason: "test:ask",
        preset: "read-only",
        paramsDigest: "digest",
        paramsKeys: ["command"],
        deadlineAt: "2026-10-20T00:01:00.000Z",
      },
    });
    await session.close();

    const resumed = await resumeSession(dir);
    const events = resumed.events();
    const decision = events.find(
      (event) =>
        event.type === "permission_decision" &&
        event.payload.callId === "call-1" &&
        event.payload.effective === "deny" &&
        event.payload.reason === "approval_aborted: crash_recovery",
    );

    expect(decision).toBeDefined();
    expect(decision?.payload).toMatchObject({
      callId: "call-1",
      tool: "shell",
      action: "ask",
      effective: "deny",
      reason: "approval_aborted: crash_recovery",
      preset: "read-only",
      source: "builtin",
      paramsDigest: "digest",
      paramsKeys: ["command"],
    });
    expect(decision?.parent).toBeUndefined();
    expect(() => buildMessages(events)).not.toThrow();
    await resumed.close();
  });
});

describe("tool_started / mcp_status / device_status 事件", () => {
  it("写入三种新事件后可读且 seq 连续", async () => {
    const dir = makeTempDir();
    const session = await createSession(dir);
    await session.append({ type: "user", payload: { content: "u" } });
    await session.append({
      type: "tool_started",
      payload: { callId: "c1", tool: "fs", access: "read" },
    });
    await session.append({
      type: "mcp_status",
      payload: { kind: "connected", server: "probe", toolCount: 2 },
    });
    await session.append({
      type: "device_status",
      payload: {
        callId: "c1",
        server: "probe",
        tool: "mcp__probe__attach",
        state: { probe: "attached" },
      },
    });
    await session.close();

    const result = readSessionDir(dir);

    expect(result.events.map((event) => event.type)).toEqual([
      "user",
      "tool_started",
      "mcp_status",
      "device_status",
    ]);
    expect(result.events.map((event) => event.seq)).toEqual([0, 1, 2, 3]);
    expect(result.events[1]?.payload).toMatchObject({ callId: "c1", tool: "fs", access: "read" });
    expect(result.events[2]?.payload).toMatchObject({ kind: "connected", toolCount: 2 });
    expect(result.events[3]?.payload).toMatchObject({ server: "probe", state: { probe: "attached" } });
  });

  it("旧日志不含新类型时读取正常", () => {
    const dir = makeTempDir();
    writeHeader(dir, defaultHeader());
    writeLines(dir, "session.v1.jsonl", [
      JSON.stringify(makeEvent(0, "user")),
      JSON.stringify(makeEvent(1, "status")),
    ]);

    const result = readSessionDir(dir);

    expect(result.events.map((event) => event.type)).toEqual(["user", "status"]);
  });

  it("未知事件类型仍抛 unknown_event_type", () => {
    const dir = makeTempDir();
    writeHeader(dir, defaultHeader());
    writeLines(dir, "session.v1.jsonl", [
      JSON.stringify({ ...makeEvent(0), type: "tool_finished" }),
    ]);

    expect(captureCorruption(() => readSessionDir(dir)).code).toBe("unknown_event_type");
  });
});

type Session = Awaited<ReturnType<typeof createSession>>;

async function makeSource(): Promise<{ dir: string; session: Session }> {
  const dir = path.join(makeTempDir(), "source");
  return { dir, session: await createSession(dir, { id: "source" }) };
}

async function appendBatch(session: Session, ids: string[]): Promise<number> {
  await session.append({ type: "user", payload: { content: "u" } });
  await session.append({ type: "checkpoint", payload: { turn: 1 } });
  const assistant = await session.append({
    type: "assistant",
    payload: {
      content: "a",
      toolCalls: ids.map((id) => ({ id, name: "echo", arguments: {} })),
    },
  });
  await session.append({ type: "usage", payload: { promptTokens: 1 } });
  return assistant.seq;
}

async function appendToolTurn(session: Session, ids: string[] = ["t"]): Promise<number> {
  const assistantSeq = await appendBatch(session, ids);
  let lastSeq = assistantSeq;
  for (const id of ids) {
    const result = await session.append({
      type: "tool_result",
      payload: { id, ok: true, text: "r" },
      parent: assistantSeq,
    });
    lastSeq = result.seq;
  }
  return lastSeq;
}

describe("forkSession", () => {
  it("在批次闭合的 tool_result 边界 fork 并保留前缀与 parent", async () => {
    const { dir, session } = await makeSource();
    const atSeq = await appendToolTurn(session, ["t1", "t2"]);
    const targetDir = path.join(makeTempDir(), "fork");

    const forked = await forkSession(dir, atSeq, { targetDir, id: "fork-1" });

    expect(forked.events().map((event) => event.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(forked.events().map((event) => event.type)).toEqual([
      "user",
      "checkpoint",
      "assistant",
      "usage",
      "tool_result",
      "tool_result",
    ]);
    expect(forked.events().map((event) => event.parent)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      2,
      2,
    ]);
    expect(forked.header).toMatchObject({
      id: "fork-1",
      status: "open",
      forkedFrom: { sessionId: "source", seq: atSeq },
    });
    expect(() => buildMessages(forked.events())).not.toThrow();
    const next = await forked.append({ type: "usage", payload: {} });
    expect(next.seq).toBe(6);
    expect(session.events()).toHaveLength(6);
  });

  it("批中 usage/部分 tool_result/越界/负数/未闭合批次 fork → not_turn_boundary 且不写文件", async () => {
    const { dir, session } = await makeSource();
    await appendBatch(session, ["t1", "t2"]);
    await session.append({
      type: "tool_result",
      payload: { id: "t1", ok: true, text: "r" },
      parent: 2,
    });

    for (const atSeq of [2, 3, 4, 6, -1, 1.5]) {
      const targetDir = path.join(makeTempDir(), `fork-${String(atSeq).replace(".", "_")}`);
      await expect(forkSession(dir, atSeq, { targetDir, id: "f" })).rejects.toMatchObject({
        code: "not_turn_boundary",
      });
      expect(existsSync(targetDir)).toBe(false);
    }
  });

  it("atSeq 等于或超过事件数 → not_turn_boundary 且不写文件", async () => {
    const { dir, session } = await makeSource();
    await session.append({ type: "user", payload: { content: "u" } });
    const eventCount = readSessionDir(dir).events.length;

    for (const atSeq of [eventCount, eventCount + 1]) {
      const targetDir = path.join(makeTempDir(), `fork-bound-${atSeq}`);
      await expect(forkSession(dir, atSeq, { targetDir, id: "f" })).rejects.toMatchObject({
        code: "not_turn_boundary",
      });
      expect(existsSync(targetDir)).toBe(false);
    }
  });

  it("user 前缀与无工具轮的 usage 前缀可投影 → 允许 fork", async () => {
    const { dir, session } = await makeSource();
    await session.append({ type: "user", payload: { content: "u" } });
    await session.append({ type: "checkpoint", payload: { turn: 1 } });
    await session.append({ type: "assistant", payload: { content: "a", toolCalls: [] } });
    await session.append({ type: "usage", payload: { promptTokens: 1 } });

    const userFork = await forkSession(dir, 0, {
      targetDir: path.join(makeTempDir(), "fork-user"),
      id: "fork-user",
    });
    const usageFork = await forkSession(dir, 3, {
      targetDir: path.join(makeTempDir(), "fork-usage"),
      id: "fork-usage",
    });

    expect(() => buildMessages(userFork.events())).not.toThrow();
    expect(() => buildMessages(usageFork.events())).not.toThrow();
    expect(usageFork.events().map((event) => event.type)).toEqual([
      "user",
      "checkpoint",
      "assistant",
      "usage",
    ]);
  });

  it("fork header.forkedFrom 正确且原会话不受影响", async () => {
    const { dir, session } = await makeSource();
    const atSeq = await appendToolTurn(session);
    const before = readSessionDir(dir).events;
    const targetDir = path.join(makeTempDir(), "fork");

    const forked = await forkSession(dir, atSeq, { targetDir, id: "fork-2" });
    await forked.append({ type: "user", payload: { content: "branch" } });

    expect(forked.header.forkedFrom).toEqual({ sessionId: "source", seq: atSeq });
    expect(readSessionDir(dir).events).toEqual(before);
    expect(session.events()).toHaveLength(before.length);
    expect(readSessionDir(targetDir).header.forkedFrom).toEqual({
      sessionId: "source",
      seq: atSeq,
    });
  });

  it("artifact 复制并重写路径", async () => {
    const { dir, session } = await makeSource();
    const sourceArtifacts = path.join(dir, "artifacts");
    mkdirSync(sourceArtifacts, { recursive: true });
    const artifactPath = path.join(sourceArtifacts, "result.txt");
    writeFileSync(artifactPath, "full output", "utf8");
    const assistantSeq = await appendBatch(session, ["t"]);
    await session.append({
      type: "tool_result",
      payload: { id: "t", ok: true, text: "short", artifactPath },
      parent: assistantSeq,
    });
    const targetDir = path.join(makeTempDir(), "fork");

    const forked = await forkSession(dir, assistantSeq + 2, { targetDir, id: "fork-art" });

    const copied = path.join(targetDir, "artifacts", "result.txt");
    expect(readFileSync(copied, "utf8")).toBe("full output");
    expect(forked.events()[4]?.payload.artifactPath).toBe(copied);
    expect(forked.events()[4]?.payload.detail).toBeUndefined();
    expect(session.events()[4]?.payload.artifactPath).toBe(artifactPath);
  });

  it("artifact 缺失 → 保留原路径并标记 artifactMissing", async () => {
    const { dir, session } = await makeSource();
    const missing = path.join(dir, "artifacts", "gone.txt");
    const assistantSeq = await appendBatch(session, ["t"]);
    await session.append({
      type: "tool_result",
      payload: {
        id: "t",
        ok: true,
        text: "x",
        artifactPath: missing,
        detail: { reason: "truncated" },
      },
      parent: assistantSeq,
    });
    const targetDir = path.join(makeTempDir(), "fork");

    const forked = await forkSession(dir, assistantSeq + 2, { targetDir, id: "fork-missing" });

    expect(forked.events()[4]?.payload.artifactPath).toBe(missing);
    expect(forked.events()[4]?.payload.detail).toEqual({
      reason: "truncated",
      artifactMissing: true,
    });
  });

  it("artifact 缺失且 detail 非对象 → 保留原值并标记 artifactMissing", async () => {
    const { dir, session } = await makeSource();
    const missing = path.join(dir, "artifacts", "gone.txt");
    const assistantSeq = await appendBatch(session, ["t"]);
    await session.append({
      type: "tool_result",
      payload: { id: "t", ok: true, text: "x", artifactPath: missing, detail: "raw" },
      parent: assistantSeq,
    });
    const targetDir = path.join(makeTempDir(), "fork");

    const forked = await forkSession(dir, assistantSeq + 2, { targetDir, id: "fork-detail" });

    expect(forked.events()[4]?.payload.artifactPath).toBe(missing);
    expect(forked.events()[4]?.payload.detail).toEqual({
      originalDetail: "raw",
      artifactMissing: true,
    });
  });

  it("artifact 越界 → 标记 artifactRejected 而非 artifactMissing（D-042）", async () => {
    const { dir, session } = await makeSource();
    const outside = path.join(makeTempDir(), "outside.txt");
    writeFileSync(outside, "outside", "utf8");
    const assistantSeq = await appendBatch(session, ["t"]);
    await session.append({
      type: "tool_result",
      payload: { id: "t", ok: true, text: "x", artifactPath: outside },
      parent: assistantSeq,
    });
    const targetDir = path.join(makeTempDir(), "fork");

    const forked = await forkSession(dir, assistantSeq + 2, { targetDir, id: "fork-out" });

    expect(forked.events()[4]?.payload.artifactPath).toBe(outside);
    expect(forked.events()[4]?.payload.detail).toEqual({ artifactRejected: true });
  });

  it("artifact 为目录 → 按不支持标记并跳过复制，fork 成功（D-042）", async () => {
    const { dir, session } = await makeSource();
    const dirArtifact = path.join(dir, "artifacts", "bundle");
    mkdirSync(dirArtifact, { recursive: true });
    const assistantSeq = await appendBatch(session, ["t"]);
    await session.append({
      type: "tool_result",
      payload: { id: "t", ok: true, text: "x", artifactPath: dirArtifact },
      parent: assistantSeq,
    });
    const targetDir = path.join(makeTempDir(), "fork");

    const forked = await forkSession(dir, assistantSeq + 2, { targetDir, id: "fork-dir-art" });

    expect(forked.events()[4]?.payload.artifactPath).toBe(dirArtifact);
    expect(forked.events()[4]?.payload.detail).toEqual({ artifactRejected: true });
    expect(existsSync(path.join(targetDir, "artifacts", "bundle"))).toBe(false);
  });

  it("targetDir 非空 → target_not_empty 且不改动目标", async () => {
    const { dir, session } = await makeSource();
    await session.append({ type: "user", payload: { content: "u" } });
    const targetDir = makeTempDir();
    writeFileSync(path.join(targetDir, "keep.txt"), "keep", "utf8");

    await expect(forkSession(dir, 0, { targetDir, id: "fork" })).rejects.toMatchObject({
      code: "target_not_empty",
    });

    expect(readFileSync(path.join(targetDir, "keep.txt"), "utf8")).toBe("keep");
    expect(existsSync(path.join(targetDir, "header.json"))).toBe(false);
  });

  it("targetDir 已存在但为空 → target_not_empty 且不改动目录", async () => {
    const { dir, session } = await makeSource();
    await session.append({ type: "user", payload: { content: "u" } });
    const emptyTarget = path.join(makeTempDir(), "empty-target");
    mkdirSync(emptyTarget);

    await expect(forkSession(dir, 0, { targetDir: emptyTarget, id: "fork" })).rejects.toMatchObject({
      code: "target_not_empty",
    });

    expect(readdirSync(emptyTarget)).toEqual([]);
  });

  it("targetDir 父路径为文件 → invalid_target 且不改动文件", async () => {
    const { dir, session } = await makeSource();
    await session.append({ type: "user", payload: { content: "u" } });
    const parentFile = path.join(makeTempDir(), "parent-file");
    writeFileSync(parentFile, "keep", "utf8");
    const targetDir = path.join(parentFile, "child");

    await expect(forkSession(dir, 0, { targetDir, id: "fork" })).rejects.toMatchObject({
      code: "invalid_target",
    });

    expect(readFileSync(parentFile, "utf8")).toBe("keep");
  });

  it("非法或 Windows 保留 id → invalid_target 且不写文件", async () => {
    const { dir, session } = await makeSource();
    await session.append({ type: "user", payload: { content: "u" } });

    for (const id of ["bad id", "CON", "", "a".repeat(129)]) {
      const targetDir = path.join(makeTempDir(), "fork");
      await expect(forkSession(dir, 0, { targetDir, id })).rejects.toMatchObject({
        code: "invalid_target",
      });
      expect(existsSync(targetDir)).toBe(false);
    }
  });

  it("opts.id 与源会话 id 相同 → invalid_target 且不写文件", async () => {
    const { dir, session } = await makeSource();
    await session.append({ type: "user", payload: { content: "u" } });
    const targetDir = path.join(makeTempDir(), "fork");

    await expect(forkSession(dir, 0, { targetDir, id: "source" })).rejects.toMatchObject({
      code: "invalid_target",
    });
    expect(existsSync(targetDir)).toBe(false);
  });

  it("targetDir 位于 sourceDir 内 → invalid_target 且不写文件", async () => {
    const { dir, session } = await makeSource();
    await session.append({ type: "user", payload: { content: "u" } });
    const targetDir = path.join(dir, "nested", "fork");

    await expect(forkSession(dir, 0, { targetDir, id: "fork" })).rejects.toMatchObject({
      code: "invalid_target",
    });
    expect(existsSync(targetDir)).toBe(false);
  });

  it.skipIf(!symlinkSupported)("targetDir 经符号链接落在源目录内 → invalid_target 且不写文件", async () => {
    const { dir, session } = await makeSource();
    await session.append({ type: "user", payload: { content: "u" } });
    const inner = path.join(dir, "inner");
    mkdirSync(inner);
    const alias = path.join(makeTempDir(), "alias");
    symlinkSync(inner, alias, process.platform === "win32" ? "junction" : "dir");
    const targetDir = path.join(alias, "fork");

    await expect(forkSession(dir, 0, { targetDir, id: "fork" })).rejects.toMatchObject({
      code: "invalid_target",
    });
    expect(existsSync(targetDir)).toBe(false);
  });

  it.skipIf(!symlinkSupported)("fork 源目录为符号链接 → invalid_target 且不写目标", async () => {
    const { dir, session } = await makeSource();
    await session.append({ type: "user", payload: { content: "u" } });
    const link = path.join(makeTempDir(), "source-link");
    symlinkSync(dir, link, process.platform === "win32" ? "junction" : "dir");
    const targetDir = path.join(makeTempDir(), "fork");

    await expect(forkSession(link, 0, { targetDir, id: "fork" })).rejects.toMatchObject({
      code: "invalid_target",
    });
    expect(existsSync(targetDir)).toBe(false);
  });

  it("targetDir 与 sourceDir 相同 → invalid_target", async () => {
    const { dir, session } = await makeSource();
    await session.append({ type: "user", payload: { content: "u" } });

    await expect(forkSession(dir, 0, { targetDir: dir, id: "fork" })).rejects.toMatchObject({
      code: "invalid_target",
    });
  });

  it("targetDir 缺省为 $HARNESS_HOME/sessions/<id>", async () => {
    const home = makeTempDir();
    const previous = process.env.HARNESS_HOME;
    process.env.HARNESS_HOME = home;
    try {
      const { dir, session } = await makeSource();
      await session.append({ type: "user", payload: { content: "u" } });

      const forked = await forkSession(dir, 0, { id: "fork-default" });

      const expected = path.resolve(path.join(home, "sessions", "fork-default"));
      expect(forked.dir).toBe(expected);
      expect(existsSync(path.join(expected, "header.json"))).toBe(true);
      expect(existsSync(path.join(expected, "session.v1.jsonl"))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.HARNESS_HOME;
      else process.env.HARNESS_HOME = previous;
    }
  });

  it("前缀事件深冻结且修改返回值不影响内部", async () => {
    const { dir, session } = await makeSource();
    await session.append({ type: "user", payload: { content: "a", nested: { x: 1 } } });
    await session.append({ type: "usage", payload: { promptTokens: 1 } });
    const targetDir = path.join(makeTempDir(), "fork");

    const forked = await forkSession(dir, 1, { targetDir, id: "fork-freeze" });
    const events = forked.events();
    const first = events[0];

    expect(Object.isFrozen(events)).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first?.payload)).toBe(true);
    expect(Object.isFrozen(first?.payload.nested)).toBe(true);
    expect(Reflect.set(first as object, "seq", 99)).toBe(false);
    expect(Reflect.set(first?.payload as object, "content", "hacked")).toBe(false);
    expect(forked.events()[0]?.seq).toBe(0);
    expect(forked.events()[0]?.payload.content).toBe("a");
    expect(readSessionDir(targetDir).events).toEqual(forked.events());
  });

  it("artifact 相对路径在源目录内 → 复制并重写", async () => {
    const { dir, session } = await makeSource();
    mkdirSync(path.join(dir, "artifacts"), { recursive: true });
    writeFileSync(path.join(dir, "artifacts", "rel.txt"), "relative", "utf8");
    const assistantSeq = await appendBatch(session, ["t"]);
    await session.append({
      type: "tool_result",
      payload: {
        id: "t",
        ok: true,
        text: "x",
        artifactPath: path.join("artifacts", "rel.txt"),
      },
      parent: assistantSeq,
    });
    const targetDir = path.join(makeTempDir(), "fork");

    const forked = await forkSession(dir, assistantSeq + 2, { targetDir, id: "fork-rel" });

    const copied = path.join(targetDir, "artifacts", "rel.txt");
    expect(readFileSync(copied, "utf8")).toBe("relative");
    expect(forked.events()[4]?.payload.artifactPath).toBe(copied);
  });

  it("artifact 路径越界 → 不复制并按越界拒绝标记", async () => {
    const root = makeTempDir();
    const dir = path.join(root, "source");
    const session = await createSession(dir, { id: "source" });
    const outsideRelative = path.join(root, "outside.txt");
    const outsideAbsolute = path.join(root, "absolute.txt");
    writeFileSync(outsideRelative, "outside", "utf8");
    writeFileSync(outsideAbsolute, "outside", "utf8");
    const assistantSeq = await appendBatch(session, ["t1", "t2"]);
    await session.append({
      type: "tool_result",
      payload: { id: "t1", ok: true, text: "x", artifactPath: "../outside.txt" },
      parent: assistantSeq,
    });
    await session.append({
      type: "tool_result",
      payload: { id: "t2", ok: true, text: "x", artifactPath: outsideAbsolute },
      parent: assistantSeq,
    });
    const targetDir = path.join(makeTempDir(), "fork");

    const forked = await forkSession(dir, assistantSeq + 3, { targetDir, id: "fork-outside" });

    expect(forked.events()[4]?.payload.artifactPath).toBe("../outside.txt");
    expect(forked.events()[4]?.payload.detail).toMatchObject({ artifactRejected: true });
    expect(forked.events()[5]?.payload.artifactPath).toBe(outsideAbsolute);
    expect(forked.events()[5]?.payload.detail).toMatchObject({ artifactRejected: true });
    expect(existsSync(path.join(targetDir, "artifacts"))).toBe(false);
  });

  it.skipIf(!symlinkSupported)("artifact 符号链接指向源目录外 → 不复制并按越界拒绝标记", async () => {
    const { dir, session } = await makeSource();
    mkdirSync(path.join(dir, "artifacts"), { recursive: true });
    const outside = path.join(makeTempDir(), "outside.txt");
    writeFileSync(outside, "outside", "utf8");
    const link = path.join(dir, "artifacts", "link.txt");
    symlinkSync(outside, link, "file");
    const assistantSeq = await appendBatch(session, ["t"]);
    await session.append({
      type: "tool_result",
      payload: { id: "t", ok: true, text: "x", artifactPath: link },
      parent: assistantSeq,
    });
    const targetDir = path.join(makeTempDir(), "fork");

    const forked = await forkSession(dir, assistantSeq + 2, { targetDir, id: "fork-link" });

    expect(forked.events()[4]?.payload.artifactPath).toBe(link);
    expect(forked.events()[4]?.payload.detail).toMatchObject({ artifactRejected: true });
    expect(existsSync(path.join(targetDir, "artifacts"))).toBe(false);
  });

  it("同名 artifact 复制为 -1 后缀且不覆盖", async () => {
    const { dir, session } = await makeSource();
    mkdirSync(path.join(dir, "artifacts", "sub"), { recursive: true });
    const first = path.join(dir, "artifacts", "same.txt");
    const second = path.join(dir, "artifacts", "sub", "same.txt");
    writeFileSync(first, "first", "utf8");
    writeFileSync(second, "second", "utf8");
    const assistantSeq = await appendBatch(session, ["t1", "t2"]);
    await session.append({
      type: "tool_result",
      payload: { id: "t1", ok: true, text: "x", artifactPath: first },
      parent: assistantSeq,
    });
    await session.append({
      type: "tool_result",
      payload: { id: "t2", ok: true, text: "x", artifactPath: second },
      parent: assistantSeq,
    });
    const targetDir = path.join(makeTempDir(), "fork");

    const forked = await forkSession(dir, assistantSeq + 3, { targetDir, id: "fork-same" });

    const artifacts = path.join(targetDir, "artifacts");
    expect(readFileSync(path.join(artifacts, "same.txt"), "utf8")).toBe("first");
    expect(readFileSync(path.join(artifacts, "same-1.txt"), "utf8")).toBe("second");
    expect(forked.events().map((event) => event.payload.artifactPath)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      path.join(artifacts, "same.txt"),
      path.join(artifacts, "same-1.txt"),
    ]);
  });

  it("header 写失败 → 回滚新建 targetDir 并抛原错误", async () => {
    const { dir, session } = await makeSource();
    await session.append({ type: "user", payload: { content: "u" } });
    const targetDir = path.join(makeTempDir(), "fork");
    // rename 失败是 header 原子写里唯一能稳定注入的故障点;writeFile 的包装
    // 也会命中 fork 自身的日志写入,无法区分 header 与日志。
    fsFaults.rename = new Error("rename boom");

    await expect(forkSession(dir, 0, { targetDir, id: "fork" })).rejects.toThrow("rename boom");
    expect(existsSync(targetDir)).toBe(false);
  });

  it("日志写失败 → 回滚已写 header 并抛原错误", async () => {
    const { dir, session } = await makeSource();
    await session.append({ type: "user", payload: { content: "u" } });
    const targetDir = path.join(makeTempDir(), "fork");
    fsFaults.writeFile = (file) => file.endsWith("session.v1.jsonl");

    await expect(forkSession(dir, 0, { targetDir, id: "fork" })).rejects.toThrow("write boom");
    expect(existsSync(targetDir)).toBe(false);
  });

  it("artifact 复制失败 → 回滚新建 targetDir 并抛原错误", async () => {
    const { dir, session } = await makeSource();
    mkdirSync(path.join(dir, "artifacts"), { recursive: true });
    const artifactPath = path.join(dir, "artifacts", "result.txt");
    writeFileSync(artifactPath, "full", "utf8");
    const assistantSeq = await appendBatch(session, ["t"]);
    await session.append({
      type: "tool_result",
      payload: { id: "t", ok: true, text: "r", artifactPath },
      parent: assistantSeq,
    });
    const targetDir = path.join(makeTempDir(), "fork");
    fsFaults.copyFile = new Error("copy boom");

    await expect(forkSession(dir, assistantSeq + 2, { targetDir, id: "fork" })).rejects.toThrow(
      "copy boom",
    );
    expect(existsSync(targetDir)).toBe(false);
  });

  it("并发 fork 同一 targetDir：一个成功、一个 target_not_empty", async () => {
    const { dir, session } = await makeSource();
    await session.append({ type: "user", payload: { content: "u" } });
    const targetDir = path.join(makeTempDir(), "fork");

    const results = await Promise.allSettled([
      forkSession(dir, 0, { targetDir, id: "fork-a" }),
      forkSession(dir, 0, { targetDir, id: "fork-b" }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ code: "target_not_empty" });
    const target = readSessionDir(targetDir);
    expect(target.events.map((event) => event.seq)).toEqual([0]);
  });

  it("两个 fork handle 并发 append 到不同目录互不影响", async () => {
    const { dir, session } = await makeSource();
    await session.append({ type: "user", payload: { content: "u" } });
    const targetA = path.join(makeTempDir(), "fork-a");
    const targetB = path.join(makeTempDir(), "fork-b");
    const forkA = await forkSession(dir, 0, { targetDir: targetA, id: "fork-a" });
    const forkB = await forkSession(dir, 0, { targetDir: targetB, id: "fork-b" });

    const [a1, b1] = await Promise.all([
      forkA.append({ type: "user", payload: { content: "a1" } }),
      forkB.append({ type: "usage", payload: { promptTokens: 1 } }),
    ]);
    const [a2, b2] = await Promise.all([
      forkA.append({ type: "user", payload: { content: "a2" } }),
      forkB.append({ type: "usage", payload: { promptTokens: 2 } }),
    ]);

    expect([a1.seq, a2.seq]).toEqual([1, 2]);
    expect([b1.seq, b2.seq]).toEqual([1, 2]);
    expect(forkA.events()).toHaveLength(3);
    expect(forkB.events()).toHaveLength(3);
    expect(readSessionDir(targetA).events.map((event) => event.payload.content)).toEqual([
      "u",
      "a1",
      "a2",
    ]);
    expect(readSessionDir(targetB).events.map((event) => event.payload.promptTokens)).toEqual([
      undefined,
      1,
      2,
    ]);
    expect(session.events()).toHaveLength(1);
  });

  it("targetDir 为文件 → invalid_target 且不改动文件", async () => {
    const { dir, session } = await makeSource();
    await session.append({ type: "user", payload: { content: "u" } });
    const targetFile = path.join(makeTempDir(), "target-file");
    writeFileSync(targetFile, "keep", "utf8");

    await expect(forkSession(dir, 0, { targetDir: targetFile, id: "fork" })).rejects.toMatchObject({
      code: "invalid_target",
    });

    expect(readFileSync(targetFile, "utf8")).toBe("keep");
  });

  it("随机 id 合法且落在默认会话目录", async () => {
    const home = makeTempDir();
    const previous = process.env.HARNESS_HOME;
    process.env.HARNESS_HOME = home;
    try {
      const { dir, session } = await makeSource();
      await session.append({ type: "user", payload: { content: "u" } });

      const forked = await forkSession(dir, 0);

      expect(forked.id).toMatch(/^[a-zA-Z0-9_-]{1,128}$/);
      expect(forked.dir).toBe(path.resolve(path.join(home, "sessions", forked.id)));
      expect(forked.header.forkedFrom).toEqual({ sessionId: "source", seq: 0 });
    } finally {
      if (previous === undefined) delete process.env.HARNESS_HOME;
      else process.env.HARNESS_HOME = previous;
    }
  });

  it("空 targetDir 按缺省处理", async () => {
    const home = makeTempDir();
    const previous = process.env.HARNESS_HOME;
    process.env.HARNESS_HOME = home;
    try {
      const { dir, session } = await makeSource();
      await session.append({ type: "user", payload: { content: "u" } });

      const forked = await forkSession(dir, 0, { targetDir: "", id: "empty-target" });

      expect(forked.dir).toBe(path.resolve(path.join(home, "sessions", "empty-target")));
    } finally {
      if (previous === undefined) delete process.env.HARNESS_HOME;
      else process.env.HARNESS_HOME = previous;
    }
  });

  it("fork 后 close 原子更新 header", async () => {
    const { dir, session } = await makeSource();
    await session.append({ type: "user", payload: { content: "u" } });
    const targetDir = path.join(makeTempDir(), "fork");
    const forked = await forkSession(dir, 0, { targetDir, id: "fork-close" });

    await forked.close();

    expect(forked.header.status).toBe("closed");
    expect(readSessionDir(targetDir).header.status).toBe("closed");
  });
});