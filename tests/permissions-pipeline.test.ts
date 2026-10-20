import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createMcpTools } from "../src/mcp/tools.js";
import { createPermissionGate } from "../src/permissions/gate.js";
import type {
  PermissionCheckInput,
  PermissionGate,
  PermissionRequest,
} from "../src/permissions/types.js";
import type { SessionHandle } from "../src/session/session.js";
import { executeBatch } from "../src/tools/pipeline.js";
import type { BatchCall, PermissionOptions } from "../src/tools/pipeline.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { ToolAnnotations, ToolDef, ToolResult } from "../src/tools/types.js";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "permissions-pipeline-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function makeSession(dir: string): SessionHandle {
  return {
    id: "sess-1",
    dir,
    header: { id: "sess-1", createdAt: "2026-01-01T00:00:00.000Z", status: "open" },
    append: async () => ({
      seq: 0,
      ts: "2026-10-18T00:00:00.000Z",
      type: "status",
      payload: {},
    }),
    events: () => [],
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
): ToolDef<I> {
  return { name, description: "", schema, annotations, execute };
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
  permission?: PermissionOptions,
  overrides: Partial<{ timeoutMs: number; settleGraceMs: number; signal: AbortSignal }> = {},
): Parameters<typeof executeBatch>[3] {
  return {
    signal: overrides.signal ?? new AbortController().signal,
    artifactDir: path.join(tmp, "artifacts"),
    ...(overrides.timeoutMs === undefined ? {} : { timeoutMs: overrides.timeoutMs }),
    ...(overrides.settleGraceMs === undefined ? {} : { settleGraceMs: overrides.settleGraceMs }),
    ...(permission === undefined ? {} : { permission }),
  };
}

describe("executeBatch 权限授权与执行边界", () => {
  it("deny → 审计一次、不执行、结构化 permission_denied", async () => {
    const session = makeSession(path.join(tmp, "session"));
    const execute = vi.fn(async () => ok("never"));
    const tool = makeTool("fs", z.object({ op: z.string() }), execute, { readOnly: false });
    const reg = new ToolRegistry([tool]);
    const onDecision = vi.fn<PermissionOptions["onDecision"]>(async () => {});
    const gate = fakeGate((input) =>
      decisionFor(input, {
        action: "deny",
        effective: "deny",
        reason: "rule:deny",
        source: "user",
        ruleIndex: 2,
      }),
    );

    const results = await executeBatch(
      session,
      reg,
      [call("c1", "fs", { op: "write" })],
      optsOf(permissionOf(gate, onDecision)),
    );

    expect(execute).not.toHaveBeenCalled();
    expect(onDecision).toHaveBeenCalledTimes(1);
    const [auditCall, auditDecision] = onDecision.mock.calls[0] as [BatchCall, PermissionRequest];
    expect(auditCall.id).toBe("c1");
    expect(auditDecision.callId).toBe("c1");
    expect(auditDecision.action).toBe("deny");
    expect(auditDecision.effective).toBe("deny");

    const result = results[0]!.result;
    expect(result.isError).toBe(true);
    expect(result.code).toBe("permission_denied");
    expect(result.detail).toEqual({
      action: "deny",
      effective: "deny",
      reason: "rule:deny",
      preset: "diagnose",
      source: "user",
      ruleIndex: 2,
    });
  });

  it("allow → 审计先于执行，onDecision 恰好一次", async () => {
    const session = makeSession(path.join(tmp, "session"));
    const order: string[] = [];
    const execute = vi.fn(async () => {
      order.push("execute");
      return ok("done");
    });
    const tool = makeTool("fs", z.object({ op: z.string() }), execute, { readOnly: false });
    const reg = new ToolRegistry([tool]);
    const onDecision = vi.fn(async (batchCall: BatchCall, decision: PermissionRequest) => {
      expect(batchCall.id).toBe("c1");
      expect(decision.callId).toBe("c1");
      expect(decision.action).toBe("allow");
      expect(decision.effective).toBe("allow");
      order.push("audit");
    });

    const results = await executeBatch(
      session,
      reg,
      [call("c1", "fs", { op: "read" })],
      optsOf(permissionOf(fakeGate(), onDecision)),
    );

    expect(order).toEqual(["audit", "execute"]);
    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(results[0]!.result).toMatchObject({ isError: false, code: "ok", text: "done" });
  });

  it("gate 收到解析后的参数、调用 id 与批次 signal", async () => {
    const session = makeSession(path.join(tmp, "session"));
    const execute = vi.fn(async () => ok("done"));
    const tool = makeTool("fs", z.object({ op: z.string() }), execute, { readOnly: true });
    const reg = new ToolRegistry([tool]);
    const controller = new AbortController();
    const check = vi.fn(async (input: PermissionCheckInput) => decisionFor(input));
    const gate: PermissionGate = { check };

    await executeBatch(
      session,
      reg,
      [call("c9", "fs", { op: "read" })],
      optsOf(permissionOf(gate, async () => {}), { signal: controller.signal }),
    );

    expect(check).toHaveBeenCalledTimes(1);
    const input = check.mock.calls[0]![0];
    expect(input.callId).toBe("c9");
    expect(input.tool.name).toBe("fs");
    expect(input.args).toEqual({ op: "read" });
    expect(input.signal).toBe(controller.signal);
  });

  it("ask 无审批通道 → audit 记录 action=ask/effective=deny 且不执行", async () => {
    const session = makeSession(path.join(tmp, "session"));
    const execute = vi.fn(async () => ok("never"));
    const tool = makeTool("fs", z.object({ op: z.string() }), execute, {
      readOnly: false,
      destructive: true,
    });
    const reg = new ToolRegistry([tool]);
    const gate = createPermissionGate({ preset: "diagnose", rules: [] });
    const onDecision = vi.fn<PermissionOptions["onDecision"]>(async () => {});

    const results = await executeBatch(
      session,
      reg,
      [call("ask-1", "fs", { op: "write" })],
      optsOf(permissionOf(gate, onDecision)),
    );

    expect(execute).not.toHaveBeenCalled();
    expect(onDecision).toHaveBeenCalledTimes(1);
    const decision = onDecision.mock.calls[0]![1];
    expect(decision).toMatchObject({
      callId: "ask-1",
      action: "ask",
      effective: "deny",
      reason: "approval_unavailable",
    });
    expect(results[0]!.result).toMatchObject({ isError: true, code: "permission_denied" });
    expect(results[0]!.result.detail).toMatchObject({ action: "ask", effective: "deny" });
  });

  it("未提供 permission → 直接执行（P0 行为）", async () => {
    const session = makeSession(path.join(tmp, "session"));
    const execute = vi.fn(async () => ok("done"));
    const tool = makeTool("fs", z.object({ op: z.string() }), execute, { readOnly: false });
    const reg = new ToolRegistry([tool]);

    const results = await executeBatch(
      session,
      reg,
      [call("c1", "fs", { op: "write" })],
      optsOf(),
    );

    expect(execute).toHaveBeenCalledTimes(1);
    expect(results[0]!.result.code).toBe("ok");
  });

  it("onDecision 抛错 → 工具不执行且错误上抛", async () => {
    const session = makeSession(path.join(tmp, "session"));
    const execute = vi.fn(async () => ok("never"));
    const tool = makeTool("fs", z.object({ op: z.string() }), execute, { readOnly: false });
    const reg = new ToolRegistry([tool]);
    const onDecision = vi.fn(async () => {
      throw new Error("audit down");
    });

    await expect(
      executeBatch(
        session,
        reg,
        [call("c1", "fs", { op: "read" })],
        optsOf(permissionOf(fakeGate(), onDecision)),
      ),
    ).rejects.toThrow("audit down");
    expect(execute).not.toHaveBeenCalled();
  });

  it("串行审批期间调用方中止 → allow 也不执行，返回 tool_aborted", async () => {
    const session = makeSession(path.join(tmp, "session"));
    const execute = vi.fn(async () => ok("never"));
    const tool = makeTool("writer", z.object({}), execute, { readOnly: false });
    const reg = new ToolRegistry([tool]);
    const controller = new AbortController();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release!: () => void;
    const gate: PermissionGate = {
      check: async (input) => {
        markStarted();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return decisionFor(input);
      },
    };
    const onDecision = vi.fn<PermissionOptions["onDecision"]>(async () => {});

    const pending = executeBatch(
      session,
      reg,
      [call("c1", "writer")],
      optsOf(permissionOf(gate, onDecision), { signal: controller.signal }),
    );
    await started;
    controller.abort();
    release();
    const results = await pending;

    expect(execute).not.toHaveBeenCalled();
    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(results[0]!.result).toMatchObject({ isError: true, code: "tool_aborted" });
  });
});

describe("executeBatch 并发批次两阶段授权", () => {
  it("只读批次按调用顺序串行授权，全部授权后并发执行", async () => {
    const session = makeSession(path.join(tmp, "session"));
    const order: string[] = [];
    const spans: Array<{ name: string; start: number; end: number }> = [];
    const make = (name: string): ToolDef<{}> =>
      makeTool(
        name,
        z.object({}),
        async () => {
          const start = performance.now();
          order.push(`execute:${name}`);
          await new Promise((resolve) => setTimeout(resolve, 30));
          spans.push({ name, start, end: performance.now() });
          return ok(name);
        },
        { readOnly: true },
      );
    const reg = new ToolRegistry([make("a"), make("b")]);
    const onDecision = vi.fn(async (batchCall: BatchCall) => {
      order.push(`audit:${batchCall.id}`);
    });

    const results = await executeBatch(
      session,
      reg,
      [call("1", "a"), call("2", "b")],
      optsOf(permissionOf(fakeGate(), onDecision)),
    );

    expect(onDecision).toHaveBeenCalledTimes(2);
    expect(order.slice(0, 2)).toEqual(["audit:1", "audit:2"]);
    expect(order.slice(2).sort()).toEqual(["execute:a", "execute:b"]);
    const first = spans.find((span) => span.name === "a");
    const second = spans.find((span) => span.name === "b");
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first && second) {
      expect(Math.min(first.end, second.end) - Math.max(first.start, second.start)).toBeGreaterThan(0);
    }
    expect(results.map((entry) => entry.result.code)).toEqual(["ok", "ok"]);
  });

  it("并发只读审批期间调用方中止 → 所有 allow 均不执行", async () => {
    const session = makeSession(path.join(tmp, "session"));
    const first = vi.fn(async () => ok("never"));
    const second = vi.fn(async () => ok("never"));
    const reg = new ToolRegistry([
      makeTool("a", z.object({}), first, { readOnly: true }),
      makeTool("b", z.object({}), second, { readOnly: true }),
    ]);
    const controller = new AbortController();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let release!: () => void;
    const gate: PermissionGate = {
      check: async (input) => {
        markStarted();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return decisionFor(input);
      },
    };
    const onDecision = vi.fn<PermissionOptions["onDecision"]>(async () => {});

    const pending = executeBatch(
      session,
      reg,
      [call("1", "a"), call("2", "b")],
      optsOf(permissionOf(gate, onDecision), { signal: controller.signal }),
    );
    await started;
    controller.abort();
    release();
    const results = await pending;

    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(results.map((entry) => entry.result.code)).toEqual([
      "tool_aborted",
      "tool_aborted",
    ]);
  });

  it("混合 deny/allow：allow 执行、deny 不执行，各审计一次", async () => {
    const session = makeSession(path.join(tmp, "session"));
    const allowExecute = vi.fn(async () => ok("allowed"));
    const denyExecute = vi.fn(async () => ok("never"));
    const reg = new ToolRegistry([
      makeTool("reader", z.object({}), allowExecute, { readOnly: true }),
      makeTool("writer", z.object({}), denyExecute, { readOnly: true }),
    ]);
    const onDecision = vi.fn<PermissionOptions["onDecision"]>(async () => {});
    const gate = fakeGate((input) =>
      input.callId === "deny"
        ? decisionFor(input, {
            action: "deny",
            effective: "deny",
            reason: "rule:deny",
            source: "user",
          })
        : decisionFor(input),
    );

    const results = await executeBatch(
      session,
      reg,
      [call("allow", "reader"), call("deny", "writer")],
      optsOf(permissionOf(gate, onDecision)),
    );

    expect(onDecision).toHaveBeenCalledTimes(2);
    expect(allowExecute).toHaveBeenCalledTimes(1);
    expect(denyExecute).not.toHaveBeenCalled();
    expect(results.map((entry) => entry.result.code)).toEqual(["ok", "permission_denied"]);
  });

  it("并发批次 onDecision 抛错 → 所有工具均不执行", async () => {
    const session = makeSession(path.join(tmp, "session"));
    const first = vi.fn(async () => ok("never"));
    const second = vi.fn(async () => ok("never"));
    const reg = new ToolRegistry([
      makeTool("a", z.object({}), first, { readOnly: true }),
      makeTool("b", z.object({}), second, { readOnly: true }),
    ]);
    const onDecision = vi.fn(async () => {
      throw new Error("audit down");
    });

    await expect(
      executeBatch(
        session,
        reg,
        [call("1", "a"), call("2", "b")],
        optsOf(permissionOf(fakeGate(), onDecision)),
      ),
    ).rejects.toThrow("audit down");
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });

  it("gate.check 抛错 → 并发批次所有工具均不执行", async () => {
    const session = makeSession(path.join(tmp, "session"));
    const first = vi.fn(async () => ok("never"));
    const second = vi.fn(async () => ok("never"));
    const reg = new ToolRegistry([
      makeTool("a", z.object({}), first, { readOnly: true }),
      makeTool("b", z.object({}), second, { readOnly: true }),
    ]);
    const gate: PermissionGate = {
      check: async () => {
        throw new Error("gate down");
      },
    };
    const onDecision = vi.fn<PermissionOptions["onDecision"]>(async () => {});

    await expect(
      executeBatch(
        session,
        reg,
        [call("1", "a"), call("2", "b")],
        optsOf(permissionOf(gate, onDecision)),
      ),
    ).rejects.toThrow("gate down");
    expect(onDecision).not.toHaveBeenCalled();
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });

  it("串行批次逐调用 deny → 后续 allow 仍正常执行", async () => {
    const session = makeSession(path.join(tmp, "session"));
    const denyExecute = vi.fn(async () => ok("never"));
    const allowExecute = vi.fn(async () => ok("allowed"));
    const reg = new ToolRegistry([
      makeTool("writer", z.object({}), denyExecute, { readOnly: false }),
      makeTool("reader", z.object({}), allowExecute, { readOnly: false }),
    ]);
    const onDecision = vi.fn<PermissionOptions["onDecision"]>(async () => {});
    const gate = fakeGate((input) =>
      input.callId === "deny"
        ? decisionFor(input, { action: "deny", effective: "deny", reason: "rule:deny", source: "user" })
        : decisionFor(input),
    );

    const results = await executeBatch(
      session,
      reg,
      [call("deny", "writer"), call("allow", "reader")],
      optsOf(permissionOf(gate, onDecision)),
    );

    expect(onDecision).toHaveBeenCalledTimes(2);
    expect(denyExecute).not.toHaveBeenCalled();
    expect(allowExecute).toHaveBeenCalledTimes(1);
    expect(results.map((entry) => entry.result.code)).toEqual([
      "permission_denied",
      "ok",
    ]);
  });

  it("串行批次 onDecision 抛错 → 当前及后续工具均不执行", async () => {
    const session = makeSession(path.join(tmp, "session"));
    const first = vi.fn(async () => ok("never"));
    const second = vi.fn(async () => ok("never"));
    const reg = new ToolRegistry([
      makeTool("a", z.object({}), first, { readOnly: false }),
      makeTool("b", z.object({}), second, { readOnly: false }),
    ]);
    const onDecision = vi.fn(async () => {
      throw new Error("audit down");
    });

    await expect(
      executeBatch(
        session,
        reg,
        [call("1", "a"), call("2", "b")],
        optsOf(permissionOf(fakeGate(), onDecision)),
      ),
    ).rejects.toThrow("audit down");
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  });
});

