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
