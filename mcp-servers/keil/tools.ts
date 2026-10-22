/**
 * Tools for driving Keil MDK headless.
 *
 * The plain build path already runs `UV4 -b`, but a Keil project's debugger,
 * project structure and per-target options are not reachable from
 * command-line flags. They are reachable through uVision's own socket
 * interface, and `keil_debug` / `keil_project` expose that: breakpoints,
 * stepping, registers, variables, memory, stack — and adding files, groups,
 * targets and compile options to the `.uvprojx` itself.
 *
 * Everything here works on the user's own licensed install. Nothing is
 * bundled, downloaded or redistributed.
 *
 * Two constraints found by measurement, both reflected below:
 *
 *  - Debug mode and project edits are mutually exclusive: an entered debugger
 *    refuses `PRJ_ADD_GROUP` and `PRJ_GET_OPTITEM` with "Target is in debug
 *    mode", while the structure listers only answer *inside* one.
 *  - `DBG_ENTER` returns `SUCCESS` before it has done anything; a board that
 *    does not answer is reported as a later `0x4000` frame, so the outcome is
 *    read from the status and those frames rather than from the reply.
 */

import { debugInputSchema, projectInputSchema, DEBUG_DESCRIPTION, PROJECT_DESCRIPTION, EVIDENCE_ACTIONS, DESTRUCTIVE_ACTIONS } from "./actions.js";
import { declarationFor } from "./declarations.js";
import { selectionFromEnv } from "./resolve.js";
import type { ProbeToolResult, ProbeToolSpec } from "../probe/tools.js";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import type { KeilSelection } from "./resolve.js";
import { detectProject, keilOutputDirs } from "./project.js";
import {
  addAccessBreakpoint,
  addBreakpoint,
  addFile,
  addGroup,
  addWatch,
  filePathsInGroup,
  addressToSource,
  buildInIde,
  cancelBuild,
  changeBreakpoint,
  cleanInIde,
  closeKeilSession,
  verifyFlash,
  currentLocation,
  currentTarget,
  eraseFlash,
  massEraseCommand,
  massEraseSucceeded,
  massEraseUnavailableReason,
  evaluate,
  evalInWindow,
  flashInIde,
  getOption,
  getOutputName,
  sameOutputName,
  halt,
  imageLocation,
  listBreakpoints,
  listKeilSessions,
  enterDebug,
  openKeilSession,
  projectGroups,
  projectTargets,
  readMemory,
  readRegisterGroups,
  readRegisters,
  readStructMembers,
  readStack,
  readTasks,
  readVariables,
  readVariablesTruncated,
  VARIABLE_BATCH,
  describeVariableValue,
  evaluationError,
  readVtr,
  readNamedRegisters,
  readScvdFiles,
  readVtrValue,
  registerItm,
  removeWatch,
  setEventRecorder,
  showCodeAt,
  debugCommand,
  disassemble,
  execMenu,
  ideVersionText,
  licenseInfo,
  readMenus,
  resetTarget,
  runToAddress,
  setVariable,
  setVtr,
  stepMany,
  timeInfo,
  windowState,
  waitForStop,
  removeFile,
  removeGroup,
  run,
  setOption,
  setOutputName,
  setTarget,
  step,
  writeRegister,
  writeMemory,
  type KeilSession,
  type OptionName,
} from "./keilSession.js";
import { keilCli } from "./keilCli.js";
import { NEEDS_EXTENDED_STACK, UNSUPPORTED_ON_MDK_5_43 } from "./keilExtra.js";
import { readProjectFacts } from "./keilProjectFile.js";
import { toolEnv } from "./toolEnv.js";
import { stopReasonName } from "./uvsock.js";

/** A 侧工具的返回形状；注册层再转换成 probe 的 ProbeToolResult。 */
interface LegacyResult {
  content: string;
  isError?: boolean;
  display?: string;
  data?: unknown;
}

interface ToolContext {
  cwd: string;
  selection?: KeilSelection;
}

interface LegacyTool {
  name: string;
  description: string;
  readonly: boolean;
  parameters: Record<string, unknown>;
  summarize?: (input: Record<string, unknown>) => string;
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<LegacyResult>;
}

/**
 * STM32CubeProgrammer 的最小发现。
 *
 * A 侧走完整的 toolchain 探测（9 种工具链）；Keil 闭包只需要 `erase` 用的这一个
 * CLI，因此按 PATH 与 ST 的标准安装目录查找（keil-porting-spec.md §5.3 的同一
 * 取舍：不全量搬探测）。
 */
async function findStm32Programmer(): Promise<{ path: string } | null> {
  const names = process.platform === "win32"
    ? ["STM32_Programmer_CLI.exe", "STM32_Programmer_CLI"]
    : ["STM32_Programmer_CLI"];
  const sep = process.platform === "win32" ? ";" : ":";
  for (const dir of (process.env.PATH ?? "").split(sep).filter(Boolean)) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return { path: candidate };
    }
  }
  const roots = [process.env["ProgramFiles"], process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA, process.env.USERPROFILE]
    .filter((value): value is string => Boolean(value));
  for (const root of roots) {
    const candidate = join(root, "STMicroelectronics", "STM32Cube", "STM32CubeProgrammer", "bin", "STM32_Programmer_CLI.exe");
    if (existsSync(candidate)) return { path: candidate };
  }
  return null;
}

const hex = (value: number) => `0x${value.toString(16)}`;

/** The last addressable byte of a Cortex-M's 32-bit address space. */
const LAST_ADDRESS = 0xffffffff;

/**
 * The rows a `read` prints, one per access width.
 *
 * A read that starts near the top of the address space used to run past the
 * end: `read address=0xFFFFFFFF width=u8 count=4` printed `0x100000000 = 168`,
 * an address this chip does not have. The debugger had answered with bytes for
 * whatever it had, and the renderer counted them out arithmetically. Nothing
 * past `0xFFFFFFFF` is addressable, so the list stops there.
 *
 * A short reply ends the list at the last whole unit. Asking for four u32 and
 * getting nine bytes is nine bytes of evidence — six of them still form a
 * `u32` worth reporting as a `u16` and a `u8`, and dropping the whole answer
 * because the tail was short throws away what the chip did say.
 */
export function memoryReadRows(address: number, size: number, bytes: number[]): { address: number; value: number }[] {
  const rows: { address: number; value: number }[] = [];
  const requested = size === 1 ? 1 : size === 2 ? 2 : 4;
  // Fall back to a narrower unit only when the reply is shorter than the one
  // asked for; a full reply is always reported at the width the caller chose.
  const width = bytes.length >= requested ? requested : bytes.length >= 2 ? 2 : 1;
  for (let offset = 0; offset + width <= bytes.length; offset += width) {
    const at = address + offset;
    // The row's last byte must still be inside the address space. A 32-bit
    // word at 0xFFFFFFFC is readable; one at 0xFFFFFFFE is not this chip's.
    if (at + width - 1 > LAST_ADDRESS) break;
    let value = 0;
    for (let position = 0; position < width; position++) value += bytes[offset + position]! * 2 ** (8 * position);
    rows.push({ address: at, value: value >>> 0 });
  }
  return rows;
}

/**
 * Resolve what a Keil call should use, without the caller restating it.
 *
 * Explicit arguments win, then the selection the user made in the Board pane,
 * then the defaults. This is the same precedence `selectedBoard` applies to
 * `embed_flash`, and it exists for the same reason: fifty-odd actions that each
 * need the project path would otherwise make the model repeat it every turn.
 */
export function resolveKeil(
  input: Record<string, unknown>,
  keil: KeilSelection | undefined,
  options: { connectOnly?: boolean } = {},
): {
  project?: string;
  backend: "hardware" | "simulator";
  /** The port a debug session uses. */
  debugPort: number;
  /** The port a plain project session uses. */
  projectPort: number;
  /** The port this call should use, given what kind of session it needs. */
  port: number;
  targetName?: string;
} {
  const project = input.project ? String(input.project) : keil?.project;
  // `backend` chooses the simulator or the board; `targetName` chooses a
  // `<Target>` block. They used to share one field, which is why a multi-target
  // project could not be named and why `-t` received `hardware`.
  const explicitBackend = input.backend ?? input.target;
  const backend =
    explicitBackend === "hardware" || explicitBackend === "simulator"
      ? explicitBackend
      : keil?.backend ?? "hardware";
  const targetName = input.target_name ? String(input.target_name) : keil?.targetName;
  const explicitPort = input.port !== undefined ? Number(input.port) : undefined;
  const debugPort = explicitPort ?? keil?.port ?? 4823;
  const projectPort = explicitPort ?? keil?.projectPort ?? 4824;
  return {
    ...(project ? { project } : {}),
    backend,
    debugPort,
    projectPort,
    port: options.connectOnly ? projectPort : debugPort,
    ...(targetName ? { targetName } : {}),
  };
}

