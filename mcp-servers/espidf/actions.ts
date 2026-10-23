import { z } from "zod";

/**
 * `esp_debug` / `esp_build` 的 action 面与白名单。命名与 keil/cubeide 对齐，
 * 门面转发无需翻译。
 */

export const ESP_DEBUG_ACTIONS = [
  "open",
  "run",
  "continue",
  "halt",
  "reset",
  "step",
  "step_into",
  "step_instruction",
  "step_out",
  "breakpoints",
  "breakpoint_add",
  "breakpoint_delete",
  "registers",
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

export const ESP_BUILD_ACTIONS = [
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

export type EspDebugAction = (typeof ESP_DEBUG_ACTIONS)[number];
export type EspBuildAction = (typeof ESP_BUILD_ACTIONS)[number];

export const ESP_EVIDENCE_ACTIONS: ReadonlySet<string> = new Set([
  "registers", "variables", "evaluate", "stack", "where", "read", "disassemble",
  "breakpoints", "status", "info", "probe", "version", "capabilities", "flash",
]);

export const ESP_DESTRUCTIVE_ACTIONS: ReadonlySet<string> = new Set([
  "write", "breakpoint_add", "breakpoint_delete",
  "run", "continue", "reset", "step", "step_into", "step_instruction", "step_out",
  "flash", "erase", "build", "rebuild", "clean", "close",
]);

export const espDebugInputSchema = z
  .object({
    action: z.enum(ESP_DEBUG_ACTIONS),
    project: z.string().optional(),
    board_cfg: z.string().optional(),
    reuse_openocd: z.boolean().optional(),
    location: z.string().optional(),
    address: z.number().int().min(0).max(0xffffffff).optional(),
    width: z.enum(["u8", "u16", "u32"]).optional(),
    count: z.number().int().min(1).optional(),
    value: z.number().int().optional(),
    expression: z.string().optional(),
    timeout_ms: z.number().int().min(0).optional(),
  })
  .strict();

export const espBuildInputSchema = z
  .object({
    action: z.enum(ESP_BUILD_ACTIONS),
    project: z.string().optional(),
    target: z.string().optional(),
    port: z.string().optional(),
    baud: z.number().int().min(9600).max(3_000_000).optional(),
    verify: z.boolean().optional(),
  })
  .strict();

export const DEBUG_DESCRIPTION =
  "Debug an ESP32 (ESP-IDF) project through openocd-esp32 + esp-gdb over GDB/MI, headless: breakpoints, run, halt, step, registers, variables, memory. The board config comes from the project's own build/project_description.json (written by idf.py), so no chip guessing. Debugging uses JTAG or the chip's built-in USB-JTAG (S3/C3 etc.) — a plain UART board cannot be debugged, only flashed. Sessions stay open between calls; pass action `close` to release.";

export const BUILD_DESCRIPTION =
  "Build, flash and erase an ESP32 (ESP-IDF) project, headless: build with idf.py (CMake), flash the full image set from build/flasher_args.json with esptool (bootloader + partition table + app at their own offsets, verified), and full-chip erase with erase-flash. The project argument is the directory holding CMakeLists.txt (an IDF project includes tools/cmake/project.cmake).";
