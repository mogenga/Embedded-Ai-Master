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
        makeInfo("s", "ro", {
          readOnly: true,
          destructive: false,
          evidence: true,
          description: "只读证据工具",
        }),
        makeInfo("s", "rw", { destructive: true, description: "破坏性工具" }),
        makeInfo("s", "plain", {}),
      ]).manager,
    );

    // D-100: 输出按 (server, tool) 字典序稳定排序,不依赖 manager 返回顺序。
    expect(tools.map((tool) => tool.name)).toEqual([
      "mcp__s__plain",
      "mcp__s__ro",
      "mcp__s__rw",
    ]);
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect(byName.get("mcp__s__ro")?.annotations).toEqual({
      readOnly: true,
      destructive: false,
      evidence: true,
    });
    expect(byName.get("mcp__s__ro")?.description).toBe("只读证据工具");
    expect(byName.get("mcp__s__rw")?.annotations).toEqual({
      readOnly: false,
      destructive: true,
      evidence: false,
    });
    expect(byName.get("mcp__s__rw")?.description).toBe("破坏性工具");
    expect(byName.get("mcp__s__plain")?.annotations).toEqual({
      readOnly: false,
      destructive: false,
      evidence: false,
    });
  });

  it("evidence 工具的结果带 evidence 标记", async () => {
    const { manager } = makeManager([
      makeInfo("s", "ro", { readOnly: true, evidence: true }),
      makeInfo("s", "plain", {}),
    ]);
    const tools = createMcpTools(manager);
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    const evidence = await byName.get("mcp__s__ro")!.execute({}, ctx, signal);
    expect(evidence.evidence).toBe(true);

    const plain = await byName.get("mcp__s__plain")!.execute({}, ctx, signal);
    expect(plain.evidence).toBeUndefined();
  });

  it("同 server 内名称冲突时后一个追加 hash 并记录 renamed", () => {
    const statuses: McpToolAdapterStatus[] = [];
    const tools = createMcpTools(
      makeManager([
        makeInfo("a", "dup"),
        makeInfo("a", "dup"),
        makeInfo("a", "dup"),
        makeInfo("a", "ok"),
      ]).manager,
      { onStatus: (status) => statuses.push(status) },
    );

    expect(tools.map((tool) => tool.name)).toEqual([
      "mcp__a__dup",
      "mcp__a__dup_b68125",
      "mcp__a__dup_9caddb",
      "mcp__a__ok",
    ]);
    expect(statuses).toEqual([
      {
        kind: "mcp_tool_name_renamed",
        server: "a",
        tool: "dup",
        name: "mcp__a__dup_b68125",
        originalName: "mcp__a__dup",
      },
      {
        kind: "mcp_tool_name_renamed",
        server: "a",
        tool: "dup",
        name: "mcp__a__dup_9caddb",
        originalName: "mcp__a__dup",
      },
    ]);
  });

  it("inputSchema 根非 object 的工具被跳过并记录 invalid_schema，registry 可构建", () => {
    const statuses: McpToolAdapterStatus[] = [];
    const tools = createMcpTools(
      makeManager([
        makeInfo("s", "good"),
        makeInfo("s", "bad", { inputSchema: { type: "string" } }),
      ]).manager,
      { onStatus: (status) => statuses.push(status) },
    );

    expect(tools.map((tool) => tool.name)).toEqual(["mcp__s__good"]);
    expect(statuses).toEqual([
      {
        kind: "mcp_tool_invalid_schema",
        server: "s",
        tool: "bad",
        message: "MCP 工具 inputSchema 根必须是 object: s/bad",
      },
    ]);
    expect(() => new ToolRegistry(tools)).not.toThrow();
    expect(toModelToolSchemas(tools).map((schema) => schema.function.name)).toEqual([
      "mcp__s__good",
    ]);
  });

  it("reservedNames 中的名称被占用时确定性改名并记录 renamed", () => {
    const statuses: McpToolAdapterStatus[] = [];
    const tools = createMcpTools(makeManager([makeInfo("s", "echo")]).manager, {
      reservedNames: ["mcp__s__echo"],
      onStatus: (status) => statuses.push(status),
    });

    expect(tools).toHaveLength(1);
    expect(tools[0].name).toMatch(/^mcp__s__echo_[0-9a-f]{6}$/);
    expect(statuses).toEqual([
      {
        kind: "mcp_tool_name_renamed",
        server: "s",
        tool: "echo",
        name: tools[0].name,
        originalName: "mcp__s__echo",
      },
    ]);
  });

  it("跨 server sanitize 冲突时确定性改名，且不阻塞其他 server", () => {
    const statuses: McpToolAdapterStatus[] = [];
    const tools = createMcpTools(
      makeManager([makeInfo("a.b", "x"), makeInfo("a_b", "x"), makeInfo("c", "x")]).manager,
      { onStatus: (status) => statuses.push(status) },
    );

    expect(tools.map((tool) => tool.name)).toEqual([
      "mcp__a_b__x",
      "mcp__a_b__x_7513b1",
      "mcp__c__x",
    ]);
    expect(statuses).toEqual([
      {
        kind: "mcp_tool_name_renamed",
        server: "a_b",
        tool: "x",
        name: "mcp__a_b__x_7513b1",
        originalName: "mcp__a_b__x",
      },
    ]);
  });

  it("截断后的名称冲突同样追加 hash 并保持 64 字符", () => {
    const longTool = "t".repeat(60);
    const clipped = `mcp__a_b__${longTool}`.slice(0, 57);
    const base = `${clipped}_39e981`;
    const renamed = `${clipped}_cac240`;
    const statuses: McpToolAdapterStatus[] = [];
    const tools = createMcpTools(
      makeManager([makeInfo("a.b", longTool), makeInfo("a_b", longTool)]).manager,
      { onStatus: (status) => statuses.push(status) },
    );

    expect(tools.map((tool) => tool.name)).toEqual([base, renamed]);
    expect(tools[1].name).toHaveLength(64);
    expect(tools[1].name).not.toBe(tools[0].name);
    expect(statuses).toEqual([
      {
        kind: "mcp_tool_name_renamed",
        server: "a_b",
        tool: longTool,
        name: renamed,
        originalName: base,
      },
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

  it("成功结果的 structuredContent.deviceStatus 附加为 deviceStatus", async () => {
    const { manager } = makeManager([makeInfo("probe", "attach")], async () => ({
      isError: false,
      code: "ok",
      message: "",
      text: "attached",
      structuredContent: { deviceStatus: { probe: "attached" } },
    }));
    const [tool] = createMcpTools(manager);

    const result = await tool.execute({}, ctx, signal);

    expect(result.deviceStatus).toEqual({ server: "probe", state: { probe: "attached" } });
    expect(result.deviceStatusInvalid).toBeUndefined();
    expect(result.text).toBe("attached");
  });

  it("isError 结果即使带 deviceStatus 也不附加", async () => {
    const { manager } = makeManager([makeInfo("probe", "attach")], async () => ({
      isError: true,
      code: "mcp_tool_error",
      message: "boom",
      text: "boom",
      structuredContent: { deviceStatus: { probe: "attached" } },
    }));
    const [tool] = createMcpTools(manager);

    const result = await tool.execute({}, ctx, signal);

    expect(result.deviceStatus).toBeUndefined();
    expect(result.deviceStatusInvalid).toBeUndefined();
  });

  it("非法 deviceStatus 记录 deviceStatusInvalid 原因且不附加状态", async () => {
    const { manager } = makeManager([makeInfo("probe", "attach")], async () => ({
      isError: false,
      code: "ok",
      message: "",
      text: "ok",
      structuredContent: { deviceStatus: [] },
    }));
    const [tool] = createMcpTools(manager);

    const result = await tool.execute({}, ctx, signal);

    expect(result.deviceStatus).toBeUndefined();
    expect(typeof result.deviceStatusInvalid).toBe("string");
    expect(result.deviceStatusInvalid!.length).toBeGreaterThan(0);
  });

  it("structuredContent 无 deviceStatus 时不附加任何状态", async () => {
    const { manager } = makeManager([makeInfo("echo", "echo")], async () => ({
      isError: false,
      code: "ok",
      message: "",
      text: "ok",
      structuredContent: { answer: 42 },
    }));
    const [tool] = createMcpTools(manager);

    const result = await tool.execute({}, ctx, signal);

    expect(result.deviceStatus).toBeUndefined();
    expect(result.deviceStatusInvalid).toBeUndefined();
  });

  it("structuredContent.deviceStatus 是访问器时不读取 getter", async () => {
    let getterCalls = 0;
    const structuredContent: Record<string, unknown> = {};
    Object.defineProperty(structuredContent, "deviceStatus", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return { probe: "attached" };
      },
    });
    const { manager } = makeManager([makeInfo("probe", "attach")], async () => ({
      isError: false,
      code: "ok",
      message: "",
      text: "ok",
      structuredContent,
    }));
    const [tool] = createMcpTools(manager);

    const result = await tool.execute({}, ctx, signal);

    expect(getterCalls).toBe(0);
    expect(result.deviceStatus).toBeUndefined();
    expect(result.deviceStatusInvalid).toBeUndefined();
  });
});