/** Opening a session is shared by both tools; failures read the same. */
async function sessionFor(
  input: Record<string, unknown>,
  cwd: string,
  selection: KeilSelection | undefined,
  options: { target?: "hardware" | "simulator"; connectOnly?: boolean } = {},
): Promise<{ ok: true; session: KeilSession; key: string; log: string[] } | { ok: false; content: string }> {
  const resolved = resolveKeil(input, selection, { ...(options.connectOnly ? { connectOnly: true } : {}) });
  // A debug session and a plain project session cannot be the same uVision:
  // the target options refuse to answer while the debugger is entered, so the
  // plain one runs on its own port and is reused only by plain work.
  const chosen = options.target ?? resolved.backend;
  const opened = await openKeilSession({
    cwd,
    ...(resolved.project ? { project: resolved.project } : {}),
    target: chosen,
    port: resolved.port,
    ...(options.connectOnly ? { connectOnly: true } : {}),
  });
  if (!opened.ok || !opened.session) {
    return { ok: false, content: [opened.reason ?? "could not open a Keil session", ...opened.log].join("\n") };
  }
  return { ok: true, session: opened.session, key: opened.key!, log: opened.log };
}

/**
 * The project's targets, from whichever source can answer.
 *
 * `PRJ_ENUM_TARGETS` refuses inside a debug session (status `DEBUGGING`, no
 * frames), and most `keil_debug` actions are in one. The project file holds the
 * same list and is readable in either state, so it is the fallback rather than
 * reporting a project with no targets.
 */
async function targetsFor(session: KeilSession): Promise<string[]> {
  const listed = await projectTargets(session);
  if (listed.length > 0) return listed;
  try {
    return readProjectFacts(session.project).targets;
  } catch {
    return [];
  }
}
function describeWhere(where: { address: number; file?: string; line?: number; function?: string }): string {
  const symbol = where.function ? `${where.function} ` : "";
  const at = where.file ? `${where.file}:${where.line ?? "?"}` : hex(where.address);
  return `${symbol}${at}${where.file ? ` (${hex(where.address)})` : ""}`;
}

/** Close every session and say whether the project file was written. */
async function closeAndReport(cwd: string): Promise<LegacyResult> {
  // Closing is how project edits reach the file: uVision writes the
  // `.uvprojx` on its way out. Comparing the file around the close is what
  // turns "closed" into "saved".
  //
  // Measured on this bench: with the session open, adding a group answers
  // SUCCESS and the `.uvprojx` is byte-identical, same mtime, same group
  // list. Only after uVision exits does the group appear. So an edit that is
  // reported as made is not on disk until this runs, and a close that changed
  // nothing is reported as such rather than assumed to have saved.
  //
  // The file to watch is the one the **open sessions** were opened on, not
  // whatever detection answers now: a session started with an explicit
  // `project` argument can point outside `cwd`, and detection would then
  // compare the wrong file and report "unchanged" about a project nobody
  // touched.
  const watched = [...new Set(listKeilSessions().map((entry) => entry.project))];
  const fallback = detectProject(cwd).file;
  const files = (watched.length > 0 ? watched : fallback ? [fallback] : []).filter((file) => existsSync(file));
  const before = new Map(files.map((file) => [file, readFileSync(file)]));
  let closed = 0;
  for (const entry of listKeilSessions()) if (await closeKeilSession(entry.key)) closed++;
  const lines = [`closed ${closed} Keil session(s)`];
  if (files.length === 0) {
    lines.push("no .uvprojx is known — no session was open and none was detected — so there was nothing to write");
  }
  for (const file of files) {
    const after = existsSync(file) ? readFileSync(file) : null;
    const previous = before.get(file)!;
    if (!after) lines.push(`${file} disappeared while the session closed`);
    else if (!previous.equals(after)) lines.push(`wrote ${file}`);
    else lines.push(`${file} is unchanged; there were no edits to write, or they were already on disk`);
  }
  return { content: lines.join("\n"), display: "closed" };
}

/**
 * Erase the whole chip, which uVision on this target cannot do.
 *
 * `PRJ_FLASH_ERASE` never answers and a download only erases the sectors its
 * image occupies (both measured — see `FLASH_ERASE_LIMITATION`). ST's CLI talks
 * to the same ST-Link and has the chip's mass-erase command, so it is what
 * "erase" means here.
 *
 * The debug sessions are closed first: one probe cannot be owned by uVision and
 * ST's CLI at the same time.
 */
async function massErase(cwd: string): Promise<{ ok: boolean; lines: string[] }> {
  const found = await findStm32Programmer();
  if (!found) return { ok: false, lines: [massEraseUnavailableReason()] };
  const closed = await closeAndReport(cwd);
  const run = () =>
    new Promise<{ code: number | null; out: string }>((resolve) => {
      execFile(
        found.path,
        massEraseCommand({ cli: found.path }).slice(1),
        { cwd, timeout: 3 * 60_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: toolEnv() },
        (error, stdout, stderr) => {
          const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
          resolve({ code, out: `${stdout ?? ""}${stderr ?? ""}` });
        },
      );
    });
  const result = await run();
  const kept = String(closed.content ?? "").split("\n").filter((line) => line.startsWith("closed"));
  const lines = [...kept, `mass erase through ${basename(found.path)}`];
  const shown = result.out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  lines.push(...shown.filter((line) => /erase|error|fail|No STM32/i.test(line)).slice(-6));
  if (!massEraseSucceeded(result.out)) {
    lines.push(`the mass erase did not report success (exit ${result.code})`);
    return { ok: false, lines };
  }
  lines.push("mass erase achieved: the whole flash is 0xFF");
  return { ok: true, lines };
}

/** The stop, in the words a person would use. */function describeStop(info: { stopped: boolean; reason?: string; reasonCode?: number; pc?: number; slot?: number; reasonText?: string; output: string[] }): string[] {
  const lines: string[] = [];
  if (info.stopped) {
    const why = info.reasonText ?? (info.reasonCode !== undefined ? stopReasonName(info.reasonCode) : "stopped");
    lines.push(`stopped: ${why}${info.pc !== undefined ? ` at ${hex(info.pc)}` : ""}${info.slot !== undefined ? ` (hardware slot ${info.slot})` : ""}`);
  } else {
    lines.push(info.reason ?? "did not come to a stop");
  }
  for (const line of info.output) lines.push(`  ${line}`);
  return lines;
}

/**
 * Why a run that never stopped is a failure, in one line.
 *
 * `run` is "execute until something stops it". A target that is still running
 * when the wait expires has not done what was asked, so reporting the call as
 * a success told the caller "fine" about a program that is still going. The
 * message says what is true instead: it is running, and there was no stop.
 */
function didNotStop(
  info: { stopped: boolean; reason?: string },
  context?: { pcBefore?: number; pcAfter?: number; breakpoints?: { address?: number }[] },
): string | undefined {
  if (info.stopped) return undefined;
  const why = info.reason ?? "no stop notification arrived";
  // Measured: a core halted **on** a breakpoint often does not move when told
  // to run, and uVision sends no stop frame at all — the PC before and after
  // are the same address, and that address has a breakpoint on it. Naming that
  // turns "it did not stop" into something the caller can act on.
  const stuck = context?.pcBefore !== undefined && context.pcAfter !== undefined && context.pcBefore === context.pcAfter;
  const onBreakpoint = stuck && (context?.breakpoints ?? []).some((entry) => entry.address === context?.pcAfter);
  if (onBreakpoint) {
    return (
      `the target did not stop: ${why}. The core is halted at ${hex(context!.pcAfter!)} and did not move — ` +
      "a breakpoint sits on exactly that address, so it stops again the instant execution starts. " +
      "Step once (`step` / `step_instruction`) to leave it, or delete that breakpoint, then run."
    );
  }
  return `the target did not stop: ${why}. It may still be running — halt it, or set a breakpoint it will reach.`;
}

// ---- keil_debug ------------------------------------------------------------