describe("executeBatch 不进入授权的路径", () => {
  it("工具不存在 → tool_not_found，无审计无执行", async () => {
    const session = makeSession(path.join(tmp, "session"));
    const onDecision = vi.fn<PermissionOptions["onDecision"]>(async () => {});
    const results = await executeBatch(
      session,
      new ToolRegistry([]),
      [call("1", "ghost")],
      optsOf(permissionOf(fakeGate(), onDecision)),
    );

    expect(results[0]!.result.code).toBe("tool_not_found");
    expect(onDecision).not.toHaveBeenCalled();
  });

  it("schema 失败 → schema_validation，无审计无执行", async () => {
    const session = makeSession(path.join(tmp, "session"));
    const execute = vi.fn(async () => ok("never"));
    const reg = new ToolRegistry([
      makeTool("strict", z.object({ n: z.number() }), execute, { readOnly: true }),
    ]);
    const onDecision = vi.fn<PermissionOptions["onDecision"]>(async () => {});

    const results = await executeBatch(
      session,
      reg,
      [call("1", "strict", { n: "bad" })],
      optsOf(permissionOf(fakeGate(), onDecision)),
    );

    expect(results[0]!.result.code).toBe("schema_validation");
    expect(onDecision).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("signal 已中止 → tool_aborted，无审计无执行", async () => {
    const session = makeSession(path.join(tmp, "session"));
    const execute = vi.fn(async () => ok("never"));
    const reg = new ToolRegistry([makeTool("reader", z.object({}), execute, { readOnly: true })]);
    const onDecision = vi.fn<PermissionOptions["onDecision"]>(async () => {});
    const controller = new AbortController();
    controller.abort();

    const results = await executeBatch(
      session,
      reg,
      [call("1", "reader")],
      optsOf(permissionOf(fakeGate(), onDecision), { signal: controller.signal }),
    );

    expect(results[0]!.result.code).toBe("tool_aborted");
    expect(onDecision).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("非法 id → tool_protocol_error，无审计无执行", async () => {
    const session = makeSession(path.join(tmp, "session"));
    const execute = vi.fn(async () => ok("never"));
    const reg = new ToolRegistry([makeTool("reader", z.object({}), execute, { readOnly: true })]);
    const onDecision = vi.fn<PermissionOptions["onDecision"]>(async () => {});

    const results = await executeBatch(
      session,
      reg,
      [{ id: 42 as unknown as string, name: "reader", input: {} }],
      optsOf(permissionOf(fakeGate(), onDecision)),
    );

    expect(results[0]!.result.code).toBe("tool_protocol_error");
    expect(onDecision).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("重复 id → 仅首个进入授权与执行", async () => {
    const session = makeSession(path.join(tmp, "session"));
    const execute = vi.fn(async () => ok("once"));
    const reg = new ToolRegistry([makeTool("reader", z.object({}), execute, { readOnly: true })]);
    const onDecision = vi.fn<PermissionOptions["onDecision"]>(async () => {});

    const results = await executeBatch(
      session,
      reg,
      [call("dup", "reader"), call("dup", "reader")],
      optsOf(permissionOf(fakeGate(), onDecision)),
    );

    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(results[0]!.result.code).toBe("ok");
    expect(results[1]!.result.code).toBe("duplicate_call_id");
  });

  it("超时跳过 → 后续工具不审计不执行", async () => {
    const session = makeSession(path.join(tmp, "session"));
    const first = vi.fn(() => new Promise<ToolResult>(() => {}));
    const second = vi.fn(async () => ok("never"));
    const reg = new ToolRegistry([
      makeTool("never", z.object({}), first, { readOnly: false }),
      makeTool("second", z.object({}), second, { readOnly: false }),
    ]);
    const onDecision = vi.fn<PermissionOptions["onDecision"]>(async () => {});

    const results = await executeBatch(
      session,
      reg,
      [call("1", "never"), call("2", "second")],
      optsOf(permissionOf(fakeGate(), onDecision), { timeoutMs: 10, settleGraceMs: 10 }),
    );

    expect(results.map((entry) => entry.result.code)).toEqual([
      "tool_timeout",
      "tool_skipped_after_timeout",
    ]);
    expect(onDecision).toHaveBeenCalledTimes(1);
    expect(onDecision.mock.calls[0]![0]).toMatchObject({ id: "1" });
    expect(second).not.toHaveBeenCalled();
  });
});

describe("executeBatch MCP 端到端授权", () => {
  it("destructive/unknown deny 不调用 source.call，readOnly allow 调用一次", async () => {
    const session = makeSession(path.join(tmp, "session"));
    const sourceCall = vi.fn(async () => ok("mcp-read"));
    const mcpTools = createMcpTools({
      tools: () => [
        {
          server: "probe",
          tool: "mem_read",
          description: "读取内存",
          inputSchema: { type: "object", properties: {} },
          readOnly: true,
        },
        {
          server: "probe",
          tool: "flash_write",
          description: "写 flash",
          inputSchema: { type: "object", properties: {} },
          destructive: true,
        },
        {
          server: "probe",
          tool: "mystery",
          description: "未知能力",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      call: sourceCall,
    });
    const reg = new ToolRegistry(mcpTools);
    const gate = createPermissionGate({ preset: "diagnose", rules: [] });
    const onDecision = vi.fn<PermissionOptions["onDecision"]>(async () => {});

    const results = await executeBatch(
      session,
      reg,
      [
        call("read", "mcp__probe__mem_read"),
        call("write", "mcp__probe__flash_write"),
        call("unknown", "mcp__probe__mystery"),
      ],
      optsOf(permissionOf(gate, onDecision)),
    );

    expect(sourceCall).toHaveBeenCalledTimes(1);
    expect(sourceCall.mock.calls[0]!.slice(0, 2)).toEqual(["probe", "mem_read"]);
    expect(onDecision).toHaveBeenCalledTimes(3);
    expect(results.map((entry) => entry.result.code)).toEqual([
      "ok",
      "permission_denied",
      "permission_denied",
    ]);
    expect(results[0]!.result.text).toBe("mcp-read");
    expect(results[1]!.result.detail).toMatchObject({
      action: "ask",
      effective: "deny",
      preset: "diagnose",
    });
    expect(results[2]!.result.detail).toMatchObject({
      action: "deny",
      effective: "deny",
      preset: "diagnose",
    });
  });
});
