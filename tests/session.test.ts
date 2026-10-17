import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSession, readSessionFile } from "../src/session/session.js";

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
});
