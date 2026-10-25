import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAssistantDeltaWriter } from "../src/loop/assistant-delta.js";
import { createSession } from "../src/session/session.js";
import type { SessionHandle } from "../src/session/session.js";

const tempDirs: string[] = [];
const sessions: SessionHandle[] = [];

async function makeSession(): Promise<SessionHandle> {
  const dir = await mkdtemp(path.join(tmpdir(), "assistant-delta-"));
  tempDirs.push(dir);
  const session = await createSession(dir);
  sessions.push(session);
  return session;
}

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await session.close().catch(() => undefined);
  }
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("createAssistantDeltaWriter", () => {
  it("缓冲的文本在 flush 后落成 assistant_delta 事件", async () => {
    const session = await makeSession();
    const writer = createAssistantDeltaWriter({ session, maxChars: 1000, maxDelayMs: 10_000 });

    writer.push("你");
    writer.push("好");
    await writer.flush();

    const deltas = session.events().filter((event) => event.type === "assistant_delta");
    expect(deltas.map((event) => event.payload.text)).toEqual(["你好"]);
  });

  it("超过 maxChars 时立刻落盘，不等 flush", async () => {
    const session = await makeSession();
    const writer = createAssistantDeltaWriter({ session, maxChars: 4, maxDelayMs: 10_000 });
    const deltas = () => session.events().filter((event) => event.type === "assistant_delta");

    writer.push("12345");
    // 不 flush：缓冲已超限，落盘应当已经发生。
    //
    // 原来的写法是「睡 10ms 然后断言至少一条」。`session.append` 是带 fsync 的
    // 真实写盘，实测首次落盘在不同机器/负载下要 18–25ms（本机连测 5 次：
    // 10ms 时一律 0 条，18.0 / 18.4 / 19.5 / 24.8 / 25.5ms 才可见），所以那条
    // 断言测的其实是磁盘延迟，不是「超限不等 flush」这个行为。改成轮询到状态
    // 出现为止：仍然不 flush，仍然证明「不靠定时器/显式 flush 就会落盘」，
    // 但不再把机器的 IO 速度写进判据。
    await vi.waitFor(
      () => {
        expect(deltas().length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 2000, interval: 5 },
    );
    expect(deltas().map((event) => event.payload.text).join("")).toBe("12345");
  });

  it("空的 push 不产生事件", async () => {
    const session = await makeSession();
    const writer = createAssistantDeltaWriter({ session, maxDelayMs: 10_000 });

    writer.push("");
    await writer.flush();

    expect(session.events().some((event) => event.type === "assistant_delta")).toBe(false);
  });

  it("写失败被吞掉并计入 dropped，不抛出", async () => {
    const session = await makeSession();
    await session.close();
    const errors: unknown[] = [];
    const writer = createAssistantDeltaWriter({
      session,
      maxDelayMs: 10_000,
      onError: (error) => errors.push(error),
    });

    writer.push("丢失");
    await writer.flush();

    expect(errors.length).toBeGreaterThanOrEqual(1);
    // dropped 按字符计，不是按字节。
    expect(writer.dropped).toBe(2);
  });

  it("flush 之后没有残留缓冲", async () => {
    const session = await makeSession();
    const writer = createAssistantDeltaWriter({ session, maxDelayMs: 10_000 });

    writer.push("a");
    await writer.flush();
    await writer.flush();

    const deltas = session.events().filter((event) => event.type === "assistant_delta");
    expect(deltas).toHaveLength(1);
  });
});

describe("createAssistantDeltaWriter 的思考通道", () => {
  const deltasOf = (session: SessionHandle) =>
    session.events().filter(
      (event) => event.type === "assistant_delta" || event.type === "thinking_delta",
    );

  it("pushThinking 落成 thinking_delta，与正文共用一套批量参数", async () => {
    const session = await makeSession();
    const writer = createAssistantDeltaWriter({ session, maxChars: 1000, maxDelayMs: 10_000 });

    writer.pushThinking("先看");
    writer.pushThinking("串口");
    await writer.flush();

    const events = deltasOf(session);
    expect(events.map((event) => event.type)).toStrictEqual(["thinking_delta"]);
    expect(events[0]?.payload).toStrictEqual({ text: "先看串口" });
  });

  it("推理与正文按到达顺序交错，不因批量而重排", async () => {
    const session = await makeSession();
    const writer = createAssistantDeltaWriter({ session, maxChars: 1000, maxDelayMs: 10_000 });

    writer.pushThinking("想");
    writer.push("答");
    writer.pushThinking("再想");
    writer.push("再答");
    await writer.flush();

    // 这是最重要的一条：两个独立缓冲各带一个定时器时，正文可能先攒满
    // 400 字符而立刻落盘、推理还在等 60ms 的定时器，日志里就会变成
    // 「答在前、想在后」——转录的真实顺序就此丢失。
    expect(deltasOf(session).map((event) => [event.type, event.payload.text])).toStrictEqual([
      ["thinking_delta", "想"],
      ["assistant_delta", "答"],
      ["thinking_delta", "再想"],
      ["assistant_delta", "再答"],
    ]);
  });

  it("相邻的同通道片段合并成一条事件，跨通道不合并", async () => {
    const session = await makeSession();
    const writer = createAssistantDeltaWriter({ session, maxChars: 1000, maxDelayMs: 10_000 });

    writer.pushThinking("a");
    writer.pushThinking("b");
    writer.push("c");
    writer.push("d");
    writer.pushThinking("e");
    await writer.flush();

    const events = deltasOf(session);
    expect(events.map((event) => [event.type, event.payload.text])).toStrictEqual([
      ["thinking_delta", "ab"],
      ["assistant_delta", "cd"],
      ["thinking_delta", "e"],
    ]);
  });

  it("超限阈值按两个通道的字符合计计算", async () => {
    const session = await makeSession();
    const writer = createAssistantDeltaWriter({ session, maxChars: 4, maxDelayMs: 10_000 });

    writer.pushThinking("12");
    writer.push("34");
    // 合计已到 4 个字符，不等 flush 就应当落盘。轮询而不是睡固定时长：
    // 落盘是带 fsync 的真实写，耗时随机器变化（见上一条用例的注释）。
    await vi.waitFor(
      () => {
        expect(deltasOf(session).length).toBeGreaterThanOrEqual(1);
      },
      { timeout: 2000, interval: 5 },
    );
    await writer.flush();
    expect(deltasOf(session).map((event) => [event.type, event.payload.text])).toStrictEqual([
      ["thinking_delta", "12"],
      ["assistant_delta", "34"],
    ]);
  });

  it("pushThinking 的空串不产生事件", async () => {
    const session = await makeSession();
    const writer = createAssistantDeltaWriter({ session, maxDelayMs: 10_000 });

    writer.pushThinking("");
    await writer.flush();

    expect(deltasOf(session)).toStrictEqual([]);
  });

  it("思考写失败也计入 dropped，不影响正文落盘", async () => {
    const session = await makeSession();
    await session.close();
    const errors: unknown[] = [];
    const writer = createAssistantDeltaWriter({
      session,
      maxDelayMs: 10_000,
      onError: (error) => errors.push(error),
    });

    writer.pushThinking("思考");
    writer.push("正文");
    await writer.flush();

    // 两条都失败（会话已关闭），dropped 按字符合计。
    expect(errors.length).toBe(2);
    expect(writer.dropped).toBe(4);
  });
});
