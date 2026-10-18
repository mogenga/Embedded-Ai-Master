import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildMessages } from "../src/context/build.js";
import { assertBreakers, computeCostUsd } from "../src/loop/breakers.js";
import type { LoopEvent } from "../src/loop/events.js";
import type { LoopCtx } from "../src/loop/query.js";
import { query } from "../src/loop/query.js";
import type {
  CompletionResult,
  ModelChatMessage,
  ModelProtocol,
  ModelToolSchema,
} from "../src/model/protocol.js";
import type { SessionHandle } from "../src/session/session.js";
import { createSession } from "../src/session/session.js";
import { echoTool } from "../src/tools/echo.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { ToolDef } from "../src/tools/types.js";

const tempDirs: string[] = [];
const sessions: SessionHandle[] = [];

async function makeSession(systemPrompt?: string): Promise<{ session: SessionHandle; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "query-test-"));
  tempDirs.push(dir);
  const session = await createSession(dir, systemPrompt === undefined ? {} : { systemPrompt });
  sessions.push(session);
  return { session, dir };
}

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

interface CompleteCall {
  messages: ModelChatMessage[];
  tools: ModelToolSchema[];
  maxOutputTokens: number;
  signal: AbortSignal;
}

function scriptedProvider(
  sequence: Array<CompletionResult | Error>,
  onServe?: (index: number) => void,
): ModelProtocol & { calls: CompleteCall[] } {
  let index = 0;
  const calls: CompleteCall[] = [];
  return {
    calls,
    async complete(messages, tools, opts) {
      const callIndex = index;
      calls.push({
        messages,
        tools,
        maxOutputTokens: opts.maxOutputTokens,
        signal: opts.signal,
      });
      if (callIndex >= sequence.length) throw new Error("script exhausted");
      index += 1;
      onServe?.(callIndex);
      const item = sequence[callIndex];
      if (item instanceof Error) throw item;
      return item;
    },
    countTokens() {
      return 0;
    },
  };
}

function reply(
  content: string,
  toolCalls: CompletionResult["toolCalls"] = [],
  truncatedByMaxTokens = false,
  usage?: CompletionResult["usage"],
): CompletionResult {
  const result: CompletionResult = {
    content,
    toolCalls,
    truncatedByMaxTokens,
    stopReason: null,
  };
  if (usage !== undefined) result.usage = usage;
  return result;
}

async function makeCtx(
  model: ModelProtocol,
  overrides: Partial<LoopCtx> = {},
  sessionSystemPrompt?: string,
): Promise<{ ctx: LoopCtx; session: SessionHandle; dir: string }> {
  const { session, dir } = await makeSession(sessionSystemPrompt);
  const ctx: LoopCtx = {
    session,
    model,
    modelCfg: { contextWindow: 8192, maxOutput: 512 },
    tools: new ToolRegistry([echoTool]),
    budget: () => ({ over: false, tokens: 0, softLimit: 1 }),
    signal: new AbortController().signal,
    artifactDir: path.join(dir, "artifacts"),
    ...overrides,
  };
  return { ctx, session, dir };
}

