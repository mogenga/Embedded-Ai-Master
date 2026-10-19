import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { McpCallResult, McpToolInfo } from "../src/mcp/manager.js";
import { createMcpTools, mcpToolName } from "../src/mcp/tools.js";
import type { McpToolAdapterStatus } from "../src/mcp/tools.js";
import { ToolRegistry, toModelToolSchemas } from "../src/tools/registry.js";

const ctx = { sessionId: "s", cwd: "." };
const signal = new AbortController().signal;

function makeInfo(server: string, tool: string, overrides: Partial<McpToolInfo> = {}): McpToolInfo {
  return {
    server,
    tool,
    description: "",
    inputSchema: { type: "object", properties: {} },
    ...overrides,
  };
}

interface FakeManager {
  tools(): McpToolInfo[];
  call(server: string, tool: string, args: unknown, signal?: AbortSignal): Promise<McpCallResult>;
}

function makeManager(
  tools: McpToolInfo[],
  callImpl?: (
    server: string,
    tool: string,
    args: unknown,
    signal?: AbortSignal,
  ) => Promise<McpCallResult>,
): { manager: FakeManager; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const manager: FakeManager = {
    tools: () => tools.map((tool) => ({ ...tool })),
    call: async (server, tool, args, callSignal) => {
      calls.push([server, tool, args, callSignal]);
      if (callImpl) {
        return callImpl(server, tool, args, callSignal);
      }
      return { isError: false, code: "ok", message: "", text: "ok" };
    },
  };
  return { manager, calls };
}

const okResult = (text: string): McpCallResult => ({
  isError: false,
  code: "ok",
  message: "",
  text,
});

describe("mcpToolName", () => {
  it("生成 mcp__<server>__<tool>", () => {
    expect(mcpToolName("echo", "echo")).toBe("mcp__echo__echo");
  });

  it("sanitize 非法字符为下划线", () => {
    expect(mcpToolName("my server.v2", "do/thing:x")).toBe("mcp__my_server_v2__do_thing_x");
  });

  it("合法字符保持不变", () => {
    expect(mcpToolName("srv_1-a", "tool_2-b")).toBe("mcp__srv_1-a__tool_2-b");
  });

  it("恰好 64 字符不截断", () => {
    const tool = "t".repeat(54);
    const name = mcpToolName("srv", tool);

    expect(name).toHaveLength(64);
    expect(name).toBe(`mcp__srv__${tool}`);
  });

  it("超长名称截断到 64 并追加 6 位 hash", () => {
    const name = mcpToolName("s".repeat(40), "t".repeat(40));

    expect(name).toHaveLength(64);
    expect(name).toBe("mcp__ssssssssssssssssssssssssssssssssssssssss__tttttttttt_c645d2");
    expect(name).toMatch(/_[0-9a-f]{6}$/);
  });

  it("超长名称对相同输入稳定、对不同输入区分", () => {
    const a = mcpToolName("s".repeat(40), "t".repeat(40));
    const b = mcpToolName("s".repeat(40), "t".repeat(40));
    const c = mcpToolName("s".repeat(40), "u".repeat(40));

    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("createMcpTools", () => {
  it("空工具列表返回空数组", () => {
    expect(createMcpTools(makeManager([]).manager)).toEqual([]);
  });

  it("schema 使用 z.unknown 并透传 inputSchema 作为 modelSchema", () => {
    const inputSchema = {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    };
    const [tool] = createMcpTools(makeManager([makeInfo("echo", "echo", { inputSchema })]).manager);

    expect(tool.name).toBe("mcp__echo__echo");
    expect(tool.description).toBe("");
    expect(tool.schema.safeParse({ anything: 1 }).success).toBe(true);
    expect(tool.modelSchema).toBe(inputSchema);
  });

  it("z.unknown() 不触发 toJSONSchema 根类型错误", () => {
    const inputSchema = { type: "object", properties: {} };
    const tools = createMcpTools(makeManager([makeInfo("echo", "echo", { inputSchema })]).manager);

    expect(() => toModelToolSchemas(tools)).not.toThrow();
    expect(toModelToolSchemas(tools)[0].function.parameters).toBe(inputSchema);
    expect(() => new ToolRegistry(tools)).not.toThrow();
  });

  it("annotations 映射 readOnly/destructive/evidence", () => {
    const tools = createMcpTools(
      makeManager([
        makeInfo("s", "ro", { readOnly: true, destructive: false }),
        makeInfo("s", "rw", {}),
      ]).manager,
    );

    expect(tools[0].annotations).toEqual({ readOnly: true, destructive: false, evidence: false });
    expect(tools[1].annotations).toEqual({ readOnly: false, destructive: false, evidence: false });
  });

  it("同 server 内名称冲突跳过后一个并记录 status", () => {
    const statuses: McpToolAdapterStatus[] = [];
    const tools = createMcpTools(
      makeManager([makeInfo("a", "dup"), makeInfo("a", "dup"), makeInfo("a", "ok")]).manager,
      { onStatus: (status) => statuses.push(status) },
    );

    expect(tools.map((tool) => tool.name)).toEqual(["mcp__a__dup", "mcp__a__ok"]);
    expect(statuses).toEqual([
      { kind: "mcp_tool_name_collision", server: "a", tool: "dup", name: "mcp__a__dup" },
    ]);
  });

  it("跨 server 的 sanitize 冲突同样跳过，且不阻塞其他 server", () => {
    const statuses: McpToolAdapterStatus[] = [];
    const tools = createMcpTools(
      makeManager([makeInfo("a.b", "x"), makeInfo("a_b", "x"), makeInfo("c", "x")]).manager,
      { onStatus: (status) => statuses.push(status) },
    );

    expect(tools.map((tool) => tool.name)).toEqual(["mcp__a_b__x", "mcp__c__x"]);
    expect(statuses).toEqual([
      { kind: "mcp_tool_name_collision", server: "a_b", tool: "x", name: "mcp__a_b__x" },
    ]);
  });

  it("execute 调 manager.call 并映射 ToolResult", async () => {
    const { manager, calls } = makeManager([makeInfo("echo", "echo")], async () => okResult("done"));
    const [tool] = createMcpTools(manager);

    const result = await tool.execute({ query: "hi" }, ctx, signal);

    expect(calls).toEqual([["echo", "echo", { query: "hi" }, signal]]);
    expect(result).toEqual({ isError: false, code: "ok", message: "", text: "done" });
  });

  it("execute 透传错误结果而不吞掉", async () => {
    const { manager } = makeManager([makeInfo("echo", "echo")], async () => ({
      isError: true,
      code: "mcp_tool_error",
      message: "boom",
      text: "boom",
    }));
    const [tool] = createMcpTools(manager);

    const result = await tool.execute({}, ctx, signal);

    expect(result).toMatchObject({ isError: true, code: "mcp_tool_error", message: "boom", text: "boom" });
  });

  it("execute 不捕获 manager.call 抛出的异常", async () => {
    const { manager } = makeManager([makeInfo("echo", "echo")], async () => {
      throw new Error("network down");
    });
    const [tool] = createMcpTools(manager);

    await expect(tool.execute({}, ctx, signal)).rejects.toThrow("network down");
  });
});