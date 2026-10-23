import type { ProbeToolResult } from "../probe/tools.js";

/**
 * espidf 侧的路由落点：embed_project 的入参转 esp_build / esp_debug。
 *
 * 动作归属与 actions.ts 的两张 action 面一致；`project` 参数是工程目录
 * （CMakeLists.txt 所在层），esp 后端的 resolveProject 会再验证签名。
 */

const BUILD_ACTIONS = new Set(["build", "rebuild", "clean", "flash", "erase", "probe", "version", "capabilities", "info"]);

export async function handleEspIdfAction(input: Record<string, unknown>): Promise<ProbeToolResult> {
  const { createEspIdfTools } = await import("./tools.js");
  const [debugTool, buildTool] = createEspIdfTools();
  const action = String(input.action);
  const tool = BUILD_ACTIONS.has(action) ? buildTool : debugTool;
  const result = await tool.handler(input);
  const structured = (result.structuredContent ?? {}) as Record<string, unknown>;
  return {
    ...result,
    structuredContent: { tool: "embed_project", action, backend: "espidf", ...structured },
  };
}