const keilDebugTool: LegacyTool = {
  name: "keil_debug",
  description:
    "Debug a Keil MDK project through uVision's own debugger, headless: set breakpoints, run, step, halt, read registers, variables, memory and the stack. This is the path to take on a machine whose only debugger is Keil's — it uses the probe, device and flash algorithm configured in the .uvprojx/.uvoptx, so no second toolchain is needed. `target` chooses the real board (`hardware`, the default) or uVision's instruction set simulator (`simulator`). Sessions stay open between calls; pass action `close` to release the probe.",
  readonly: false,
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [
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
        ],
        description: "What to do. Default `run`: start execution and stop at the first breakpoint.",
      },
      project: { type: "string", description: "The .uvprojx path; defaults to the project detected in the workspace" },
      target: { type: "string", enum: ["hardware", "simulator"], description: "Debug the real board or uVision's simulator (default hardware). This is not the Keil `<Target>` name — use `target_name` for that." },
      target_name: { type: "string", description: "Keil's `<TargetName>` in a multi-target .uvprojx; defaults to the target picked in the Board pane, else the project's first target" },
      port: { type: "integer", description: "UVSOCK TCP port when 4823 is taken" },
      location: { type: "string", description: "For breakpoint_add/breakpoint_delete/watch_add: a function, `file:line`, `*0x08001234`, or the breakpoint number" },
      kind: { type: "string", enum: ["exec", "read", "write", "readwrite"], description: "Breakpoint kind (default exec)" },
      address: { type: "integer", description: "For read/write/run_to/disassemble: the address" },
      width: { type: "string", enum: ["u8", "u16", "u32"], description: "For read/write: access width (default u32)" },
      count: { type: "integer", description: "For read: how many values; for step_many: how many steps (default 1); for disassemble: how many instructions' worth of bytes (default 8)" },
      frame: { type: "integer", description: "For variables: which stack frame to list the locals of (0, the default, lists the globals)" },
      value: { type: "integer", description: "For write: the value to store" },
      expression: { type: "string", description: "For evaluate: a debugger expression, e.g. `uwTick` or `&g_state`" },
      command: {
        type: "string",
        description:
          "For action `command`: a uVision Command-window command, e.g. `BS main`, `BA read 0x20000000,4`, `LOG c:\trace.txt`, `SAVE c:\dump.hex 0x08000000,0x1000`, `LOGICAnalyze add ...`. This is the escape hatch for the parts of the debugger that are a command language rather than separate operations.",
      },
      name: { type: "string", description: "For a register write: the register name" },
      register_value: { type: "string", description: "For a register write: the new value" },
      window: { type: "string", enum: ["show", "hide", "minimize"], description: "For action `window`: what to do to the uVision window" },
      timeout_ms: { type: "integer", description: "How long to wait for a stop (default 30000)" },
    },
    required: ["action"],
    additionalProperties: false,
  },
  summarize: (input) => `keil: ${String(input.action)}`,
  async execute(input, ctx): Promise<LegacyResult> {
    const action = String(input.action);
    if (action === "sessions") {
      const open = listKeilSessions();
      if (open.length === 0) return { content: "No Keil sessions are open.", display: "no sessions" };
      return {
        content: open.map((entry) => `${entry.project} — ${entry.target}${entry.debugging ? ", in debug mode" : ""}`).join("\n"),
        display: `${open.length} session(s)`,
      };
    }
    if (action === "close") {
      return closeAndReport(ctx.cwd);
    }

    // Build, download and erase are **project** operations, and uVision
    // refuses them in a debug session ("Target is in debug mode"). They run on
    // the plain session, which is the same one `keil_project` edits through.
    // Everything else here is a debugger operation and needs the debug session.
    const projectAction = action === "build" || action === "rebuild" || action === "flash" || action === "erase";
    // `clean`, `clean_rebuild`, `export_cprj`, `symbols` and `convert` are one
    // UV4 command-line run each; they do not need a debugger, and entering one
    // first makes them fail on a machine with no image to load ("Flash
    // Download failed — Could not load file"). Measured: `convert` on a clean
    // tree reported that failure before ever reaching the conversion.
    const cliAction =
      action === "clean" ||
      action === "clean_rebuild" ||
      action === "export_cprj" ||
      action === "export_cprjs" ||
      action === "symbols" ||
      action === "symbols_all" ||
      action === "convert";
    // `keil_project action: "close"` and `keil_debug action: "close_project"`
    // close both sessions, and need no new one.
    if (action === "close_project") {
      return closeAndReport(ctx.cwd);
    }
    const opened = await sessionFor(input, ctx.cwd, ctx.selection, projectAction || cliAction ? { connectOnly: true } : {});
    if (!opened.ok) return { isError: true, content: opened.content, display: "Keil unavailable" };
    const session = opened.session;
    // Every inspection below answers an empty list when the debugger is not
    // entered, and an empty list is also a legitimate answer inside it — so
    // the two were indistinguishable. The session can be in this state without
    // anyone noticing: `command EXIT` leaves it in the map with `debugging`
    // false, and the next action reuses it. Only `open` re-enters, so every
    // other action is refused here rather than printing "(no breakpoints)".
    const needsDebugger = !projectAction && !cliAction && action !== "open";
    if (needsDebugger && !session.debugging) {
      return {
        isError: true,
        content:
          "this session is no longer in the debugger (a command-window `EXIT`, or it was never entered). " +
          "Run `keil_debug` with action `open` first; reading breakpoints, registers or memory now would report empty results as if they were the truth.",
        display: "not in debug mode",
      };
    }
    // The debug session and the project session are two uVision instances on
    // two ports. `registry` picks one; by default a project operation runs on
    // the plain session and everything else on the debugger, because uVision
    // refuses each on the other's session.
    try {
      // The connection log belongs to `open`, where it is what was asked for;
      // repeating it on every action buries the answer.
      const lines: string[] = [];
      const location = input.location ? String(input.location) : "";
      // Some failures are only known after the debugger's own words have been
      // collected into `lines` (a refused delete, an erase that never answers).
      // Marking them here keeps the single return at the end of the action
      // honest instead of forcing every branch to build its own result.
      let failure: string | undefined;
      const fail = (reason: string) => {
        failure = reason;
        lines.push(reason);
      };

      if (action === "open") {
        // Re-entering after `EXIT` from the command window: the session was
        // kept but the debugger had left, so it is entered again rather than
        // reporting a PC that no longer exists.
        if (!session.debugging) {
          const reentered = await enterDebug(session, session.target, 40_000);
          lines.push(...reentered.log);
          if (!reentered.ok) return { isError: true, content: reentered.reason ?? "could not re-enter debug mode", display: "not debugging" };
        }
        // `open` also re-establishes state that a command-window `EXIT` clears.
        lines.push(...opened.log);
        const where = await currentLocation(session);
        lines.push(`project: ${session.project}`);
        lines.push(`target: ${session.target}`);
        if (where) lines.push(`pc: ${hex(where.address)}${where.file ? ` (${where.file}:${where.line ?? "?"})` : ""}`);
      } else if (action === "run" || action === "continue") {
        const pcBefore = (await currentLocation(session))?.address;
        const ran = await run(session, Number(input.timeout_ms ?? 30_000));
        lines.push(...describeStop(ran));
        if (!ran.stopped) {
          const stalled = didNotStop(ran, {
            ...(pcBefore !== undefined ? { pcBefore } : {}),
            ...((await currentLocation(session))?.address !== undefined ? { pcAfter: (await currentLocation(session))!.address } : {}),
            breakpoints: await listBreakpoints(session),
          });
          if (stalled) fail(stalled);
        }
        const where = await currentLocation(session);
        if (where) lines.push(`at ${describeWhere(where)}`);
      } else if (action === "reset") {
        const done = await resetTarget(session);
        lines.push(...(done.lines.length > 0 ? done.lines : [done.ok ? "target reset" : `reset failed: ${done.message ?? "no reason given"}`]));
        if (!done.ok) fail(`the reset was refused: ${done.message ?? "no reason given"}`);
      } else if (action === "run_to") {
        const address = Number(input.address);
        if (!Number.isFinite(address)) return { isError: true, content: "run_to needs an `address`.", display: "missing address" };
        const reached = await runToAddress(session, address, (_session, mark, timeoutMs) => waitForStop(session, mark, timeoutMs), Number(input.timeout_ms ?? 30_000));
        lines.push(...describeStop(reached));
        const missed = didNotStop(reached);
        if (missed) fail(`the target never reached ${hex(address)}: ${missed}`);
        const where = await currentLocation(session);
        if (where) lines.push(`at ${describeWhere(where)}`);
      } else if (action === "halt") {
        const halted = await halt(session);
        lines.push(...describeStop(halted));
        // A halt that did not stop is not a halt. The registers and memory
        // read next would otherwise be whatever the running core happened to
        // publish, and the tool would have said the core was stopped.
        if (!halted.stopped) fail(`the target did not halt: ${halted.reason ?? "no stop notification arrived"}`);
      } else if (action === "step" || action === "step_into" || action === "step_instruction" || action === "step_out") {
        const kind = action === "step" ? "over" : action === "step_into" ? "into" : action === "step_instruction" ? "instruction" : "out";
        const stepped = await step(session, kind, Number(input.timeout_ms ?? 15_000));
        lines.push(...describeStop(stepped));
        const stuck = didNotStop(stepped);
        if (stuck) fail(stuck);
        const where = await currentLocation(session);
        if (where) lines.push(`at ${describeWhere(where)}`);
      } else if (action === "step_many") {
        const steps = Math.max(1, Math.min(1000, Number(input.count ?? 1)));
        const kind = input.width === "u8" ? "instruction" : "line";
        const many = await stepMany(session, steps, kind, (_session, mark, timeoutMs) => waitForStop(session, mark, timeoutMs));
        lines.push(...describeStop(many));
        const short = didNotStop(many);
        if (short) fail(short);
        const where = await currentLocation(session);
        if (where) lines.push(`at ${describeWhere(where)}`);
      } else if (action === "breakpoints") {
        const list = await listBreakpoints(session);
        if (list.length === 0) lines.push("(no breakpoints)");
        for (const entry of list) {
          lines.push(`#${entry.number} ${entry.type === 1 ? "exec" : entry.type === 2 ? "read" : entry.type === 3 ? "write" : "access"} ${entry.expression ?? ""}${entry.address ? ` @ ${hex(entry.address)}` : ""}${entry.enabled ? "" : " (disabled)"}`);
        }
      } else if (action === "breakpoint_add") {
        if (!location) return { isError: true, content: "breakpoint_add needs a `location`.", display: "missing location" };
        const kind = String(input.kind ?? "exec");
        if (kind === "exec") {
          // A `file:line` is not an expression uVision parses: it answers
          // SUCCESS, prints an error and creates nothing. Resolve it against
          // the image's line table first so the breakpoint is a real one.
          const image = await imageLocation(session);
          const added = await addBreakpoint(session, location, "error" in image ? undefined : image);
          if (!added.ok) {
            lines.push(`could not set a breakpoint on ${location}: ${added.reason ?? added.reply.message ?? added.reply.statusName}`);
            return { isError: true, content: lines.join("\n"), display: "breakpoint refused" };
          }
          lines.push(
            added.resolved
              ? `breakpoint set on ${location} (${hex(added.resolved.address)})`
              : `breakpoint set on ${location}`,
          );
        } else {
          const reply = await addAccessBreakpoint(session, location, kind as "read" | "write" | "readwrite", Number(input.width === "u8" ? 1 : input.width === "u16" ? 2 : 4));
          // The reply is SUCCESS for an expression the debugger could not
          // resolve — measured with `uwTick`, where nothing was created. A
          // watchpoint's address form (`0x20000000`) is the one that works.
          if (!reply.created) {
            return {
              isError: true,
              content:
                `uVision answered ${reply.statusName} but created no ${kind} watchpoint on ${location}. ` +
                "It accepts a literal address here; a symbol name is evaluated as a C expression and can produce nothing.",
              display: "watchpoint not created",
            };
          }
          lines.push(`breakpoint set on ${location}`);
        }
      } else if (action === "breakpoint_delete") {
        // `location` carries the breakpoint number (`#2` or `2`), which is
        // what `breakpoints` prints. The list is 1-based; an off-by-one here
        // deleted the wrong breakpoint silently.
        const requested = Number(location.replace(/^[#Bb]/, ""));
        const list = await listBreakpoints(session);
        if (!Number.isInteger(requested)) {
          const all = list.map((entry) => `#${entry.number} ${entry.expression ?? ""}`).join(", ");
          return { isError: true, content: `breakpoint_delete needs a breakpoint number; the list has ${list.length}${all ? ` (${all})` : ""}.`, display: "missing number" };
        }
        const target = list.find((entry) => entry.number === requested);
        if (!target) return { isError: true, content: `there is no breakpoint ${requested}; the list has ${list.length}.`, display: "not found" };
        // The reply is the only evidence the delete happened — the list is
        // re-read rather than assumed, because `BP_NOTFOUND` is a failure that
        // otherwise reads exactly like a delete that worked.
        const changed = await changeBreakpoint(session, target.tickMark, 1);
        if (!changed.ok) {
          return { isError: true, content: `could not delete breakpoint ${requested}: ${changed.message ?? changed.statusName}`, display: "delete refused" };
        }
        const remaining = await listBreakpoints(session);
        if (remaining.some((entry) => entry.tickMark === target.tickMark)) {
          return {
            isError: true,
            content: `the debugger accepted the delete of breakpoint ${requested} but still lists it.`,
            display: "delete did not take",
          };
        }
        lines.push(`deleted breakpoint ${requested}${target.expression ? ` (${target.expression})` : ""}`);
      } else if (action === "watch_remove") {
        if (!location) return { isError: true, content: "watch_remove needs the `location` expression that was added.", display: "missing expression" };
        const reply = await removeWatch(session, location);
        if (reply.ok) lines.push(`removed watch ${location}`);
        else fail(`could not remove it: ${reply.message ?? reply.statusName}`);
      } else if (action === "watch_add") {
        if (!location) return { isError: true, content: "watch_add needs a `location` expression.", display: "missing expression" };
        const watched = await addWatch(session, location);
        if (!watched.ok) return { isError: true, content: `could not watch ${location}: ${watched.message ?? "no reason given"}`, display: "watch refused" };
        // The handle uVision returns is a pointer into its own watch list
        // (`0x117b0708`), not a small index a person would recognise, and
        // `watch_remove` takes the expression rather than this number. It is
        // said here only so the reply matches the field, not as something to
        // retype.
        lines.push(
          `watching ${location}${watched.value ? ` = ${watched.value}` : ""}${watched.type ? ` (${watched.type.trim()})` : ""}` +
            `${watched.id !== undefined ? ` [debugger handle ${watched.id}]` : ""}. Remove it with \`watch_remove\` and the same expression.`,
        );
      } else if (action === "registers") {
        const list = await readRegisters(session);
        if (list.length === 0) lines.push("(no registers reported)");
        for (const entry of list) lines.push(`${entry.name.padEnd(6)} ${entry.value}${entry.isPC ? "   <- PC" : ""}`);
        const groups = await readRegisterGroups(session);
        if (groups.length > 0) lines.push("", `groups: ${groups.join(", ")}`);
      } else if (action === "register_read") {
        const list = String(input.location ?? input.expression ?? "").split(/[,\s]+/).filter(Boolean);
        if (list.length === 0) return { isError: true, content: "register_read needs register names in `location`, e.g. `PC,SP,LR`.", display: "missing registers" };
        const values = await readNamedRegisters(session, list);
        for (const entry of values) lines.push(`${entry.name} = ${entry.value || "(not in the register enumeration)"}`);
      } else if (action === "register_set") {
        const name = input.name ? String(input.name) : "";
        const value = input.register_value !== undefined ? String(input.register_value) : "";
        if (!name) return { isError: true, content: "register_set needs a `name`.", display: "missing register" };
        const outcome = await writeRegister(session, name, value);
        if (!outcome.ok) return { isError: true, content: `could not write ${name}: ${outcome.detail}`, display: "register refused" };
        lines.push(outcome.detail);
      } else if (action === "variables") {
        // Locals belong to a frame; `frame` says which, and the globals are
        // always worth showing because a stopped "at main" is usually a
        // question about one of them.
        const frame = input.frame !== undefined ? Math.max(0, Number(input.frame)) : 0;
        const list = await readVariables(session, frame);
        if (list.length === 0) {
          lines.push(
            session.extended
              ? `the debugger enumerated no variables at frame ${frame} — the image may have been built without debug info, or that frame has no locals (globals: frame 0).`
              : "this session did not get extended stack mode, so variable enumeration is refused; close the session and open it again.",
          );
        }
        for (const entry of list.slice(0, 200)) {
          const size = entry.count > 0 ? `[${entry.count}]` : "";
          lines.push(
            `${entry.name}${size}${entry.type ? `: ${entry.type}` : ""} = ${describeVariableValue(entry)}${entry.editable === false ? " (read-only)" : ""}`,
          );
        }
        if (list.length > 200) lines.push(`… and ${list.length - 200} more`);
        if (readVariablesTruncated(list)) {
          lines.push(
            `(the debugger was asked for ${VARIABLE_BATCH}; a full batch came back, so there may be more variables than are listed here)`,
          );
        }
        if (frame === 0 && list.length > 0) lines.push("", "pass `frame` to list the locals of a stack frame instead of the globals");
      } else if (action === "struct_members") {
        const symbol = input.name ? String(input.name) : "";
        if (!symbol) return { isError: true, content: "struct_members needs a `name` naming a struct or union variable.", display: "missing name" };
        const found = await readStructMembers(session, symbol);
        if (!found.ok) {
          return {
            isError: true,
            content:
              `the debugger could not enumerate ${symbol}'s members: ${found.message ?? "no reason given"}. ` +
              "It answers a struct or union variable's name; a scalar has no members to list.",
            display: "not a struct",
          };
        }
        if (found.members.length === 0) {
          lines.push(`the debugger reported no members for ${symbol} — it is a scalar, or its type carries no debug information`);
        }
        for (const member of found.members) {
          lines.push(`${symbol}.${member.name}  offset ${member.offset} size ${member.size}`);
        }
      } else if (action === "stack") {
        const frames = await readStack(session);
        if (frames.length === 0) lines.push("(empty stack)");
        for (const frame of frames) {
          const source = await addressToSource(session, frame.address);
          const fn = source?.function ? `${source.function} ` : "";
          const where = source?.file ? `${source.file}:${source.line ?? "?"}` : hex(frame.address);
          // The debugger attaches the source line to the frame; it is the one
          // thing `addressToSource` cannot supply from an inline function.
          const hint = frame.source ? `  ${frame.source}` : "";
          lines.push(`#${frame.level} ${fn}${where}  (${hex(frame.address)})${hint}`);
        }
      } else if (action === "where") {
        const where = await currentLocation(session);
        if (!where) lines.push("the debugger could not read the PC");
        else {
          const source = await addressToSource(session, where.address);
          lines.push(`${describeWhere({ ...where, ...(source ?? {}) })}`);
        }
      } else if (action === "read") {
        const address = Number(input.address);
        if (!Number.isFinite(address)) return { isError: true, content: "read needs an `address`.", display: "missing address" };
        const width = (input.width as "u8" | "u16" | "u32" | undefined) ?? "u32";
        const size = width === "u8" ? 1 : width === "u16" ? 2 : 4;
        const count = Math.max(1, Math.min(256, Number(input.count ?? 1)));
        const memory = await readMemory(session, address, size * count);
        if (!memory) fail(`could not read ${size * count} byte(s) at ${hex(address)}`);
        else {
          for (const row of memoryReadRows(address, size, memory.bytes)) {
            lines.push(`${hex(row.address)} = ${row.value} (${hex(row.value)})`);
          }
          if (memory.errorAddress !== undefined) lines.push(`(the bus refused access at ${hex(memory.errorAddress)})`);
        }
      } else if (action === "write") {
        const address = Number(input.address);
        const value = Number(input.value);
        if (!Number.isFinite(address) || !Number.isFinite(value)) return { isError: true, content: "write needs an `address` and a `value`.", display: "missing argument" };
        const width = (input.width as "u8" | "u16" | "u32" | undefined) ?? "u32";
        const size = width === "u8" ? 1 : width === "u16" ? 2 : 4;
        const bytes: number[] = [];
        let rest = value >>> 0;
        for (let index = 0; index < size; index++) {
          bytes.push(rest & 0xff);
          rest >>>= 8;
        }
        const outcome = await writeMemory(session, address, bytes);
        lines.push(outcome.detail);
        if (outcome.readBack) lines.push(`read back: ${outcome.readBack.map((byte) => byte.toString(16).padStart(2, "0")).join(" ")}`);
        if (!outcome.ok) return { isError: true, content: lines.join("\n"), display: "write not confirmed" };
      } else if (action === "evaluate") {
        const expression = input.expression ? String(input.expression) : "";
        if (!expression) return { isError: true, content: "evaluate needs an `expression`.", display: "missing expression" };
        // `CALC_EXPRESSION` is the interface's own evaluator; the command
        // window is the fallback for forms it refuses.
        const direct = await evaluate(session, expression);
        const directError = direct.ok ? evaluationError(direct.text ?? "") : direct.message;
        if (direct.ok && directError === undefined) {
          const rendered = direct.text && direct.text !== expression ? direct.text : `0x${(direct.value ?? 0n).toString(16)}`;
          lines.push(`${expression} = ${rendered}${direct.value !== undefined ? ` (${direct.value})` : ""}`);
        } else {
          const viaWindow = await evalInWindow(session, expression);
          const windowError = evaluationError(viaWindow.value ?? "");
          if (viaWindow.ok && windowError === undefined) lines.push(`${expression} = ${viaWindow.value}`);
          else fail(`the debugger could not evaluate ${expression}: ${directError ?? windowError ?? viaWindow.lines.join(" ")}`);
        }
      } else if (action === "command") {
        const typed = input.command ? String(input.command) : "";
        if (!typed) return { isError: true, content: "command needs a `command` string.", display: "missing command" };
        const ran = await debugCommand(session, typed);
        // The channel echoes the command, then prints its answer on the same
        // stream; the echo is dropped so a silent success reads as silent.
        const said = typed.trim();
        const output = ran.lines.filter((line) => line.trim() !== said && line.trim() !== "");
        // `EXIT` ends the debug session from inside the command language, and
        // nothing else would notice: the session would keep claiming it was
        // in debug mode and answer NOT_DEBUGGING to everything.
        const left = /^EXIT$/i.test(typed.trim());
        if (left) {
          session.debugging = false;
          // Breakpoints live in the debugger, so leaving takes them with it.
          // Saying so is the difference between "add it again" and believing
          // the next `run` will stop where the last one did.
          lines.push("left debug mode; the debugger's breakpoints were cleared with it");
          return { content: lines.join(String.fromCharCode(10)), display: "keil: command" };
        }
        const note: string[] = [];
        // The note is appended in both branches: `EXIT` prints nothing, and
        // "ran, no output" was the one message that most needed it.
        if (output.length > 0) lines.push(...output);
        else if (!ran.ok) fail(`the command was refused: ${ran.message ?? "no reason given"}`);
        else if (note.length === 0) lines.push(`ran \`${typed}\` (no output)`);
        lines.push(...note);
      } else if (action === "variable_set") {
        const name = input.expression ? String(input.expression) : "";
        const value = input.value !== undefined ? String(input.value) : "";
        if (!name) return { isError: true, content: "variable_set needs an `expression` naming the variable.", display: "missing variable" };
        const written = await setVariable(session, name, value);
        if (!written.ok) return { isError: true, content: `could not set ${name}: ${written.message ?? "no reason given"}`, display: "variable refused" };
        lines.push(written.detail ?? `${name} = ${value}`);
      } else if (action === "disassemble") {
        const address = Number(input.address);
        if (!Number.isFinite(address)) return { isError: true, content: "disassemble needs an `address`.", display: "missing address" };
        const decoded = await disassemble(session, address, Math.max(4, Math.min(256, Number(input.count ?? 8) * 4)));
        if (!decoded) fail(`the debugger refused the disassembly request at ${hex(address)}`);
        else if (!decoded.text.trim()) {
          lines.push(
            `the debugger returned no code at ${hex(decoded.address)}. ` +
              "On this build a small byte count comes back empty; ask for more (`count`), or check that the address is inside the loaded image.",
          );
        } else {
          lines.push(`at ${hex(decoded.address)}:`);
          lines.push(...decoded.text.replace(/\r/g, "").split("\n").filter((line) => line.trim()));
        }
      } else if (action === "menus" || action === "menu_exec") {
        const entries = await readMenus(session);
        if (action === "menus") {
          const list = entries.map((entry) => `${entry.id} ${entry.enabled ? "" : "(disabled) "}${entry.label}`);
          lines.push(entries.length > 0 ? list.join(", ") : "the debugger reported no menu entries");
        } else {
          const id = Number(input.count ?? input.value ?? -1);
          if (!Number.isFinite(id) || id < 0) return { isError: true, content: "menu_exec needs a menu `id` from the `menus` list.", display: "missing id" };
          const reply = await execMenu(session, id);
          if (reply.ok) lines.push(`ran menu ${id}`);
          else fail(`could not run it: ${reply.message ?? reply.statusName}`);
        }
      } else if (action === "time") {
        const clock = await timeInfo(session);
        lines.push(clock ? `${clock.cycles} cycles, tStamp ${clock.seconds}` : "the debugger did not report a clock (it is simulator-only)");
      } else if (action === "license") {
        const info = await licenseInfo(session);
        lines.push(info.licensed ? "uVision reports a valid licence" : "uVision did not report a valid licence");
      } else if (action === "version") {
        const info = await ideVersionText(session);
        lines.push(info ? `uVision V${info.uv}, socket interface V${info.socket}` : "the IDE did not report its version");
      } else if (action === "capabilities") {
        // The list of what this build refuses is only useful where a caller
        // will see it. It used to sit in a table nothing read.
        lines.push("supported here: open / run / halt / step* / breakpoint_* / registers / variables / stack / read / write / evaluate / watch_* / tasks / trace* / itm / event_recorder / disassemble / show_code / build / flash");
        lines.push("needs the debugger entered first: anything answered NOT_DEBUGGING outside a session");
        lines.push("needs extended stack mode (enabled automatically before entering): variables, tasks, watches");
        const unsupported = Object.entries(UNSUPPORTED_ON_MDK_5_43);
        if (unsupported.length > 0) {
          lines.push(`refused by this build (${unsupported.length}):`);
          for (const [name, why] of unsupported) lines.push(`  ${name}: ${why}`);
        }
        const extended = Object.entries(NEEDS_EXTENDED_STACK);
        if (extended.length > 0) {
          lines.push(`available only after entering the debugger (${extended.length}):`);
          for (const [name, why] of extended) lines.push(`  ${name}: ${why}`);
        }
      } else if (action === "window") {
        const state = (input.window as "show" | "hide" | "minimize" | undefined) ?? "hide";
        const reply = await windowState(session, state);
        if (reply.ok) lines.push(`uVision window: ${state}`);
        else fail(`could not change it: ${reply.message ?? reply.statusName}`);
      } else if (action === "trace_set") {
        const name = input.location ? String(input.location) : "";
        if (!name) return { isError: true, content: "trace_set needs a `location` naming the trace variable.", display: "missing name" };
        const reply = await setVtr(session, name, true);
        if (!reply.ok) return { isError: true, content: `could not enable ${name}: ${reply.message ?? reply.statusName}`, display: "trace refused" };
        // `SUCCESS` is not the claim being made — "enabled" is. Read it back.
        const after = await readVtrValue(session, name);
        if (after.ok) lines.push(`trace variable ${name} = ${after.value}`);
        else fail(`the debugger accepted the change to ${name} but would not read it back`);
      } else if (action === "tasks") {
        const tasks = await readTasks(session);
        lines.push(
          tasks.length
            ? tasks.map((task) => `#${task.id} ${task.name}`).join("\n")
            : "the debugger reported no tasks. On a bare-metal image that is the honest answer; with an RTOS it means the awareness plugin is not enabled for this target.",
        );
      } else if (action === "trace") {
        const items = await readVtr(session);
        lines.push(items.length ? items.map((item) => item.name).join(", ") : "no trace variables reported");
      } else if (action === "trace_get") {
        if (!location) return { isError: true, content: "trace_get needs a `location` naming the trace variable.", display: "missing name" };
        const read = await readVtrValue(session, location);
        if (read.ok) lines.push(`${location} = ${read.value}`);
        else fail(`could not read ${location}: ${read.message ?? "no reason given"}`);
      } else if (action === "itm") {
        // `count` carries the channel number; `value` 0 turns it off.
        const channel = Number(input.count ?? -1);
        if (!Number.isInteger(channel) || channel < 0) {
          return { isError: true, content: "itm needs a channel number in `count` (0-31).", display: "missing channel" };
        }
        const enable = input.value === undefined ? true : Number(input.value) !== 0;
        const reply = await registerItm(session, channel, enable);
        if (reply.ok) lines.push(`ITM stimulus port ${channel} ${enable ? "enabled" : "disabled"}`);
        else fail(`could not change it: ${reply.message ?? reply.statusName}`);
      } else if (action === "event_recorder") {
        const enable = input.value === undefined ? true : Number(input.value) !== 0;
        const reply = await setEventRecorder(session, enable);
        if (!reply.ok) return { isError: true, content: `the Event Recorder could not be ${enable ? "started" : "stopped"}: ${reply.message ?? reply.statusName}`, display: "event recorder refused" };
        const files = enable ? await readScvdFiles(session) : [];
        lines.push(`Event Recorder ${enable ? "started" : "stopped"}`);
        if (enable) {
          lines.push(files.length > 0 ? `SCVD files: ${files.join(", ")}` : "SCVD files: none — this image describes no events with a recorder description");
        }
      } else if (action === "show_code") {
        const address = Number(input.address);
        if (!Number.isFinite(address)) return { isError: true, content: "show_code needs an `address`.", display: "missing address" };
        const reply = await showCodeAt(session, address, input.width !== "u8");
        if (reply.ok) lines.push(`the editor was asked to show ${hex(address)}`);
        else fail(`could not show it: ${reply.message ?? reply.statusName}`);
      } else if (action === "clean") {
        // The session is already open and `PRJ_CLEAN` does the same job in
        // 0.4 s; a second UV4 for `-c` was the slow path.
        const cleaned = await cleanInIde(session);
        lines.push(...cleaned.lines.slice(-20));
        if (!cleaned.ok) fail(`the clean failed (uVision build code ${cleaned.status})`);
      } else if (action === "clean_rebuild" || action === "export_cprj" || action === "export_cprjs" || action === "symbols" || action === "symbols_all" || action === "convert") {
        // These are the rest of UV4's documented switches; each is one headless
        // run, so the build's log/exit-code reading applies unchanged.
        const operation =
          action === "clean_rebuild"
            ? "clean-rebuild"
            : action === "export_cprj"
              ? "export-cprj"
              : action === "export_cprjs"
                ? "export-cprjs"
                : action === "symbols"
                  ? "symbols"
                  : action === "symbols_all"
                    ? "symbols-all"
                    : "convert";
        const result = await keilCli({
          cwd: ctx.cwd,
          operation,
          uv4: session.client.programPath,
          ...(session.project ? { project: session.project } : {}),
          // `-t` is Keil's `<TargetName>`, not the hardware/simulator backend.
          // The schema's `target` field means the backend everywhere else in
          // this tool, so a multi-target project names its target with
          // `target_name`; falling back to `target` would pass "hardware" to
          // UV4 as a target name, which is what used to happen.
          ...(() => {
            const name = input.target_name ? String(input.target_name) : ctx.selection?.targetName;
            return name ? { target: name } : {};
          })(),
        });
        if (result.ok) lines.push(`${operation}: done (exit ${result.exitCode}, ${result.durationMs} ms)`);
        else fail(`${operation}: failed (exit ${result.exitCode}, ${result.durationMs} ms)${result.reason ? ` — ${result.reason}` : ""}`);
        if (result.produced.length > 0) lines.push(`wrote: ${result.produced.join(", ")}`);
        if (result.log) lines.push(...result.log.split(String.fromCharCode(10)).slice(-12));
      } else if (action === "build" || action === "rebuild") {
        const started = await buildInIde(session, action === "rebuild");
        const wanted = started.lines.filter((line) => /error|warning|Program Size|Build target|Rebuild target/i.test(line));
        const shown = wanted.length > 0 ? wanted : started.lines;
        // A truncated log that does not say it was truncated reads as the
        // whole log, and the error the caller needs is usually the one cut off.
        if (shown.length > 60) lines.push(`(showing the last 60 of ${shown.length} build lines)`);
        lines.push(...shown.slice(-60));
        // `buildInIde` returns uVision's `UVBUILDCODES`: 1 ok, 2 warnings,
        // 3 errors, 4 cancelled, 5 cleaned.
        if (!started.ok) {
          lines.push(`the build failed (uVision build code ${started.status}); no image was produced`);
          fail(`the build failed with uVision build code ${started.status}`);
        } else if (started.status === 2) lines.push("the build completed with warnings (uVision build code 2)");
      } else if (action === "flash") {
        const flashed = await flashInIde(session);
        if (flashed.lines.length > 30) lines.push(`(showing the last 30 of ${flashed.lines.length} download lines)`);
        lines.push(...flashed.lines.slice(-30));
        if (!flashed.ok) {
          fail("the download did not finish cleanly");
        } else {
          lines.push("downloaded to flash");
          // The downloader says "Verify OK"; this is the chip's own answer.
          // The 4824 session is not a debug session, so the comparison needs
          // the debugger — a second session on the debug port, read-only.
          const name = `${basename(session.project, extname(session.project))}`;
          const dirs = keilOutputDirs(session.project, ctx.cwd);
          // A project without "Create HEX File" produces only the `.axf`. The
          // comparison used to be skipped outright in that case; `fromelf` can
          // render the same image the `.hex` would contain.
          const hex =
            dirs.map((dir) => join(dir, `${name}.hex`)).find((path) => existsSync(path)) ??
            dirs.map((dir) => join(dir, `${name}.axf`)).find((path) => existsSync(path));
          if (hex) {
            const check = await openKeilSession({ cwd: ctx.cwd, project: session.project, target: "hardware", port: 4823, timeoutMs: 40_000 });
            if (check.ok && check.session) {
              const compared = await verifyFlash(check.session, hex);
              lines.push(`flash check: ${compared.detail}`);
              if (!compared.ok && compared.expected && compared.got) {
                lines.push(`  image: ${compared.expected}`, `  chip:  ${compared.got}`);
                // `Verify OK` came from the downloader; this is the chip
                // disagreeing with the image, so the flash is not confirmed.
                fail(`the chip does not match ${basename(hex)} after the download`);
              }
              await closeKeilSession(check.key!);
            } else {
              lines.push(`flash check: skipped — the debugger could not be opened to read the chip back (${check.reason ?? "no session"})`);
            }
          } else {
            lines.push("flash check: skipped — the build produced no .hex or .axf to compare against");
          }
        }
      } else if (action === "erase") {
        const erased = await eraseFlash(session);
        if (!erased.ok) {
          // `PRJ_FLASH_ERASE` is not answered on this build, and a download is
          // not a full-chip erase — it erases only its own image's sectors.
          // The action is still "erase the flash", so the fallback runs rather
          // than reporting a timeout with nowhere to go.
          const full = await massErase(ctx.cwd);
          if (full.ok) {
            lines.push(...full.lines);
          } else {
            return { isError: true, content: `${erased.message ?? erased.statusName}\n${full.lines.join("\n")}`, display: "erase unavailable" };
          }
        } else {
          lines.push("flash erase accepted by the configured algorithm");
        }
      } else {
        return { isError: true, content: `unknown action \`${action}\``, display: "unknown action" };
      }
      return {
        ...(failure ? { isError: true } : {}),
        content: lines.join("\n") || "(no output)",
        display: failure ? `keil: ${action} failed` : `keil: ${action}`,
      };
    } finally {
      // Sessions are kept open deliberately: re-entering debug mode re-flashes
      // the target and drops every breakpoint, which would make a
      // set-and-run sequence impossible across tool calls.
    }
  },
};

// ---- keil_project ----------------------------------------------------------

const keilProjectTool: LegacyTool = {
  name: "keil_project",
  description:
    "Read and change the Keil MDK project itself, headless: list targets, groups and files; add or remove a group or a source file; read and set the compile defines, include paths and optimisation for a target; switch the active target. Changes are written to the .uvprojx by uVision, so the project opens and builds exactly as edited here.",
  readonly: false,
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["info", "targets", "groups", "files", "add_group", "add_file", "remove_file", "remove_group", "get_option", "set_option", "set_target", "set_output_name", "output_name", "close"],
        description: "What to do. `info` summarises the project.",
      },
      project: { type: "string", description: "The .uvprojx path; defaults to the detected project" },
      group: { type: "string", description: "Group name for files / add_file / add_group / remove_group" },
      file: { type: "string", description: "File for add_file / remove_file; a path relative to the project directory, or the file name the project lists" },
      target: { type: "string", description: "Keil's <TargetName> for set_target / get_option / set_option; defaults to the target picked in the Board pane, else the current target" },
      option: {
        type: "string",
        enum: ["CDEF", "CINCL", "ADEF", "AINCL", "COPTIMIZE", "CODEGEN", "CMISC", "AMISC", "LMISC", "MEMRANGES", "UBCOMP1", "UBCOMP2", "UBBUILD1", "UBBUILD2"],
        description: "For get_option/set_option: which target option",
      },
      value: { type: "string", description: "For set_option: the new value (replaces the current one)" },
      port: { type: "integer", description: "UVSOCK TCP port when 4823 is taken" },
    },
    required: ["action"],
    additionalProperties: false,
  },
  summarize: (input) => `keil project: ${String(input.action)}`,
  async execute(input, ctx): Promise<LegacyResult> {
    const action = String(input.action);
    if (action === "close") {
      return closeAndReport(ctx.cwd);
    }
    // Every project operation runs on a plain (non-debug) session, measured on
    // MDK 5.43a: an entered debugger answers "Target is in debug mode" to all
    // of them. The structure listers additionally need an entered debugger, so
    // groups/files fail on a plain session with `NOT_DEBUGGING` — at which
    // point there is nothing this session can do, so the list falls back to
    // uVision's own `PRJ_ENUM_*` stream rather than showing an empty project.
    const opened = await sessionFor(input, ctx.cwd, ctx.selection, { connectOnly: true });
    if (!opened.ok) return { isError: true, content: opened.content, display: "Keil unavailable" };
    const session = opened.session;
    const group = input.group ? String(input.group) : "";
    const lines: string[] = [];
    // A project operation that the debugger refused is a failed call, not a
    // successful one with a sad sentence in it.
    let failure: string | undefined;
    const fail = (reason: string) => {
      failure = reason;
      lines.push(reason);
    };

    if (action === "info") {
      lines.push(`project: ${session.project}`);
      const targets = await targetsFor(session);
      const active = await currentTarget(session);
      lines.push(`target: ${active}${targets.length > 1 ? ` (of ${targets.length}: ${targets.join(", ")})` : ""}`);
      const output = await getOutputName(session);
      if (output) lines.push(`output: ${output}`);
      const defines = await getOption(session, "CDEF");
      if (defines.ok) lines.push(`defines: ${defines.values.join(", ") || "(none)"}`);
      const groups = await projectGroups(session);
      lines.push(`groups: ${groups.join(", ") || "(none)"}`, "run `files` with a group to list its sources");
    } else if (action === "targets") {
      const targets = await projectTargets(session);
      const active = await currentTarget(session);
      lines.push(targets.length > 0 ? targets.map((name) => `${name === active ? "*" : " "} ${name}`).join(String.fromCharCode(10)) : "(no targets)");
    } else if (action === "groups") {
      const groups = await projectGroups(session);
      lines.push(groups.length > 0 ? groups.join("\n") : "(no groups)");
    } else if (action === "files") {
      if (!group) return { isError: true, content: "files needs a `group`.", display: "missing group" };
      // The project file is where uVision itself keeps the list, and it is
      // readable without an entered debugger — which `PRJ_ENUM_FILES` needs.
      // Read the active target's block: a multi-target project lists one set
      // of groups per target, and the debugger's "current" one is what the
      // user means by "this project".
      const files = filePathsInGroup(session.project, group, (await currentTarget(session)) || undefined);
      lines.push(files.length > 0 ? files.map((entry) => entry.path || entry.name).join("\n") : `(no files in ${group})`);
    } else if (action === "add_group") {
      if (!group) return { isError: true, content: "add_group needs a `group` name.", display: "missing group" };
      const reply = await addGroup(session, group);
      if (reply.ok) lines.push(`added group ${group}`);
      else fail(`could not add it: ${reply.message ?? reply.statusName}`);
    } else if (action === "add_file") {
      const file = input.file ? String(input.file) : "";
      if (!group || !file) return { isError: true, content: "add_file needs a `group` and a `file`.", display: "missing argument" };
      const reply = await addFile(session, group, file, ctx.cwd);
      if (reply.ok) lines.push(`added ${file} to ${group}`);
      else fail(`could not add it: ${reply.message ?? reply.statusName}`);
    } else if (action === "remove_file") {
      const file = input.file ? String(input.file) : "";
      if (!group || !file) return { isError: true, content: "remove_file needs a `group` and a `file`.", display: "missing argument" };
      // `PRJ_DEL_FILE` deletes by `FileName`, not by path, and it does not
      // scope to the group it is given: measured, deleting
      // `{"CORE", "../CORE/startup.s"}` removed `startup.s` no matter which
      // group was named. Resolving the exact entry first is what keeps a
      // request for one file from deleting another with the same base name.
      const listed = filePathsInGroup(session.project, group, (await currentTarget(session)) || undefined);
      const base = file.split(/[\\/]/).pop() ?? file;
      const normalize = (text: string) => text.replace(/\//g, "\\").toLowerCase();
      const match =
        listed.find((entry) => normalize(entry.path) === normalize(file)) ??
        listed.find((entry) => normalize(entry.name) === normalize(file)) ??
        listed.find((entry) => normalize(entry.name) === normalize(base)) ??
        listed.find((entry) => normalize(entry.path).endsWith(`\\${normalize(file)}`));
      if (!match) {
        return {
          isError: true,
          content: `"${file}" is not in group ${group}${listed.length > 0 ? ` (it has: ${listed.map((entry) => entry.name).join(", ")})` : " (the group has no files)"}; nothing was deleted.`,
          display: "not in project",
        };
      }
      const reply = await removeFile(session, group, match.name);
      if (reply.ok) lines.push(`removed ${match.name} from ${group}`);
      else fail(`could not remove it: ${reply.message ?? reply.statusName}`);
    } else if (action === "remove_group") {
      if (!group) return { isError: true, content: "remove_group needs a `group`.", display: "missing group" };
      const reply = await removeGroup(session, group);
      if (reply.ok) lines.push(`removed group ${group}`);
      else fail(`could not remove it: ${reply.message ?? reply.statusName}`);
    } else if (action === "get_option") {
      const option = (input.option ? String(input.option) : "CDEF") as OptionName;
      const result = await getOption(session, option, input.target ? String(input.target) : undefined);
      if (result.ok) lines.push(`${option}: ${result.values.join(", ") || "(empty)"}`);
      else fail(`could not read it: ${result.message}`);
    } else if (action === "set_option") {
      const option = (input.option ? String(input.option) : "") as OptionName;
      if (!option) return { isError: true, content: "set_option needs an `option`.", display: "missing option" };
      const value = input.value !== undefined ? String(input.value) : "";
      const reply = await setOption(session, option, value, input.target ? String(input.target) : undefined);
      if (!reply.ok) fail(`could not set it: ${reply.message ?? reply.statusName}`);
      else {
        // The reply is not the state. `REGISTER_SET` and `PRJ_SET_OUTPUTNAME`
        // both answer SUCCESS without writing anything, so a project option is
        // read back too rather than trusted because the call returned.
        const stored = await getOption(session, option, input.target ? String(input.target) : undefined);
        if (stored.ok && stored.values.join(", ").trim() !== value.trim()) {
          fail(`the debugger accepted it but reads back ${JSON.stringify(stored.values.join(", ") || "(empty)")}, not ${JSON.stringify(value)}`);
        } else {
          lines.push(`${option} set to ${stored.ok ? stored.values.join(", ") : value || "(empty)"}`);
        }
      }
    } else if (action === "set_target") {
      const target = input.target ? String(input.target) : "";
      if (!target) return { isError: true, content: "set_target needs a `target`.", display: "missing target" };
      const known = await targetsFor(session);
      if (known.length > 0 && !known.includes(target)) {
        return {
          isError: true,
          content: `there is no target ${JSON.stringify(target)}; the project has ${known.map((name) => JSON.stringify(name)).join(", ")}.`,
          display: "unknown target",
        };
      }
      const reply = await setTarget(session, target);
      if (!reply.ok) return { isError: true, content: `could not switch: ${reply.message ?? reply.statusName}`, display: "switch refused" };
      // The reply is not the state: read it back, the same way register and
      // memory writes are checked.
      const active = await currentTarget(session);
      if (active !== target) {
        return {
          isError: true,
          content: `the switch was accepted but the project still reports ${JSON.stringify(active || "(none)")}, not ${JSON.stringify(target)}.`,
          display: "switch did not take",
        };
      }
      lines.push(`active target is now ${target}`);
      // Which target the debugger loads is a property of this switch, measured:
      // with `TOUCH` current a debug session logged `Load "..\OBJ\TOUCH.axf"`,
      // and after switching to `TOUCH_SIM` it logged
      // `Load "..\OBJ_SIM\TOUCH_SIM.axf"`. So a hardware/simulator debug
      // session always uses whichever target is current — the debug tool has
      // no target of its own to choose, and the image it would load is worth
      // naming before someone debugs the wrong one.
      const image = await imageLocation(session);
      if (!("error" in image)) lines.push(`a new keil_debug session will load ${image.elf}`);
    } else if (action === "set_output_name") {
      const name = input.value ? String(input.value) : input.file ? String(input.file) : "";
      if (!name) return { isError: true, content: "set_output_name needs a `value`: the file name only, e.g. `app.axf` (the output directory is a separate option).", display: "missing name" };
      const reply = await setOutputName(session, name);
      if (!reply.ok) return { isError: true, content: `could not set it: ${reply.message ?? reply.statusName}`, display: "output name refused" };
      // Settling for the reply is how this went wrong once: the project kept
      // the old name while the call reported success, and the next build and
      // debug session pointed at a file that did not exist. The debugger's own
      // answer is the check — and it answers with the whole path, not the
      // bare name that was sent, so the comparison is on the file name.
      const stored = await getOutputName(session);
      if (!sameOutputName(stored, name)) {
        return {
          isError: true,
          content: `the debugger accepted the request but still reports ${JSON.stringify(stored)}, not ${JSON.stringify(name)}; nothing was changed.`,
          display: "output name unchanged",
        };
      }
      lines.push(`output name set to ${stored || name}`);
    } else if (action === "output_name") {
      const name = await getOutputName(session);
      lines.push(name ? `output: ${name}` : "the project did not report an output name");
    } else {
      return { isError: true, content: `unknown action \`${action}\``, display: "unknown action" };
    }
    return {
      ...(failure ? { isError: true } : {}),
      content: lines.join("\n"),
      display: failure ? `keil: ${action} failed` : `keil: ${action}`,
    };
  },
};

