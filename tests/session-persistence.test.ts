import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionCorruptionError } from "../src/session/errors.js";
import { forkSession, readSessionDir } from "../src/session/persistence.js";
import { createSession } from "../src/session/session.js";
import type { EventType, SessionEvent, SessionHeader } from "../src/session/types.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "session-persistence-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
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
    writeLines(dir, "session.v10.jsonl", [JSON.stringify(makeEvent(2))]);
    writeLines(dir, "session.v2.jsonl", [JSON.stringify(makeEvent(1))]);
    writeLines(dir, "session.v1.jsonl", ["", JSON.stringify(makeEvent(0)), ""]);

    const result = readSessionDir(dir);

    expect(result.events.map((event) => event.seq)).toEqual([0, 1, 2]);
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

  it("坏行 → invalid_event_line 且 detail 含文件与行号", () => {
    const dir = makeTempDir();
    writeHeader(dir, defaultHeader());
    writeLines(dir, "session.v1.jsonl", [JSON.stringify(makeEvent(0)), "{oops}"]);

    const error = captureCorruption(() => readSessionDir(dir));

    expect(error.code).toBe("invalid_event_line");
    expect(error.detail).toMatchObject({ file: "session.v1.jsonl", line: 2 });
  });

  it("JSON 合法但非对象 → invalid_event_line", () => {
    const dir = makeTempDir();
    writeHeader(dir, defaultHeader());
    writeLines(dir, "session.v1.jsonl", ["null"]);

    expect(captureCorruption(() => readSessionDir(dir)).code).toBe("invalid_event_line");
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
    writeLines(dir, "session.v2.jsonl", [JSON.stringify(makeEvent(0))]);

    const result = readSessionDir(dir);

    expect(result.events.map((event) => event.seq)).toEqual([0]);
  });
});
async function makeSource(): Promise<{ dir: string; session: Awaited<ReturnType<typeof createSession>> }> {
  const dir = path.join(makeTempDir(), "source");
  return { dir, session: await createSession(dir, { id: "source" }) };
}

