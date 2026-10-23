import { join } from "node:path";
import { existsSync } from "node:fs";
import type { ProbeToolResult } from "../probe/tools.js";
import { readEclipseName } from "./eclipseProject.js";

/**
 * cubeide 侧的路由落点：把 embed_project 的入参转成 cubeide_build /
 * cubeide_debug 的 handler 调用。
 *
 * 动作归属（与 cubeide/actions.ts 的两张 action 面一致）：
 *   build/rebuild/clean/flash/erase/probe/version/capabilities/info → cubeide_build
 *   其余（调试动作）                                                 → cubeide_debug
 *
 * `project` 参数这里是**目录**（Eclipse 工程目录），与 keil 侧的单文件
 * .uvprojx 不同——这正是两个后端不能共用一张 schema 的原因之一。
 */

const BUILD_ACTIONS = new Set(["build", "rebuild", "clean", "flash", "erase", "probe", "version", "capabilities", "info"]);
const DEBUG_ACTIONS = new Set([
  "open", "run", "continue", "halt", "reset", "run_to", "step", "step_into",
  "step_instruction", "step_out", "breakpoints", "breakpoint_add", "breakpoint_delete",
  "registers", "register_read", "variables", "evaluate", "stack", "where", "read", "write",
  "disassemble", "status", "sessions", "close",
]);

/** CubeIDE 工程目录的构建产物：Debug/<name>.elf 是默认布局。 */
export function eclipseBuildElf(projectDir: string): string | undefined {
  const name = readEclipseName(join(projectDir, ".project")) ?? "";
  for (const config of ["Debug", "Release"]) {
    for (const candidate of [join(projectDir, config, `${name}.elf`), join(projectDir, config, `${name}.bin`), join(projectDir, config, `${name}.hex`)]) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

export async function handleCubeIdeAction(input: Record<string, unknown>, root: string): Promise<ProbeToolResult> {
  const { createCubeIdeTools } = await import("./tools.js");
  const [debugTool, buildTool] = createCubeIdeTools();
  const action = String(input.action);

  // project 参数：识别器已判定这是 CubeIDE 工程；把目录传给后端。
  let projectDir = input.project ? String(input.project) : undefined;
  if (projectDir?.endsWith(".project")) projectDir = join(projectDir, "..");
  const tool = BUILD_ACTIONS.has(action) ? buildTool : DEBUG_ACTIONS.has(action) ? debugTool : null;
  if (!tool) {
    return {
      content: [{ type: "text", text: `action \`${action}\` belongs to neither cubeide_debug nor cubeide_build; nothing was routed.` }],
      structuredContent: { tool: "embed_project", action, backend: "cubeide" },
      isError: true,
    };
  }
  const forwarded = { ...input, ...(projectDir ? { project: projectDir } : {}) };
  const result = await tool.handler(forwarded);
  const structured = (result.structuredContent ?? {}) as Record<string, unknown>;
  return {
    ...result,
    structuredContent: { tool: "embed_project", action, backend: "cubeide", ...structured },
  };
}