export const keilTools: LegacyTool[] = [keilDebugTool, keilProjectTool];


// ---- MCP registration -------------------------------------------------------

function failResult(code: string, message: string): ProbeToolResult {
  const structuredContent = { code, message };
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent) }],
    structuredContent,
    isError: true,
  };
}

/**
 * 把 A 侧的工具形状转换成 probe 的 ProbeToolSpec。
 *
 * 不重写 action 分支：语义、错误文案与会话生命周期都留在上面（逐字保留自 A），
 * 这里只负责外层契约——zod schema、注解、写前声明、structuredContent。
 */
export function createKeilTools(): ProbeToolSpec[] {
  return keilTools.map((legacy) => {
    const isDebug = legacy.name === "keil_debug";
    return {
      name: legacy.name,
      description: isDebug ? DEBUG_DESCRIPTION : PROJECT_DESCRIPTION,
      inputSchema: isDebug ? debugInputSchema : projectInputSchema,
      annotations: { readOnlyHint: false, destructiveHint: true },
      meta: {
        evidenceActions: [...EVIDENCE_ACTIONS],
        destructiveActions: [...DESTRUCTIVE_ACTIONS],
      },
      handler: async (args: unknown): Promise<ProbeToolResult> => {
        const input = (args ?? {}) as Record<string, unknown>;
        const action = String(input.action);
        const declaration = declarationFor(legacy.name, action, input);
        let result: LegacyResult;
        try {
          result = await legacy.execute(input, { cwd: process.cwd(), selection: selectionFromEnv() });
        } catch (error) {
          return failResult("keil_error", error instanceof Error ? error.message : String(error));
        }
        const structured: Record<string, unknown> = {
          tool: legacy.name,
          action,
          ...(EVIDENCE_ACTIONS.has(action) ? { evidence: true } : {}),
          ...(declaration ? { declaration } : {}),
          ...(result.data && typeof result.data === "object" ? (result.data as Record<string, unknown>) : {}),
        };
        return {
          content: [{ type: "text", text: result.content }],
          structuredContent: structured,
          ...(result.isError ? { isError: true } : {}),
        };
      },
    };
  });
}
