import { z } from "zod";

/**
 * `cubeide_debug` / `cubeide_build` 的 action 面与白名单。
 *
 * 动作名尽量与 keil 的对齐（同名同义），这样路由门面转发时不需要翻译，
 * 模型在两个后端之间迁移时肌肉记忆也是同一套。差异点：
 * - erase 在这里是**可用**的（STM32_Programmer_CLI -e all），keil 侧不可用；
 * - open 的 `project` 参数是工程目录（不是 uvprojx 那种单文件）；
 * - 没有 keil 的 target(hardware|simulator) 二选一——CubeIDE 无仿真器，
 *   调试永远走探针。
 */

export const CUBEIDE_DEBUG_ACTIONS = [
  "open",
  "run",
  "continue",
  "halt",
  "reset",
  "run_to",
  "step",
  "step_into",
  "step_instruction",
  "step_out",
  "breakpoints",
  "breakpoint_add",
  "breakpoint_delete",
  "registers",
  "register_read",
  "variables",
  "evaluate",
  "stack",
  "where",
  "read",
  "write",
  "disassemble",
  "status",
  "sessions",
  "close",
] as const;

export const CUBEIDE_BUILD_ACTIONS = [
  "info",
  "build",
  "rebuild",
  "clean",
  "probe",
  "flash",
  "erase",
  "version",
  "capabilities",
] as const;

export type CubeIdeDebugAction = (typeof CUBEIDE_DEBUG_ACTIONS)[number];
export type CubeIdeBuildAction = (typeof CUBEIDE_BUILD_ACTIONS)[number];

export const CUBEIDE_EVIDENCE_ACTIONS: ReadonlySet<string> = new Set([
  "registers", "register_read", "variables", "evaluate", "stack", "where",
  "read", "disassemble", "breakpoints", "status",
  "info", "probe", "version", "capabilities", "flash",
]);

export const CUBEIDE_DESTRUCTIVE_ACTIONS: ReadonlySet<string> = new Set([
  "write",
  "breakpoint_add", "breakpoint_delete",
  "run", "continue", "reset", "run_to", "step", "step_into", "step_instruction", "step_out",
  "flash", "erase",
  "build", "rebuild", "clean",
  "close",
]);

export const CUBEIDE_READONLY_ACTIONS: ReadonlySet<string> = new Set([
  "sessions", "status", "breakpoints", "registers", "register_read", "variables",
  "evaluate", "stack", "where", "read", "disassemble",
  "info", "probe", "version", "capabilities",
]);

export const cubeideDebugInputSchema = z
  .object({
    action: z.enum(CUBEIDE_DEBUG_ACTIONS),
    project: z.string().optional(),
    elf: z.string().optional(),
    port: z.number().int().min(1024).max(65535).optional(),
    load: z.boolean().optional(),
    location: z.string().optional(),
    address: z.number().int().min(0).max(0xffffffff).optional(),
    width: z.enum(["u8", "u16", "u32"]).optional(),
    count: z.number().int().min(1).optional(),
    value: z.number().int().optional(),
    expression: z.string().optional(),
    timeout_ms: z.number().int().min(0).optional(),
  })
  .strict();

export const cubeideBuildInputSchema = z
  .object({
    action: z.enum(CUBEIDE_BUILD_ACTIONS),
    project: z.string().optional(),
    config: z.string().optional(),
    image: z.string().optional(),
    address: z.number().int().min(0).max(0xffffffff).optional(),
    verify: z.boolean().optional(),
    port: z.number().int().min(1024).max(65535).optional(),
  })
  .strict();

export const DEBUG_DESCRIPTION =
  "Debug an STM32CubeIDE (Eclipse CDT) project through arm-none-eabi-gdb + ST-LINK_gdbserver, headless: set breakpoints, run, step, halt, read registers, variables, memory and the stack. The probe, device and flash algorithm come from the CubeIDE install itself — nothing is bundled. The project argument is the directory that holds .project and .cproject. Sessions stay open between calls; pass action `close` to release the probe.";

export const BUILD_DESCRIPTION =
  "Build, flash and erase an STM32CubeIDE project, headless: build through the IDE's own headless Eclipse builder, download the image with the bundled STM32_Programmer_CLI (with read-back verification), and — unlike the Keil backend — full-chip erase IS available here (`erase`). The project argument is the directory that holds .project and .cproject. Flash and erase end any open debug session first, because one probe cannot serve both.";
