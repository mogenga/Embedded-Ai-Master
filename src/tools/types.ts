import type { z } from "zod";
import type { TodoItem } from "../session/types.js";

export interface ToolCtx {
  sessionId: string;
  cwd: string;
  /**
   * 会话产物根（`<session.dir>/artifacts`），与 pipeline 落盘用的是同一个值。
   *
   * 只给 `artifact` 这类明确以产物为读取对象的工具用；文件工具仍锁 `cwd`。
   */
  artifactDir?: string;
}

export interface ToolResult {
  isError: boolean;
  code: string;
  message: string;
  detail?: unknown;
  artifactPath?: string;
  text: string;
  evidence?: boolean;
  deviceStatus?: { server: string; state: Record<string, unknown> };
  deviceStatusInvalid?: string;
  /** 模型要显示的计划；由 query 写成一条 `todos` 事件，不进 tool_result 正文。 */
  todos?: TodoItem[];
}

export interface ToolAnnotations {
  readOnly?: boolean;
  evidence?: boolean;
  destructive?: boolean;
}

export type ToolAccess = "read" | "write" | "unknown";

export interface ToolDef<I> {
  name: string;
  description: string;
  schema: z.ZodType<I>;
  modelSchema?: unknown;
  annotations?: ToolAnnotations;
  access?(input: I): ToolAccess;
  /**
   * 该工具自己知道的单次调用预算（毫秒）。缺省表示「按管线的 120s 缺省」。
   *
   * 只有「工具比管线更清楚自己要跑多久」时才该声明：`keil_debug` 的构建动作
   * 内部允许 10 分钟，而管线的 120s 会在它之前把调用掐断（OPT-13 / D-022）。
   * 声明之后，管线取 `max(本次运行的 timeoutMs, 该值)`——用户显式配了更长的
   * 预算仍然优先，因为那是他为本轮做的决定。
   *
   * **不要给内置工具批量声明**：`shell` / `grep` / `glob` 的 120s 是故意的，
   * 放宽它们等于让一次卡住的调用占住会话十分钟。
   */
  callTimeoutMs?: number;
  execute(input: I, ctx: ToolCtx, signal: AbortSignal): Promise<ToolResult>;
}
