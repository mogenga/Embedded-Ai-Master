import { z } from "zod";

/**
 * `keil_debug` / `keil_project` 的 action 面与参数表。
 *
 * 枚举与参数逐字取自 A 的 `keilTools.ts:369-455`（56 + 14）。这里的注解表
 * （evidence / destructive）对应 keil-porting-spec.md §7：evidence 的动作结果
 * 不允许被上下文压缩吞掉，destructive 的动作必须带写前声明。
 */

export const DEBUG_ACTIONS = [
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
  "step_many",
  "breakpoints",
  "breakpoint_add",
  "breakpoint_delete",
  "watch_add",
  "watch_remove",
  "registers",
  "register_read",
  "register_set",
  "variables",
  "struct_members",
  "stack",
  "where",
  "read",
  "write",
  "evaluate",
  "command",
  "variable_set",
  "tasks",
  "trace",
  "trace_set",
  "trace_get",
  "itm",
  "event_recorder",
  "show_code",
  "disassemble",
  "menus",
  "menu_exec",
  "time",
  "license",
  "version",
  "capabilities",
  "window",
  "build",
  "rebuild",
  "clean",
  "clean_rebuild",
  "export_cprj",
  "symbols",
  "symbols_all",
  "export_cprjs",
  "convert",
  "flash",
  "erase",
  "sessions",
  "close",
  "close_project",
] as const;

export const PROJECT_ACTIONS = [
  "info",
  "targets",
  "groups",
  "files",
  "add_group",
  "add_file",
  "remove_file",
  "remove_group",
  "get_option",
  "set_option",
  "set_target",
  "set_output_name",
  "output_name",
  "close",
] as const;

export type DebugAction = (typeof DEBUG_ACTIONS)[number];
export type ProjectAction = (typeof PROJECT_ACTIONS)[number];

/** 调试取证读数：结果本身是证据（§7.1）。 */
export const EVIDENCE_ACTIONS: ReadonlySet<string> = new Set([
  "registers", "register_read", "variables", "struct_members", "stack", "where", "tasks", "time",
  "read", "disassemble", "show_code", "symbols", "symbols_all", "trace_get", "itm", "event_recorder",
  "flash",
  "info", "targets", "groups", "files", "output_name", "get_option", "capabilities", "version", "license",
]);

/** 会改变目标状态、工程文件或烧录内容的动作（§7.2）。 */
export const DESTRUCTIVE_ACTIONS: ReadonlySet<string> = new Set([
  "write", "register_set", "variable_set",
  "breakpoint_add", "breakpoint_delete", "watch_add", "watch_remove",
  "run", "continue", "reset", "run_to", "step", "step_into", "step_instruction", "step_out", "step_many",
  "flash", "erase",
  "build", "rebuild", "clean", "clean_rebuild", "convert", "export_cprj", "export_cprjs",
  "command", "menu_exec",
  "add_group", "add_file", "remove_file", "remove_group", "set_option", "set_target", "set_output_name",
  "close", "close_project",
]);

/** 只读且无副作用的查询动作（拿不准的不标，fail-closed）。 */
export const READONLY_ACTIONS: ReadonlySet<string> = new Set([
  "sessions", "menus", "breakpoints", "capabilities", "version", "license", "time",
  "registers", "register_read", "variables", "struct_members", "stack", "where", "tasks",
  "read", "disassemble", "show_code", "symbols", "symbols_all", "trace_get", "itm", "event_recorder",
  "info", "targets", "groups", "files", "output_name", "get_option",
]);

export const debugInputSchema = z
  .object({
    action: z.enum(DEBUG_ACTIONS),
    project: z.string().optional(),
    target: z.enum(["hardware", "simulator"]).optional(),
    target_name: z.string().optional(),
    port: z.number().int().min(1).max(65535).optional(),
    location: z.string().optional(),
    kind: z.enum(["exec", "read", "write", "readwrite"]).optional(),
    address: z.number().int().min(0).max(0xffffffff).optional(),
    width: z.enum(["u8", "u16", "u32"]).optional(),
    count: z.number().int().min(1).optional(),
    frame: z.number().int().min(0).optional(),
    value: z.number().int().optional(),
    expression: z.string().optional(),
    command: z.string().optional(),
    name: z.string().optional(),
    register_value: z.string().optional(),
    window: z.enum(["show", "hide", "minimize"]).optional(),
    timeout_ms: z.number().int().min(0).optional(),
  })
  .strict();

export const projectInputSchema = z
  .object({
    action: z.enum(PROJECT_ACTIONS),
    project: z.string().optional(),
    group: z.string().optional(),
    file: z.string().optional(),
    target: z.string().optional(),
    option: z
      .enum(["CDEF", "CINCL", "ADEF", "AINCL", "COPTIMIZE", "CODEGEN", "CMISC", "AMISC", "LMISC", "MEMRANGES", "UBCOMP1", "UBCOMP2", "UBBUILD1", "UBBUILD2"])
      .optional(),
    value: z.string().optional(),
    port: z.number().int().min(1).max(65535).optional(),
  })
  .strict();

/** 两个工具的描述，以 A 的 keilTools.ts:369 / 1086 为底，补上落盘语义（§6.3）。 */
export const DEBUG_DESCRIPTION =
  "Debug a Keil MDK project through uVision's own debugger, headless: set breakpoints, run, step, halt, read registers, variables, memory and the stack. This is the path to take on a machine whose only debugger is Keil's — it uses the probe, device and flash algorithm configured in the .uvprojx/.uvoptx, so no second toolchain is needed. `target` chooses the real board (`hardware`, the default) or uVision's instruction set simulator (`simulator`). Sessions stay open between calls; pass action `close` to release the probe.";

export const PROJECT_DESCRIPTION =
  "Read and change the Keil MDK project itself, headless: list targets, groups and files; add or remove a group or a source file; read and set the compile defines, include paths and optimisation for a target; switch the active target. Changes are written to the .uvprojx by uVision, so the project opens and builds exactly as edited here. Changes are written to the .uvprojx by uVision when the session closes — not by this process writing the file directly.";