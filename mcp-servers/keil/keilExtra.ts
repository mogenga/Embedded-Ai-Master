/**
 * The operations beyond the core loop, kept in their own module so the session
 * file stays about "stop here, look, step".
 *
 * Every one of these was probed against MDK 5.43a before being written down.
 * Some work on this build, some answer `NOT_SUPPORTED` or time out, and the
 * ones that do not work say so with the interface's own words instead of
 * pretending an empty result means "nothing found".
 */

import type { Reply } from "./uvsock.js";
import { decodeGbk } from "./gbk.js";
import {
  OP,
  asyncText,
  commandWindowText,
  prjData,
  readDisassemblyText,
  readMenu,
  readSstr,
  readVset,
  sstr,
  vset,
  vsetWithValue,
  type MenuEntry,
  type UvSocketClient,
} from "./uvsock.js";
import type { KeilSession, StopInfo } from "./keilSession.js";
import { findRegister, readRegisters, readVariables, readVtr, setRegister, setVariableById } from "./keilSession.js";

/* ---------- expression evaluation ---------- */

/**
 * Evaluate an expression.
 *
 * `DBG_CALC_EXPRESSION` is the interface's own evaluator and the one to use:
 * it answers with a 64-bit value **and** the debugger's rendering, where the
 * command window gives text that has to be parsed. Measured:
 *
 *   `main`  → type 5, 0x08006be0, "main"
 *   `$+4`   → type 9, 0x0800645c, "$+4"
 *
 * The record is a packed `VSET`, so the text is at 12 and the value at 4.
 * Reading the value at 8 truncated it: `0x08006458` came back as `0x006458`,
 * an address in the wrong half of memory.
 *
 * `DBG_EVAL_WATCH_EXPRESSION` answers `NOT_SUPPORTED` unless extended stack
 * mode is on, and even then expects a watch id; `CALC_EXPRESSION` is the
 * direct path.
 */
export async function evaluate(session: KeilSession, expression: string): Promise<{ ok: boolean; value?: bigint; text?: string; message?: string }> {
  const reply = await session.client.send(OP.DBG_CALC_EXPRESSION, vset(expression), 10_000);
  if (!reply.ok) {
    // A symbol that is out of scope is a normal answer to "what is this?",
    // reported in the debugger's own words rather than as a failure.
    return { ok: false, message: reply.message ?? reply.statusName };
  }
  return evaluateReply(expression, reply.data);
}

/**
 * Turn a `CALC_EXPRESSION` payload into a result, or into the reason it is not one.
 *
 * The debugger echoes the expression back for `$` when it has no better
 * rendering; the numeric value is the answer in that case and the caller
 * formats it. `<cannot evaluate>` is different: the reply is `SUCCESS` and the
 * value field is zero, so treating it as a value printed `expr = 0x0 (0)` for
 * a symbol the debugger had just said it could not resolve. The marker is now
 * the failure it is, and the command-window fallback gets its chance.
 */
export function evaluateReply(expression: string, payload: Buffer): { ok: boolean; value?: bigint; text?: string; message?: string } {
  const decoded = readVset(payload);
  if (!decoded) return { ok: false, message: "the reply carried no value" };
  if (/^\s*<cannot evaluate>\s*$/i.test(decoded.text)) {
    return { ok: false, message: `${expression} could not be evaluated: the debugger answered <cannot evaluate>` };
  }
  const rendered = decoded.text && decoded.text !== expression ? decoded.text : undefined;
  return { ok: true, value: decoded.value, ...(rendered ? { text: rendered } : {}) };
}

