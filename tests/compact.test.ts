import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ModelCfg } from "../src/config/providers.js";
import { buildMessages } from "../src/context/build.js";
import { compactSession, SUMMARY_PROMPT } from "../src/context/compact.js";
import type { CompactOptions } from "../src/context/compact.js";
import type { CompletionResult, ModelChatMessage, ModelProtocol } from "../src/model/protocol.js";
import { createSession } from "../src/session/session.js";
import type { SessionHandle } from "../src/session/session.js";

interface ModelCall {
  messages: ModelChatMessage[];
  tools: unknown[];
  maxOutputTokens: number;
  signal: AbortSignal;
}

function ok(content = "SUMMARY"): CompletionResult {
  return {
    content,
    toolCalls: [],
    truncatedByMaxTokens: false,
    usage: { promptTokens: 100, completionTokens: 10, cachedTokens: 5 },
    stopReason: "stop",
  };
}

function createFakeModel(
  respond: (call: ModelCall) => Promise<CompletionResult> = async () => ok(),
): { calls: ModelCall[]; model: ModelProtocol } {
  const calls: ModelCall[] = [];
  const model: ModelProtocol = {
    async complete(messages, tools, opts) {
      const call = {
        messages,
        tools,
        maxOutputTokens: opts.maxOutputTokens,
        signal: opts.signal,
      };
      calls.push(call);
      return respond(call);
    },
    countTokens(messages) {
      return messages.reduce(
        (total, message) => total + Math.ceil(message.content.length / 4),
        0,
      );
    },
  };
  return { calls, model };
}

function cfg(contextWindow: number, maxOutput = 4096): ModelCfg {
  return { contextWindow, maxOutput };
}

const tempDirs: string[] = [];

