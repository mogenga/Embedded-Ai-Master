import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createBuiltinTools } from "../src/tools/builtin.js";
import { echoTool } from "../src/tools/echo.js";
import { ToolRegistry, toModelToolSchemas } from "../src/tools/registry.js";
import type { ToolDef } from "../src/tools/types.js";

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