/** Evaluate through the command window, the path `EVAL` reaches. */
export async function evalInWindow(session: KeilSession, expression: string): Promise<{ ok: boolean; value?: string; lines: string[] }> {
  const payload = Buffer.alloc(4 + 28 + 260);
  payload.writeUInt32LE(1, 0);
  sstr(`EVAL ${expression}`).copy(payload, 32);
  const mark = session.client.mark;
  const reply = await session.client.send(OP.DBG_EXEC_CMD, payload, 12_000);
  // A collection with no `from` consumes every frame that arrived in the
  // window, including a stop or build frame somebody else is waiting on.
  // Fencing it to this request's mark keeps those frames in the stream.
  const frames = await session.client.collect(400, undefined, mark);
  const lines = frames.map((frame) => commandWindowText(frame)).filter(Boolean);
  const answer = lines.filter((line) => line.trim() !== `EVAL ${expression}` && !/^\s*\^/.test(line));
  const text = answer.join(" ").trim();
  return { ok: reply.ok && text.length > 0 && !/^\*\*\* error/i.test(text), ...(text ? { value: text } : {}), lines };
}

/**
 * Run a debugger command exactly as typed into uVision's Command window.
 *
 * This is the escape hatch for the whole command language: breakpoints with
 * conditions, tracepoints, `SAVE`, `LOG`, `PerformanceAnalyze`, `LOGIC`,
 * `COVERAGE`, and every system variable — the interface exposes them through
 * one command channel rather than one operation each. The reply comes back on
 * the `0x5020` stream, not in the response, so it is read from there.
 */
export async function debugCommand(session: KeilSession, command: string): Promise<{ ok: boolean; lines: string[]; message?: string }> {
  const payload = Buffer.alloc(4 + 28 + 260);
  payload.writeUInt32LE(1, 0); // echo the command and its output
  sstr(command).copy(payload, 32);
  // The mark is taken before sending, not after: a command that prints its
  // answer and then replies put every `0x5020` line before the collection
  // window, so `command` reported `ran ... (no output)` for output it had
  // already received. `evalInWindow` was fixed this way; this one was not.
  const mark = session.client.mark;
  const reply = await session.client.send(OP.DBG_EXEC_CMD, payload, 12_000);
  // `EXIT` makes uVision leave debug mode and answer on the stream after a
  // delay; a short wait reported it as a silent success and the session kept
  // claiming it was still debugging.
  const leaving = /^EXIT$/i.test(command.trim());
  const frames = await session.client.collect(leaving ? 2500 : 600, undefined, mark);
  const lines = frames.map((frame) => commandWindowText(frame)).filter(Boolean);
  return {
    ok: reply.ok,
    lines,
    ...(reply.ok ? {} : { message: reply.message ?? reply.statusName }),
  };
}

/**
 * Set a variable, by name, to a new value.
 *
 * `VARIABLE_SET` is `VARVAL`: the `IVARENUM` that names the variable plus the
 * value. A name-based request is answered `NOT_FOUND` (or, with a zeroed
 * `IVARENUM`, `SUCCESS` that writes nothing), so the variable is looked up in
 * the enumeration first and written by its id. The write is read back.
 */
export async function setVariable(session: KeilSession, name: string, value: string): Promise<{ ok: boolean; message?: string; detail?: string }> {
  const variables = await readVariables(session);
  const wanted = name.trim();
  const target =
    variables.find((entry) => entry.name === wanted) ??
    variables.find((entry) => entry.name.toLowerCase() === wanted.toLowerCase()) ??
    // A qualified name (`\file.c\symbol`) is what the debugger prints for a
    // static; the plain name is what a person types.
    variables.find((entry) => entry.name.split(/[\\/]/).pop() === wanted);
  if (!target) {
    const names = variables.slice(0, 12).map((entry) => entry.name).join(", ");
    return {
      ok: false,
      message: variables.length === 0
        ? "the debugger enumerated no variables; the image needs debug information and the target must be stopped"
        : `${wanted} is not among the ${variables.length} variables the debugger lists (${names}${variables.length > 12 ? ", …" : ""})`,
    };
  }
  const outcome = await setVariableById(session, target, value);
  return { ok: outcome.ok, ...(outcome.ok ? { detail: outcome.detail } : { message: outcome.detail }) };
}

/** Write a register and check that it took. */
export async function writeRegister(session: KeilSession, name: string, value: string) {
  return setRegister(session, name, value);
}

