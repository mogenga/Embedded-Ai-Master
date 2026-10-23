import type { ProbeToolResult } from "../probe/tools.js";

/**
 * arduino 侧的路由落点：embed_project 的入参直通 arduino_build。
 * Arduino 只有一个工具，全动作面直转，无 action 归属表。
 */

export async function handleArduinoAction(input: Record<string, unknown>): Promise<ProbeToolResult> {
  const { createArduinoTools } = await import("./tools.js");
  const [tool] = createArduinoTools();
  const action = String(input.action);
  const result = await tool.handler(input);
  const structured = (result.structuredContent ?? {}) as Record<string, unknown>;
  return {
    ...result,
    structuredContent: { tool: "embed_project", action, backend: "arduino", ...structured },
  };
}
