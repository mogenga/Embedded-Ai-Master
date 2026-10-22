import { z } from "zod";
import type { TodoItem } from "../session/types.js";
import type { ToolDef, ToolResult } from "./types.js";

// 上限 50 项：计划卡是给人看的，超过一屏半的「计划」已经退化成草稿纸，
// 而模型真需要那么长时应该分阶段重列，而不是一次塞满。
const MAX_ITEMS = 50;
const MAX_CONTENT_CHARS = 500;

export const todoWriteInputSchema = z.object({
  items: z
    .array(
      z.object({
        content: z.string().min(1).max(MAX_CONTENT_CHARS),
        status: z.enum(["pending", "in_progress", "completed"]),
      }),
    )
    .max(MAX_ITEMS),
});

export type TodoWriteInput = z.infer<typeof todoWriteInputSchema>;

function count(items: readonly TodoItem[], status: TodoItem["status"]): number {
  return items.filter((item) => item.status === status).length;
}

export const todoWriteTool: ToolDef<TodoWriteInput> = {
  name: "todo_write",
  description:
    "替换整份待办列表（不是追加）。多步骤任务开始时先列出计划，每完成一步就用新列表整体更新一次；"
    + "已完成项保留在列表里并标记 completed，正在做的那项标记 in_progress。传空数组表示没有待办了。",
  schema: todoWriteInputSchema,
  // 刻意不设 annotations，也用 access 覆盖掉注解推导。
  //
  // 权限门控关心的是**对工作区的副作用**：read-only / diagnose 预设拒绝 write 类工具，
  // 是因为它们会改文件、跑命令。todo_write 只往会话日志里写一条事件——而这件事
  // 每一次工具调用都在做（tool_started / tool_result），它连一个字节的文件都不碰。
  // 把它判成 write 会让这两个预设下的计划功能直接不可用，却换不来任何安全收益。
  access: () => "read",
  execute: async (input, _ctx, signal): Promise<ToolResult> => {
    if (signal.aborted) {
      return { isError: true, code: "aborted", message: "todo_write aborted", text: "todo_write aborted" };
    }

    // 复制一份：调用方给的是 schema 解析结果，但返回的 items 会被写进会话日志，
    // 不让工具的返回值与入参共享同一批对象。
    const items: TodoItem[] = input.items.map((item) => ({
      content: item.content,
      status: item.status,
    }));
    const completed = count(items, "completed");
    const inProgress = count(items, "in_progress");

    return {
      isError: false,
      code: "ok",
      message: "",
      text: `Updated plan: ${items.length} items (${completed} completed, ${inProgress} in progress)`,
      detail: { items },
      todos: items,
    };
  },
};