/**
 * Add an expression to the debugger's Watch window.
 *
 * `EVAL_WATCH_EXPRESSION` needs extended stack mode; without it the answer is
 * `NOT_SUPPORTED` for every expression and the old code surfaced that as the
 * whole feature being unavailable. The reply is a `VALAMEM`:
 *
 *   nID(4) nRes(4) nRes(4) nRes(4) type(4) len(4) value-text… type-text…
 *
 * measured as `nID=… | 0 | 0 | 0 | 0x02001001 | 11 | "0x08006BE0" | "int f() "`.
 */
export async function addWatch(session: KeilSession, expression: string): Promise<{ ok: boolean; id?: number; value?: string; type?: string; message?: string }> {
  // A session that is not in the debugger at all reports `extended: false`
  // too, and answering "close it and open it again" sends the caller after the
  // wrong thing: there is no debugger to add a watch to yet.
  if (!session.debugging) {
    return { ok: false, message: "not in debug mode; enter it before adding a watch expression" };
  }
  if (!session.extended) {
    return {
      ok: false,
      message:
        "the Watch window needs extended stack mode, which this session did not get — it is set before the debugger starts, so close the session and open it again",
    };
  }
  const reply = await session.client.send(OP.DBG_EVAL_WATCH_EXPRESSION, vset(expression), 10_000);
  if (!reply.ok) return { ok: false, message: reply.message ?? reply.statusName };
  const data = reply.data;
  if (data.length < 28) return { ok: false, message: "the reply carried no watch record" };
  const id = data.readInt32LE(0);
  const length = data.readUInt32LE(20);
  const value = length > 0 ? decodeGbk(data.subarray(24, Math.min(24 + length, data.length))).replace(/\0.*$/s, "") : "";
  // The type string follows the value's fixed 260-byte slot.
  const typeLength = data.length >= 24 + 260 + 4 ? data.readUInt32LE(24 + 260) : 0;
  const type = typeLength > 0 && typeLength < 200 ? decodeGbk(data.subarray(24 + 260 + 4, 24 + 260 + 4 + typeLength)).replace(/\0.*$/s, "") : "";
  if (value === "<cannot evaluate>") return { ok: false, message: `${expression} could not be evaluated in the current context` };
  return { ok: true, id, value, ...(type ? { type } : {}) };
}

/** Remove a watch expression by the expression itself. */
export async function removeWatch(session: KeilSession, expression: string): Promise<Reply> {
  // Measured: the id that `addWatch` reports is answered `NOT_FOUND: Item not
  // found`; the **expression** removes it. Sending the id was a request that
  // could never succeed.
  return session.client.send(OP.DBG_REMOVE_WATCH_EXPRESSION, vset(expression), 8_000);
}

/* ---------- run control beyond the basics ---------- */

/** Reset the target through the debugger. */
export async function resetTarget(session: KeilSession): Promise<{ ok: boolean; lines: string[]; message?: string }> {
  const mark = session.client.mark;
  const reply = await session.client.send(OP.DBG_RESET, Buffer.alloc(0), 10_000);
  const frames = await session.client.collect(1200, undefined, mark);
  const lines = frames.map((frame) => asyncText(frame)).filter(Boolean);
  return { ok: reply.ok, lines, ...(reply.ok ? {} : { message: reply.message ?? reply.statusName }) };
}

/** Run until an address, then stop. */
export async function runToAddress(
  session: KeilSession,
  address: number,
  wait: (session: KeilSession, mark: number, timeoutMs: number) => Promise<StopInfo>,
  timeoutMs = 30_000,
): Promise<StopInfo> {
  const mark = session.client.mark;
  const payload = Buffer.alloc(8);
  payload.writeBigUInt64LE(BigInt(address), 0);
  const reply = await session.client.send(OP.DBG_RUN_TO_ADDRESS, payload, 10_000);
  if (!reply.ok && reply.status !== 11) return { stopped: false, reason: reply.message ?? reply.statusName, output: [] };
  return wait(session, mark, timeoutMs);
}

