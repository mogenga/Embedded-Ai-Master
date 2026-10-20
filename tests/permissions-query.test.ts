import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { buildMessages } from "../src/context/build.js";
import type { LoopEvent } from "../src/loop/events.js";
import type { LoopCtx } from "../src/loop/query.js";
import { query } from "../src/loop/query.js";
import type {
  CompletionResult,
  ModelChatMessage,
  ModelProtocol,
  ModelToolSchema,
} from "../src/model/protocol.js";
import { forkSession } from "../src/session/persistence.js";
import type { SessionHandle } from "../src/session/session.js";
import { createSession, resumeSession } from "../src/session/session.js";
import { echoTool } from "../src/tools/echo.js";
import type {
  PermissionCheckInput,
  PermissionGate,
  PermissionRequest,
} from "../src/permissions/types.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { ToolDef } from "../src/tools/types.js";

const tempDirs: string[] = [];
const sessions: SessionHandle[] = [];

async function makeSession(): Promise<{ session: SessionHandle; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "permissions-query-"));
  tempDirs.push(dir);
  const session = await createSession(dir);
  sessions.push(session);
  return { session, dir };
}

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

interface CompleteCall {
  messages: ModelChatMessage[];
  tools: ModelToolSchema[];
  maxOutputTokens: number;
  signal: AbortSignal;
}

