import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createBuiltinTools } from "../src/tools/builtin.js";
import { echoTool } from "../src/tools/echo.js";
import { ToolRegistry, toModelToolSchemas } from "../src/tools/registry.js";
import type { ToolDef } from "../src/tools/types.js";

vi.mock("zod", { spy: true });

const otherTool: ToolDef<{ count: number }> = {
  name: "other",
  description: "另一个工具",
  schema: z.object({ count: z.number() }),
  execute: async (input) => ({ isError: false, code: "ok", message: "", text: String(input.count) }),
};

function makeTool<I>(name: string, schema: z.ZodType<I>): ToolDef<I> {
  return {
    name,
    description: "测试工具",
    schema,
    execute: async () => ({ isError: false, code: "ok", message: "", text: "" }),
  };
}

describe("createBuiltinTools", () => {
  it("按固定顺序返回 5 个内置工具", () => {
    expect(createBuiltinTools().map((tool) => tool.name)).toEqual([
      "echo",
      "fs",
      "shell",
      "glob",
      "grep",
    ]);
  });

  it("可直接构造注册表且无重复工具名", () => {
    const registry = new ToolRegistry(createBuiltinTools());

    expect(registry.all()).toHaveLength(5);
    expect(registry.lookup("fs")?.name).toBe("fs");
  });
});

describe("ToolRegistry", () => {
  it("lookup 命中与未命中", () => {
    const reg = new ToolRegistry([echoTool]);

    expect(reg.lookup("echo")?.name).toBe("echo");
    expect(reg.lookup("nope")).toBeUndefined();
  });

  it("find 命中返回 {tool},未命中返回 {}", () => {
    const reg = new ToolRegistry([echoTool]);

    expect(reg.find("echo").tool?.name).toBe("echo");
    expect(reg.find("nope")).toStrictEqual({});
  });

  it("空注册表 lookup 未命中且 all 为空", () => {
    const reg = new ToolRegistry([]);

    expect(reg.lookup("echo")).toBeUndefined();
    expect(reg.all()).toEqual([]);
  });

  it("all 返回全部工具,且外部修改返回数组不影响注册表", () => {
    const reg = new ToolRegistry([echoTool, otherTool]);

    const tools = reg.all();
    expect(tools.map((t) => t.name)).toEqual(["echo", "other"]);

    tools.pop();
    tools.push(otherTool);
    expect(reg.all().map((t) => t.name)).toEqual(["echo", "other"]);
  });

  it("重复工具名构造抛错", () => {
    expect(() => new ToolRegistry([echoTool, echoTool])).toThrow(/tool already registered/);
  });

  it("replace 成功后全量替换工具集合", () => {
    const reg = new ToolRegistry([echoTool]);

    reg.replace([otherTool]);

    expect(reg.all().map((tool) => tool.name)).toEqual(["other"]);
    expect(reg.lookup("echo")).toBeUndefined();
  });

  it("replace 重复名失败时保留旧集合", () => {
    const reg = new ToolRegistry([echoTool]);

    expect(() => reg.replace([otherTool, otherTool])).toThrow(/tool already registered/);
    expect(reg.all().map((tool) => tool.name)).toEqual(["echo"]);
  });

  it("replace 坏 modelSchema 失败时保留旧集合", () => {
    const reg = new ToolRegistry([echoTool]);
    const bad: ToolDef<unknown> = {
      name: "bad",
      description: "坏 modelSchema",
      schema: z.unknown(),
      modelSchema: { type: "string" },
      execute: async () => ({ isError: false, code: "ok", message: "", text: "" }),
    };

    expect(() => reg.replace([bad])).toThrow(/modelSchema root must be an object/);
    expect(reg.all().map((tool) => tool.name)).toEqual(["echo"]);
  });
});

describe("echoTool", () => {
  it("执行回显", async () => {
    const r = await echoTool.execute(
      { text: "hello" },
      { sessionId: "s", cwd: "." },
      new AbortController().signal,
    );

    expect(r).toMatchObject({ isError: false, code: "ok", text: "hello" });
  });

  it("声明 readOnly=true", () => {
    expect(echoTool.annotations?.readOnly).toBe(true);
  });

  it("schema 拒绝非字符串 text", () => {
    const parsed = echoTool.schema.safeParse({ text: 123 });

    expect(parsed.success).toBe(false);
  });
});

describe("ToolRegistry 注册期校验", () => {
  it.each(["", "has space", "中文名", "a".repeat(65)])("拒绝非法工具名 %j", (name) => {
    expect(() => new ToolRegistry([makeTool(name, z.object({}))])).toThrow(/invalid tool name/);
  });

  it("接受 64 字符上限与下划线/短横线/数字", () => {
    const maxName = "a".repeat(64);
    expect(new ToolRegistry([makeTool(maxName, z.object({}))]).lookup(maxName)?.name).toBe(maxName);
    expect(new ToolRegistry([makeTool("tool_1-a", z.object({}))]).lookup("tool_1-a")).toBeDefined();
  });

  it.each([
    ["string", z.string()],
    ["array", z.array(z.string())],
    ["union", z.union([z.object({ a: z.string() }), z.object({ b: z.number() })])],
    ["any", z.any()],
  ])("拒绝根 schema 为 %s 的工具", (_label, schema) => {
    expect(() => new ToolRegistry([makeTool("bad_root", schema)])).toThrow(/parameters root must be an object/);
  });

  it("不可表示的类型在构造期抛错(fail-fast)", () => {
    expect(() => new ToolRegistry([makeTool("with_date", z.object({ d: z.date() }))]))
      .toThrow(/Date cannot be represented/);
  });

  it("零参工具使用 z.object({}) 可通过", () => {
    expect(new ToolRegistry([makeTool("no_args", z.object({}))]).lookup("no_args")).toBeDefined();
  });
});