/** Step N source lines or N instructions. */
export async function stepMany(
  session: KeilSession,
  count: number,
  kind: "line" | "instruction",
  wait: (session: KeilSession, mark: number, timeoutMs: number) => Promise<StopInfo>,
  timeoutMs = 30_000,
): Promise<StopInfo> {
  const command = kind === "instruction" ? OP.DBG_STEP_INSTRUCTION_N : OP.DBG_STEP_HLL_N;
  const payload = Buffer.alloc(4);
  payload.writeUInt32LE(Math.max(1, count), 0);
  const mark = session.client.mark;
  const reply = await session.client.send(command, payload, 10_000);
  if (!reply.ok) return { stopped: false, reason: reply.message ?? reply.statusName, output: [] };
  return wait(session, mark, timeoutMs);
}

/**
 * The instructions the debugger holds at an address.
 *
 * The reply is an `AMEM` whose bytes are the disassembly window's **text**, not
 * instruction words. It carries both the source line and the decoded
 * instruction when the image has symbols:
 *
 *   "    35:     HAL_Init();                     //初始化HAL库 \n"
 *   "0x08006BE0 F7F9FF38  BL.W          0x08000A54 HAL_Init\n"
 *
 * An empty text is "the debugger has nothing here", which is distinct from a
 * failed request (`null`).
 */
export async function disassemble(session: KeilSession, address: number, bytes = 32): Promise<{ address: number; text: string; bytes: number } | null> {
  const request = (size: number) => {
    const payload = Buffer.alloc(24);
    payload.writeBigUInt64LE(BigInt(address), 0);
    payload.writeUInt32LE(size, 8);
    return payload;
  };
  let last: { address: number; text: string; bytes: number } | null = null;
  // Measured: a request for 32 bytes comes back with `nBytes = 0` and no text,
  // while 64 and 128 return the decoded lines. The window is filled by byte
  // count, and one instruction plus its source line can exceed a small one, so
  // a fixed small request silently disassembled nothing.
  for (const size of [Math.max(32, bytes), 128]) {
    const reply = await session.client.send(OP.DBG_DSM_READ, request(size), 10_000);
    if (!reply.ok) return null;
    const decoded = readDisassemblyText(reply.data);
    if (!decoded) return null;
    if (decoded.text.trim()) return { address: decoded.address, text: decoded.text, bytes: decoded.bytes };
    last = decoded;
  }
  return last ? { address: last.address, text: last.text, bytes: last.bytes } : null;
}

/** uVision's own version strings, in the form the IDE reports them. */
export async function ideVersionText(session: KeilSession): Promise<{ uv: string; socket: string } | null> {
  const reply = await session.client.send(OP.GEN_GET_EXTVERSION, Buffer.alloc(0), 8_000);
  if (!reply.ok) return null;
  // Measured tail: "µVision=V5.43.1.0UVSOCK=V2.29".
  const text =decodeGbk( reply.data);
  const uv = /µVision=V([0-9.]+)/.exec(text)?.[1] ?? "";
  const socket = /UVSOCK=V([0-9.]+)/.exec(text)?.[1] ?? "";
  return { uv, socket };
}

/* ---------- menus, trace, recorder ---------- */

/** The debugger's own menu model. */
export async function readMenus(session: KeilSession): Promise<MenuEntry[]> {
  const mark = session.client.mark;
  await session.client.send(OP.DBG_ENUM_MENUS, Buffer.alloc(16), 10_000);
  const frames = await session.client.collect(1500, 0x5062, mark);
  return frames.map(readMenu).filter((entry): entry is MenuEntry => entry !== null);
}

/** Invoke one of those menu entries by the id `readMenus` reported. */
export async function execMenu(session: KeilSession, id: number, group = 0): Promise<Reply> {
  const payload = Buffer.alloc(16);
  payload.writeInt32LE(id, 0);
  payload.writeInt32LE(group, 4);
  return session.client.send(OP.DBG_MENU_EXEC, payload, 10_000);
}

