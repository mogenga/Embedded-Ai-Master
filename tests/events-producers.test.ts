import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createLogTailEventSource } from "../src/events/log-tail.js";
import { appendMcpStatus, toMcpStatusPayload } from "../src/index.js";
import type { McpSessionStatus } from "../src/index.js";
import type { LoopEvent } from "../src/loop/events.js";
import type { LoopCtx } from "../src/loop/query.js";
import { query } from "../src/loop/query.js";
import type {
  CompletionResult,
  ModelChatMessage,
  ModelProtocol,
  ModelToolSchema,
} from "../src/model/protocol.js";
import type { McpStatusEvent } from "../src/mcp/manager.js";
import type {
  PermissionCheckInput,
  PermissionGate,
  PermissionRequest,
} from "../src/permissions/types.js";
import { createSession } from "../src/session/session.js";
import type { SessionHandle } from "../src/session/session.js";
import type { SessionEvent } from "../src/session/types.js";
import { echoTool } from "../src/tools/echo.js";
import { executeBatch } from "../src/tools/pipeline.js";
import type { BatchCall, BatchOptions, PermissionOptions } from "../src/tools/pipeline.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { ToolAnnotations, ToolDef, ToolResult } from "../src/tools/types.js";

const tempDirs: string[] = [];
const sessions: SessionHandle[] = [];

async function makeTempDir(prefix = "events-producers-"): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function removeTempDir(dir: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOTEMPTY" || attempt >= 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close().catch(() => undefined);
  for (const dir of tempDirs.splice(0)) await removeTempDir(dir);
});

function makeFakeSession(
  events: SessionEvent[],
  failOn?: (event: Omit<SessionEvent, "seq" | "ts">) => boolean,
): SessionHandle {
  let seq = 0;
  return {
    id: "sess-1",
    dir: path.join(tmpdir(), "events-producers-fake"),
    header: { id: "sess-1", createdAt: "2026-10-19T00:00:00.000Z", status: "open" },
    append: async (event) => {
      if (failOn?.(event) === true) throw new Error("append boom");
      const stored: SessionEvent = {
        seq,
        ts: "2026-10-19T00:00:00.000Z",
        type: event.type,
        payload: event.payload,
        ...(event.parent === undefined ? {} : { parent: event.parent }),
      };
      seq += 1;
      events.push(stored);
      return stored;
    },
    events: () => events,
    usageTotals: () => ({ promptTokens: 0, completionTokens: 0, cachedTokens: 0 }),
    close: async () => {},
  };
}

function ok(text: string): ToolResult {
  return { isError: false, code: "ok", message: "", text };
}

function makeTool<I>(
  name: string,
  schema: z.ZodType<I>,
  execute: ToolDef<I>["execute"],
  annotations: ToolAnnotations = {},
  access?: ToolDef<I>["access"],
): ToolDef<I> {
  return {
    name,
    description: "",
    schema,
    annotations,
    execute,
    ...(access === undefined ? {} : { access }),
  };
}

function call(id: string, name: string, input: unknown = {}): BatchCall {
  return { id, name, input };
}

function decisionFor(
  input: PermissionCheckInput,
  overrides: Partial<PermissionRequest> = {},
): PermissionRequest {
  return {
    requestId: `req-${input.callId}`,
    callId: input.callId,
    tool: input.tool.name,
    args: input.args,
    access: "write",
    action: "allow",
    effective: "allow",
    reason: "test:allow",
    preset: "diagnose",
    source: "builtin",
    paramsDigest: "digest",
    paramsKeys: [],
    ...overrides,
  };
}

function fakeGate(
  decide: (input: PermissionCheckInput) => PermissionRequest = (input) => decisionFor(input),
): PermissionGate {
  return { check: async (input) => decide(input) };
}

function permissionOf(
  gate: PermissionGate,
  onDecision: PermissionOptions["onDecision"],
): PermissionOptions {
  return { gate, onDecision };
}

