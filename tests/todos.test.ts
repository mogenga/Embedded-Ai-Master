import { describe, expect, it } from "vitest";
import { todoWriteTool } from "../src/tools/todos.js";
import type { TodoItem } from "../src/session/types.js";

function parse(input: unknown) {
  return todoWriteTool.schema.safeParse(input);
}

function item(content: string, status: TodoItem["status"] = "pending"): TodoItem {
  return { content, status };
}

const ctx = { sessionId: "s", cwd: "." };

describe("todo_write schema", () => {
  it("接受空数组：清空计划是合法操作", () => {
    expect(parse({ items: [] }).success).toBe(true);
  });

  it("接受三种状态", () => {
    const parsed = parse({
      items: [item("a", "pending"), item("b", "in_progress"), item("c", "completed")],
    });

    expect(parsed.success).toBe(true);
  });

  it("拒绝 51 项：上限 50 是给计划卡的，不是给模型的草稿纸", () => {
    const items = Array.from({ length: 51 }, (_unused, index) => item(`step ${index}`));

    expect(parse({ items }).success).toBe(false);
  });

  it("接受 50 项", () => {
    const items = Array.from({ length: 50 }, (_unused, index) => item(`step ${index}`));

    expect(parse({ items }).success).toBe(true);
  });

  it("拒绝空 content：没有内容的待办在卡片上是一行空白", () => {
    expect(parse({ items: [item("")] }).success).toBe(false);
  });

  it("拒绝非法 status", () => {
    expect(parse({ items: [{ content: "a", status: "done" }] }).success).toBe(false);
  });

  it("拒绝缺失 items", () => {
    expect(parse({}).success).toBe(false);
  });
});

describe("todo_write 执行", () => {
  it("成功时把 items 放进 result.todos，并回报统计", async () => {
    const items = [item("读 datasheet", "completed"), item("量波形", "in_progress"), item("写报告")];

    const result = await todoWriteTool.execute({ items }, ctx, new AbortController().signal);

    expect(result.isError).toBe(false);
    expect(result.code).toBe("ok");
    expect(result.todos).toStrictEqual(items);
    expect(result.detail).toStrictEqual({ items });
    expect(result.text).toBe("Updated plan: 3 items (1 completed, 1 in progress)");
  });

  it("空计划回报 0 项，而不是把清空当成失败", async () => {
    const result = await todoWriteTool.execute({ items: [] }, ctx, new AbortController().signal);

    expect(result.isError).toBe(false);
    expect(result.todos).toStrictEqual([]);
    expect(result.text).toBe("Updated plan: 0 items (0 completed, 0 in progress)");
  });

  it("已中断时返回 aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await todoWriteTool.execute({ items: [item("a")] }, ctx, controller.signal);

    expect(result).toMatchObject({ isError: true, code: "aborted" });
    expect(result.todos).toBeUndefined();
  });
});

describe("todo_write 权限", () => {
  it("access() 恒为 read", () => {
    // 契约的一部分：权限门控关心的是对工作区的副作用，而 todo_write 只写会话日志
    // （tool_started / tool_result 本来每次调用都在写）。判成 write 会让 read-only /
    // diagnose 预设下的计划功能直接不可用，而它连一个字节的文件都不碰。
    expect(todoWriteTool.access?.({ items: [] })).toBe("read");
    expect(todoWriteTool.access?.({ items: [item("a", "completed")] })).toBe("read");
  });

  it("不设 annotations：没有文件副作用，也就不该冒领 readOnly/evidence 语义", () => {
    expect(todoWriteTool.annotations).toBeUndefined();
  });
});
