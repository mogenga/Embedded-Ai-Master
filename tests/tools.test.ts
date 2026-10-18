import { describe, expect, it } from "vitest";
import { z } from "zod";
import { echoTool } from "../src/tools/echo.js";
import { ToolRegistry, toModelToolSchemas } from "../src/tools/registry.js";
import type { ToolDef } from "../src/tools/types.js";

const otherTool: ToolDef<{ count: number }> = {
  name: "other",
  description: "另一个工具",
  schema: z.object({ count: z.number() }),
  execute: async (input) => ({ isError: false, code: "ok", message: "", text: String(input.count) }),
};

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