describe("toModelToolSchemas", () => {
  it("单工具产出 OpenAI function schema", () => {
    const s = toModelToolSchemas([echoTool])[0];

    expect(s.type).toBe("function");
    expect(s.function.name).toBe("echo");
    expect(s.function.description).toBe(echoTool.description);
    expect(s.function.parameters).toMatchObject({
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
    });
  });

  it("多工具保持输入顺序", () => {
    const schemas = toModelToolSchemas([echoTool, otherTool]);

    expect(schemas.map((s) => s.function.name)).toEqual(["echo", "other"]);
  });

  it("toModelToolSchemas([]) 返回空数组", () => {
    expect(toModelToolSchemas([])).toEqual([]);
  });

  it("按 input 侧产出 schema(无 additionalProperties,与 output 模式可区分)", () => {
    const s = toModelToolSchemas([echoTool])[0];
    const parameters = s.function.parameters as Record<string, unknown>;

    // Zod v4: output 模式会给 z.object() 加 additionalProperties:false,input 模式不加
    expect(parameters).not.toHaveProperty("additionalProperties");
  });

  it("带 default() 的字段在 input 模式下不是 required", () => {
    const tool = makeTool("with_default", z.object({ n: z.string().default("x") }));
    const parameters = toModelToolSchemas([tool])[0].function.parameters as Record<string, unknown>;

    expect(parameters.required).toBeUndefined();
  });

  it("modelSchema 优先透传且不调用 z.toJSONSchema", () => {
    const spy = vi.mocked(z.toJSONSchema);
    spy.mockClear();
    const modelSchema = {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    };
    const tool: ToolDef<unknown> = {
      name: "mcp_like",
      description: "透传 MCP schema",
      schema: z.unknown(),
      modelSchema,
      execute: async () => ({ isError: false, code: "ok", message: "", text: "" }),
    };

    expect(toModelToolSchemas([tool])[0].function.parameters).toBe(modelSchema);
    expect(spy).not.toHaveBeenCalled();
  });

  it("ToolRegistry 接受带 modelSchema 的 z.unknown 工具", () => {
    const tool: ToolDef<unknown> = {
      name: "mcp_like",
      description: "透传 MCP schema",
      schema: z.unknown(),
      modelSchema: { type: "object", properties: {} },
      execute: async () => ({ isError: false, code: "ok", message: "", text: "" }),
    };

    expect(new ToolRegistry([tool]).lookup("mcp_like")).toBe(tool);
  });

  it("modelSchema 为 undefined 时回退 z.toJSONSchema 并校验根 object", () => {
    const tool: ToolDef<unknown> = {
      name: "unknown_root",
      description: "",
      schema: z.unknown(),
      modelSchema: undefined,
      execute: async () => ({ isError: false, code: "ok", message: "", text: "" }),
    };

    expect(() => new ToolRegistry([tool])).toThrow(/parameters root must be an object/);
  });

  it("非法 modelSchema 根类型在注册期失败", () => {
    const nonObject: ToolDef<unknown> = {
      name: "bad_model_schema",
      description: "",
      schema: z.unknown(),
      modelSchema: { type: "string" },
      execute: async () => ({ isError: false, code: "ok", message: "", text: "" }),
    };
    const nullSchema: ToolDef<unknown> = {
      name: "null_model_schema",
      description: "",
      schema: z.unknown(),
      modelSchema: null,
      execute: async () => ({ isError: false, code: "ok", message: "", text: "" }),
    };

    expect(() => new ToolRegistry([nonObject])).toThrow(/modelSchema root must be an object/);
    expect(() => toModelToolSchemas([nullSchema])).toThrow(/modelSchema root must be an object/);
  });

  it("内置工具无 modelSchema 时行为不变", () => {
    const schemas = toModelToolSchemas(createBuiltinTools());

    expect(schemas.map((schema) => schema.function.name)).toEqual([
      "echo",
      "fs",
      "shell",
      "glob",
      "grep",
    ]);
    expect(schemas[0].function.parameters).toMatchObject({ type: "object" });
  });

  it("不修改输入工具数组", () => {
    const tools = [echoTool, otherTool];
    const fieldsBefore = tools.map((t) => ({
      tool: t,
      name: t.name,
      description: t.description,
      annotations: t.annotations,
      schema: t.schema,
    }));
    const serializedBefore = JSON.stringify(tools);

    toModelToolSchemas(tools);

    expect(tools).toHaveLength(2);
    expect(JSON.stringify(tools)).toBe(serializedBefore);
    tools.forEach((tool, index) => {
      const before = fieldsBefore[index];
      expect(tool).toBe(before.tool);
      expect(tool.name).toBe(before.name);
      expect(tool.description).toBe(before.description);
      expect(tool.annotations).toBe(before.annotations);
      expect(tool.schema).toBe(before.schema);
    });
  });
});