function optsOf(
  overrides: Partial<BatchOptions> = {},
  permission?: PermissionOptions,
): BatchOptions {
  return {
    signal: overrides.signal ?? new AbortController().signal,
    artifactDir: path.join(tmpdir(), "events-producers-artifacts"),
    ...overrides,
    ...(permission === undefined ? {} : { permission }),
  };
}

describe("pipeline tool_started 生产者", () => {
  it("started 在审计之后、execute 之前，access 来自 decision", async () => {
    const logged: SessionEvent[] = [];
    const order: string[] = [];
    const session = makeFakeSession(logged);
    const tool = makeTool(
      "writer",
      z.object({ op: z.string() }),
      async () => {
        order.push("execute");
        return ok("done");
      },
      { readOnly: false },
      () => "read",
    );
    const reg = new ToolRegistry([tool]);
    const onDecision = vi.fn(async () => {
      order.push("audit");
    });
    const onToolStarted = vi.fn(async (batchCall: BatchCall, access: string) => {
      order.push("started");
      await session.append({
        type: "tool_started",
        payload: { callId: batchCall.id, tool: batchCall.name, access },
      });
    });

    const results = await executeBatch(
      session,
      reg,
      [call("c1", "writer", { op: "write" })],
      optsOf({ onToolStarted }, permissionOf(fakeGate(), onDecision)),
    );

    expect(order).toEqual(["audit", "started", "execute"]);
    expect(onToolStarted).toHaveBeenCalledTimes(1);
    expect(onToolStarted.mock.calls[0]![0]).toEqual({
      id: "c1",
      name: "writer",
      input: { op: "write" },
    });
    expect(onToolStarted.mock.calls[0]![1]).toBe("write");
    const started = logged.find((event) => event.type === "tool_started");
    expect(started?.payload).toEqual({ callId: "c1", tool: "writer", access: "write" });
    expect(results[0]!.result.code).toBe("ok");
  });

  it("deny 的调用没有 tool_started 且不执行", async () => {
    const logged: SessionEvent[] = [];
    const session = makeFakeSession(logged);
    const execute = vi.fn(async () => ok("never"));
    const reg = new ToolRegistry([
      makeTool("writer", z.object({}), execute, { readOnly: false }),
    ]);
    const onToolStarted = vi.fn(async () => {});
    const gate = fakeGate((input) =>
      decisionFor(input, { action: "deny", effective: "deny", reason: "rule:deny" }),
    );

    const results = await executeBatch(
      session,
      reg,
      [call("c1", "writer")],
      optsOf({ onToolStarted }, permissionOf(gate, async () => {})),
    );

    expect(onToolStarted).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(logged.some((event) => event.type === "tool_started")).toBe(false);
    expect(results[0]!.result.code).toBe("permission_denied");
  });

  it("onToolStarted 抛错 → 该调用不执行，且不为它留下孤儿 started", async () => {
    const logged: SessionEvent[] = [];
    const session = makeFakeSession(logged);
    const first = vi.fn(async () => ok("first"));
    const second = vi.fn(async () => ok("never"));
    const reg = new ToolRegistry([
      makeTool("a", z.object({}), first, { readOnly: false }),
      makeTool("b", z.object({}), second, { readOnly: false }),
    ]);
    const onToolStarted = vi.fn(async (batchCall: BatchCall) => {
      if (batchCall.id === "2") throw new Error("started boom");
      await session.append({
        type: "tool_started",
        payload: { callId: batchCall.id, tool: batchCall.name, access: "write" },
      });
    });

    await expect(
      executeBatch(
        session,
        reg,
        [call("1", "a"), call("2", "b")],
        optsOf({ onToolStarted }, permissionOf(fakeGate(), async () => {})),
      ),
    ).rejects.toThrow("started boom");

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    const startedIds = logged
      .filter((event) => event.type === "tool_started")
      .map((event) => event.payload.callId);
    expect(startedIds).toEqual(["1"]);
  });

  it("onToolStarted 期间中止 → 该调用不执行，返回 tool_aborted", async () => {
    const logged: SessionEvent[] = [];
    const session = makeFakeSession(logged);
    const controller = new AbortController();
    const execute = vi.fn(async () => ok("never"));
    const reg = new ToolRegistry([
      makeTool("writer", z.object({}), execute, { readOnly: false }),
    ]);
    const onToolStarted = vi.fn(async (batchCall: BatchCall) => {
      await session.append({
        type: "tool_started",
        payload: { callId: batchCall.id, tool: batchCall.name, access: "write" },
      });
      controller.abort();
    });

    const results = await executeBatch(
      session,
      reg,
      [call("c1", "writer")],
      optsOf({ onToolStarted, signal: controller.signal }),
    );

    expect(onToolStarted).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(results[0]!.result).toMatchObject({
      isError: true,
      code: "tool_aborted",
      message: "tool aborted before execution",
    });
  });

  it("并发只读批次：每个调用在自身 execute 前写 started，允许交错", async () => {
    const logged: SessionEvent[] = [];
    const order: string[] = [];
    const session = makeFakeSession(logged);
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const makeWriter = (name: string): ToolDef<{}> =>
      makeTool(
        name,
        z.object({}),
        async () => {
          order.push(`execute:${name}`);
          return ok(name);
        },
        { readOnly: true },
      );
    const reg = new ToolRegistry([makeWriter("a"), makeWriter("b")]);
    const onToolStarted = async (batchCall: BatchCall): Promise<void> => {
      order.push(`started-begin:${batchCall.id}`);
      if (batchCall.id === "1") await firstGate;
      await session.append({
        type: "tool_started",
        payload: { callId: batchCall.id, tool: batchCall.name, access: "unknown" },
      });
      order.push(`started-end:${batchCall.id}`);
      if (batchCall.id === "2") releaseFirst();
    };

    const results = await executeBatch(
      session,
      reg,
      [call("1", "a"), call("2", "b")],
      optsOf({ onToolStarted }),
    );

    expect(results.map((entry) => entry.result.code)).toEqual(["ok", "ok"]);
    const starts = order.filter((entry) => entry.startsWith("started-end:"));
    expect(starts).toHaveLength(2);
    expect(order.slice(0, 4)).toEqual([
      "started-begin:1",
      "started-begin:2",
      "started-end:2",
      "started-end:1",
    ]);
    for (const [id, name] of [["1", "a"], ["2", "b"]] as const) {
      expect(order.indexOf(`started-end:${id}`)).toBeLessThan(order.indexOf(`execute:${name}`));
    }
    expect(logged.filter((event) => event.type === "tool_started")).toHaveLength(2);
  });

  it("无 permission gate 时 access 回退 tool.access(input) ?? unknown", async () => {
    const session = makeFakeSession([]);
    const reg = new ToolRegistry([
      makeTool(
        "classifier",
        z.object({ op: z.string() }),
        async () => ok("done"),
        { readOnly: false },
        (input) => (input.op === "write" ? "write" : "read"),
      ),
      makeTool("plain", z.object({}), async () => ok("done"), { readOnly: false }),
    ]);
    const accesses: Array<[string, string]> = [];
    const onToolStarted = async (batchCall: BatchCall, access: string): Promise<void> => {
      accesses.push([batchCall.id, access]);
    };

    await executeBatch(
      session,
      reg,
      [call("c1", "classifier", { op: "write" }), call("c2", "plain")],
      optsOf({ onToolStarted }),
    );

    expect(accesses).toEqual([
      ["c1", "write"],
      ["c2", "unknown"],
    ]);
  });
});