async function collect(generator: AsyncGenerator<LoopEvent>): Promise<LoopEvent[]> {
  const events: LoopEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

const echoCall = (id: string, text = "hi"): CompletionResult["toolCalls"][number] => ({
  id,
  name: "echo",
  arguments: { text },
});

describe("query 主循环", () => {
  it("每轮 complete 前落 checkpoint,且不进入事件流", async () => {
    const provider = scriptedProvider([reply("用 echo", [echoCall("c1")]), reply("完成")]);
    const { ctx, session } = await makeCtx(provider);

    const events = await collect(query(ctx, "x", { maxTurns: 10 }));

    expect(events.some((event) => (event.kind as string) === "checkpoint")).toBe(false);

    const logged = session.events();
    const checkpoints = logged.filter((event) => event.type === "checkpoint");
    expect(checkpoints.map((event) => event.payload)).toStrictEqual([{ turn: 1 }, { turn: 2 }]);

    const user = logged.find((event) => event.type === "user");
    const assistants = logged.filter((event) => event.type === "assistant");
    expect(assistants).toHaveLength(2);
    expect(user?.seq).toBeLessThan(checkpoints[0].seq);
    expect(checkpoints[0].seq).toBeLessThan(assistants[0].seq);
    expect(assistants[0].seq).toBeLessThan(checkpoints[1].seq);
    expect(checkpoints[1].seq).toBeLessThan(assistants[1].seq);
  });

  it("闭环: user→model→tool_use→tool_result→model→done(no_tool_calls)", async () => {
    const provider = scriptedProvider([reply("用 echo", [echoCall("c1")]), reply("完成")]);
    const { ctx, session } = await makeCtx(provider);

    const events = await collect(query(ctx, "请回应", { maxTurns: 10 }));

    expect(events).toEqual([
      { kind: "model_message", content: "用 echo" },
      { kind: "tool_use", id: "c1", name: "echo", input: { text: "hi" } },
      { kind: "tool_result", id: "c1", ok: true, text: "hi", code: "ok" },
      { kind: "model_message", content: "完成" },
      { kind: "done", finishReason: "no_tool_calls" },
    ]);
    expect(provider.calls).toHaveLength(2);
    expect(session.events().map((event) => event.type)).toEqual([
      "user",
      "checkpoint",
      "assistant",
      "status",
      "tool_result",
      "checkpoint",
      "assistant",
      "status",
      "status",
    ]);
    const toolResult = session.events().find((event) => event.type === "tool_result");
    const assistant = session.events().find((event) => event.type === "assistant");
    expect(toolResult?.parent).toBe(assistant?.seq);
    expect(toolResult?.payload).toMatchObject({ id: "c1", ok: true, text: "hi" });
  });

  it("tool_result 事件透传结构化 detail 与 artifactPath", async () => {
    const richTool: ToolDef<{ text: string }> = {
      name: "rich",
      description: "返回结构化取证详情",
      schema: z.object({ text: z.string() }),
      execute: async (input) => ({
        isError: false,
        code: "ok",
        message: "",
        text: input.text,
        detail: { address: "0x40023808", value: "0x00000000" },
        artifactPath: "artifacts/rich.txt",
      }),
    };
    const provider = scriptedProvider([
      reply("调用", [{ id: "r1", name: "rich", arguments: { text: "read" } }]),
      reply("完成"),
    ]);
    const { ctx } = await makeCtx(provider, { tools: new ToolRegistry([richTool]) });

    const events = await collect(query(ctx, "取证", { maxTurns: 10 }));
    const result = events.find((event) => event.kind === "tool_result");

    expect(result).toMatchObject({
      kind: "tool_result",
      id: "r1",
      ok: true,
      code: "ok",
      detail: { address: "0x40023808", value: "0x00000000" },
      artifactPath: "artifacts/rich.txt",
    });
  });

  it("tool_result payload 写入 toolName 与 evidence", async () => {
    const evidenceTool: ToolDef<{ text: string }> = {
      name: "evidence",
      description: "返回取证结果",
      schema: z.object({ text: z.string() }),
      annotations: { readOnly: true, evidence: true },
      execute: async (input) => ({
        isError: false,
        code: "ok",
        message: "",
        text: input.text,
      }),
    };
    const provider = scriptedProvider([
      reply("取证", [{ id: "e1", name: "evidence", arguments: { text: "proof" } }]),
      reply("完成"),
    ]);
    const { ctx, session } = await makeCtx(provider, {
      tools: new ToolRegistry([evidenceTool]),
    });

    await collect(query(ctx, "取证", { maxTurns: 10 }));

    const logged = session.events().find((event) => event.type === "tool_result");
    expect(logged?.payload).toStrictEqual({
      id: "e1",
      ok: true,
      text: "proof",
      code: "ok",
      toolName: "evidence",
      evidence: true,
    });
  });

  it("model-visible means logged: 投影含 tool 消息", async () => {
    const provider = scriptedProvider([reply("用 echo", [echoCall("c1")]), reply("完成")]);
    const { ctx, session } = await makeCtx(provider);

    await collect(query(ctx, "请回应", { maxTurns: 10 }));

    const messages = buildMessages(session.events());
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(messages[2]).toMatchObject({ role: "tool", tool_call_id: "c1", content: "hi" });
    expect(messages[1].tool_calls?.[0].function.arguments).toBe('{"text":"hi"}');
  });

  it("每轮 complete 收到 tools 与 maxOutput", async () => {
    const provider = scriptedProvider([reply("完成")]);
    const { ctx } = await makeCtx(provider);

    await collect(query(ctx, "x", { maxTurns: 10 }));

    expect(provider.calls[0].tools.map((tool) => tool.function.name)).toEqual(["echo"]);
    expect(provider.calls[0].maxOutputTokens).toBe(512);
    expect(provider.calls[0].signal).toBe(ctx.signal);
  });

  it("truncatedByMaxTokens=true 且无工具调用 → 再次 complete", async () => {
    const provider = scriptedProvider([reply("part", [], true), reply("done")]);
    const { ctx, session } = await makeCtx(provider);

    const events = await collect(query(ctx, "x", { maxTurns: 10 }));

    expect(events.map((event) => event.kind)).toEqual([
      "model_message",
      "model_message",
      "done",
    ]);
    expect(provider.calls).toHaveLength(2);
    expect(session.events().filter((event) => event.type === "assistant")).toHaveLength(2);
  });

  it("truncatedByMaxTokens=true 且有工具调用 → 执行后再次 complete", async () => {
    const provider = scriptedProvider([
      reply("part", [echoCall("c1")], true),
      reply("done"),
    ]);
    const { ctx } = await makeCtx(provider);

    const events = await collect(query(ctx, "x", { maxTurns: 10 }));

    expect(events.map((event) => event.kind)).toEqual([
      "model_message",
      "tool_use",
      "tool_result",
      "model_message",
      "done",
    ]);
    expect(provider.calls).toHaveLength(2);
  });

  it("maxTurns=1 熔断 → interrupted + done(max_turns)", async () => {
    const provider = scriptedProvider([reply("x", [echoCall("c1")])]);
    const { ctx, session } = await makeCtx(provider);

    const events = await collect(query(ctx, "x", { maxTurns: 1 }));

    expect(events.map((event) => event.kind)).toEqual([
      "model_message",
      "tool_use",
      "tool_result",
      "interrupted",
      "done",
    ]);
    expect(events.at(-2)).toEqual({ kind: "interrupted", reason: "max_turns" });
    expect(events.at(-1)).toEqual({ kind: "done", finishReason: "max_turns" });
    expect(provider.calls).toHaveLength(1);
    expect(session.events().map((event) => event.type)).toEqual([
      "user",
      "checkpoint",
      "assistant",
      "status",
      "tool_result",
      "interrupted",
    ]);
  });

  it("maxCostUsd 触发熔断", async () => {
    const provider = scriptedProvider([
      reply("x", [echoCall("c1")], false, { promptTokens: 10, completionTokens: 5 }),
    ]);
    const { ctx, session } = await makeCtx(provider, {
      pricePerMillion: { input: 1_000_000, output: 1_000_000 },
    });

    const events = await collect(query(ctx, "x", { maxTurns: 10, maxCostUsd: 0.5 }));

    expect(events.at(-2)).toEqual({ kind: "interrupted", reason: "max_cost_usd" });
    expect(events.at(-1)).toEqual({ kind: "done", finishReason: "max_cost_usd" });
    expect(provider.calls).toHaveLength(1);
    expect(session.events().filter((event) => event.type === "usage")).toHaveLength(1);
  });

  it("cost 恰等于 maxCostUsd 时熔断", async () => {
    const provider = scriptedProvider([
      reply("x", [echoCall("c1")], false, { promptTokens: 1, completionTokens: 0 }),
    ]);
    const { ctx } = await makeCtx(provider, {
      pricePerMillion: { input: 1_000_000, output: 1_000_000 },
    });

    const events = await collect(query(ctx, "x", { maxTurns: 10, maxCostUsd: 1 }));

    expect(events.at(-1)).toEqual({ kind: "done", finishReason: "max_cost_usd" });
    expect(provider.calls).toHaveLength(1);
  });

  it("两轮各自低于阈值、累计超阈值 → max_cost_usd", async () => {
    const usage = { promptTokens: 1, completionTokens: 0 };
    const provider = scriptedProvider([
      reply("a", [echoCall("c1")], false, usage),
      reply("b", [echoCall("c2")], false, usage),
    ]);
    const { ctx } = await makeCtx(provider, {
      pricePerMillion: { input: 1_000_000, output: 1_000_000 },
    });

    const events = await collect(query(ctx, "x", { maxTurns: 10, maxCostUsd: 1.5 }));

    expect(events.at(-1)).toEqual({ kind: "done", finishReason: "max_cost_usd" });
    expect(provider.calls).toHaveLength(2);
  });

  it("maxCostUsd 未配 → 只计 token 不熔断", async () => {
    const usage = { promptTokens: 1000, completionTokens: 1000 };
    const provider = scriptedProvider([
      reply("a", [echoCall("c1")], false, usage),
      reply("b", [echoCall("c2")], false, usage),
      reply("done", [], false, usage),
    ]);
    const { ctx, session } = await makeCtx(provider, {
      pricePerMillion: { input: 1_000_000, output: 1_000_000 },
    });

    const events = await collect(query(ctx, "x", { maxTurns: 10 }));

    expect(events.at(-1)).toEqual({ kind: "done", finishReason: "no_tool_calls" });
    expect(provider.calls).toHaveLength(3);
    expect(session.events().filter((event) => event.type === "usage")).toHaveLength(3);
  });

  it("历史 usage 计入 maxCostUsd,首轮前即熔断", async () => {
    const provider = scriptedProvider([]);
    const { ctx, session } = await makeCtx(provider, {
      pricePerMillion: { input: 1_000_000, output: 1_000_000 },
    });
    await session.append({ type: "usage", payload: { promptTokens: 1, completionTokens: 0 } });

    const events = await collect(query(ctx, "x", { maxTurns: 10, maxCostUsd: 0.5 }));

    expect(events.at(-2)).toEqual({ kind: "interrupted", reason: "max_cost_usd" });
    expect(events.at(-1)).toEqual({ kind: "done", finishReason: "max_cost_usd" });
    expect(provider.calls).toHaveLength(0);
  });

  it("price 缺省时历史 usage 仍不熔断", async () => {
    const provider = scriptedProvider([
      reply("done", [], false, { promptTokens: 1_000_000, completionTokens: 1_000_000 }),
    ]);
    const { ctx, session } = await makeCtx(provider);
    await session.append({
      type: "usage",
      payload: { promptTokens: 1_000_000, completionTokens: 1_000_000 },
    });

    const events = await collect(query(ctx, "x", { maxTurns: 10, maxCostUsd: 0 }));

    expect(events.at(-1)).toEqual({ kind: "done", finishReason: "no_tool_calls" });
    expect(provider.calls).toHaveLength(1);
  });

  it("price 缺省 → 只计 token 不熔断", async () => {
    const usage = { promptTokens: 10_000_000, completionTokens: 10_000_000 };
    const provider = scriptedProvider([
      reply("a", [echoCall("c1")], false, usage),
      reply("done", [], false, usage),
    ]);
    const { ctx, session } = await makeCtx(provider);

    const events = await collect(query(ctx, "x", { maxTurns: 10, maxCostUsd: 0 }));

    expect(events.at(-1)).toEqual({ kind: "done", finishReason: "no_tool_calls" });
    expect(session.events().filter((event) => event.type === "usage")).toHaveLength(2);
  });

  it("计价分支: cachedInput 缺省 vs 已配 结果不同", () => {
    const usage = { promptTokens: 100, completionTokens: 50, cachedTokens: 40 };

    const withoutCachedPrice = computeCostUsd(usage, { input: 1, output: 2 });
    const withCachedPrice = computeCostUsd(usage, { input: 1, output: 2, cachedInput: 0.1 });

    expect(withoutCachedPrice).toBeCloseTo(200 / 1_000_000, 12);
    expect(withCachedPrice).toBeCloseTo(164 / 1_000_000, 12);
    expect(withoutCachedPrice).toBeGreaterThan(withCachedPrice);
    expect(computeCostUsd(usage)).toBe(0);
  });

  it("cachedTokens 越界时钳制到 [0, promptTokens]", () => {
    const huge = computeCostUsd(
      { promptTokens: 10, completionTokens: 0, cachedTokens: 100 },
      { input: 1, output: 1, cachedInput: 10 },
    );
    const negative = computeCostUsd(
      { promptTokens: 10, completionTokens: 0, cachedTokens: -5 },
      { input: 1, output: 1, cachedInput: 10 },
    );

    expect(huge).toBeCloseTo(100 / 1_000_000, 12);
    expect(negative).toBeCloseTo(10 / 1_000_000, 12);
  });

  it("负/NaN/Infinity usage 不产生负成本", () => {
    const price = { input: 1, output: 1, cachedInput: 0.5 };

    expect(
      computeCostUsd({ promptTokens: -10, completionTokens: -5, cachedTokens: -3 }, price),
    ).toBe(0);
    expect(
      computeCostUsd({ promptTokens: NaN, completionTokens: NaN, cachedTokens: NaN }, price),
    ).toBe(0);
    expect(
      computeCostUsd({ promptTokens: Infinity, completionTokens: Infinity }, price),
    ).toBe(0);
  });

  it("assertBreakers 拒绝非法 maxTurns/maxCostUsd", () => {
    expect(() => assertBreakers({ maxTurns: NaN }, 1, 0)).toThrow(TypeError);
    expect(() => assertBreakers({ maxTurns: Infinity }, 1, 0)).toThrow(TypeError);
    expect(() => assertBreakers({ maxTurns: -1 }, 1, 0)).toThrow(TypeError);
    expect(() => assertBreakers({ maxTurns: 1, maxCostUsd: NaN }, 1, 0)).toThrow(TypeError);
    expect(() => assertBreakers({ maxTurns: 1, maxCostUsd: Infinity }, 1, 0)).toThrow(TypeError);
  });

  it("负/NaN usage 归一化后成本不减少,maxCostUsd 仍可触发", async () => {
    const provider = scriptedProvider([
      reply("a", [echoCall("c1")], false, {
        promptTokens: -10,
        completionTokens: -5,
        cachedTokens: -3,
      }),
      reply("b", [echoCall("c2")], false, { promptTokens: 1, completionTokens: 0 }),
    ]);
    const { ctx, session } = await makeCtx(provider, {
      pricePerMillion: { input: 1_000_000, output: 1_000_000 },
    });

    const events = await collect(query(ctx, "x", { maxTurns: 10, maxCostUsd: 1 }));

    expect(events.at(-1)).toEqual({ kind: "done", finishReason: "max_cost_usd" });
    expect(provider.calls).toHaveLength(2);
    const usages = session.events()
      .filter((event) => event.type === "usage")
      .map((event) => event.payload);
    expect(usages[0]).toStrictEqual({
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      cachedTokensRaw: -3,
    });
    expect(usages[1]).toStrictEqual({ promptTokens: 1, completionTokens: 0 });
  });

  it("usage 落日志写归一化 cachedTokens", async () => {
    const provider = scriptedProvider([
      reply("done", [], false, { promptTokens: 10, completionTokens: 1, cachedTokens: 100 }),
    ]);
    const { ctx, session } = await makeCtx(provider, {
      pricePerMillion: { input: 1, output: 1, cachedInput: 0.1 },
    });

    await collect(query(ctx, "x", { maxTurns: 10 }));

    const usage = session.events().find((event) => event.type === "usage");
    expect(usage?.payload).toStrictEqual({
      promptTokens: 10,
      completionTokens: 1,
      cachedTokens: 10,
      cachedTokensRaw: 100,
    });
  });

  it("usage 缺失时逐次落 status usage_missing,不累计成本", async () => {
    const provider = scriptedProvider([reply("a", [echoCall("c1")]), reply("done")]);
    const { ctx, session } = await makeCtx(provider, {
      pricePerMillion: { input: 1, output: 1 },
    });

    const events = await collect(query(ctx, "x", { maxTurns: 10 }));

    expect(events.at(-1)).toEqual({ kind: "done", finishReason: "no_tool_calls" });
    const missing = session.events().filter(
      (event) => event.type === "status" && event.payload.status === "usage_missing",
    );
    expect(missing).toHaveLength(2);
    expect(session.events().filter((event) => event.type === "usage")).toHaveLength(0);
  });

  it("usage 事件按字段落日志,cachedTokens 缺省时不写该键", async () => {
    const provider = scriptedProvider([
      reply("done", [], false, { promptTokens: 12, completionTokens: 3 }),
    ]);
    const { ctx, session } = await makeCtx(provider);

    await collect(query(ctx, "x", { maxTurns: 10 }));

    const usage = session.events().find((event) => event.type === "usage");
    expect(usage?.payload).toStrictEqual({ promptTokens: 12, completionTokens: 3 });
  });

  it("usage 事件含 cachedTokens 时保留该字段", async () => {
    const provider = scriptedProvider([
      reply("done", [], false, { promptTokens: 12, completionTokens: 3, cachedTokens: 4 }),
    ]);
    const { ctx, session } = await makeCtx(provider);

    await collect(query(ctx, "x", { maxTurns: 10 }));

    const usage = session.events().find((event) => event.type === "usage");
    expect(usage?.payload).toStrictEqual({
      promptTokens: 12,
      completionTokens: 3,
      cachedTokens: 4,
    });
  });

  it("abort → interrupted,已收到的 assistant 结果先落日志", async () => {
    const controller = new AbortController();
    const provider = scriptedProvider([reply("慢")], () => controller.abort());
    const { ctx, session } = await makeCtx(provider, { signal: controller.signal });

    const events = await collect(query(ctx, "x", { maxTurns: 10 }));

    expect(events.map((event) => event.kind)).toEqual([
      "model_message",
      "interrupted",
      "done",
    ]);
    expect(events.at(-1)).toEqual({ kind: "done", finishReason: "aborted" });
    expect(session.events().map((event) => event.type)).toEqual([
      "user",
      "checkpoint",
      "assistant",
      "status",
      "interrupted",
    ]);
  });

  it("取消时已声明的 toolCalls 全部补 tool_aborted 结果", async () => {
    let executed = 0;
    const spyTool: ToolDef<{ text: string }> = {
      name: "echo",
      description: "执行计数",
      schema: z.object({ text: z.string() }),
      annotations: { readOnly: true },
      execute: async (input) => {
        executed += 1;
        return { isError: false, code: "ok", message: "", text: input.text };
      },
    };
    const controller = new AbortController();
    const provider = scriptedProvider(
      [reply("调用两个", [echoCall("c1", "a"), echoCall("c2", "b")])],
      () => controller.abort(),
    );
    const { ctx, session } = await makeCtx(provider, {
      tools: new ToolRegistry([spyTool]),
      signal: controller.signal,
    });

    const events = await collect(query(ctx, "x", { maxTurns: 10 }));

    expect(executed).toBe(0);
    expect(events.map((event) => event.kind)).toEqual([
      "model_message",
      "tool_use",
      "tool_use",
      "tool_result",
      "tool_result",
      "interrupted",
      "done",
    ]);
    expect(events[3]).toEqual({
      kind: "tool_result",
      id: "c1",
      ok: false,
      text: "tool aborted before execution",
      code: "tool_aborted",
    });
    expect(events[4]).toEqual({
      kind: "tool_result",
      id: "c2",
      ok: false,
      text: "tool aborted before execution",
      code: "tool_aborted",
    });
    expect(events.at(-1)).toEqual({ kind: "done", finishReason: "aborted" });

    const assistant = session.events().find((event) => event.type === "assistant");
    const logged = session.events().filter((event) => event.type === "tool_result");
    expect(logged).toHaveLength(2);
    expect(logged.map((event) => event.payload)).toStrictEqual([
      {
        id: "c1",
        ok: false,
        text: "tool aborted before execution",
        code: "tool_aborted",
        toolName: "echo",
      },
      {
        id: "c2",
        ok: false,
        text: "tool aborted before execution",
        code: "tool_aborted",
        toolName: "echo",
      },
    ]);
    expect(logged.map((event) => event.parent)).toStrictEqual([
      assistant?.seq,
      assistant?.seq,
    ]);

    const messages = buildMessages(session.events());
    expect(messages.map((message) => message.role)).toStrictEqual([
      "user",
      "assistant",
      "tool",
      "tool",
    ]);
    expect(messages[1].tool_calls?.map((call) => call.id)).toStrictEqual(["c1", "c2"]);
    expect(messages[2]).toStrictEqual({
      role: "tool",
      tool_call_id: "c1",
      content: "tool aborted before execution",
    });
    expect(messages[3]).toStrictEqual({
      role: "tool",
      tool_call_id: "c2",
      content: "tool aborted before execution",
    });
  });

  it("消费者提前 return → 补 tool_aborted 日志与 consumer_closed", async () => {
    let executed = 0;
    const spyTool: ToolDef<{ text: string }> = {
      name: "echo",
      description: "执行计数",
      schema: z.object({ text: z.string() }),
      annotations: { readOnly: true },
      execute: async (input) => {
        executed += 1;
        return { isError: false, code: "ok", message: "", text: input.text };
      },
    };
    const provider = scriptedProvider([
      reply("调用两个", [echoCall("c1", "a"), echoCall("c2", "b")], false, {
        promptTokens: 5,
        completionTokens: 2,
      }),
    ]);
    const { ctx, session } = await makeCtx(provider, {
      tools: new ToolRegistry([spyTool]),
    });

    const generator = query(ctx, "x", { maxTurns: 10 });
    const first = await generator.next();
    expect(first.value).toEqual({ kind: "model_message", content: "调用两个" });
    await generator.return(undefined);

    expect(executed).toBe(0);
    expect(session.events().map((event) => event.type)).toStrictEqual([
      "user",
      "checkpoint",
      "assistant",
      "usage",
      "tool_result",
      "tool_result",
      "interrupted",
    ]);
    expect(session.events().find((event) => event.type === "usage")?.payload).toStrictEqual({
      promptTokens: 5,
      completionTokens: 2,
    });
    const assistant = session.events().find((event) => event.type === "assistant");
    const logged = session.events().filter((event) => event.type === "tool_result");
    expect(logged.map((event) => event.payload)).toStrictEqual([
      {
        id: "c1",
        ok: false,
        text: "tool aborted before execution",
        code: "tool_aborted",
        toolName: "echo",
      },
      {
        id: "c2",
        ok: false,
        text: "tool aborted before execution",
        code: "tool_aborted",
        toolName: "echo",
      },
    ]);
    expect(logged.map((event) => event.parent)).toStrictEqual([
      assistant?.seq,
      assistant?.seq,
    ]);
    const interrupted = session.events().find((event) => event.type === "interrupted");
    expect(interrupted?.payload).toStrictEqual({ reason: "consumer_closed" });

    const messages = buildMessages(session.events());
    expect(messages.map((message) => message.role)).toStrictEqual([
      "user",
      "assistant",
      "tool",
      "tool",
    ]);
  });

  it("无工具调用时消费者提前 return → usage 已落且 interrupted(consumer_closed)", async () => {
    const provider = scriptedProvider([
      reply("仅文本", [], false, { promptTokens: 3, completionTokens: 1 }),
    ]);
    const { ctx, session } = await makeCtx(provider);

    const generator = query(ctx, "x", { maxTurns: 10 });
    const first = await generator.next();
    expect(first.value).toEqual({ kind: "model_message", content: "仅文本" });
    await generator.return(undefined);

    expect(session.events().map((event) => event.type)).toStrictEqual([
      "user",
      "checkpoint",
      "assistant",
      "usage",
      "interrupted",
    ]);
    expect(session.events().find((event) => event.type === "usage")?.payload).toStrictEqual({
      promptTokens: 3,
      completionTokens: 1,
    });
    expect(
      session.events().find((event) => event.type === "interrupted")?.payload,
    ).toStrictEqual({ reason: "consumer_closed" });
    expect(buildMessages(session.events()).map((message) => message.role)).toStrictEqual([
      "user",
      "assistant",
    ]);
  });

  it("模型抛 AbortError → interrupted + done(aborted)", async () => {
    const provider = scriptedProvider([new DOMException("aborted", "AbortError")]);
    const { ctx, session } = await makeCtx(provider);

    const events = await collect(query(ctx, "x", { maxTurns: 10 }));

    expect(events.map((event) => event.kind)).toEqual(["interrupted", "done"]);
    expect(events.at(-1)).toEqual({ kind: "done", finishReason: "aborted" });
    expect(session.events().map((event) => event.type)).toEqual([
      "user",
      "checkpoint",
      "interrupted",
    ]);
  });

  it("signal 已中止 → 不调用模型", async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = scriptedProvider([]);
    const { ctx, session } = await makeCtx(provider, { signal: controller.signal });

    const events = await collect(query(ctx, "x", { maxTurns: 10 }));

    expect(events.map((event) => event.kind)).toEqual(["interrupted", "done"]);
    expect(events.at(-1)).toEqual({ kind: "done", finishReason: "aborted" });
    expect(provider.calls).toHaveLength(0);
    expect(session.events().map((event) => event.type)).toEqual(["user", "interrupted"]);
  });

  it("provider 在 abort 后抛普通 Error → interrupted + done(aborted)", async () => {
    const controller = new AbortController();
    const provider = scriptedProvider([new Error("network died")], () => controller.abort());
    const { ctx, session } = await makeCtx(provider, { signal: controller.signal });

    const events = await collect(query(ctx, "x", { maxTurns: 10 }));

    expect(events.map((event) => event.kind)).toEqual(["interrupted", "done"]);
    expect(events.at(-1)).toEqual({ kind: "done", finishReason: "aborted" });
    expect(session.events().map((event) => event.type)).toEqual([
      "user",
      "checkpoint",
      "interrupted",
    ]);
  });

  it("非 AbortError 的模型异常直接上抛,不伪造 done", async () => {
    const provider = scriptedProvider([new Error("boom")]);
    const { ctx, session } = await makeCtx(provider);

    await expect(collect(query(ctx, "x", { maxTurns: 10 }))).rejects.toThrow("boom");

    expect(session.events().map((event) => event.type)).toStrictEqual([
      "user",
      "checkpoint",
      "interrupted",
    ]);
    expect(
      session.events().find((event) => event.type === "interrupted")?.payload,
    ).toStrictEqual({ reason: "error" });
  });

  it("模型返回重复 tool call id → 不落不可回放的日志,原错误上抛", async () => {
    const provider = scriptedProvider([
      reply("调用两个", [echoCall("dup", "a"), echoCall("dup", "b")]),
    ]);
    const { ctx, session } = await makeCtx(provider);

    await expect(collect(query(ctx, "x", { maxTurns: 10 }))).rejects.toThrow(
      /duplicate tool call id/,
    );

    expect(session.events().map((event) => event.type)).toStrictEqual([
      "user",
      "checkpoint",
      "interrupted",
    ]);
    expect(session.events().at(-1)?.payload).toStrictEqual({ reason: "error" });
    expect(() => buildMessages(session.events())).not.toThrow();
  });

  it("executeBatch 抛错 → 补 tool_result_lost 与 interrupted(error) 后原错误上抛", async () => {
    const provider = scriptedProvider([
      reply("调用两个", [echoCall("c1"), echoCall("c2")]),
    ]);
    const registry = new ToolRegistry([echoTool]);
    const brokenTools = {
      all: () => registry.all(),
      lookup: () => {
        throw new Error("lookup exploded");
      },
    } as unknown as ToolRegistry;
    const { ctx, session } = await makeCtx(provider, { tools: brokenTools });

    await expect(collect(query(ctx, "x", { maxTurns: 10 }))).rejects.toThrow(
      "lookup exploded",
    );

    const assistant = session.events().find((event) => event.type === "assistant");
    const results = session.events().filter((event) => event.type === "tool_result");
    expect(results.map((event) => event.payload)).toStrictEqual([
      {
        id: "c1",
        ok: false,
        text: "tool result not recorded due to error",
        code: "tool_result_lost",
        toolName: "echo",
      },
      {
        id: "c2",
        ok: false,
        text: "tool result not recorded due to error",
        code: "tool_result_lost",
        toolName: "echo",
      },
    ]);
    expect(results.map((event) => event.parent)).toStrictEqual([
      assistant?.seq,
      assistant?.seq,
    ]);
    expect(
      session.events()
        .filter((event) => event.type === "interrupted")
        .map((event) => event.payload),
    ).toStrictEqual([{ reason: "error" }]);
    expect(() => buildMessages(session.events())).not.toThrow();
  });

  it("append 失败 → 补 tool_result_lost 与 interrupted(error),原错误上抛", async () => {
    const provider = scriptedProvider([
      reply("调用两个", [echoCall("c1"), echoCall("c2")], false, {
        promptTokens: 1,
        completionTokens: 1,
      }),
    ]);
    const { ctx, session } = await makeCtx(provider);
    let count = 0;
    const failing: SessionHandle = {
      id: session.id,
      dir: session.dir,
      header: session.header,
      append: async (event) => {
        count += 1;
        if (count === 5) throw new Error("append boom");
        return session.append(event);
      },
      events: () => session.events(),
      usageTotals: () => session.usageTotals(),
      close: () => session.close(),
    };
    ctx.session = failing;

    await expect(collect(query(ctx, "x", { maxTurns: 10 }))).rejects.toThrow(
      "append boom",
    );

    expect(session.events().map((event) => event.type)).toStrictEqual([
      "user",
      "checkpoint",
      "assistant",
      "usage",
      "tool_result",
      "tool_result",
      "interrupted",
    ]);
    const results = session.events().filter((event) => event.type === "tool_result");
    expect(results.map((event) => event.payload)).toStrictEqual([
      {
        id: "c1",
        ok: false,
        text: "tool result not recorded due to error",
        code: "tool_result_lost",
        toolName: "echo",
      },
      {
        id: "c2",
        ok: false,
        text: "tool result not recorded due to error",
        code: "tool_result_lost",
        toolName: "echo",
      },
    ]);
    expect(
      session.events().find((event) => event.type === "interrupted")?.payload,
    ).toStrictEqual({ reason: "error" });
    expect(
      session.events().some(
        (event) => event.type === "interrupted" && event.payload.reason === "consumer_closed",
      ),
    ).toBe(false);
    expect(() => buildMessages(session.events())).not.toThrow();
  });

  it("未知工具 → tool_result isError,循环继续至 done", async () => {
    const provider = scriptedProvider([
      reply("", [{ id: "c1", name: "ghost", arguments: {} }]),
      reply("done"),
    ]);
    const { ctx, session } = await makeCtx(provider);

    const events = await collect(query(ctx, "x", { maxTurns: 10 }));

    expect(events.map((event) => event.kind)).toEqual([
      "model_message",
      "tool_use",
      "tool_result",
      "model_message",
      "done",
    ]);
    expect(events[0]).toEqual({ kind: "model_message", content: "" });
    expect(events[2]).toMatchObject({ kind: "tool_result", id: "c1", ok: false });
    const logged = session.events().find((event) => event.type === "tool_result");
    expect(logged?.payload).toMatchObject({ id: "c1", ok: false, code: "tool_not_found" });
    expect(events.at(-1)).toEqual({ kind: "done", finishReason: "no_tool_calls" });
  });

  it("入参 schema 不符 → tool_result isError(schema_validation),循环继续", async () => {
    const provider = scriptedProvider([
      reply("", [{ id: "c1", name: "echo", arguments: { wrong: true } }]),
      reply("done"),
    ]);
    const { ctx, session } = await makeCtx(provider);

    const events = await collect(query(ctx, "x", { maxTurns: 10 }));

    expect(events[2]).toMatchObject({ kind: "tool_result", id: "c1", ok: false });
    const logged = session.events().find((event) => event.type === "tool_result");
    expect(logged?.payload).toMatchObject({ id: "c1", ok: false, code: "schema_validation" });
    expect(Array.isArray(logged?.payload.detail)).toBe(true);
    expect(events.at(-1)).toEqual({ kind: "done", finishReason: "no_tool_calls" });
  });

  it("invalid_json 标记分流: 不进 executeBatch,raw 保留且正常调用仍执行", async () => {
    const provider = scriptedProvider([
      reply("", [
        { id: "m1", name: "echo", arguments: { error: "invalid_json", raw: "{bad" }, invalidJson: true },
        echoCall("c2", "ok"),
      ]),
      reply("done"),
    ]);
    const { ctx, session } = await makeCtx(provider);

    const events = await collect(query(ctx, "x", { maxTurns: 10 }));

    expect(events.map((event) => event.kind)).toEqual([
      "model_message",
      "tool_use",
      "tool_use",
      "tool_result",
      "tool_result",
      "model_message",
      "done",
    ]);
    expect(events[1]).toEqual({
      kind: "tool_use",
      id: "m1",
      name: "echo",
      input: { error: "invalid_json", raw: "{bad" },
    });
    expect(events[3]).toMatchObject({ kind: "tool_result", id: "m1", ok: false });
    expect(String((events[3] as { text: string }).text)).toContain("{bad");
    expect(events[4]).toEqual({ kind: "tool_result", id: "c2", ok: true, text: "ok", code: "ok" });

    const logged = session.events().filter((event) => event.type === "tool_result");
    expect(logged.map((event) => event.payload.id)).toEqual(["m1", "c2"]);
    expect(logged[0].payload).toMatchObject({
      id: "m1",
      ok: false,
      code: "invalid_json",
      detail: { raw: "{bad" },
    });
    expect(String(logged[0].payload.text)).toContain("{bad");
    expect(logged[1].payload).toMatchObject({ id: "c2", ok: true, code: "ok" });
    const assistant = session.events().find((event) => event.type === "assistant");
    expect(logged[0].parent).toBe(assistant?.seq);
    expect(logged[1].parent).toBe(assistant?.seq);
  });

  it("模型输出形如 marker 的合法参数时照常执行工具(D-038)", async () => {
    const seen: unknown[] = [];
    const acceptsMarkerShape: ToolDef<{ error: "invalid_json"; raw: string }> = {
      name: "accept",
      description: "接受同形参数",
      schema: z.object({ error: z.literal("invalid_json"), raw: z.string() }),
      annotations: { readOnly: true },
      execute: async (input) => {
        seen.push(input);
        return { isError: false, code: "ok", message: "", text: JSON.stringify(input) };
      },
    };
    const provider = scriptedProvider([
      reply("", [
        {
          id: "c1",
          name: "accept",
          arguments: { error: "invalid_json", raw: '{"real":1}' },
        },
      ]),
      reply("done"),
    ]);
    const { ctx, session } = await makeCtx(provider, {
      tools: new ToolRegistry([acceptsMarkerShape]),
    });

    const events = await collect(query(ctx, "x", { maxTurns: 10 }));

    expect(seen).toStrictEqual([{ error: "invalid_json", raw: '{"real":1}' }]);
    expect(events.find((event) => event.kind === "tool_result")).toMatchObject({
      kind: "tool_result",
      id: "c1",
      ok: true,
      code: "ok",
    });
    expect(session.events().find((event) => event.type === "tool_result")?.payload).toMatchObject({
      id: "c1",
      ok: true,
      code: "ok",
    });
  });

  it("每轮 complete 前预算检查,超限时每轮最多压缩一次", async () => {
    let compactions = 0;
    const provider = scriptedProvider([reply("a", [echoCall("c1")]), reply("done")]);
    const { ctx } = await makeCtx(provider, {
      budget: () => ({ over: true, tokens: 100, softLimit: 10 }),
      compactor: async (session) => {
        compactions += 1;
        await session.append({ type: "user", payload: { content: `summary-${compactions}` } });
      },
    });

    const events = await collect(query(ctx, "x", { maxTurns: 10 }));

    expect(events.map((event) => event.kind)).toStrictEqual([
      "compacted",
      "model_message",
      "tool_use",
      "tool_result",
      "compacted",
      "model_message",
      "done",
    ]);
    expect(events.filter((event) => event.kind === "compacted")).toHaveLength(2);
    expect(compactions).toBe(2);
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[0].messages.map((message) => message.content)).toContain("summary-1");
    expect(provider.calls[1].messages.map((message) => message.content)).toContain("summary-2");
  });

  it("超限但无 compactor 时继续当前循环", async () => {
    const provider = scriptedProvider([reply("done")]);
    const { ctx } = await makeCtx(provider, {
      budget: () => ({ over: true, tokens: 100, softLimit: 10 }),
    });

    const events = await collect(query(ctx, "x", { maxTurns: 10 }));

    expect(events.map((event) => event.kind)).toEqual(["model_message", "done"]);
    expect(provider.calls).toHaveLength(1);
  });

  it("compactor 压缩后 yield compacted 且视图含摘要、不含旧工具结果", async () => {
    const provider = scriptedProvider([reply("done")]);
    const { ctx, session } = await makeCtx(provider, {
      budget: () => ({ over: true, tokens: 100, softLimit: 10 }),
    });
    const oldAssistant = await session.append({
      type: "assistant",
      payload: {
        content: "",
        toolCalls: [{ id: "old-1", name: "echo", arguments: { text: "old" } }],
      },
    });
    const oldResult = await session.append({
      type: "tool_result",
      payload: {
        id: "old-1",
        ok: true,
        text: "OLD-RESULT-MARKER",
        code: "ok",
        toolName: "echo",
      },
      parent: oldAssistant.seq,
    });
    ctx.compactor = async (target) => {
      await target.append({
        type: "compaction",
        payload: { kind: "summary", summary: "OLD-SUMMARY", coversUpToSeq: oldResult.seq },
      });
    };

    const events = await collect(query(ctx, "new input", { maxTurns: 10 }));

    expect(events.map((event) => event.kind)).toEqual(["compacted", "model_message", "done"]);
    const sent = provider.calls[0].messages;
    expect(sent.some((message) => message.content.includes("OLD-SUMMARY"))).toBe(true);
    expect(sent.some((message) => message.content.includes("OLD-RESULT-MARKER"))).toBe(false);
    expect(sent.at(-1)).toEqual({ role: "user", content: "new input" });
  });

  it("compactor 追加的 usage 在压缩后重算成本并触发 maxCostUsd", async () => {
    const provider = scriptedProvider([reply("", [echoCall("c1")]), reply("done")]);
    const { ctx } = await makeCtx(provider, {
      budget: () => ({ over: true, tokens: 100, softLimit: 10 }),
      pricePerMillion: { input: 1, output: 1 },
    });
    ctx.compactor = async (target) => {
      await target.append({
        type: "usage",
        payload: { promptTokens: 1_000_000, completionTokens: 0 },
      });
    };

    const events = await collect(query(ctx, "x", { maxTurns: 10, maxCostUsd: 0.5 }));

    expect(provider.calls).toHaveLength(1);
    expect(events.slice(-2)).toEqual([
      { kind: "interrupted", reason: "max_cost_usd" },
      { kind: "done", finishReason: "max_cost_usd" },
    ]);
  });

  it("compactor 抛 AbortError 时以 interrupted(aborted) 结束", async () => {
    const provider = scriptedProvider([reply("done")]);
    const { ctx } = await makeCtx(provider, {
      budget: () => ({ over: true, tokens: 100, softLimit: 10 }),
      compactor: async () => {
        throw new DOMException("The operation was aborted", "AbortError");
      },
    });

    const events = await collect(query(ctx, "x", { maxTurns: 10 }));

    expect(events).toEqual([
      { kind: "interrupted", reason: "aborted" },
      { kind: "done", finishReason: "aborted" },
    ]);
    expect(provider.calls).toHaveLength(0);
  });

  it("complete 后 observe 更新测量,使下一轮 budget 超限并触发 compactor", async () => {
    let ratio = 1;
    const observed: Array<{ promptTokens: number; messages: ModelChatMessage[] }> = [];
    const meter = {
      measure(messages: ModelChatMessage[]) {
        const raw = messages.reduce(
          (total, message) => total + Math.ceil(message.content.length / 4),
          0,
        );
        return raw * ratio;
      },
      observe(promptTokens: number, messages: ModelChatMessage[]) {
        observed.push({ promptTokens, messages });
        ratio = 100;
      },
      ratio() {
        return ratio;
      },
    };
    let compactions = 0;
    const provider = scriptedProvider([
      reply("", [echoCall("c1")], false, { promptTokens: 1000, completionTokens: 1 }),
      reply("done", [], false, { promptTokens: 20, completionTokens: 1 }),
    ]);
    const { ctx } = await makeCtx(provider, {
      meter,
      budget: (messages) => ({
        over: meter.measure(messages) > 10,
        tokens: meter.measure(messages),
        softLimit: 10,
      }),
      compactor: async (target) => {
        compactions += 1;
        await target.append({
          type: "compaction",
          payload: { kind: "microcompact", elidedSeqs: [], note: "noop" },
        });
      },
    });

    const events = await collect(query(ctx, "x", { maxTurns: 10 }));

    expect(observed).toHaveLength(2);
    expect(observed[0].promptTokens).toBe(1000);
    expect(observed[0].messages).toEqual(provider.calls[0].messages);
    expect(compactions).toBe(1);
    expect(events.map((event) => event.kind)).toEqual([
      "model_message",
      "tool_use",
      "tool_result",
      "compacted",
      "model_message",
      "done",
    ]);
  });

  it("cwd/timeoutMs/artifactDir 透传至 executeBatch", async () => {
    let capturedCwd = "";
    const whereTool: ToolDef<{}> = {
      name: "where",
      description: "记录 cwd",
      schema: z.object({}),
      annotations: { readOnly: true },
      execute: async (_input, toolCtx) => {
        capturedCwd = toolCtx.cwd;
        return { isError: false, code: "ok", message: "", text: toolCtx.cwd };
      },
    };
    const slowTool: ToolDef<{}> = {
      name: "slow",
      description: "慢工具",
      schema: z.object({}),
      annotations: { readOnly: true },
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { isError: false, code: "ok", message: "", text: "late" };
      },
    };
    const bigTool: ToolDef<{}> = {
      name: "big",
      description: "大输出",
      schema: z.object({}),
      annotations: { readOnly: true },
      execute: async () => ({ isError: false, code: "ok", message: "", text: "x".repeat(40000) }),
    };
    const provider = scriptedProvider([
      reply("", [{ id: "w1", name: "where", arguments: {} }]),
      reply("", [{ id: "s1", name: "slow", arguments: {} }]),
      reply("", [{ id: "b1", name: "big", arguments: {} }]),
      reply("done"),
    ]);
    const { ctx, session } = await makeCtx(provider, {
      tools: new ToolRegistry([whereTool, slowTool, bigTool]),
      cwd: "C:/workspace-custom",
      timeoutMs: 5,
    });

    const events = await collect(query(ctx, "x", { maxTurns: 10 }));

    expect(capturedCwd).toBe("C:/workspace-custom");
    const results = session.events().filter((event) => event.type === "tool_result");
    expect(results[0].payload).toMatchObject({ id: "w1", ok: true, text: "C:/workspace-custom" });
    expect(results[1].payload).toMatchObject({ id: "s1", ok: false, code: "tool_timeout" });
    expect(results[2].payload.code).toBe("ok");
    const artifactPath = results[2].payload.artifactPath;
    expect(typeof artifactPath).toBe("string");
    expect(existsSync(String(artifactPath))).toBe(true);
    expect(path.dirname(String(artifactPath))).toBe(ctx.artifactDir);
    expect(events.at(-1)).toEqual({ kind: "done", finishReason: "no_tool_calls" });
  });

  it("ctx.systemPrompt 在会话无 system 时补齐,已有 system 时不重复", async () => {
    const first = scriptedProvider([reply("done")]);
    const created = await makeCtx(first, { systemPrompt: "SYS" });
    await collect(query(created.ctx, "x", { maxTurns: 10 }));
    expect(created.session.events().filter((event) => event.type === "system")).toHaveLength(1);
    expect(created.session.events()[0]).toMatchObject({
      type: "system",
      payload: { content: "SYS" },
    });

    const second = scriptedProvider([reply("done")]);
    const existing = await makeCtx(second, { systemPrompt: "SYS" }, "SYS");
    await collect(query(existing.ctx, "x", { maxTurns: 10 }));
    expect(existing.session.events().filter((event) => event.type === "system")).toHaveLength(1);
  });

  it("会话非空且无 system 时提供 systemPrompt → throw", async () => {
    const provider = scriptedProvider([]);
    const { ctx, session } = await makeCtx(provider, { systemPrompt: "SYS" });
    await session.append({ type: "user", payload: { content: "earlier" } });

    await expect(collect(query(ctx, "x", { maxTurns: 10 }))).rejects.toThrow(/systemPrompt/);

    expect(session.events().filter((event) => event.type === "system")).toHaveLength(0);
    expect(session.events().map((event) => event.type)).toStrictEqual(["user"]);
    expect(provider.calls).toHaveLength(0);
  });
});
