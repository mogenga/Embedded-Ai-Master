import { afterEach, describe, expect, it } from "vitest";
import type { McpServerConfig } from "../src/mcp/config.js";
import { McpManager } from "../src/mcp/manager.js";
import type { McpCallResult, McpToolInfo } from "../src/mcp/manager.js";
import { createMcpTools } from "../src/mcp/tools.js";
import type { McpToolSource } from "../src/mcp/tools.js";
import { evaluatePolicy, toolAccess } from "../src/permissions/policy.js";
import type { ToolAccess, ToolDef } from "../src/tools/types.js";

const SCHEMA = { type: "object", properties: {} };
const CONFIG: McpServerConfig = { name: "keil", command: process.execPath };

// keil_debug / keil_project 的真实注解形状：工具级只能说「可能有破坏性」，
// 所以没有动作白名单时，读一个寄存器也要审批（OPT-21 的出发点）。
const KEIL_ANNOTATIONS = { readOnlyHint: false, destructiveHint: true };

const managers: McpManager[] = [];

afterEach(async () => {
  while (managers.length > 0) {
    await managers.pop()?.close();
  }
});

interface ListToolsClient {
  listTools(): Promise<{ tools: unknown[] }>;
}

/** 走 `McpManager.loadTools` 的真实代码路径，只把 MCP Client 换成假对象。 */
async function loadInfos(tools: unknown[]): Promise<McpToolInfo[]> {
  const manager = new McpManager([]);
  managers.push(manager);
  const client: ListToolsClient = { listTools: async () => ({ tools }) };
  const load = (
    manager as unknown as {
      loadTools(client: ListToolsClient, config: McpServerConfig): Promise<McpToolInfo[]>;
    }
  ).loadTools;
  return load.call(manager, client, CONFIG);
}

function rawTool(name: string, meta?: Record<string, unknown>): unknown {
  return {
    name,
    description: "",
    inputSchema: SCHEMA,
    annotations: KEIL_ANNOTATIONS,
    ...(meta === undefined ? {} : { _meta: meta }),
  };
}

function info(overrides: Partial<McpToolInfo> = {}): McpToolInfo {
  return {
    server: "keil",
    tool: "keil_debug",
    description: "",
    inputSchema: SCHEMA,
    readOnly: false,
    destructive: true,
    ...overrides,
  };
}

function build(infos: McpToolInfo[]): ToolDef<unknown>[] {
  const source: McpToolSource = {
    tools: () => infos.map((entry) => ({ ...entry })),
    call: async (): Promise<McpCallResult> => ({
      isError: false,
      code: "ok",
      message: "",
      text: "ok",
    }),
  };
  return createMcpTools(source);
}

function only(overrides: Partial<McpToolInfo> = {}): ToolDef<unknown> {
  return build([info(overrides)])[0]!;
}

function accessOf(tool: ToolDef<unknown>, input: unknown): ToolAccess {
  if (tool.access === undefined) {
    throw new Error("tool.access 未声明");
  }
  return tool.access(input);
}

function diagnose(tool: ToolDef<any>, args: unknown) {
  return evaluatePolicy({ preset: "diagnose", rules: [], tool, args });
}

describe("McpToolInfo 的动作白名单提取（loadTools）", () => {
  it("从 _meta 读取两份字符串白名单", async () => {
    const [loaded] = await loadInfos([
      rawTool("keil_debug", {
        readOnlyActions: ["registers", "version"],
        destructiveActions: ["flash", "reset"],
      }),
    ]);

    expect(loaded?.readOnlyActions).toEqual(["registers", "version"]);
    expect(loaded?.destructiveActions).toEqual(["flash", "reset"]);
  });

  it("数组里的非字符串项逐个丢弃，其余字符串仍然生效", async () => {
    const [loaded] = await loadInfos([
      rawTool("keil_debug", {
        readOnlyActions: ["registers", 1, null, { action: "version" }, "version"],
        destructiveActions: [true],
      }),
    ]);

    expect(loaded?.readOnlyActions).toEqual(["registers", "version"]);
    // 全部项都不是字符串：白名单仍然存在，但为空（等价于「一个都没声明」）。
    expect(loaded?.destructiveActions).toEqual([]);
  });

  it("非数组形状被忽略，不抛错", async () => {
    const loaded = await loadInfos([
      rawTool("keil_debug", {
        readOnlyActions: "registers",
        destructiveActions: { flash: true },
      }),
    ]);

    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.readOnlyActions).toBeUndefined();
    expect(loaded[0]?.destructiveActions).toBeUndefined();
  });

  it("没有 _meta 时两个字段都不出现", async () => {
    const [loaded] = await loadInfos([rawTool("keil_debug")]);

    expect(loaded?.readOnlyActions).toBeUndefined();
    expect(loaded?.destructiveActions).toBeUndefined();
  });

  it("白名单不影响注解映射", async () => {
    const withLists = (
      await loadInfos([
        rawTool("keil_debug", {
          evidence: true,
          readOnlyActions: ["registers"],
          destructiveActions: ["flash"],
        }),
      ])
    )[0];
    const withoutLists = (await loadInfos([rawTool("keil_debug", { evidence: true })]))[0];

    // `loadTools` 只在 hint 为 true 时才置位（未置位的字段保持 undefined），
    // 所以这里直接与「同一工具但不带白名单」逐字段对比，而不是手写期望值。
    expect(withLists).toEqual({ ...withoutLists, readOnlyActions: ["registers"], destructiveActions: ["flash"] });
    expect(withLists).toMatchObject({ destructive: true, evidence: true });
  });

  it("一份白名单里出现重复动作不影响结果", async () => {
    const [loaded] = await loadInfos([
      rawTool("keil_debug", { readOnlyActions: ["registers", "registers"] }),
    ]);
    const [tool] = build([loaded!]);

    expect(accessOf(tool, { action: "registers" })).toBe("read");
  });
});