/** Turn an ITM channel on or off. */
export async function registerItm(session: KeilSession, channel: number, enable = true): Promise<Reply> {
  // `UV_ITM_REGISTER` takes `{ u16 nChan, u16 nMode }` where the mode selects
  // 8- or 16-bit stimulus ports. Measured, sending `{ channel, 1 }` is refused
  // with "16Bit Mode not supported", so the mode word is 0 (the 8-bit form)
  // and the channel alone carries the request.
  const payload = Buffer.alloc(16);
  payload.writeUInt16LE(channel, 0);
  payload.writeUInt16LE(0, 2);
  return session.client.send(enable ? OP.DBG_ITM_REGISTER : OP.DBG_ITM_UNREGISTER, payload, 10_000);
}

/** Turn the Event Recorder on or off. */
export async function setEventRecorder(session: KeilSession, enable: boolean): Promise<Reply> {
  return session.client.send(enable ? OP.DBG_EVTR_REGISTER : OP.DBG_EVTR_UNREGISTER, Buffer.alloc(0), 10_000);
}

/**
 * The SCVD description files the recorder knows.
 *
 * An empty answer is the normal one on a target with no Event Recorder
 * configured: measured, the enumeration sends its start and end frames with
 * nothing between them. That is "this image describes no events", not a failed
 * request, and the caller is told which.
 */
export async function readScvdFiles(session: KeilSession): Promise<string[]> {
  const mark = session.client.mark;
  await session.client.send(OP.DBG_EVTR_ENUMSCVDFILES, Buffer.alloc(0), 10_000);
  const frames = await session.client.collect(1200, 0x5066, mark);
  return frames
    .filter((frame) => frame.type === 0x5065)
    .map((frame) => readSstr(frame.data, 0))
    .filter(Boolean);
}

/**
 * Turn a trace variable on or off by name.
 *
 * `VTR_SET` is a `VSET`: the on/off state is the **value**, the name is the
 * string. The old request put the state in the first word and the name at 12 —
 * `SUCCESS` for any name at all, and nothing changed. Setting a name the
 * debugger does not enumerate is now reported as such.
 */
export async function setVtr(session: KeilSession, name: string, on: boolean): Promise<Reply> {
  const known = await readVtr(session);
  if (known.length > 0 && !known.some((entry) => entry.name === name)) {
    return {
      ok: false,
      status: 9,
      statusName: "NOT_FOUND",
      data: Buffer.alloc(0),
      message: `${name} is not one of the trace variables this target exposes (${known.map((entry) => entry.name).join(", ")})`,
    };
  }
  return session.client.send(OP.DBG_VTR_SET, vsetWithValue(name, 5, on ? 1n : 0n), 8_000);
}

/**
 * Read one trace variable's value.
 *
 * `VTR_GET` takes the same `VSET` as `VTR_SET` and answers with one: the
 * numeric field and the debugger's rendering. Measured: while the extended
 * stack option is on, `STCLK` comes back with a type word, a zero value and
 * the name, rather than the `Unknown VTR-name` this build returned before —
 * so the answer is passed through as the debugger gave it instead of being
 * dressed up as a number it did not provide.
 */
export async function readVtrValue(session: KeilSession, name: string): Promise<{ ok: boolean; value: string; message?: string }> {
  const reply = await session.client.send(OP.DBG_VTR_GET, vsetWithValue(name, 0, 0n), 8_000);
  if (!reply.ok) return { ok: false, value: "", message: reply.message ?? reply.statusName };
  const decoded = readVset(reply.data);
  if (!decoded) return { ok: false, value: "", message: "the reply carried no value" };
  const text = decoded.text && decoded.text !== name ? decoded.text : `0x${decoded.value.toString(16)}`;
  return { ok: true, value: text };
}

