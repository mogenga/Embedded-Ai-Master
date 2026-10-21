import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ModelCfg } from "../src/config/providers.js";
import { buildMessages } from "../src/context/build.js";
import { compactSession, SUMMARY_PROMPT } from "../src/context/compact.js";
import type { CompactOptions } from "../src/context/compact.js";
import { heuristicCountTokens } from "../src/model/count.js";
import type { CompletionResult, ModelChatMessage, ModelProtocol } from "../src/model/protocol.js";
import { createSession } from "../src/session/session.js";
import type { SessionHandle } from "../src/session/session.js";
import type { SessionEvent } from "../src/session/types.js";

interface ModelCall {
  messages: ModelChatMessage[];
  tools: unknown[];
  maxOutputTokens: number;
  signal: AbortSignal;
}

function ok(content = "SUMMARY", truncatedByMaxTokens = false): CompletionResult {
  return {
    content,
    toolCalls: [],
    truncatedByMaxTokens,
    usage: { promptTokens: 100, completionTokens: 10, cachedTokens: 5 },
    stopReason: "stop",
  };
}

function okNoUsage(content = "SUMMARY"): CompletionResult {
  return {
    content,
    toolCalls: [],
    truncatedByMaxTokens: false,
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

function fakeSession(snapshots: SessionEvent[][]): {
  session: SessionHandle;
  appended: SessionEvent[];
} {
  let call = 0;
  const appended: SessionEvent[] = [];
  const session: SessionHandle = {
    id: "fake",
    dir: ".",
    header: { id: "fake", createdAt: new Date(0).toISOString(), status: "open" },
    async append(ev) {
      const event: SessionEvent = {
        ...ev,
        seq: appended.length,
        ts: new Date(0).toISOString(),
      };
      appended.push(event);
      return event;
    },
    events() {
      const snapshot = snapshots[Math.min(call, snapshots.length - 1)] ?? [];
      call += 1;
      return snapshot;
    },
    usageTotals() {
      return { promptTokens: 0, completionTokens: 0, cachedTokens: 0 };
    },
    async close() {},
  };
  return { session, appended };
}

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

async function addMultiBatch(
  session: SessionHandle,
  id: string,
  results: Array<{ id: string; text: string; evidence?: boolean }>,
) {
  void id;
  const assistant = await session.append({
    type: "assistant",
    payload: {
      content: "",
      toolCalls: results.map((item) => ({ id: item.id, name: "echo", arguments: { id: item.id } })),
    },
  });
  const appended = [];
  for (const item of results) {
    const payload: Record<string, unknown> = {
      id: item.id,
      ok: true,
      text: item.text,
      toolName: "echo",
    };
    if (item.evidence === true) payload.evidence = true;
    appended.push(
      await session.append({ type: "tool_result", payload, parent: assistant.seq }),
    );
  }
  return { assistant, results: appended };
}

async function addHeavyHistory(session: SessionHandle) {
  await addUser(session, "x".repeat(6000));
  await addBatch(session, "c1", "a".repeat(400));
  await addBatch(session, "c2", "b".repeat(400));
  await addBatch(session, "c3", "c".repeat(40));
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

  it("长 evidence 是唯一可修剪候选时不进入 microcompact", async () => {
    const session = await makeSession();
    await addUser(session, "start");
    await addBatch(session, "e1", "E".repeat(1200), { evidence: true });
    await addBatch(session, "c2", "a".repeat(1200), { evidence: true });
    await addBatch(session, "c3", "b".repeat(1200), { evidence: true });
    const { calls, model } = createFakeModel(async () => ok("SUMMARY_EVIDENCE_ONLY"));

    await compactSession(makeOptions(session, model, cfg(1000)));

    const microcompactions = session
      .events()
      .filter((event) => event.type === "compaction" && event.payload.kind === "microcompact");
    expect(microcompactions).toHaveLength(0);
    expect(calls).toHaveLength(1);
    expect(
      buildMessages(session.events()).some(
        (message) => message.role === "tool" && message.content === "E".repeat(1200),
      ),
    ).toBe(true);
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
    expect(calls[0].messages).toHaveLength(2);
    expect(calls[0].messages[0]).toStrictEqual({ role: "system", content: SUMMARY_PROMPT });
    expect(calls[0].messages[1].role).toBe("user");
    expect(calls[0].messages[1].content.length).toBeLessThanOrEqual(2400);
    expect(calls[0].messages[1].content).toContain("user: ");

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

  // contextWindow / maxOutput 在 providers.json 里是可选的；压缩路径必须自己兜底，
  // 否则 undefined 参与算术会得到 NaN 阈值，让压缩永不触发或永远触发。
  it("modelCfg 缺 contextWindow/maxOutput 时按内核默认值判定不压缩", async () => {
    const session = await makeSession();
    await addUser(session, "hello");
    const { calls, model } = createFakeModel();
    const before = session.events().length;

    await compactSession(makeOptions(session, model, {}));

    expect(session.events().length).toBe(before);
    expect(calls).toHaveLength(0);
  });

  it("modelCfg 缺 maxOutput 时摘要请求用内核默认 maxOutput", async () => {
    const session = await makeSession();
    await addUser(session, "x".repeat(6000));
    await addBatch(session, "c1", "a".repeat(400));
    await addBatch(session, "c2", "b".repeat(400));
    await addBatch(session, "c3", "c".repeat(40));
    const { calls, model } = createFakeModel(async () => ok("SUMMARY_TEXT"));
    // 只给 contextWindow：摘要的 maxOutputTokens 应回落到默认值，
    // 且 Math.min(2048, DEFAULT_MAX_OUTPUT) 仍是 2048（默认值大于 2048）。
    await compactSession(makeOptions(session, model, { contextWindow: 1000 }));

    expect(calls).toHaveLength(1);
    expect(calls[0].maxOutputTokens).toBe(2048);
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

  it("前缀投影失败时 append failed 不抛出", async () => {
    const ts = new Date(0).toISOString();
    const valid: SessionEvent[] = [
      { seq: 0, ts, type: "user", payload: { content: "y".repeat(6000) } },
    ];
    const malformed: SessionEvent[] = [
      { seq: 0, ts, type: "user", payload: { content: "start" } },
      {
        seq: 1,
        ts,
        type: "assistant",
        payload: { content: "", toolCalls: [{ id: "c1", name: "echo", arguments: {} }] },
      },
      { seq: 2, ts, type: "user", payload: { content: "x".repeat(4000) } },
    ];
    const { session, appended } = fakeSession([valid, valid, malformed]);
    const { calls, model } = createFakeModel(async () => ok("MUST_NOT_RUN"));

    await expect(
      compactSession(makeOptions(session, model, cfg(1000))),
    ).resolves.toBeUndefined();

    expect(calls).toHaveLength(0);
    expect(appended).toHaveLength(1);
    expect(appended[0].payload).toMatchObject({
      kind: "failed",
      stage: "summary",
    });
    expect(String(appended[0].payload.reason)).toContain("missing tool_result");
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
    expect(microcompactions.length).toBeGreaterThan(0);
    const elided = microcompactions.flatMap(
      (event) => event.payload.elidedSeqs as number[],
    );
    expect(new Set(elided).size).toBe(elided.length);
  });

  it("已有 summary 后可追加新 summary", async () => {
    const session = await makeSession();
    await addUser(session, "x".repeat(6000));
    await addBatch(session, "c1", "a".repeat(400));
    await addBatch(session, "c2", "b".repeat(400));
    await addBatch(session, "c3", "c".repeat(40));
    let count = 0;
    const { calls, model } = createFakeModel(async () => ok(`SUMMARY_${(count += 1)}`));
    const options = () =>
      makeOptions(session, model, cfg(1000), { keepRecentTurns: 15 });

    await compactSession(options());
    for (let index = 0; index < 15; index += 1) {
      await addBatch(session, `d${index}`, "d".repeat(400));
    }
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

  it.each([
    ["空串", "", false, "empty summary"],
    ["全空白", " \n\t ", false, "empty summary"],
    ["截断", "PARTIAL", true, "summary truncated"],
  ])("摘要结果%s时 failed 且不落 usage/summary", async (_label, content, truncated, reason) => {
    const session = await makeSession();
    await addHeavyHistory(session);
    const { calls, model } = createFakeModel(async () => ok(content, truncated));

    await compactSession(makeOptions(session, model, cfg(1000)));

    expect(calls).toHaveLength(1);
    const events = session.events();
    expect(events[events.length - 1].payload).toMatchObject({
      kind: "failed",
      stage: "summary",
      reason,
    });
    expect(events.some((event) => event.type === "usage")).toBe(false);
    expect(
      events.some(
        (event) => event.type === "compaction" && event.payload.kind === "summary",
      ),
    ).toBe(false);
  });

  it("边界不前进时 failed(no_progress) 且不重复计费", async () => {
    const session = await makeSession();
    await addUser(session, "x".repeat(6000));
    const assistant = await session.append({
      type: "assistant",
      payload: {
        content: "",
        toolCalls: [{ id: "c1", name: "echo", arguments: { id: "c1" } }],
      },
    });
    const result = await session.append({
      type: "tool_result",
      payload: { id: "c1", ok: true, text: "a".repeat(4000), toolName: "echo" },
      parent: assistant.seq,
    });
    await session.append({
      type: "compaction",
      payload: { kind: "summary", summary: "S".repeat(4000), coversUpToSeq: result.seq },
    });
    const { calls, model } = createFakeModel(async () => {
      throw new Error("must not summarize again");
    });

    await compactSession(makeOptions(session, model, cfg(1000)));

    expect(calls).toHaveLength(0);
    const events = session.events();
    expect(events[events.length - 1].payload).toMatchObject({
      kind: "failed",
      stage: "summary",
      reason: "no_progress",
    });
    expect(
      events.filter(
        (event) => event.type === "compaction" && event.payload.kind === "summary",
      ),
    ).toHaveLength(1);
    expect(events.filter((event) => event.type === "usage")).toHaveLength(0);
  });

  it.each<[number, number]>([
    [0, 0.8],
    [-0.1, 0.8],
    [0.8, 0.8],
    [0.9, 0.8],
    [0.16, 1],
    [0.16, 0],
    [Number.NaN, 0.8],
  ])("非法比例 keepTailRatio=%s softRatio=%s 抛 TypeError", async (keepTailRatio, softRatio) => {
    const session = await makeSession();
    const { model } = createFakeModel();

    await expect(
      compactSession(
        makeOptions(session, model, cfg(1000), { keepTailRatio, softRatio }),
      ),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("evidence 时批次中间边界回退到 assistant 之前且可投影", async () => {
    const session = await makeSession();
    const user = await addUser(session, "start");
    const first = await addBatch(session, "c1", "a".repeat(4000), { evidence: true });
    await addBatch(session, "c2", "b".repeat(400));
    const { calls, model } = createFakeModel(async () => ok("SUMMARY_BATCH"));

    await compactSession(makeOptions(session, model, cfg(1000)));

    const summaries = session.events().filter(
      (event) => event.type === "compaction" && event.payload.kind === "summary",
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0].payload.coversUpToSeq).toBe(user.seq);
    expect(summaries[0].payload.coversUpToSeq).toBeLessThan(first.assistant.seq);
    expect(calls).toHaveLength(1);
    expect(() => buildMessages(session.events())).not.toThrow();
    expect(
      buildMessages(session.events()).some(
        (message) => message.role === "tool" && message.content === "a".repeat(4000),
      ),
    ).toBe(true);
  });

  it("evidence 位于批次内部时回退到 assistant 之前", async () => {
    const session = await makeSession();
    const user = await addUser(session, "start");
    const batch = await addMultiBatch(session, "b", [
      { id: "c1", text: "a".repeat(400) },
      { id: "c2", text: "E".repeat(400), evidence: true },
      { id: "c3", text: "c".repeat(4000) },
    ]);
    const { calls, model } = createFakeModel(async () => ok("SUMMARY_EVIDENCE_IN_BATCH"));

    await compactSession(makeOptions(session, model, cfg(1000)));

    const summaries = session.events().filter(
      (event) => event.type === "compaction" && event.payload.kind === "summary",
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0].payload.coversUpToSeq).toBe(user.seq);
    expect(summaries[0].payload.coversUpToSeq).toBeLessThan(batch.assistant.seq);
    expect(calls).toHaveLength(1);
    expect(
      buildMessages(session.events()).some(
        (message) => message.role === "tool" && message.content === "E".repeat(400),
      ),
    ).toBe(true);
  });

  it("transcript 截断不切断代理对", async () => {
    const session = await makeSession();
    await addUser(session, "start");
    const transcriptPrefix = "user: start\nassistant: ";
    const content = "x".repeat(2400 - transcriptPrefix.length - 1) + "😀" + "y".repeat(2000);
    await session.append({
      type: "assistant",
      payload: { content, toolCalls: [] },
    });
    await addBatch(session, "c1", "z".repeat(400));
    const { calls, model } = createFakeModel(async () => ok("SUMMARY_SURROGATE"));

    await compactSession(makeOptions(session, model, cfg(1000)));

    expect(calls).toHaveLength(1);
    const transcript = calls[0].messages[1].content;
    expect(transcript.length).toBeLessThanOrEqual(2400);
    expect(/[\uD800-\uDBFF]$/.test(transcript)).toBe(false);
    expect(/^[\uDC00-\uDFFF]/.test(transcript.slice(-1))).toBe(false);
  });

  it("transcript 在 60% 上限内不提前截断", async () => {
    const session = await makeSession();
    await addUser(session, "u".repeat(2200));
    await addBatch(session, "c1", "z".repeat(1200));
    const { calls, model } = createFakeModel(async () => ok("SUMMARY_60"));

    await compactSession(makeOptions(session, model, cfg(1000)));

    expect(calls).toHaveLength(1);
    const transcript = calls[0].messages[1].content;
    expect(transcript.length).toBe(2206);
    expect(transcript.length).toBeGreaterThan(2000);
  });

  it("近期 evidence 批次过大导致摘要后仍超阈值时 failed(still_over_budget)", async () => {
    const session = await makeSession();
    await addUser(session, "start");
    await addBatch(session, "c1", "a".repeat(4000), { evidence: true });
    const { calls, model } = createFakeModel(async () => ok("SUMMARY_STILL_OVER"));

    await compactSession(makeOptions(session, model, cfg(1000)));

    expect(calls).toHaveLength(1);
    const events = session.events();
    expect(
      events.some(
        (event) => event.type === "compaction" && event.payload.kind === "summary",
      ),
    ).toBe(true);
    expect(events[events.length - 1].payload).toMatchObject({
      kind: "failed",
      stage: "summary",
      reason: "still_over_budget",
    });
    expect(
      buildMessages(events).some(
        (message) => message.role === "tool" && message.content === "a".repeat(4000),
      ),
    ).toBe(true);
  });

  it("近期非 evidence 大结果超窗时 emergency microcompact 降到阈值内", async () => {
    const session = await makeSession();
    await addUser(session, "start");
    await addBatch(session, "c1", "a".repeat(4000));
    const { calls, model } = createFakeModel(async () => ok("SUMMARY_EMERGENCY"));

    await compactSession(makeOptions(session, model, cfg(1000)));

    expect(calls).toHaveLength(1);
    const events = session.events();
    expect(
      events.some(
        (event) => event.type === "compaction" && event.payload.kind === "summary",
      ),
    ).toBe(true);
    const emergency = events.find(
      (event) =>
        event.type === "compaction"
        && event.payload.kind === "microcompact"
        && typeof event.payload.note === "string"
        && /emergency/.test(event.payload.note),
    );
    expect(emergency).toBeDefined();
    expect(
      events.some(
        (event) =>
          event.type === "compaction"
          && event.payload.kind === "failed"
          && event.payload.reason === "still_over_budget",
      ),
    ).toBe(false);
    const messages = buildMessages(events);
    expect(
      messages.some((message) => message.role === "tool" && message.content === "a".repeat(4000)),
    ).toBe(false);
    expect(
      messages.some(
        (message) => message.role === "tool" && message.content.includes("[tool result elided; echo:"),
      ),
    ).toBe(true);
    expect(heuristicCountTokens(messages)).toBeLessThanOrEqual(800);
  });

  it("evidence 带 artifact 时 emergency 降级为 artifact 引用", async () => {
    const session = await makeSession();
    await addUser(session, "start");
    await addBatch(session, "e1", "E".repeat(4000), {
      evidence: true,
      artifactPath: "/tmp/evidence-e1.txt",
    });
    const { calls, model } = createFakeModel(async () => ok("SUMMARY_EVIDENCE_ARTIFACT"));

    await compactSession(makeOptions(session, model, cfg(1000)));

    expect(calls).toHaveLength(1);
    const events = session.events();
    expect(
      events.some(
        (event) => event.type === "compaction" && event.payload.kind === "summary",
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "compaction"
          && event.payload.kind === "microcompact"
          && typeof event.payload.note === "string"
          && /emergency/.test(event.payload.note),
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.type === "compaction"
          && event.payload.kind === "failed"
          && event.payload.reason === "still_over_budget",
      ),
    ).toBe(false);
    const messages = buildMessages(events);
    expect(
      messages.some(
        (message) =>
          message.role === "tool"
          && message.content === "[tool result elided; full output at /tmp/evidence-e1.txt]",
      ),
    ).toBe(true);
    expect(heuristicCountTokens(messages)).toBeLessThanOrEqual(800);
  });

  it("摘要结果缺 usage 时落 status 而非零 usage", async () => {
    const session = await makeSession();
    await addHeavyHistory(session);
    const { model } = createFakeModel(async () => okNoUsage("SUMMARY_NO_USAGE"));

    await compactSession(makeOptions(session, model, cfg(1000)));

    const events = session.events();
    expect(events.some((event) => event.type === "usage")).toBe(false);
    expect(
      events.some(
        (event) =>
          event.type === "status"
          && event.payload.status === "usage_missing"
          && event.payload.stage === "summary",
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) => event.type === "compaction" && event.payload.kind === "summary",
      ),
    ).toBe(true);
  });

  it("摘要 usage 的 cachedTokens 归一化", async () => {
    const session = await makeSession();
    await addHeavyHistory(session);
    const { model } = createFakeModel(async () => ({
      content: "SUMMARY_CACHED",
      toolCalls: [],
      truncatedByMaxTokens: false,
      usage: { promptTokens: 10, completionTokens: 5, cachedTokens: 20 },
      stopReason: "stop",
    }));

    await compactSession(makeOptions(session, model, cfg(1000)));

    const usage = session.events().find((event) => event.type === "usage");
    expect(usage?.payload).toStrictEqual({
      promptTokens: 10,
      completionTokens: 5,
      cachedTokens: 10,
      cachedTokensRaw: 20,
    });
  });

  it("再次摘要时旧 summary 只由 buildMessages 注入一次", async () => {
    const session = await makeSession();
    await addUser(session, "old");
    const assistant = await session.append({
      type: "assistant",
      payload: {
        content: "",
        toolCalls: [{ id: "old", name: "echo", arguments: {} }],
      },
    });
    const result = await session.append({
      type: "tool_result",
      payload: { id: "old", ok: true, text: "r".repeat(40), toolName: "echo" },
      parent: assistant.seq,
    });
    const oldSummary = await session.append({
      type: "compaction",
      payload: { kind: "summary", summary: "OLD-SUM", coversUpToSeq: result.seq },
    });
    for (let index = 0; index < 15; index += 1) {
      await addBatch(session, `b${index}`, "x".repeat(400));
    }
    const { calls, model } = createFakeModel(async () => ok("NEW-SUM"));

    await compactSession(
      makeOptions(session, model, cfg(1000), { keepRecentTurns: 15 }),
    );

    expect(calls).toHaveLength(1);
    const transcript = calls[0].messages[1].content;
    expect(transcript).toContain("[Conversation summary]\nOLD-SUM");
    expect(transcript).not.toContain("[Previous summary]");
    expect(transcript.match(/OLD-SUM/g)).toHaveLength(1);
    const summaries = session
      .events()
      .filter((event) => event.type === "compaction" && event.payload.kind === "summary");
    expect(summaries).toHaveLength(2);
    expect(Number(summaries[1].payload.coversUpToSeq)).toBeGreaterThan(oldSummary.seq);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "非法 keepRecentTurns=%s 抛 TypeError",
    async (keepRecentTurns) => {
      const session = await makeSession();
      const { model } = createFakeModel();

      await expect(
        compactSession(makeOptions(session, model, cfg(1000), { keepRecentTurns })),
      ).rejects.toBeInstanceOf(TypeError);
    },
  );

  it("短工具结果不因 microcompact 膨胀", async () => {
    const session = await makeSession();
    for (let index = 0; index < 10; index += 1) {
      await addUser(session, "u".repeat(2000));
    }
    await addBatch(session, "c1", "ok");
    const { model } = createFakeModel(async () => ok("SUMMARY_SHORT"));

    await compactSession(makeOptions(session, model, cfg(1000), { keepRecentTurns: 0 }));

    const compactions = session
      .events()
      .filter((event) => event.type === "compaction");
    expect(compactions.some((event) => event.payload.kind === "microcompact")).toBe(false);
    expect(
      buildMessages(session.events()).some(
        (message) => message.role === "tool" && message.content === "ok",
      ),
    ).toBe(true);
  });
});