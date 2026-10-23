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
  // CubeMX 三件套集成（用户定案：三件全装、各司其职）
  "generate",       // CubeMX 无头生成工程（MCU 名 → CubeIDE 工程）
  "ioc_generate",   // 从已有 .ioc 重新生成
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
    // generate: CubeMX 参数
    mcu: z.string().optional(),
    name: z.string().optional(),
    path: z.string().optional(),
    toolchain: z.enum(["STM32CubeIDE", "MDK-ARM", "EWARM", "Makefile", "CMake"]).optional(),
  })
  .strict();

export const DEBUG_DESCRIPTION =
  "Debug an STM32CubeIDE (Eclipse CDT) project through arm-none-eabi-gdb + ST-LINK_gdbserver, headless: set breakpoints, run, step, halt, read registers, variables, memory and the stack. The probe, device and flash algorithm come from the CubeIDE install itself — nothing is bundled. The project argument is the directory that holds .project and .cproject. Sessions stay open between calls; pass action `close` to release the probe.";

export const BUILD_DESCRIPTION =
  "The STM32Cube toolchain, headless — three tools with one job each: CubeMX generates the project (from an MCU part number or an existing .ioc, with correct clock tree and peripheral config), CubeIDE builds it (Eclipse headlessbuild) and debugs it (gdb + ST-LINK_gdbserver), CubeProgrammer flashes it (with verify; full-chip erase included). Requires all three installed: CUBEMX_HOME for CubeMX, CUBEIDE_HOME for CubeIDE (the bundled CubeProgrammer is used). Typical flow: generate → build → flash, then debug via cubeide_debug.";

// ---- embed_serial -----------------------------------------------------------

export const SERIAL_ACTIONS = ["read", "write", "ports", "status"] as const;
export type SerialAction = (typeof SERIAL_ACTIONS)[number];

export const SERIAL_EVIDENCE_ACTIONS: ReadonlySet<string> = new Set(["read", "ports", "status"]);
export const SERIAL_DESTRUCTIVE_ACTIONS: ReadonlySet<string> = new Set(["write"]);

export const serialInputSchema = z
  .object({
    action: z.enum(SERIAL_ACTIONS),
    // `read` without port → the panel's ring mirror; with port+baud → open
    // the port directly for durationMs and read the line tail.
    port: z.string().optional(),
    baud: z.number().int().min(300).max(4_000_000).optional(),
    max_lines: z.number().int().min(1).max(500).optional(),
    since: z.number().int().min(0).optional(),
    duration_ms: z.number().int().min(50).max(30_000).optional(),
    data: z.string().max(4096).optional(),
  })
  .strict();

export const SERIAL_DESCRIPTION =
  "Serial monitor access for the agent — the same data the desktop panel shows. action `read` without `port` returns the panel's live ring buffer (the desktop host keeps writing it to <home>/.harness/serial/ring.json); action `read` with `port`+`baud`+`duration_ms` opens the COM port directly for that window and returns the lines captured (fails honestly if the panel already owns the port — COM ports are exclusive). action `write` sends data out through the panel's open port or a transient one. action `ports` lists COM ports with friendly names. action `status` reports which port is open and who owns it.";