async function makeSession(): Promise<SessionHandle> {
  const dir = mkdtempSync(path.join(tmpdir(), "compact-"));
  tempDirs.push(dir);
  return createSession(dir);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function addUser(session: SessionHandle, content: string) {
  return session.append({ type: "user", payload: { content } });
}

interface BatchOptions {
  evidence?: boolean;
  artifactPath?: string;
}

async function addBatch(
  session: SessionHandle,
  id: string,
  text: string,
  opts: BatchOptions = {},
) {
  const assistant = await session.append({
    type: "assistant",
    payload: {
      content: "",
      toolCalls: [{ id, name: "echo", arguments: { id } }],
    },
  });
  const payload: Record<string, unknown> = { id, ok: true, text, toolName: "echo" };
  if (opts.evidence === true) payload.evidence = true;
  if (opts.artifactPath !== undefined) payload.artifactPath = opts.artifactPath;
  const result = await session.append({ type: "tool_result", payload, parent: assistant.seq });
  return { assistant, result };
}

function makeOptions(
  session: SessionHandle,
  model: ModelProtocol,
  modelCfg: ModelCfg,
  overrides: Partial<Omit<CompactOptions, "session" | "model" | "modelCfg">> = {},
): CompactOptions {
  return {
    session,
    model,
    modelCfg,
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe("compactSession", () => {
  it("未超阈值不追加事件", async () => {
    const session = await makeSession();
    await addUser(session, "hello");
    const { calls, model } = createFakeModel();
    const before = session.events().length;

    await compactSession(makeOptions(session, model, cfg(2000)));

    expect(session.events().length).toBe(before);
    expect(calls).toHaveLength(0);
  });

  it("二级 elide 非 evidence、非最近轮，并保留 artifact 引用", async () => {
    const session = await makeSession();
    await addUser(session, "start");
    const c1 = await addBatch(session, "c1", "ev", { evidence: true });
    const c2 = await addBatch(session, "c2", "a".repeat(1200));
    const c3 = await addBatch(session, "c3", "b".repeat(1200), {
      artifactPath: "/tmp/artifacts/a.txt",
    });
    const c4 = await addBatch(session, "c4", "c".repeat(1200));
    const c5 = await addBatch(session, "c5", "d".repeat(1200));
    const c6 = await addBatch(session, "c6", "e".repeat(1200));
    const { calls, model } = createFakeModel();

    await compactSession(makeOptions(session, model, cfg(2000), { softRatio: 0.5 }));

    const compactions = session.events().filter((event) => event.type === "compaction");
    expect(compactions).toHaveLength(1);
    expect(compactions[0].payload).toMatchObject({
      kind: "microcompact",
      elidedSeqs: [c2.result.seq, c3.result.seq, c4.result.seq],
    });
    expect(calls).toHaveLength(0);

    const toolMessages = buildMessages(session.events()).filter((message) => message.role === "tool");
    expect(toolMessages[0].content).toBe("ev");
    expect(c1.result.payload.evidence).toBe(true);
    expect(toolMessages[1].content).toContain("[tool result elided; echo:");
    expect(toolMessages[2].content).toContain("/tmp/artifacts/a.txt");
    expect(toolMessages[3].content).toContain("[tool result elided;");
    expect(toolMessages[4].content).toBe("d".repeat(1200));
    expect(toolMessages[5].content).toBe("e".repeat(1200));
  });

  it("二级后仍超时摘要，append usage 与 summary 并保留尾部", async () => {
    const session = await makeSession();
    const user = await addUser(session, "x".repeat(6000));
    await addBatch(session, "c1", "a".repeat(400));
    await addBatch(session, "c2", "b".repeat(400));
    await addBatch(session, "c3", "c".repeat(40));
    const { calls, model } = createFakeModel(async () => ok("SUMMARY_TEXT"));

    await compactSession(makeOptions(session, model, cfg(1000), { keepTailRatio: 0.16 }));

    expect(calls).toHaveLength(1);
    expect(calls[0].tools).toStrictEqual([]);
    expect(calls[0].maxOutputTokens).toBe(2048);
    expect(calls[0].messages[0]).toStrictEqual({ role: "system", content: SUMMARY_PROMPT });
    expect(calls[0].messages[1].role).toBe("user");
    expect(calls[0].messages[1].content.length).toBe(2400);

    const events = session.events();
    expect(events[events.length - 1].payload).toMatchObject({
      kind: "summary",
      summary: "SUMMARY_TEXT",
      coversUpToSeq: user.seq,
    });
    expect(events[events.length - 2]).toMatchObject({
      type: "usage",
      payload: { promptTokens: 100, completionTokens: 10, cachedTokens: 5 },
    });

    const messages = buildMessages(events);
    expect(messages[0]).toStrictEqual({
      role: "system",
      content: "[Conversation summary]\nSUMMARY_TEXT",
    });
    expect(messages.some((message) => message.role === "tool" && message.content === "c".repeat(40))).toBe(true);
  });

  it("摘要边界回退到 evidence 之前", async () => {
    const session = await makeSession();
    const user = await addUser(session, "start");
    const evidence = await addBatch(session, "e1", "E".repeat(4000), { evidence: true });
    await addBatch(session, "c2", "b".repeat(400));
    await addBatch(session, "c3", "c".repeat(400));
    await addBatch(session, "c4", "d".repeat(40));
    const { calls, model } = createFakeModel(async () => ok("SUMMARY_EVIDENCE"));

    await compactSession(makeOptions(session, model, cfg(1000)));

    const summaries = session.events().filter(
      (event) => event.type === "compaction" && event.payload.kind === "summary",
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0].payload.coversUpToSeq).toBe(user.seq);
    expect(summaries[0].payload.coversUpToSeq).toBeLessThan(evidence.result.seq);
    expect(calls).toHaveLength(1);
    expect(calls[0].messages[1].content).toBe("user: start");
    expect(
      buildMessages(session.events()).some(
        (message) => message.role === "tool" && message.content === "E".repeat(4000),
      ),
    ).toBe(true);
  });

  it("无可摘要内容时 append failed", async () => {
    const session = await makeSession();
    await addBatch(session, "e1", "E".repeat(4000), { evidence: true });
    await addBatch(session, "c2", "b".repeat(400));
    await addBatch(session, "c3", "c".repeat(40));
    const { calls, model } = createFakeModel();

    await compactSession(makeOptions(session, model, cfg(1000)));

    const events = session.events();
    expect(events[events.length - 1].type).toBe("compaction");
    expect(events[events.length - 1].payload).toMatchObject({
      kind: "failed",
      stage: "summary",
    });
    expect(calls).toHaveLength(0);
  });

  it("摘要失败 append failed 不抛出", async () => {
    const session = await makeSession();
    await addUser(session, "x".repeat(6000));
    await addBatch(session, "c1", "a".repeat(400));
    await addBatch(session, "c2", "b".repeat(400));
    await addBatch(session, "c3", "c".repeat(40));
    const { model } = createFakeModel(async () => {
      throw new Error("boom");
    });

    await expect(
      compactSession(makeOptions(session, model, cfg(1000))),
    ).resolves.toBeUndefined();

    const events = session.events();
    expect(events[events.length - 1].payload).toMatchObject({
      kind: "failed",
      stage: "summary",
      reason: "boom",
    });
  });

  it("取消传播不记录 failed", async () => {
    const session = await makeSession();
    await addUser(session, "x".repeat(6000));
    await addBatch(session, "c1", "a".repeat(400));
    await addBatch(session, "c2", "b".repeat(400));
    await addBatch(session, "c3", "c".repeat(40));
    const { model } = createFakeModel(async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    });

    await expect(
      compactSession(makeOptions(session, model, cfg(1000))),
    ).rejects.toThrow("aborted");

    expect(
      session
        .events()
        .some((event) => event.type === "compaction" && event.payload.kind === "failed"),
    ).toBe(false);
  });

  it("重复调用不重复 elide", async () => {
    const session = await makeSession();
    await addUser(session, "start");
    await addBatch(session, "c1", "ev", { evidence: true });
    await addBatch(session, "c2", "a".repeat(1200));
    await addBatch(session, "c3", "b".repeat(1200), { artifactPath: "/tmp/a" });
    await addBatch(session, "c4", "c".repeat(1200));
    await addBatch(session, "c5", "d".repeat(1200));
    await addBatch(session, "c6", "e".repeat(1200));
    const { model } = createFakeModel();
    const options = () => makeOptions(session, model, cfg(2000), { softRatio: 0.5 });

    await compactSession(options());
    await addUser(session, "f".repeat(5000));
    await compactSession(options());

    const microcompactions = session
      .events()
      .filter((event) => event.type === "compaction" && event.payload.kind === "microcompact");
    expect(microcompactions).toHaveLength(1);
  });

  it("已有 summary 后可追加新 summary", async () => {
    const session = await makeSession();
    await addUser(session, "x".repeat(6000));
    await addBatch(session, "c1", "a".repeat(400));
    await addBatch(session, "c2", "b".repeat(400));
    await addBatch(session, "c3", "c".repeat(40));
    let count = 0;
    const { calls, model } = createFakeModel(async () => ok(`SUMMARY_${(count += 1)}`));
    const options = () => makeOptions(session, model, cfg(1000));

    await compactSession(options());
    await addUser(session, "y".repeat(6000));
    await addBatch(session, "c4", "d".repeat(40));
    await compactSession(options());

    const summaries = session
      .events()
      .filter((event) => event.type === "compaction" && event.payload.kind === "summary");
    expect(summaries).toHaveLength(2);
    expect(Number(summaries[1].payload.coversUpToSeq)).toBeGreaterThan(
      Number(summaries[0].payload.coversUpToSeq),
    );
    expect(calls).toHaveLength(2);
    expect(calls[1].messages[1].content).toContain("[Conversation summary]");
  });
});