import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionCorruptionError } from "../src/session/errors.js";
import { readSessionDir } from "../src/session/persistence.js";
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
    expect(error.detail).toMatchObject({ file: path.join(dir, "header.json") });
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

  it("空目录 → invalid_header", () => {
    expect(captureCorruption(() => readSessionDir(makeTempDir())).code).toBe("invalid_header");
  });

  it("有 header 但无日志 → invalid_header", () => {
    const dir = makeTempDir();
    writeHeader(dir, defaultHeader());

    expect(captureCorruption(() => readSessionDir(dir)).code).toBe("invalid_header");
  });
});