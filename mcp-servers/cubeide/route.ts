import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { findUvprojx } from "../keil/projectLookup.js";
import { findEclipseProjects } from "./eclipseProject.js";
import type { ProbeToolResult, ProbeToolSpec } from "../probe/tools.js";
import type { LegacyTool } from "../keil/tools.js";

/**
 * 统一工程路由门面：`embed_project`。
 *
 * 用户目标（2026-10-23 决策，方案 A）：模型只调一个工具，门面识别目录里的
 * 工程类型并分发——遇到什么工程调用哪个 MCP，模型不需要知道。
 *
 * 识别规则（cubeide-porting-spec.md 的路由表）：
 *   .uvprojx/.uvproj            → keil
 *   .project + .cproject 同目录 → cubeide
 *   两者都在                    → mixed：列出全部，要求显式 `project`
 *   都没有                      → 诚实报错 + 目录线索（Makefile/CMakeLists 等）
 *
 * 备份文件不算工程、输出目录不进 —— 这两条是 findUvprojx 的实测硬规则，
 * findEclipseProjects 同样遵守。
 */

export type ProjectKind = "keil" | "cubeide" | "mixed" | "none";

export interface RouteResult {
  kind: ProjectKind;
  /** 各类型的工程文件（mixed / none 时全量列出）。 */
  keilFile?: string;
  eclipseProjects?: string[];
  /** none 时的目录线索。 */
  hints?: string[];
}

export function routeProject(root: string): RouteResult {
  const keilFile = findUvprojx(root) ?? undefined;
  const eclipse = findEclipseProjects(root);
  if (keilFile && eclipse.length === 0) return { kind: "keil", keilFile };
  if (!keilFile && eclipse.length > 0) return { kind: "cubeide", eclipseProjects: eclipse.map((entry) => entry.dir) };
  if (keilFile && eclipse.length > 0) {
    return { kind: "mixed", keilFile, eclipseProjects: eclipse.map((entry) => entry.dir) };
  }
  const hints: string[] = [];
  try {
    const entries = readdirSync(root);
    for (const marker of ["Makefile", "CMakeLists.txt", "platformio.ini", "Cargo.toml", "package.json", "CMakePresets.json"]) {
      if (entries.includes(marker)) hints.push(marker);
    }
  } catch {
    /* unreadable directory: no hints */
  }
  return { kind: "none", ...(hints.length > 0 ? { hints } : {}) };
}

const FIRMWARE_ACTIONS = new Set([
  "build", "rebuild", "clean", "flash", "erase", "info",
]);

export const embedProjectSchema = z.object({
  action: z.string().min(1),
  project: z.string().optional(),
}).passthrough();

export const EMBED_PROJECT_DESCRIPTION =
  "Work on the embedded project in the working directory — the router picks the right backend for you. " +
  "A Keil MDK project (.uvprojx) is routed to the Keil uVision backend; an STM32CubeIDE / Eclipse CDT project (.project + .cproject) is routed to the CubeIDE backend (headless build, STM32_Programmer_CLI flash, and full-chip erase — which the Keil backend cannot do). " +
  "Pass action `identify` to only ask what kind of project this is and what files were found. Other actions are forwarded verbatim to the backend tool that owns them (keil_debug / keil_project / cubeide_debug / cubeide_build); unknown or unsupported actions are reported honestly, never guessed. " +
  "When the directory holds both kinds, the router refuses and asks for an explicit `project` argument.";

/** 路由 + 转发。keil 侧的 LegacyTool 由 createKeilTools 的输入提供。 */
export function createEmbedProjectTool(keilLegacy: LegacyTool[]): ProbeToolSpec {
  const keilDebug = keilLegacy.find((tool) => tool.name === "keil_debug");
  const keilProject = keilLegacy.find((tool) => tool.name === "keil_project");
  return {
    name: "embed_project",
    description: EMBED_PROJECT_DESCRIPTION,
    inputSchema: embedProjectSchema,
    annotations: { readOnlyHint: false, destructiveHint: true },
    meta: { evidence: true, evidenceActions: ["identify", "info", "registers", "variables", "read"], destructiveActions: ["flash", "erase", "write", "build"] },
    handler: async (args: unknown): Promise<ProbeToolResult> => {
      const input = (args ?? {}) as Record<string, unknown>;
      const action = String(input.action);
      const root = process.cwd();
      const route = routeProject(root);

      if (action === "identify") {
        const lines: string[] = [];
        if (route.kind === "keil") lines.push(`kind: keil`, `project: ${route.keilFile}`);
        else if (route.kind === "cubeide") lines.push(`kind: cubeide`, `projects: ${(route.eclipseProjects ?? []).join(", ")}`);
        else if (route.kind === "mixed") {
          lines.push(`kind: mixed — both a Keil and a CubeIDE project are present; pass \`project\` to choose one`, `keil: ${route.keilFile}`, `cubeide: ${(route.eclipseProjects ?? []).join(", ")}`);
        } else {
          lines.push(`kind: none — no .uvprojx and no .project/.cproject pair in ${root}`);
          if (route.hints?.length) lines.push(`build-system clues found: ${route.hints.join(", ")}`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: { tool: "embed_project", action, ...route } };
      }

      if (route.kind === "none") {
        return {
          content: [{
            type: "text",
            text: `no recognised project in ${root} (no .uvprojx, no .project/.cproject).${route.hints?.length ? ` Build-system clues: ${route.hints.join(", ")} — that build system has no backend here.` : ""}`,
          }],
          structuredContent: { tool: "embed_project", action, ...route },
          isError: true,
        };
      }
      if (route.kind === "mixed") {
        return {
          content: [{
            type: "text",
            text: `both a Keil project (${route.keilFile}) and CubeIDE projects (${(route.eclipseProjects ?? []).join(", ")}) are present; pass \`project\` with the one you mean.`,
          }],
          structuredContent: { tool: "embed_project", action, ...route },
          isError: true,
        };
      }

      // 显式 project 参数可能指向另一种类型：以显式参数为准。
      const explicit = input.project ? String(input.project) : undefined;
      let kind = route.kind;
      if (explicit) {
        const isKeil = /\.uvprojx?$/i.test(explicit) && existsSync(explicit);
        const isEclipse = existsSync(join(explicit, ".project")) || explicit.endsWith(".project");
        if (isKeil && !isEclipse) kind = "keil";
        else if (isEclipse && !isKeil) kind = "cubeide";
        else if (!isKeil && !isEclipse) {
          return { content: [{ type: "text", text: `${explicit} is neither a .uvprojx nor a CubeIDE project directory; nothing was routed.` }], isError: true };
        }
      }

      const routed = kind === "keil" ? (FIRMWARE_ACTIONS.has(action) ? keilProject : keilDebug) : null;
      if (kind === "keil" && !routed) {
        return { content: [{ type: "text", text: `action \`${action}\` has no Keil handler (this is a routing bug)` }], isError: true };
      }
      if (kind === "keil" && routed) {
        const result = await routed.execute(input, { cwd: root });
        return {
          content: [{ type: "text", text: result.content }],
          structuredContent: { tool: "embed_project", action, backend: "keil", ...(result.data && typeof result.data === "object" ? (result.data as Record<string, unknown>) : {}) },
          ...(result.isError ? { isError: true } : {}),
        };
      }
      // cubeide 动作直接在本文件里可用——通过动态 import 避免硬依赖
      // keil 与 cubeide 互相引用（keil 不 import 本文件）。
      const { handleCubeIdeAction } = await import("./route-cubeide.js");
      return handleCubeIdeAction(input, root);
    },
  };
}

