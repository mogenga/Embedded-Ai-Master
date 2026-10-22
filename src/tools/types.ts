import type { z } from "zod";
import type { TodoItem } from "../session/types.js";

export interface ToolCtx {
  sessionId: string;
  cwd: string;
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
  execute(input: I, ctx: ToolCtx, signal: AbortSignal): Promise<ToolResult>;
}