describe("ToolDef.access：按本次输入判读写", () => {
  const lists = { readOnlyActions: ["registers"], destructiveActions: ["flash"] };

  it("动作在 destructiveActions 里返回 write", () => {
    expect(accessOf(only(lists), { action: "flash" })).toBe("write");
  });

  it("动作在 readOnlyActions 里返回 read", () => {
    expect(accessOf(only(lists), { action: "registers" })).toBe("read");
  });

  it("动作两边都在时返回 unknown（fail-closed，不二选一）", () => {
    const tool = only({ readOnlyActions: ["flash"], destructiveActions: ["flash"] });

    expect(accessOf(tool, { action: "flash" })).toBe("unknown");
  });

  it("动作两边都不在时返回 unknown", () => {
    expect(accessOf(only(lists), { action: "erase_all" })).toBe("unknown");
  });

  it("大小写不同视为不同动作，返回 unknown", () => {
    expect(accessOf(only(lists), { action: "Flash" })).toBe("unknown");
  });

  it("缺 action 字段时返回 unknown", () => {
    expect(accessOf(only(lists), {})).toBe("unknown");
  });

  it("input 为 undefined 时返回 unknown，不抛错", () => {
    expect(accessOf(only(lists), undefined)).toBe("unknown");
  });

  it("action 不是字符串时返回 unknown", () => {
    expect(accessOf(only(lists), { action: 42 })).toBe("unknown");
    expect(accessOf(only(lists), { action: null })).toBe("unknown");
    expect(accessOf(only(lists), { action: ["flash"] })).toBe("unknown");
  });

  it("只有一份白名单时，另一类动作仍是 unknown（不从缺失推断）", () => {
    const tool = only({ readOnlyActions: ["registers"] });

    expect(accessOf(tool, { action: "registers" })).toBe("read");
    expect(accessOf(tool, { action: "flash" })).toBe("unknown");
  });

  it("两个白名单都缺失时不声明 access，注解行为与今天一致", () => {
    const tool = only();

    expect("access" in tool).toBe(false);
    expect(Object.getOwnPropertyDescriptor(tool, "access")).toBeUndefined();
    // 键集与键序都与改造前一致：`...(perAction ? {access} : {})` 在 false 分支
    // 展开的是空对象，不新增、不重排任何自有属性。
    expect(Object.keys(tool)).toEqual([
      "name",
      "description",
      "schema",
      "modelSchema",
      "annotations",
      "execute",
    ]);
    expect(tool.annotations).toEqual({ readOnly: false, destructive: true, evidence: false });
    // 改造前 keil_debug 不论什么动作都是 write：这里必须原样保持。
    expect(toolAccess(tool, { action: "registers" })).toBe("write");
  });

  it("注解单独存在时（readOnlyHint）仍按旧路径返回 read", () => {
    const tool = only({ readOnly: true, destructive: false });

    expect("access" in tool).toBe(false);
    expect(toolAccess(tool, {})).toBe("read");
  });

  it("带 callTimeoutMs 时键序与改造前一致（access 缺省不插位）", () => {
    const tool = only({ callTimeoutMs: 600_000 });

    expect(Object.keys(tool)).toEqual([
      "name",
      "description",
      "schema",
      "modelSchema",
      "annotations",
      "callTimeoutMs",
      "execute",
    ]);
    expect(tool.callTimeoutMs).toBe(600_000);
  });

  it("有白名单时 access 插在 callTimeoutMs 之前，其余键序不变", () => {
    const tool = only({ callTimeoutMs: 600_000, readOnlyActions: ["registers"] });

    expect(Object.keys(tool)).toEqual([
      "name",
      "description",
      "schema",
      "modelSchema",
      "annotations",
      "access",
      "callTimeoutMs",
      "execute",
    ]);
  });
});

describe("diagnose 预设：只读动作放行，破坏性动作审批，未知拒绝", () => {
  const tool = only({
    readOnlyActions: ["registers", "variables"],
    destructiveActions: ["flash", "reset"],
  });

  it("只读动作 allow，且 access 为 read", () => {
    const decision = diagnose(tool, { action: "registers" });

    expect(decision.access).toBe("read");
    expect(decision.action).toBe("allow");
    expect(decision.reason).toBe("preset:diagnose:read");
  });

  it("破坏性动作 ask，且 access 为 write", () => {
    const decision = diagnose(tool, { action: "flash" });

    expect(decision.access).toBe("write");
    expect(decision.action).toBe("ask");
    expect(decision.reason).toBe("preset:diagnose:write");
  });

  it("未知动作 deny，且 access 为 unknown", () => {
    const decision = diagnose(tool, { action: "erase_all" });

    expect(decision.access).toBe("unknown");
    expect(decision.action).toBe("deny");
    expect(decision.reason).toBe("preset:diagnose:unknown");
  });

  it("缺 action 的调用同样 deny", () => {
    expect(diagnose(tool, {}).action).toBe("deny");
  });
});