describe("forkSession", () => {
  it("在 tool_result 边界 fork 并保留前缀与 parent", async () => {
    const { dir, session } = await makeSource();
    await session.append({ type: "user", payload: { content: "u" } });
    await session.append({ type: "assistant", payload: { content: "a" }, parent: 0 });
    await session.append({ type: "tool_result", payload: { id: "t", ok: true, text: "r" }, parent: 1 });
    await session.append({ type: "usage", payload: { promptTokens: 1 }, parent: 2 });
    const targetDir = path.join(makeTempDir(), "fork");

    const forked = await forkSession(dir, 2, { targetDir, id: "fork-1" });

    expect(forked.events().map((event) => event.seq)).toEqual([0, 1, 2]);
    expect(forked.events().map((event) => event.type)).toEqual(["user", "assistant", "tool_result"]);
    expect(forked.events().map((event) => event.parent)).toEqual([undefined, 0, 1]);
    expect(forked.header).toMatchObject({
      id: "fork-1",
      status: "open",
      forkedFrom: { sessionId: "source", seq: 2 },
    });
    const next = await forked.append({ type: "usage", payload: {} });
    expect(next.seq).toBe(3);
    expect(session.events()).toHaveLength(4);
  });

  it("在 assistant/user/越界/负数 fork → not_turn_boundary 且不写文件", async () => {
    const { dir, session } = await makeSource();
    await session.append({ type: "user", payload: {} });
    await session.append({ type: "assistant", payload: {} });
    await session.append({ type: "tool_result", payload: {} });

    for (const atSeq of [0, 1, 3, -1, 1.5]) {
      const targetDir = path.join(makeTempDir(), `fork-${String(atSeq).replace(".", "_")}`);
      await expect(forkSession(dir, atSeq, { targetDir, id: "f" })).rejects.toMatchObject({
        code: "not_turn_boundary",
      });
      expect(existsSync(targetDir)).toBe(false);
    }
  });

  it("fork header.forkedFrom 正确且原会话不受影响", async () => {
    const { dir, session } = await makeSource();
    await session.append({ type: "user", payload: { content: "u" } });
    await session.append({ type: "assistant", payload: { content: "a" } });
    await session.append({ type: "tool_result", payload: { id: "t", ok: true, text: "r" } });
    const before = readSessionDir(dir).events;
    const targetDir = path.join(makeTempDir(), "fork");

    const forked = await forkSession(dir, 2, { targetDir, id: "fork-2" });
    await forked.append({ type: "user", payload: { content: "branch" } });

    expect(forked.header.forkedFrom).toEqual({ sessionId: "source", seq: 2 });
    expect(readSessionDir(dir).events).toEqual(before);
    expect(session.events()).toHaveLength(before.length);
    expect(readSessionDir(targetDir).header.forkedFrom).toEqual({
      sessionId: "source",
      seq: 2,
    });
  });

  it("artifact 复制并重写路径", async () => {
    const { dir, session } = await makeSource();
    const sourceArtifacts = path.join(dir, "artifacts");
    mkdirSync(sourceArtifacts, { recursive: true });
    const artifactPath = path.join(sourceArtifacts, "result.txt");
    writeFileSync(artifactPath, "full output", "utf8");
    await session.append({
      type: "tool_result",
      payload: { id: "t", ok: true, text: "short", artifactPath },
    });
    const targetDir = path.join(makeTempDir(), "fork");

    const forked = await forkSession(dir, 0, { targetDir, id: "fork-art" });

    const copied = path.join(targetDir, "artifacts", "result.txt");
    expect(readFileSync(copied, "utf8")).toBe("full output");
    expect(forked.events()[0]?.payload.artifactPath).toBe(copied);
    expect(forked.events()[0]?.payload.detail).toBeUndefined();
    expect(session.events()[0]?.payload.artifactPath).toBe(artifactPath);
  });

  it("artifact 缺失 → 保留原路径并标记 artifactMissing", async () => {
    const { dir, session } = await makeSource();
    const missing = path.join(dir, "artifacts", "gone.txt");
    await session.append({
      type: "tool_result",
      payload: {
        id: "t",
        ok: true,
        text: "x",
        artifactPath: missing,
        detail: { reason: "truncated" },
      },
    });
    const targetDir = path.join(makeTempDir(), "fork");

    const forked = await forkSession(dir, 0, { targetDir, id: "fork-missing" });

    expect(forked.events()[0]?.payload.artifactPath).toBe(missing);
    expect(forked.events()[0]?.payload.detail).toEqual({
      reason: "truncated",
      artifactMissing: true,
    });
  });

  it("artifact 缺失且 detail 非对象 → 新建 detail 对象", async () => {
    const { dir, session } = await makeSource();
    const missing = path.join(dir, "artifacts", "gone.txt");
    await session.append({
      type: "tool_result",
      payload: { id: "t", ok: true, text: "x", artifactPath: missing, detail: "raw" },
    });
    const targetDir = path.join(makeTempDir(), "fork");

    const forked = await forkSession(dir, 0, { targetDir, id: "fork-detail" });

    expect(forked.events()[0]?.payload.artifactPath).toBe(missing);
    expect(forked.events()[0]?.payload.detail).toEqual({ artifactMissing: true });
  });

  it("targetDir 非空 → target_not_empty 且不改动目标", async () => {
    const { dir, session } = await makeSource();
    await session.append({ type: "tool_result", payload: { id: "t", ok: true, text: "r" } });
    const targetDir = makeTempDir();
    writeFileSync(path.join(targetDir, "keep.txt"), "keep", "utf8");

    await expect(forkSession(dir, 0, { targetDir, id: "fork" })).rejects.toMatchObject({
      code: "target_not_empty",
    });

    expect(readFileSync(path.join(targetDir, "keep.txt"), "utf8")).toBe("keep");
    expect(existsSync(path.join(targetDir, "header.json"))).toBe(false);
  });

  it("非法或 Windows 保留 id → invalid_target 且不写文件", async () => {
    const { dir, session } = await makeSource();
    await session.append({ type: "tool_result", payload: { id: "t", ok: true, text: "r" } });

    for (const id of ["bad id", "CON", "", "a".repeat(129)]) {
      const targetDir = path.join(makeTempDir(), "fork");
      await expect(forkSession(dir, 0, { targetDir, id })).rejects.toMatchObject({
        code: "invalid_target",
      });
      expect(existsSync(targetDir)).toBe(false);
    }
  });

  it("targetDir 缺省为 $HARNESS_HOME/sessions/<id>", async () => {
    const home = makeTempDir();
    const previous = process.env.HARNESS_HOME;
    process.env.HARNESS_HOME = home;
    try {
      const { dir, session } = await makeSource();
      await session.append({ type: "usage", payload: {} });

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
});