function scriptedProvider(
  sequence: Array<CompletionResult | Error>,
): ModelProtocol & { calls: CompleteCall[] } {
  let index = 0;
  const calls: CompleteCall[] = [];
  return {
    calls,
    async complete(messages, tools, opts) {
      calls.push({
        messages,
        tools,
        maxOutputTokens: opts.maxOutputTokens,
        signal: opts.signal,
      });
      if (index >= sequence.length) throw new Error("script exhausted");
      const item = sequence[index];
      index += 1;
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
): CompletionResult {
  return { content, toolCalls, truncatedByMaxTokens: false, stopReason: null };
}

const echoCall = (id: string, text = "hi"): CompletionResult["toolCalls"][number] => ({
  id,
  name: "echo",
  arguments: { text },
});

function decisionFor(
  input: PermissionCheckInput,
  overrides: Partial<PermissionRequest> = {},
): PermissionRequest {
  return {
    requestId: `req-${input.callId}`,
    callId: input.callId,
    tool: input.tool.name,
    args: input.args,
    access: "read",
    action: "allow",
    effective: "allow",
    reason: "test:allow",
    preset: "read-only",
    source: "builtin",
    paramsDigest: `digest:${input.callId}`,
    paramsKeys: Object.keys(input.args as Record<string, unknown>).sort(),
    ...overrides,
  };
}

function fakeGate(
  decide: (input: PermissionCheckInput) => PermissionRequest = (input) => decisionFor(input),
): PermissionGate {
  return { check: async (input) => decide(input) };
}

async function makeCtx(
  model: ModelProtocol,
  overrides: Partial<LoopCtx> = {},
): Promise<{ ctx: LoopCtx; session: SessionHandle; dir: string }> {
  const { session, dir } = await makeSession();
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

describe("query 权限审计", () => {
  it("permission_decision 先于 tool_result 落日志,parent 指向 assistant", async () => {
    const provider = scriptedProvider([
      reply("调用两个", [echoCall("c1", "a"), echoCall("c2", "b")]),
      reply("完成"),
    ]);
    const gate = fakeGate((input) =>
      decisionFor(input, { ruleIndex: 2, paramsPreview: { text: "a" } }),
    );
    const { ctx, session } = await makeCtx(provider, { permissionGate: gate });

    await collect(query(ctx, "x", { maxTurns: 10 }));

    const logged = session.events();
    const assistant = logged.find((event) => event.type === "assistant");
    expect(assistant).toBeDefined();
    const audits = logged.filter((event) => event.type === "permission_decision");
    const results = logged.filter((event) => event.type === "tool_result");

    expect(audits).toHaveLength(2);
    expect(results).toHaveLength(2);
    expect(audits.every((event) => event.parent === assistant?.seq)).toBe(true);
    expect(results.every((event) => event.parent === assistant?.seq)).toBe(true);
    expect(audits.map((event) => event.payload.callId)).toStrictEqual(["c1", "c2"]);
    expect(results.map((event) => event.payload.id)).toStrictEqual(["c1", "c2"]);
    for (let index = 0; index < audits.length; index += 1) {
      expect(audits[index]!.seq).toBeLessThan(results[index]!.seq);
    }
    expect(audits[0]!.payload).toStrictEqual({
      requestId: "req-c1",
      callId: "c1",
      tool: "echo",
      action: "allow",
      effective: "allow",
      reason: "test:allow",
      preset: "read-only",
      source: "builtin",
      ruleIndex: 2,
      paramsDigest: "digest:c1",
      paramsKeys: ["text"],
      paramsPreview: { text: "a" },
      access: "read",
    });
    expect(results.map((event) => event.payload.code)).toStrictEqual(["ok", "ok"]);
  });

  it("同一 assistant 批次多个同名调用按 callId 区分审计", async () => {
    const provider = scriptedProvider([
      reply("调用三次", [echoCall("c1", "a"), echoCall("c2", "b"), echoCall("c3", "c")]),
      reply("完成"),
    ]);
    const { ctx, session } = await makeCtx(provider, { permissionGate: fakeGate() });

    await collect(query(ctx, "x", { maxTurns: 10 }));

    const logged = session.events();
    const audits = logged.filter((event) => event.type === "permission_decision");
    const results = logged.filter((event) => event.type === "tool_result");
    expect(audits.map((event) => event.payload.callId)).toStrictEqual(["c1", "c2", "c3"]);
    expect(results.map((event) => event.payload.id)).toStrictEqual(["c1", "c2", "c3"]);
    expect(audits.map((event) => event.payload.paramsDigest)).toStrictEqual([
      "digest:c1",
      "digest:c2",
      "digest:c3",
    ]);
    expect(new Set(audits.map((event) => event.payload.callId)).size).toBe(3);
  });

  it("deny → 不执行工具,tool_result 为 permission_denied 且审计记 deny", async () => {
    const execute = vi.fn(async () => ({
      isError: false,
      code: "ok",
      message: "",
      text: "never",
    }));
    const tool: ToolDef<{ text: string }> = {
      name: "echo",
      description: "spy",
      schema: z.object({ text: z.string() }),
      annotations: { readOnly: true },
      execute,
    };
    const provider = scriptedProvider([
      reply("调用", [echoCall("c1")]),
      reply("完成"),
    ]);
    const gate = fakeGate((input) =>
      decisionFor(input, {
        action: "deny",
        effective: "deny",
        reason: "rule:deny",
        ruleIndex: 0,
      }),
    );
    const { ctx, session } = await makeCtx(provider, {
      tools: new ToolRegistry([tool]),
      permissionGate: gate,
    });

    const events = await collect(query(ctx, "x", { maxTurns: 10 }));

    expect(execute).not.toHaveBeenCalled();
    const result = events.find((event) => event.kind === "tool_result");
    expect(result).toMatchObject({
      kind: "tool_result",
      id: "c1",
      ok: false,
      code: "permission_denied",
    });
    const logged = session.events();
    const audit = logged.find((event) => event.type === "permission_decision");
    expect(audit?.payload).toMatchObject({
      callId: "c1",
      action: "deny",
      effective: "deny",
      reason: "rule:deny",
      ruleIndex: 0,
    });
    const toolResult = logged.find((event) => event.type === "tool_result");
    expect(toolResult?.payload.code).toBe("permission_denied");
    expect(audit!.seq).toBeLessThan(toolResult!.seq);
    expect(events.at(-1)).toEqual({ kind: "done", finishReason: "no_tool_calls" });
  });

  it("serial batch writes audit before each result and omits absent optional fields", async () => {
    // 写工具(readOnly:false)走串行路径:审计 → tool_result → 下一次调用。
    const execute = vi.fn(async () => ({
      isError: false,
      code: "ok",
      message: "",
      text: "done",
    }));
    const writer: ToolDef<{ text: string }> = {
      name: "writer",
      description: "serial",
      schema: z.object({ text: z.string() }),
      annotations: { readOnly: false },
      execute,
    };
    const call = (id: string): CompletionResult["toolCalls"][number] => ({
      id,
      name: "writer",
      arguments: { text: id },
    });
    const provider = scriptedProvider([
      reply("调用两次", [call("s1"), call("s2")]),
      reply("完成"),
    ]);
    const { ctx, session } = await makeCtx(provider, {
      tools: new ToolRegistry([writer]),
      permissionGate: fakeGate(),
    });

    await collect(query(ctx, "x", { maxTurns: 10 }));

    const logged = session.events();
    const audits = logged.filter((event) => event.type === "permission_decision");
    const results = logged.filter((event) => event.type === "tool_result");
    expect(audits.map((event) => event.payload.callId)).toStrictEqual(["s1", "s2"]);
    expect(results.map((event) => event.payload.id)).toStrictEqual(["s1", "s2"]);
    for (let index = 0; index < audits.length; index += 1) {
      expect(audits[index]!.seq).toBeLessThan(results[index]!.seq);
    }
    // fake gate 未提供 ruleIndex/paramsPreview,事件里不应出现这两个键。
    for (const audit of audits) {
      expect(Object.hasOwn(audit.payload, "ruleIndex")).toBe(false);
      expect(Object.hasOwn(audit.payload, "paramsPreview")).toBe(false);
    }
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("未提供 permissionGate 时保持既有行为,不落审计事件", async () => {
    const provider = scriptedProvider([
      reply("调用", [echoCall("c1", "ok")]),
      reply("完成"),
    ]);
    const { ctx, session } = await makeCtx(provider);

    await collect(query(ctx, "x", { maxTurns: 10 }));

    expect(session.events().some((event) => event.type === "permission_decision")).toBe(false);
    expect(session.events().find((event) => event.type === "tool_result")?.payload).toMatchObject({
      id: "c1",
      ok: true,
      text: "ok",
      code: "ok",
    });
  });

  it("含 permission_decision 的日志可连续投影、resume 与 fork", async () => {
    const provider = scriptedProvider([
      reply("调用", [echoCall("c1", "a"), echoCall("c2", "b")]),
      reply("完成"),
    ]);
    const { ctx, session, dir } = await makeCtx(provider, { permissionGate: fakeGate() });

    await collect(query(ctx, "x", { maxTurns: 10 }));

    const first = buildMessages(session.events());
    const second = buildMessages(session.events());
    expect(second).toStrictEqual(first);
    expect(first.map((message) => message.role)).toStrictEqual([
      "user",
      "assistant",
      "tool",
      "tool",
      "assistant",
    ]);
    expect(first.some((message) => message.content.includes("permission_decision"))).toBe(false);

    const resumed = await resumeSession(dir);
    sessions.push(resumed);
    expect(() => buildMessages(resumed.events())).not.toThrow();
    expect(resumed.events().filter((event) => event.type === "permission_decision")).toHaveLength(2);

    const targetDir = await mkdtemp(path.join(tmpdir(), "permissions-query-fork-"));
    tempDirs.push(targetDir);
    const lastSeq = session.events().at(-1)!.seq;
    const forked = await forkSession(dir, lastSeq, {
      targetDir: path.join(targetDir, "fork"),
      id: "fork-permissions",
    });
    sessions.push(forked);
    expect(forked.events().filter((event) => event.type === "permission_decision")).toHaveLength(2);
    expect(() => buildMessages(forked.events())).not.toThrow();
  });

  it("审计写失败 → 工具不执行,补 tool_result_lost 并上抛", async () => {
    const execute = vi.fn(async () => ({
      isError: false,
      code: "ok",
      message: "",
      text: "never",
    }));
    const tool: ToolDef<{ text: string }> = {
      name: "echo",
      description: "spy",
      schema: z.object({ text: z.string() }),
      annotations: { readOnly: true },
      execute,
    };
    const provider = scriptedProvider([reply("调用", [echoCall("c1")])]);
    const { ctx, session } = await makeCtx(provider, {
      tools: new ToolRegistry([tool]),
      permissionGate: fakeGate(),
    });
    const failing: SessionHandle = {
      id: session.id,
      dir: session.dir,
      header: session.header,
      append: async (event) => {
        if (event.type === "permission_decision") throw new Error("audit boom");
        return session.append(event);
      },
      events: () => session.events(),
      usageTotals: () => session.usageTotals(),
      close: () => session.close(),
    };
    ctx.session = failing;

    await expect(collect(query(ctx, "x", { maxTurns: 10 }))).rejects.toThrow("audit boom");

    expect(execute).not.toHaveBeenCalled();
    expect(session.events().some((event) => event.type === "permission_decision")).toBe(false);
    const result = session.events().find((event) => event.type === "tool_result");
    expect(result?.payload).toMatchObject({ id: "c1", ok: false, code: "tool_result_lost" });
    expect(
      session.events().find((event) => event.type === "interrupted")?.payload,
    ).toStrictEqual({ reason: "error" });
    expect(() => buildMessages(session.events())).not.toThrow();
  });
});