describe("toMcpStatusPayload", () => {
  const MANAGER_KINDS = [
    "connected",
    "connect_failed",
    "tools_changed",
    "tools_refresh_failed",
    "tool_invalid_schema",
    "listener_failed",
    "call_failed",
  ] as const;

  it.each(MANAGER_KINDS)("manager kind %s 保留 server/tool/toolCount/message/attempts", (kind) => {
    const event: McpStatusEvent = {
      kind,
      server: "probe",
      tool: "mem_read",
      toolCount: 3,
      message: "boom",
      attempts: 2,
    };

    expect(toMcpStatusPayload(event)).toEqual({
      kind,
      server: "probe",
      tool: "mem_read",
      toolCount: 3,
      message: "boom",
      attempts: 2,
    });
  });

  it("配置/命名 4 种旧 status 去掉 mcp_ 前缀并保留 name/originalName/scope", () => {
    expect(
      toMcpStatusPayload({ status: "mcp_config_failed", message: "bad config" }),
    ).toEqual({ kind: "config_failed", message: "bad config" });
    expect(
      toMcpStatusPayload({
        status: "mcp_config_warning",
        server: "probe",
        message: "bad field",
      }),
    ).toEqual({ kind: "config_warning", server: "probe", message: "bad field" });
    expect(
      toMcpStatusPayload({
        status: "mcp_project_config_skipped",
        message: "/work/.harness/mcp.json",
      }),
    ).toEqual({ kind: "project_config_skipped", message: "/work/.harness/mcp.json" });
    expect(
      toMcpStatusPayload({
        status: "mcp_tool_name_renamed",
        server: "probe",
        tool: "mem_read",
        name: "mcp__probe__mem_read_2",
        originalName: "mcp__probe__mem_read",
      }),
    ).toEqual({
      kind: "tool_name_renamed",
      server: "probe",
      tool: "mem_read",
      name: "mcp__probe__mem_read_2",
      originalName: "mcp__probe__mem_read",
    });
  });

  it("旧 status 的全局刷新失败保留 scope 与 toolCount", () => {
    expect(
      toMcpStatusPayload({
        status: "mcp_tools_refresh_failed",
        scope: "global",
        message: "refresh boom",
      }),
    ).toEqual({ kind: "tools_refresh_failed", scope: "global", message: "refresh boom" });
  });

  it("11 种 kind 全部可映射", () => {
    const kinds = new Set([
      ...MANAGER_KINDS,
      "config_failed",
      "config_warning",
      "project_config_skipped",
      "tool_name_renamed",
    ]);
    expect(kinds.size).toBe(11);
  });

  it("未知 kind 返回 undefined 并写 stderr，不抛错", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(
        toMcpStatusPayload({
          kind: "future_kind",
        } as unknown as McpStatusEvent),
      ).toBeUndefined();
      expect(
        toMcpStatusPayload({
          status: "mcp_future_kind",
        } as unknown as McpSessionStatus),
      ).toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("[mcp] unknown status event skipped: future_kind"),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("appendMcpStatus", () => {
  it("写入 type=mcp_status 并返回 true", async () => {
    const logged: SessionEvent[] = [];
    const session = makeFakeSession(logged);

    const result = await appendMcpStatus(session, {
      kind: "call_failed",
      server: "probe",
      message: "call boom",
    });

    expect(result).toBe(true);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      type: "mcp_status",
      payload: { kind: "call_failed", server: "probe", message: "call boom" },
    });
  });

  it("写入失败返回 false、写 stderr 且不抛出", async () => {
    const session = makeFakeSession([], (event) => event.type === "mcp_status");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await appendMcpStatus(session, { kind: "connected", server: "probe" });

      expect(result).toBe(false);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("[mcp] status event append failed: append boom"),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("query tool_started 生命周期", () => {
  function scriptedProvider(
    sequence: Array<CompletionResult | Error>,
  ): ModelProtocol & { calls: Array<{ messages: ModelChatMessage[]; tools: ModelToolSchema[] }> } {
    let index = 0;
    const calls: Array<{ messages: ModelChatMessage[]; tools: ModelToolSchema[] }> = [];
    return {
      calls,
      async complete(messages, tools) {
        calls.push({ messages, tools });
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

  async function makeCtx(
    model: ModelProtocol,
    overrides: Partial<LoopCtx> = {},
  ): Promise<{ ctx: LoopCtx; session: SessionHandle; dir: string }> {
    const dir = await makeTempDir("events-producers-query-");
    const session = await createSession(dir);
    sessions.push(session);
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

  it("顺序 permission_decision → tool_started → tool_result，parent 指向 assistant", async () => {
    const provider = scriptedProvider([
      reply("调用", [{ id: "c1", name: "echo", arguments: { text: "a" } }]),
      reply("完成"),
    ]);
    const gate = fakeGate((input) => decisionFor(input, { access: "write" }));
    const { ctx, session } = await makeCtx(provider, { permissionGate: gate });

    await collect(query(ctx, "x", { maxTurns: 10 }));

    const logged = session.events();
    const assistant = logged.find((event) => event.type === "assistant");
    expect(assistant).toBeDefined();
    const decision = logged.find((event) => event.type === "permission_decision");
    const started = logged.find((event) => event.type === "tool_started");
    const result = logged.find((event) => event.type === "tool_result");
    expect(decision).toBeDefined();
    expect(started).toBeDefined();
    expect(result).toBeDefined();
    expect(decision!.seq).toBeLessThan(started!.seq);
    expect(started!.seq).toBeLessThan(result!.seq);
    expect(started!.parent).toBe(assistant!.seq);
    expect(started!.payload).toEqual({ callId: "c1", tool: "echo", access: "write" });
  });

  it("无 permission gate 时 access 回退为 unknown", async () => {
    const provider = scriptedProvider([
      reply("调用", [{ id: "c1", name: "echo", arguments: { text: "a" } }]),
      reply("完成"),
    ]);
    const { ctx, session } = await makeCtx(provider);

    await collect(query(ctx, "x", { maxTurns: 10 }));

    const started = session.events().find((event) => event.type === "tool_started");
    expect(started?.payload).toEqual({ callId: "c1", tool: "echo", access: "unknown" });
  });
});

describe("MCP 状态日志兼容", () => {
  function withTimeout<T>(promise: Promise<T>, ms = 2_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  async function nextEvent<T extends SessionEvent>(
    iterator: AsyncIterator<T>,
    ms = 2_000,
  ): Promise<T> {
    const next = await withTimeout(iterator.next(), ms);
    if (next.done === true) throw new Error("iterator ended unexpectedly");
    return next.value;
  }

  it("旧 status + mcp_connected 仍可投影，且不合成重复 mcp_status", async () => {
    const root = await makeTempDir("events-producers-legacy-");
    const dir = path.join(root, "sess-legacy");
    const session = await createSession(dir, { id: "sess-legacy" });
    sessions.push(session);
    await session.append({
      type: "status",
      payload: { status: "mcp_connected", server: "echo", toolCount: 1 },
    });

    const source = createLogTailEventSource({ sessionsRoot: root });
    const { events } = await source.read("sess-legacy", -1);

    expect(events.map((event) => event.type)).toEqual(["status"]);
    expect(events[0]!.payload).toEqual({
      status: "mcp_connected",
      server: "echo",
      toolCount: 1,
    });
    expect(events.some((event) => event.type === "mcp_status")).toBe(false);
  });

  it("done 之后迟到的 mcp_status 仍随 follow 送达，直到会话关闭才结束", async () => {
    const root = await makeTempDir("events-producers-late-");
    const dir = path.join(root, "sess-late");
    const session = await createSession(dir, { id: "sess-late" });
    sessions.push(session);
    await session.append({
      type: "status",
      payload: { status: "done", finishReason: "no_tool_calls" },
    });

    const source = createLogTailEventSource({ sessionsRoot: root, pollMs: 20 });
    const controller = new AbortController();
    const iterator = source.follow("sess-late", -1, controller.signal)[Symbol.asyncIterator]();
    const done = await nextEvent(iterator);
    expect(done.type).toBe("status");
    expect(done.payload).toMatchObject({ status: "done" });

    const late = await session.append({
      type: "mcp_status",
      payload: { kind: "tools_changed", server: "echo", toolCount: 2 },
    });
    const received = await nextEvent(iterator);
    expect(received.seq).toBe(late.seq);
    expect(received.type).toBe("mcp_status");
    expect(received.payload).toEqual({ kind: "tools_changed", server: "echo", toolCount: 2 });

    const closed = session.close();
    const ended = await withTimeout(iterator.next(), 600);
    expect(ended.done).toBe(true);
    await closed;
    controller.abort();
  });
});