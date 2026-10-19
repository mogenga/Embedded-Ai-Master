import type { z } from "zod";

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