/** Simulator clock: cycles and the timestamp the debugger reports. */
export async function timeInfo(session: KeilSession): Promise<{ cycles: bigint; seconds: number } | null> {
  const reply = await session.client.send(OP.DBG_TIME_INFO, Buffer.alloc(0), 8_000);
  if (!reply.ok || reply.data.length < 16) return null;
  return { cycles: reply.data.readBigUInt64LE(0), seconds: reply.data.readDoubleLE(8) };
}

/* ---------- project and IDE ---------- */

/**
 * Which target a debug session is attached to.
 *
 * `PRJ_GET_DEBUG_TARGET` answers a 44-byte record whose first word was
 * measured as 1 on both a hardware and a simulator session, so it does not
 * say which one is live. The session records the choice it opened with, and
 * that is the answer that cannot be wrong — reading the register would be the
 * plausible-but-false value this interface keeps producing.
 */
export async function debugTargetKind(session: KeilSession): Promise<"hardware" | "simulator" | null> {
  return session.target;
}

/** Rename the target's output file; uVision writes it into the project. */
/**
 * Set the target's output name.
 *
 * The name is a **stem plus an extension**, not a path: `OutputDirectory` is a
 * separate target option and the debugger prepends it. Measured — sending
 * `..\OBJ\TOUCH.axf` produced `..\OBJ\..\OBJ\TOUCH.axf`, so the value is
 * reduced to its file name before it is sent.
 */
export async function setOutputName(session: KeilSession, name: string): Promise<Reply> {
  const file = name.split(/[\\/]/).pop() ?? name;
  return session.client.send(OP.PRJ_SET_OUTPUTNAME, prjData(file), 10_000);
}

/** Show, hide or minimise the uVision window. */
export async function windowState(session: KeilSession, state: "show" | "hide" | "minimize"): Promise<Reply> {
  const command = state === "show" ? OP.GEN_SHOW : state === "hide" ? OP.GEN_HIDE : OP.GEN_MINIMIZE;
  return session.client.send(command, Buffer.alloc(0), 8_000);
}

/** The license state uVision reports. */
export async function licenseInfo(session: KeilSession): Promise<{ licensed: boolean; raw: Buffer }> {
  const reply = await session.client.send(OP.GEN_CHECK_LICENSE, Buffer.alloc(0), 8_000);
  return { licensed: reply.ok && reply.data.length >= 4 && reply.data.readUInt32LE(0) !== 0, raw: reply.data };
}

/** uVision's version, which is not the socket protocol's version. */
export async function ideVersion(session: KeilSession): Promise<{ ide: number; socket: number } | null> {
  const reply = await session.client.send(OP.GEN_GET_EXTVERSION, Buffer.alloc(0), 8_000);
  if (!reply.ok || reply.data.length < 8) return null;
  return { ide: reply.data.readUInt32LE(0), socket: reply.data.readUInt32LE(4) };
}

/**
 * Read registers by name.
 *
 * `UV_DBG_READ_REGISTERS` is **not** used: measured on MDK 5.43a it ignores
 * the names and answers a small constant (`0x00000001`) for `PC`, `R0,R1` and
 * `SP` alike — a plausible-looking value that is simply wrong, which is worse
 * than a refusal. The values come from the register
 * enumeration instead, filtered to the names asked for.
 */
export async function readNamedRegisters(session: KeilSession, names: string[]): Promise<{ name: string; value: string }[]> {
  const all = await readRegisters(session);
  const wanted = names.map((name) => name.trim()).filter(Boolean);
  // The debugger names its stack pointer `R13 (SP)`, not `SP`, and likewise
  // `R14 (LR)` and `R15 (PC)`. The parenthesised alias is what a person types.
  return wanted.map((name) => ({ name, value: findRegister(all, name)?.value ?? "" }));
}

/** Show the source at an address in the IDE's editor. */
export async function showCodeAt(session: KeilSession, address: number, source = true): Promise<Reply> {
  // `iSHOWSYNC`: `{ xU64 nAdr; bAsm:1; bHll:1; … }`.
  const payload = Buffer.alloc(40);
  payload.writeBigUInt64LE(BigInt(address), 0);
  payload.writeUInt32LE(source ? 2 : 1, 8);
  return session.client.send(OP.DBG_ADR_SHOWCODE, payload, 8_000);
}

/** Close the project in the running uVision. */
export async function closeProject(session: KeilSession): Promise<Reply> {
  return session.client.send(OP.PRJ_CLOSE, Buffer.alloc(0), 10_000);
}

/**
 * Named operations this build answers `NOT_SUPPORTED`, never answers, or
 * refuses for a reason that is about the operation and not the request.
 *
 * Listed so a caller can say "Keil does not offer this here" instead of
 * leaving a defined-but-unreachable command that looks implemented.
 */
export const UNSUPPORTED_ON_MDK_5_43: Record<string, string> = {
  "DBG_EVAL_EXPRESSION_TO_STR": "never replies; DBG_CALC_EXPRESSION answers the same question",
  "DBG_EVTR_GETSTATUS": "never replies on this build",
  // Measured on 5.43.1: no reply, no async error frame, no message box, with
  // UI locking or unlocking, on both session kinds, from the first message on.
  // A download is not a substitute for a full-chip erase — it erases only its
  // own image's sectors (measured with markers left past the image). See
  // `FLASH_ERASE_LIMITATION`.
  "PRJ_FLASH_ERASE": "never replies; a download erases only its own image's sectors, and a full-chip erase is STM32_Programmer_CLI -e all",
  // Re-measured on MDK 5.43a + STM32F429. `DBG_ENUM_VTR` lists CURR_TID,
  // STCLK, STLINK_PM, CORE_CLK and TRACE_CLK, and `VTR_GET` answers every one
  // of them. `TRAPS` is not in that list and answers `Unknown VTR-name`. One
  // earlier pass took a single successful `TRAPS` reply, deleted this entry and
  // wrote into the docs that reading it worked — that note was the mistake, not
  // the table. The entry is back, saying what is true.
  "DBG_VTR_GET": "only answers names the target's own DBG_ENUM_VTR lists; any other name, TRAPS included, is refused with 'Unknown VTR-name'",
  "DBG_VERIFY_CODE": "answers FAILED on a simulator target (no flash to verify against)",
  "DBG_FILELINE_TO_ADR": "answers NO_ADRMAP 'Address mapping failed' for both relative and absolute paths",
  "DBG_STEP_INTO_N": "documented as taking no count; the _HLL_N and _INSTRUCTION_N forms work",
  "PRJ_ACTIVE_FILES": "only answers outside a debug session, where it is not needed",
  "PRJ_LOAD": "the project is opened by the `-s` launch line; loading a second one mid-session is refused the same way",
  "PRJ_CMD_PROGRESS": "a progress notification (0x500D family), not a command",
  "DBG_READ_REGISTERS": "ignores the names and answers one small constant whatever is asked; the enumeration is used instead",
  "DBG_WAKE": "simulator-only; accepted, no observable effect on a hardware build",
  "DBG_SLEEP": "simulator-only; accepted, no observable effect",
  "DBG_SET_CALLBACK": "simulator-only; accepted, no observable effect",
} as const;

/**
 * Operations that work, but only on a session that turned on extended stack
 * mode before entering the debugger.
 *
 * Kept separate from the list above because "unavailable" and "available only
 * after the right setup" are different answers, and the first version of this
 * file had the second group filed as the first.
 */
export const NEEDS_EXTENDED_STACK: Record<string, string> = {
  "DBG_ENUM_VARIABLES": "variables, including locals of a frame",
  "DBG_VARIABLE_SET": "writing a variable by the id the enumeration reports",
  "DBG_ENUM_TASKS": "the RTOS task list",
  "DBG_EVAL_WATCH_EXPRESSION": "adding an expression to the Watch window",
  "DBG_REMOVE_WATCH_EXPRESSION": "removing a watch expression",
} as const;
