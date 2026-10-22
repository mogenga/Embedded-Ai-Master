/**
 * The uVision socket interface (UVSOCK): Keil's own remote control channel.
 *
 * Everything about a Keil project that command-line flags do not cover —
 * entering a debug session, breakpoints, stepping, variables, stack, registers,
 * memory, project groups and files, per-target options — is exposed here and
 * nowhere else. `UV4.exe` speaks it over TCP once started with `-s <port>`,
 * and the message format is a 32-byte header followed by a payload:
 *
 *   off  size  field
 *    0    4    m_nTotalLen   whole message, header included
 *    4    4    m_eCmd        the operation (UV_DBG_* / UV_PRJ_* / UV_GEN_*)
 *    8    4    m_nBufLen     payload length
 *   12    8    cycles        simulator only
 *   20    8    tStamp        simulator only
 *   28    4    m_Id          reserved, always 0
 *   32    …    payload
 *
 * A reply arrives with `m_eCmd = UV_CMD_RESPONSE (0x3000)` and a payload of
 * `{ u32 echoedCommand, u32 status, … }`. Commands that enumerate (breakpoints,
 * stack, registers, variables, files) reply immediately and then stream
 * `0x50xx` frames; those are collected separately so an enumerator can wait
 * for its terminator instead of guessing.
 *
 * No vendor binary is bundled or redistributed: this speaks to a UV4.exe the
 * user installed and licensed. When it is absent, every call here fails with a
 * plain "Keil MDK is not installed" rather than a stack trace.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { toolEnv } from "./toolEnv.js";
import { decodeGbk, encodeGbk } from "./gbk.js";
import { createConnection, type Socket } from "node:net";
import { existsSync } from "node:fs";
import { killTree } from "./killTree.js";

/* ---------- operation codes ---------- */

export const OP = {
  /** General */
  GEN_GET_VERSION: 0x0001,
  GEN_EXIT: 0x0009,
  GEN_CHECK_LICENSE: 0x000b,
  /** Project */
  PRJ_LOAD: 0x1000,
  PRJ_CLOSE: 0x1001,
  PRJ_ADD_GROUP: 0x1002,
  PRJ_DEL_GROUP: 0x1003,
  PRJ_ADD_FILE: 0x1004,
  PRJ_DEL_FILE: 0x1005,
  PRJ_BUILD: 0x1006,
  PRJ_REBUILD: 0x1007,
  PRJ_CLEAN: 0x1008,
  PRJ_FLASH_DOWNLOAD: 0x100a,
  PRJ_GET_DEBUG_TARGET: 0x100b,
  PRJ_SET_DEBUG_TARGET: 0x100c,
  PRJ_GET_OPTITEM: 0x100d,
  PRJ_SET_OPTITEM: 0x100e,
  PRJ_ENUM_GROUPS: 0x100f,
  PRJ_ENUM_FILES: 0x1010,
  PRJ_ENUM_TARGETS: 0x1015,
  PRJ_SET_TARGET: 0x1016,
  PRJ_GET_CUR_TARGET: 0x1017,
  /** Debug */
  DBG_ENTER: 0x2000,
  DBG_EXIT: 0x2001,
  DBG_START_EXECUTION: 0x2002,
  DBG_STOP_EXECUTION: 0x2003,
  DBG_STATUS: 0x2004,
  DBG_RESET: 0x2005,
  DBG_STEP_HLL: 0x2006,
  DBG_STEP_INTO: 0x2007,
  DBG_STEP_INSTRUCTION: 0x2008,
  DBG_STEP_OUT: 0x2009,
  DBG_CALC_EXPRESSION: 0x200a,
  DBG_MEM_READ: 0x200b,
  DBG_MEM_WRITE: 0x200c,
  DBG_VTR_SET: 0x2010,
  DBG_CREATE_BP: 0x2014,
  DBG_ENUMERATE_BP: 0x2015,
  DBG_CHANGE_BP: 0x2016,
  DBG_ADR_TOFILELINE: 0x2018,
  DBG_ENUM_STACK: 0x2019,
  DBG_ENUM_VTR: 0x201a,
  DBG_EXEC_CMD: 0x2020,
  DBG_FILELINE_TO_ADR: 0x2025,
  DBG_READ_REGISTERS: 0x2028,
  DBG_REGISTER_SET: 0x2029,
  DBG_DSM_READ: 0x202a,
  DBG_EVAL_WATCH_EXPRESSION: 0x202b,
  DBG_REMOVE_WATCH_EXPRESSION: 0x202d,
  DBG_ENUM_VARIABLES: 0x202e,
  DBG_VARIABLE_SET: 0x202f,
  DBG_ENUM_REGISTERS: 0x2027,
  DBG_STEP_HLL_N: 0x2106,
  DBG_STEP_INTO_N: 0x2107,
  DBG_STEP_INSTRUCTION_N: 0x2108,
  DBG_RUN_TO_ADDRESS: 0x2102,
  DBG_TIME_INFO: 0x200d,
  DBG_SET_CALLBACK: 0x200e,
  DBG_VTR_GET: 0x200f,
  DBG_VERIFY_CODE: 0x2013,
  DBG_ENUM_SYMTP: 0x2017,
  DBG_ADR_SHOWCODE: 0x201c,
  DBG_WAKE: 0x201d,
  DBG_SLEEP: 0x201e,
  DBG_EVAL_EXPRESSION_TO_STR: 0x2024,
  DBG_ENUM_REGISTER_GROUPS: 0x2026,
  DBG_ENUM_TASKS: 0x2030,
  DBG_ENUM_MENUS: 0x2031,
  DBG_MENU_EXEC: 0x2032,
  DBG_ITM_REGISTER: 0x2033,
  DBG_ITM_UNREGISTER: 0x2034,
  DBG_EVTR_REGISTER: 0x2035,
  DBG_EVTR_UNREGISTER: 0x2036,
  DBG_EVTR_GETSTATUS: 0x2037,
  DBG_EVTR_ENUMSCVDFILES: 0x2038,
  PRJ_BUILD_CANCEL: 0x1009,
  PRJ_CMD_PROGRESS: 0x1011,
  PRJ_ACTIVE_FILES: 0x1012,
  PRJ_FLASH_ERASE: 0x1013,
  PRJ_GET_OUTPUTNAME: 0x1014,
  PRJ_SET_OUTPUTNAME: 0x1018,
  GEN_GET_EXTVERSION: 0x000a,
  GEN_SET_OPTIONS: 0x000d,
  GEN_SHOW: 0x0005,
  GEN_HIDE: 0x0004,
  GEN_MINIMIZE: 0x0007,
  /** Replies */
  CMD_RESPONSE: 0x3000,
  ASYNC_MSG: 0x4000,
} as const;

/** The reply status codes, in the order the interface numbers them. */
export const STATUS = [
  "SUCCESS",
  "FAILED",
  "NO_PROJECT",
  "WRITE_PROTECTED",
  "NO_TARGET",
  "NO_TOOLSET",
  "NOT_DEBUGGING",
  "ALREADY_PRESENT",
  "INVALID_NAME",
  "NOT_FOUND",
  "DEBUGGING",
  "TARGET_EXECUTING",
  "TARGET_STOPPED",
  "PARSE_ERROR",
  "OUT_OF_RANGE",
  "BP_CANCELLED",
  "BP_BADADDRESS",
  "BP_NOTSUPPORTED",
  "BP_FAILED",
  "BP_REDEFINED",
  "BP_DISABLED",
  "BP_ENABLED",
  "BP_CREATED",
  "BP_DELETED",
  "BP_NOTFOUND",
  "BUILD_OK_WARNINGS",
  "BUILD_FAILED",
  "BUILD_CANCELLED",
  "NOT_SUPPORTED",
  "TIMEOUT",
  "UNEXPECTED_MSG",
  "VERIFY_FAILED",
  "NO_ADRMAP",
  "INFO",
  "NO_MEM_ACCESS",
  "FLASH_DOWNLOAD",
  "BUILDING",
  "HARDWARE",
  "SIMULATOR",
  "BUFFER_TOO_SMALL",
] as const;

export function statusName(code: number): string {
  return STATUS[code] ?? `status ${code}`;
}

/** `BKTYPE`: what a breakpoint watches. */
export const BREAK = { EXEC: 1, READ: 2, WRITE: 3, READWRITE: 4, COMPLEX: 5 } as const;
/** `UV_TARGET_HW` / `UV_TARGET_SIM`, as `PRJ_SET_DEBUG_TARGET` takes them. */
export const TARGET = { HW: 0, SIM: 1 } as const;

/** `OPTSEL` values for `PRJ_GET_OPTITEM` / `PRJ_SET_OPTITEM`. */
export const OPT = {
  LMISC: 1,
  CMISC: 2,
  AMISC: 3,
  CINCL: 4,
  AINCL: 5,
  CDEF: 6,
  ADEF: 7,
  CUNDEF: 8,
  AUNDEF: 9,
  COPTIMIZE: 10,
  CODEGEN: 11,
  MEMRANGES: 12,
  ASNMEMRANGES: 13,
  UBCOMP1: 14,
  UBCOMP2: 15,
  UBBUILD1: 16,
  UBBUILD2: 17,
  UABUILD1: 18,
  UABUILD2: 19,
} as const;

export type OptionName = keyof typeof OPT;

/* ---------- message framing ---------- */

export const HEADER_BYTES = 32;

/** Every operation code, for recognising the envelope a reply frame carries. */
const KNOWN_COMMANDS = new Set<number>(Object.values(OP));
/** `SOCK_NDATA` in the interface: one message never exceeds this. */
export const MAX_MESSAGE = 32768;

export interface Reply {
  status: number;
  statusName: string;
  ok: boolean;
  data: Buffer;
  /** The command-echoed error text, when the status carries one. */
  message?: string;
  /** True when the request produced no reply before its deadline. */
  timedOut?: boolean;
}

export interface AsyncFrame {
  /** The `0x50xx` frame type. */
  type: number;
  /** The command this frame answers; 0 for unsolicited notifications. */
  echoed: number;
  /**
   * The frame body, with the reply envelope removed when it has one.
   *
   * Some frames carry `{ u32 echoedCommand, u32 status }` first and some do
   * not — a breakpoint item begins `15 20 00 00 | 00 00 00 00 | 01 00 00 00`
   * (0x2015 echoed), while a command-window line begins `45 00 00 00 | "*** error…"`
   * with no envelope at all. The rule used is the one the wire shows: if the
   * first word is a command in the `UV_DBG_*` range, it is an echoed command.
   */
  data: Buffer;
  /** The body exactly as it arrived, envelope included. */
  raw: Buffer;
}

/** One request message. */
export function encodeMessage(command: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const total = HEADER_BYTES + payload.length;
  const message = Buffer.alloc(total);
  message.writeUInt32LE(total, 0);
  message.writeUInt32LE(command, 4);
  message.writeUInt32LE(payload.length, 8);
  message.writeUInt32LE(0, 28);
  payload.copy(message, HEADER_BYTES);
  return message;
}

/**
 * Pull complete messages out of a stream.
 *
 * TCP splits wherever it likes, so the reader keeps a buffer and only hands
 * over a message once `m_nTotalLen` bytes are present. A length outside
 * `[32, SOCK_NDATA]` cannot come from uVision; the buffer is dropped rather
 * than scanning for a plausible header, because resynchronising on garbage
 * would pair a reply with the wrong command.
 */
export class MessageReader {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): Buffer[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const out: Buffer[] = [];
    while (this.buffer.length >= HEADER_BYTES) {
      const total = this.buffer.readUInt32LE(0);
      if (total < HEADER_BYTES || total > MAX_MESSAGE) {
        this.buffer = Buffer.alloc(0);
        break;
      }
      if (this.buffer.length < total) break;
      out.push(this.buffer.subarray(0, total));
      this.buffer = this.buffer.subarray(total);
    }
    return out;
  }
}

/** The `command` a message carries. */
export function messageCommand(message: Buffer): number {
  return message.readUInt32LE(4);
}

export function messagePayload(message: Buffer): Buffer {
  return message.subarray(HEADER_BYTES);
}

/* ---------- payload builders ---------- */

/**
 * Fit text into `size` bytes without splitting a character.
 *
 * Strings on this wire are UTF-8 (measured: a group name round-trips intact
 * only when written that way), so a fixed-width field has to cut on a
 * character boundary. Cutting mid-sequence produced a replacement character
 * in whatever read it back.
 */
/**
 * Fit text into `size` bytes of the wire code page without splitting a
 * character.
 *
 * Strings on this wire are GBK (measured: a group name round-trips intact only
 * that way), so a fixed-width field has to cut between two-byte characters
 * rather than mid-sequence. A trailing lead byte would consume the terminator
 * on the far end.
 */
export function fitUtf8(text: string, size: number): Buffer {
  const bytes = encodeGbk(text);
  if (bytes.length <= size) return bytes;
  let cut = size;
  // A GBK trail byte is 0x40–0xFE; a lead byte is 0x81–0xFE. Walking back one
  // step is enough, because at most one character straddles the boundary.
  if (cut > 0 && (bytes[cut]! & 0xc0) === 0x80) cut--;
  return bytes.subarray(0, cut);
}

/** `SSTR`: `{ i32 nLen, char szStr[256] }`, `nLen` including the terminator. */
export function sstr(text: string, size = 256): Buffer {
  const buffer = Buffer.alloc(4 + size);
  const fitted = fitUtf8(text, size - 1);
  buffer.writeInt32LE(fitted.length + 1, 0);
  fitted.copy(buffer, 4);
  return buffer;
}

/** Read an `SSTR` back out of a payload at `offset`. */
export function readSstr(payload: Buffer, offset = 0): string {
  if (payload.length < offset + 4) return "";
  const end = payload.indexOf(0, offset + 4);
  return decodeGbk(payload.subarray(offset + 4, end < 0 ? payload.length : end));
}

/**
 * `UV_DBG_DSM_READ`: what the disassembly window holds at an address.
 *
 * The reply is an `AMEM` whose `aBytes` are **text**, not instruction words —
 * the same record a memory read uses, with the bytes being the window's lines:
 *
 *   nAddr(8)  nBytes(4)  ErrAddr(8)  nErr(4)  text…
 *
 * Measured at `0x08006be0`:
 *
 *   "    35:     HAL_Init();                     //初始化HAL库 \n"
 *   "0x08006BE0 F7F9FF38  BL.W          0x08000A54 HAL_Init\n"
 *
 * An earlier version read the body as 32-bit instruction words and reported
 * `0x30307830` ("0x00" as ASCII) as an opcode — a number that looks like an
 * instruction and is not. There is no decode step: the debugger has already
 * done it, and its own text is the answer.
 */
export function readDisassemblyText(payload: Buffer): { address: number; bytes: number; text: string; errorAddress?: number } | null {
  if (payload.length < 24) return null;
  const address = Number(payload.readBigUInt64LE(0));
  const count = payload.readUInt32LE(8);
  const errorAddress = Number(payload.readBigUInt64LE(12));
  // The count is what the debugger says it filled; a line can be cut short at
  // the end of the record, so the slice is clamped rather than trusted.
  const text = decodeGbk(payload.subarray(24, Math.min(24 + count, payload.length)));
  return { address, bytes: count, text, ...(payload.readUInt32LE(20) > 0 ? { errorAddress } : {}) };
}

/**
 * Read a length-prefixed string that is not an `SSTR`.
 *
 * `SSTR` is `{ i32 nLen; char szStr[256] }` with `nLen` counting the
 * terminator, while the enumeration frames carry `{ u32 len; char text[] }`
 * where `len` counts the characters *without* it — `04 00 00 00 "Core"`
 * is the measured shape. Using one reader for both dropped the last letter
 * of every group name.
 */
/**
 * A `VSET` reply: `{ TVAL val; SSTR str }`.
 *
 * The value is a 64-bit number at offset 4 and the rendered text is an `SSTR`
 * at offset 12. Measured across five expressions:
 *
 *   main   → type 5, 0x08006be0, "main"
 *   $      → type 9, 0x08006458, "$"
 *
 * The header's `VTT_TYPE` enum does **not** match the numbers this build
 * sends (4, 5, 8 and 9 were all observed for plain integer results), so the
 * type is carried through as a number and never used to pick a member of a
 * union. The 64-bit field is correct for every expression tried, and the text
 * is the debugger's own rendering.
 */
export function readVset(payload: Buffer): { type: number; value: bigint; text: string } | null {
  if (payload.length < 16) return null;
  return {
    type: payload.readInt32LE(0),
    value: payload.readBigInt64LE(4),
    text: readSstr(payload, 12),
  };
}

/** Build a `VSET` request carrying an expression. */
export function vset(expression: string): Buffer {
  return vsetWithValue(expression, 0, 0n);
}

/**
 * A `VSET` request carrying both a name and a literal value.
 *
 * `VSET` is `{ TVAL val; SSTR str }` and the interface is compiled with
 * `#pragma pack(1)`, so the record is `type(4) value(8) len(4) text(256)` — the
 * value sits at 4, not at 8. The value field is what `REGISTER_SET` writes, and
 * a request that left it zero was accepted with `SUCCESS` while the register
 * kept its old value.
 */
export function vsetWithValue(name: string, type: number, value: bigint): Buffer {
  const buffer = Buffer.alloc(12 + 260);
  buffer.writeInt32LE(type, 0);
  buffer.writeBigInt64LE(value, 4);
  buffer.writeInt32LE(encodeGbk(name).length + 1, 12);
  encodeGbk(name).copy(buffer, 16);
  return buffer;
}

/** `IVARENUM`: `{ i32 nID, i32 nFrame, i32 nTask, u16 count, u16 flags }`. */
export function ivarEnum(nID: number, nFrame: number, nTask: number, count: number): Buffer {
  const buffer = Buffer.alloc(16);
  buffer.writeInt32LE(nID, 0);
  buffer.writeInt32LE(nFrame, 4);
  buffer.writeInt32LE(nTask, 8);
  buffer.writeUInt16LE(count, 12);
  return buffer;
}

/** `VARVAL`: `{ IVARENUM variable; SSTR value }` — how `VARIABLE_SET` names its target. */
export function varVal(nID: number, nFrame: number, nTask: number, value: string): Buffer {
  const header = ivarEnum(nID, nFrame, nTask, 1);
  const buffer = Buffer.alloc(16 + 260);
  header.copy(buffer, 0);
  sstr(value).copy(buffer, 16);
  return buffer;
}

/** One entry of the debugger's menu model (`MENUENUM`). */
export interface MenuEntry {
  id: number;
  group: number;
  enabled: boolean;
  label: string;
}

/** `MENUENUM`: `{ i32 id, i32 group, i32 info, u32 flags, u32 len, char label[] }`. */
export function readMenu(frame: AsyncFrame): MenuEntry | null {
  const data = frame.data;
  if (frame.type !== 0x5061 || data.length < 20) return null;
  const id = data.readInt32LE(0);
  const group = data.readInt32LE(4);
  const flags = data.readUInt32LE(12);
  const length = data.readUInt32LE(16);
  if (length === 0 || 20 + length > data.length + 1) return null;
  // `length` is the character count, terminator included, so the text ends
  // one byte earlier — reading `length - 1` cut the last letter off every
  // label ("Trace Dat").
  return { id, group, enabled: (flags & 1) === 1, label: decodeGbk(data.subarray(20, 20 + length)).replace(/\0.*$/s, "") };
}

/**
 * `AVTR`, the trace-variable record: `{ u32 type, u32 nRes[7], u32 nameLen,
 * char name[] }`.
 *
 * Measured: `12 00 00 00`, seven zero words, `09 00 00 00 "CURR_TID"` —
 * 40 bytes of head and then the name. The first word is the variable's type,
 * not its number.
 */
export function readVtrFrame(frame: AsyncFrame): { name: string; type: number } | null {
  if (frame.type !== 0x5018 || frame.data.length < 40) return null;
  // `{ u32 type, u32 nRes[7], u32 nameLen, u32 nRes[2], char name[] }`;
  // `nameLen` counts the terminator (9 for "CURR_TID" + NUL). Measured on all
  // five frames this target reports: the name starts at 44 and the record
  // ends exactly at `44 + nameLen`.
  // The record does not end after the first name: the measured frames carry
  // more fields after it, so the length is validated but not used as an
  // end-of-record bound.
  // `nameLen` counts the characters only — 9 for "CURR_TID", 5 for "TRAPS" —
  // unlike `SSTR`, whose length includes the terminator. Reading it the SSTR
  // way kept the NUL of one name as a trailing space.
  const length = frame.data.readUInt32LE(32);
  if (length === 0) return null;
  const name = decodeGbk(frame.data.subarray(44, 44 + length)).replace(/\0+$/, "").trim();
  if (!name) return null;
  return { name, type: frame.data.readUInt32LE(0) };
}

export function readCountedString(payload: Buffer, offset = 0): string {
  if (payload.length < offset + 4) return "";
  const length = payload.readUInt32LE(offset);
  if (length === 0 || length > 4096) return "";
  const start = offset + 4;
  const end = Math.min(start + length, payload.length);
  return decodeGbk(payload.subarray(start, end)).replace(/\0$/, "");
}

/** `PRJDATA`: `{ u32 nLen, u32 nCode, char szNames[] }` with NUL-separated names. */
/**
 * `PRJDATA`: `{ u32 nLen, u32 nCode, char szNames[] }` with NUL-separated names.
 *
 * `nLen` counts the name block including the terminators. Measured against
 * `PRJ_ADD_FILE` on MDK 5.43a: the file lands in the project as
 * `<FileName>probe_new.c</FileName>` with the path it was given.
 */
export function prjData(...names: string[]): Buffer {
  const text = names.join("\0") + "\0";
  const buffer = Buffer.alloc(8 + encodeGbk(text).length);
  buffer.writeUInt32LE(encodeGbk(text).length, 0);
  buffer.writeUInt32LE(0, 4);
  encodeGbk(text).copy(buffer, 8);
  return buffer;
}

/**
 * `TRNOPT`: which target/group/file an option belongs to.
 *
 * Layout: `{ OPTSEL job; u32 iTarg, iGroup, iFile, iItem; char szBuffer[3] }`
 * followed by a string pool. The four offsets are measured from `szBuffer`
 * (which starts at byte 20) and **0 means "not specified"** — not
 * `0xffffffff`. The string pool therefore begins at offset 3.
 *
 * That sentinel is the whole trick: sending `0xffffffff` for an unused field
 * makes uVision read a group name out of the pool at a nonsense offset and
 * answer `Group 'ÿ'`, and sending `0` while also putting a string at offset 0
 * makes it read that string as the *group* name and answer `'Target' not
 * specified`. Both were observed before the encoding was right.
 */
export function trnOpt(job: number, parts: { target?: string; group?: string; file?: string; item?: string } = {}): Buffer {
  const order: (keyof typeof parts)[] = ["target", "group", "file", "item"];
  const offsets = [0, 0, 0, 0];
  const pool: string[] = [];
  let at = 3;
  order.forEach((key, index) => {
    const value = parts[key];
    if (value === undefined) return;
    offsets[index] = at;
    pool.push(value);
    at += encodeGbk(value).length + 1;
  });
  const text = pool.length > 0 ? `${pool.join("\0")}\0` : "";
  const buffer = Buffer.alloc(23 + encodeGbk(text).length);
  buffer.writeUInt32LE(job, 0);
  offsets.forEach((value, index) => buffer.writeUInt32LE(value, 4 + index * 4));
  if (text) encodeGbk(text).copy(buffer, 23);
  return buffer;
}

/** Decode a `TRNOPT` reply: the option's strings, in order. */
export function readTrnOpt(payload: Buffer): string[] {
  // `SZBUFFER` starts at 20, so the strings are at `20 + offset` and the
  // offsets are measured from there. The first entry answers the `iTarg`
  // field and is the target's own name — it is not part of the option's
  // value, and returning it made every read look like `TOUCH, <value>`.
  if (payload.length < 23) return [];
  const out: string[] = [];
  for (let index = 0; index < 4; index++) {
    const offset = payload.readUInt32LE(4 + index * 4);
    if (offset === 0) continue;
    const start = 20 + offset;
    if (start >= payload.length) continue;
    const end = payload.indexOf(0, start);
    out.push(decodeGbk(payload.subarray(start, end < 0 ? payload.length : end)));
  }
  return out;
}

/** The option's own value, without the echoed target name in slot 0. */
export function trnOptValue(payload: Buffer): string {
  const parts = readTrnOpt(payload);
  return (parts.length > 1 ? parts[1] : parts[0] ?? "").trim();
}

/** `BKPARM`: a breakpoint definition. */
export function breakpointParam(expression: string, options: { type?: number; count?: number; accessSize?: number } = {}): Buffer {
  const buffer = Buffer.alloc(20 + 1024);
  buffer.writeUInt32LE(options.type ?? BREAK.EXEC, 0);
  buffer.writeUInt32LE(options.count ?? 1, 4);
  buffer.writeUInt32LE(options.accessSize ?? 0, 8);
  const fitted = fitUtf8(expression, 1023);
  buffer.writeUInt32LE(fitted.length + 1, 12);
  fitted.copy(buffer, 20);
  return buffer;
}

/** `AMEM` for a memory read: `{ u64 nAddr, u32 nBytes, … }`. */
export function memoryRequest(address: number, bytes: number): Buffer {
  const buffer = Buffer.alloc(24);
  buffer.writeBigUInt64LE(BigInt(Math.max(0, Math.trunc(address))), 0);
  buffer.writeUInt32LE(bytes, 8);
  return buffer;
}

/** `AMEM` for a memory write. */
export function memoryWrite(address: number, bytes: number[]): Buffer {
  const buffer = memoryRequest(address, bytes.length);
  const padded = Buffer.alloc(buffer.length + Math.max(bytes.length, 1));
  buffer.copy(padded, 0);
  Buffer.from(bytes).copy(padded, 24);
  return padded;
}

/** Decode an `AMEM` reply: the bytes `nErr` says were valid. */
export function readMemoryReply(payload: Buffer): { address: number; bytes: number[]; errorAddress?: number } | null {
  if (payload.length < 24) return null;
  const address = Number(payload.readBigUInt64LE(0));
  const count = payload.readUInt32LE(8);
  const errorAddress = Number(payload.readBigUInt64LE(12));
  const failed = payload.readUInt32LE(20);
  const available = payload.subarray(24, 24 + count);
  return {
    address,
    bytes: [...available],
    ...(failed > 0 ? { errorAddress } : {}),
  };
}

/** True when every character is printable ASCII or ordinary whitespace. */
function isPrintable(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || code === 13) continue;
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

/**
 * Decode a `0x4000` progress message.
 *
 * Body: `{ u32 a, u32 b, u32 len, char text[] }` — measured on `Execution
 * started`, whose body is `00…00 00…00 12 00 00 00 "Execution started"` and
 * whose `len` of 18 is the string plus its terminator.
 *
 * Not every `0x4000` frame is one of these: a stop notification carries a
 * `BPREASON` instead, so a frame that does not decode is returned as "" and
 * the caller keeps the raw body.
 */
export function asyncText(frame: AsyncFrame): string {
  if (frame.type !== OP.ASYNC_MSG || frame.data.length < 12) return "";
  const length = frame.data.readUInt32LE(8);
  // A stop notification shares this frame type but puts a `BPREASON` here;
  // its third word is a text length only when the frame is a progress line.
  if (isStopNotification(frame)) return "";
  if (length === 0 || length > frame.data.length - 12 + 1) return "";
  const text = decodeGbk(frame.data.subarray(12, 12 + length - 1));
  // Printable text only: a `BPREASON` body decodes to binary and must not
  // be reported as a progress message.
  return isPrintable(text) ? text : "";
}

/** Decode a `0x5020` command-window line: `{ u32 len, char text[] }`, no envelope. */
export function commandWindowText(frame: AsyncFrame): string {
  if (frame.type !== 0x5020 || frame.raw.length < 5) return "";
  const end = frame.raw.indexOf(0, 4);
  return decodeGbk(frame.raw.subarray(4, end < 0 ? frame.raw.length : end));
}

/**
 * The stop reason, when a `0x4000` frame is one.
 *
 * uVision announces "the target stopped" as `0x4000` with
 * `UV_DBG_STOP_EXECUTION` echoed back. `DBG_STATUS` reports the debugger's
 * state, not the core's — it stays `SUCCESS` whether the target runs or is
 * halted — so the notification is the only signal that a stop happened.
 *
 * The body is `BPREASON`, measured on a simulator fault:
 *
 *   res1(4)=1 res2(4)=0 strLen(4)=0 reason(4)=1 pc(8) address(8) bp(4)=0xffffffff
 *
 * so the reason word is at 8, not at 0. Reading it one word early made every
 * stop look like `reasonCode: 0` and turned a breakpoint into "none".
 */
export function isStopNotification(frame: AsyncFrame): boolean {
  return frame.type === OP.ASYNC_MSG && frame.echoed === OP.DBG_STOP_EXECUTION;
}

/**
 * `STOPREASON`, as the notification numbers it.
 *
 * Measured on a Cortex-M4 under the simulator: stopping at a breakpoint sends
 * `reason = 1` and the description "Target stopped"; a fault sends the fault
 * address as well.
 */
export const STOP_REASONS = ["none", "breakpoint", "fault", "watchpoint", "signal", "user", "step", "unknown"] as const;

/**
 * `BPREASON.eReason`, which does **not** start at `none`.
 *
 * Measured stops: hitting a breakpoint sends `1`, and `UV_DBG_STOP_EXECUTION`
 * (a manual halt) sends `0` with the text "Target stopped". So 1 is a
 * breakpoint and 0 is "the target stopped for a reason the interface did not
 * classify" — most often a user halt. A single-step reports 7 on this build.
 */
export function stopReasonName(code: number): string {
  if (code === 0) return "stopped";
  if (code === 1) return "breakpoint";
  return STOP_REASONS[code] ?? `stop reason ${code}`;
}

export function stopReason(frame: AsyncFrame): { reason: number; pc?: number; address?: number; slot?: number } | null {
  if (!isStopNotification(frame) || frame.data.length < 28) return null;
  // Words after the 8-byte envelope: res1(0), res2(4), strLen(8), reason(12),
  // pc(16, u64), address(24, u64), bp(32), tick(36).
  //
  // Measured frame, stopping on a breakpoint at 0x08006994:
  //   1, 0, 0, 1, 0x08006994, 0, 0x08006994, 0, 1, 2, …
  // The hardware slot is the `1` at 32. Reading 28 — which is what this did —
  // reads the **high half of the 64-bit address**: always 0 for a Cortex-M
  // address, so every stop reported `slot: 0` and a real `0xffffffff`
  // ("no slot") at 32 was never seen.
  const pc = frame.data.readUInt32LE(16);
  const address = frame.data.readUInt32LE(24);
  const slot = frame.data.length >= 36 ? frame.data.readInt32LE(32) : -1;
  return {
    reason: frame.data.readUInt32LE(12),
    ...(pc ? { pc } : {}),
    ...(address ? { address } : {}),
    // `0xffffffff` is "no slot", and must not be reported as a slot number.
    ...(slot >= 0 ? { slot } : {}),
  };
}

/**
 * A fixed-size string field from a reply, reading until the terminator.
 *
 * Unlike `readSstr` this takes no length word: register, task and group
 * frames carry the characters directly in a fixed-width field.
 */
export function fixedString(payload: Buffer, offset: number, width: number): string {
  if (offset >= payload.length) return "";
  const slice = payload.subarray(offset, Math.min(offset + width, payload.length));
  const end = slice.indexOf(0);
  return decodeGbk(end < 0 ? slice : slice.subarray(0, end));
}

/* ---------- the client ---------- */

export interface ConnectOptions {
  /** Path to `UV4.exe`. */
  uv4: string;
  /** Project file, or "" to run uVision with no project loaded. */
  project?: string;
  /** TCP port; 0 picks a free one from the configurable range. */
  port?: number;
  /** How long to wait for uVision to start listening. */
  startTimeoutMs?: number;
}

export interface ConnectResult {
  ok: true;
  client: UvSocketClient;
}
export interface ConnectFailure {
  ok: false;
  reason: string;
}

/** Ports tried when none is configured; the documented default is 4823. */
export const DEFAULT_PORTS = [4823, 4824, 4825, 4826, 4327, 4328, 4329];

/**
 * One live conversation with uVision.
 *
 * The client owns the process, because `-s` is a launch flag rather than
 * something a running uVision can be told to do: a session that outlives its
 * client would keep the port and the probe, and the next call could not start
 * its own.
 */
export class UvSocketClient {
  private sequence = 0;
  private pending = new Map<number, (reply: Reply) => void>();
  private frames: AsyncFrame[] = [];
  private frameWaiters: (() => void)[] = [];
  /**
   * One reader for the whole connection.
   *
   * A `MessageReader` holds the partial frame between `data` events. Creating
   * one per event — which this did — threw that away, and TCP gives no message
   * boundaries: a header split across two segments lost its first half, and
   * the next chunk was read from the middle of a payload, either dropped or
   * (when the length bytes happened to look sane) turned into a fabricated
   * frame. Large reads and an 8 KB register burst are over the segment size on
   * a loopback connection often enough for this to be a real loss of the stop
   * notification that `run` waits for.
   */
  private readonly reader = new MessageReader();
  closed = false;
  /** The executable this conversation is with, for CLI operations beside it. */
  readonly programPath: string;
  private readonly socket: Socket;
  readonly port: number;
  private readonly process?: ChildProcess;

  constructor(socket: Socket, port: number, process?: ChildProcess, programPath = "") {
    this.socket = socket;
    this.programPath = programPath;
    this.port = port;
    this.process = process;
    socket.on("data", (chunk: Buffer) => this.onData(chunk));
    // Without a listener, an `error` emitted after the one-shot handler in
    // `connectOnce` has fired is an uncaught exception — it does not fail this
    // call, it ends the host process and every session in it. `socket.write`
    // does not throw on a dead socket either, so the try/catch in `send` never
    // sees it; this listener is the only place the failure is observable.
    socket.on("error", (error: Error) => {
      this.closed = true;
      for (const [token, resolve] of this.pending) {
        resolve({
          status: 1,
          statusName: "FAILED",
          ok: false,
          data: Buffer.alloc(0),
          message: `the connection to uVision failed: ${error.message}`,
        });
        this.pending.delete(token);
      }
    });
    socket.on("close", () => {
      this.closed = true;
      for (const [token, resolve] of this.pending) {
        resolve({ status: 1, statusName: "FAILED", ok: false, data: Buffer.alloc(0), message: "uVision closed the connection" });
        this.pending.delete(token);
      }
    });
  }

  private onData(chunk: Buffer): void {
    for (const message of this.reader.push(chunk)) {
      const command = messageCommand(message);
      const payload = messagePayload(message);
      if (command === OP.CMD_RESPONSE) {
        if (payload.length < 8) continue;
        const echoed = payload.readUInt32LE(0);
        const status = payload.readUInt32LE(4);
        const data = payload.subarray(8);
        const resolve = this.pending.get(echoed);
        // The reply is matched on the echoed command, not on arrival order:
        // uVision answers asynchronously and interleaves stream frames.
        if (!resolve) continue;
        this.pending.delete(echoed);
        resolve({
          status,
          statusName: statusName(status),
          ok: status === 0,
          data,
          ...(status !== 0 ? { message: this.errorText(data) } : {}),
        });
        continue;
      }
      // See AsyncFrame: the envelope is present only when the first word is a
      // command code, which is what an echo of a request looks like. The
      // project enumerations echo `0x10xx` codes, so the test covers the whole
      // operation table rather than just the debug range.
      const first = payload.length >= 8 ? payload.readUInt32LE(0) : 0;
      const enveloped = KNOWN_COMMANDS.has(first);
      this.frames.push({
        type: command,
        echoed: enveloped ? first : 0,
        data: enveloped ? payload.subarray(8) : payload,
        raw: payload,
      });
      const waiter = this.frameWaiters.shift();
      if (waiter) waiter();
    }
  }

  /**
   * The interface reports failures as `{ u32, u32, u32 len, char text[] }`,
   * and the text is the only useful part: `'Target' not specified`, `Group
   * 'X'`, `Cannot access target`.
   */
  private errorText(data: Buffer): string | undefined {
    if (data.length < 12) return undefined;
    const length = data.readUInt32LE(8);
    if (length === 0 || length > data.length - 12 + 1) return undefined;
    return decodeGbk(data.subarray(12, 12 + length - 1)).trim() || undefined;
  }

  /** Send one request and wait for its reply. */
  send(command: number, payload: Buffer = Buffer.alloc(0), timeoutMs = 20_000): Promise<Reply> {
    if (this.closed) {
      return Promise.resolve({ status: 1, statusName: "FAILED", ok: false, data: Buffer.alloc(0), message: "the uVision connection is closed" });
    }
    // The reply is matched on the echoed command, so the wire has no room for
    // two outstanding requests of the same kind. The token here is bookkeeping
    // only; see `dispatch`.
    const token = command;
    return new Promise<Reply>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(token);
        resolve({ status: 29, statusName: "TIMEOUT", ok: false, data: Buffer.alloc(0), timedOut: true, message: `no reply to command 0x${command.toString(16)} in ${timeoutMs} ms` });
      }, timeoutMs);
      this.pending.set(token, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      try {
        this.socket.write(encodeMessage(command, payload));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(token);
        resolve({ status: 1, statusName: "FAILED", ok: false, data: Buffer.alloc(0), message: (error as Error).message });
      }
    });
  }

  /**
   * Send and wait for the adapter to stop executing.
   *
   * `DBG_START_EXECUTION` replies at once and the target then runs until it
   * hits something; the stop is a later 0x4000 frame. Waiting for that frame —
   * rather than sleeping a guessed interval — is what makes "run to the
   * breakpoint" return when it actually happened.
   */
  async runUntilStopped(timeoutMs = 30_000): Promise<{ stopped: boolean; frames: AsyncFrame[] }> {
    const started = Date.now();
    const before = this.frames.length;
    while (Date.now() - started < timeoutMs) {
      const recent = this.frames.slice(before);
      const stopped = recent.some((frame) => {
        if (frame.type !== OP.ASYNC_MSG || frame.data.length < 4) return false;
        // Reason codes live at the start; `Execution stopped` is one of them.
        const text = asyncText(frame).toLowerCase();
        return text.includes("stopped") || text.includes("break") || text.includes("error");
      });
      const status = await this.send(OP.DBG_STATUS, Buffer.alloc(0), 5_000);
      // 0 = stopped/ready, 1 = executing, per the debugger's own status word.
      const running = status.ok && status.data.length >= 4 && status.data.readUInt32LE(0) === 1;
      if (!running && (stopped || Date.now() - started > 400)) {
        return { stopped: true, frames: recent };
      }
      if (stopped) return { stopped: true, frames: recent };
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    return { stopped: false, frames: this.frames.slice(before) };
  }

  /**
   * Collect the stream frames a request answered with.
   *
   * A burst that ends in a terminator frame (`0x5006` for breakpoints,
   * `0x5029` for registers, `0x5016` for the stack) returns as soon as the
   * terminator arrives; the timeout is only for the burst that never ends.
   */
  async collect(ms = 400, terminator?: number, from?: number): Promise<AsyncFrame[]> {
    // `from` is where the caller's mark was taken. A burst can start before
    // the `^done` reply that ends `send()`, so counting from "now" silently
    // dropped every frame that beat the reply — which is how a populated
    // breakpoint list arrived as [].
    const before = from ?? this.frames.length;
    if (terminator === undefined) {
      await new Promise((resolve) => setTimeout(resolve, ms));
    } else {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        if (this.frames.slice(before).some((frame) => frame.type === terminator)) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    const frames = this.frames.slice(before);
    this.frames = this.frames.slice(0, before);
    return frames;
  }

  /** Frames received since `mark`, without consuming them. */
  since(mark: number): AsyncFrame[] {
    return this.frames.slice(mark);
  }

  /** The current frame count, for `since`. */
  get mark(): number {
    return this.frames.length;
  }

  /** Every `0x50xx` text frame received so far, as plain lines. */
  commandLines(): string[] {
    return this.frames.filter((frame) => frame.type === 0x5020).map(commandWindowText).filter(Boolean);
  }

  async exit(): Promise<void> {
    try {
      await this.send(OP.GEN_EXIT, Buffer.alloc(0), 4_000);
    } catch {
      /* the process may already be gone */
    }
    this.close();
  }

  close(): void {
    this.closed = true;
    try {
      this.socket.destroy();
    } catch {
      /* already closed */
    }
    if (this.process?.pid) {
      // uVision is a GUI application underneath: it ignores SIGTERM on
      // Windows and keeps the port and the probe, so the whole tree goes.
      try {
        killTree(this.process.pid);
      } catch {
        try {
          this.process.kill();
        } catch {
          /* already gone */
        }
      }
    }
  }
}

/** Start `UV4.exe` with the socket enabled and connect to it. */
export async function connect(options: ConnectOptions): Promise<ConnectResult | ConnectFailure> {
  if (!existsSync(options.uv4)) {
    return { ok: false, reason: `UV4.exe was not found at ${options.uv4}. Keil MDK is licensed and is never bundled with this app; install it and try again.` };
  }
  const requested = options.port && options.port > 0 ? options.port : DEFAULT_PORTS[0];
  // When the caller names a port, use it. Otherwise fall through the list: a
  // port that a leftover uVision still holds accepts a connection and then
  // hangs up, and the next one is free.
  const candidates = options.port && options.port > 0 ? [requested] : DEFAULT_PORTS;
  return connectOn(candidates, options);
}

async function connectOn(ports: number[], options: ConnectOptions): Promise<ConnectResult | ConnectFailure> {
  let last: ConnectFailure = { ok: false, reason: "no port was tried" };
  for (const port of ports) {
    const attempt = await connectOnce(port, options);
    if (attempt.ok) return attempt;
    last = attempt;
  }
  return last;
}

async function connectOnce(port: number, options: ConnectOptions): Promise<ConnectResult | ConnectFailure> {
  const args = [...(options.project ? [options.project] : []), "-s", String(port), "-j0"];
  let child: ChildProcess;
  try {
    // The same environment every other embedded tool gets. Spawning with the
    // inherited process environment handed UV4.exe — and every DLL and pack
    // tool it loads — the API key, proxy credentials and whatever else the
    // host was started with, which is exactly what toolEnv exists to prevent.
    child = spawn(options.uv4, args, { stdio: "ignore", windowsHide: true, env: toolEnv() });
  } catch (error) {
    return { ok: false, reason: `could not start UV4.exe: ${(error as Error).message}` };
  }
  const spawnError = new Promise<ConnectFailure>((resolve) => {
    child.on("error", (error) => resolve({ ok: false, reason: `could not start UV4.exe: ${error.message}` }));
    child.on("exit", (code) => resolve({ ok: false, reason: `UV4.exe exited with code ${code} before the socket opened` }));
  });

  const deadline = Date.now() + (options.startTimeoutMs ?? 25_000);
  const attempt = async (): Promise<UvSocketClient | null> => {
    while (Date.now() < deadline) {
      const socket = await new Promise<Socket | null>((resolve) => {
        const candidate = createConnection({ host: "127.0.0.1", port });
        candidate.once("connect", () => resolve(candidate));
        candidate.once("error", () => {
          candidate.destroy();
          resolve(null);
        });
      });
      if (socket) {
        // A stale uVision from an earlier session can be holding the port: it
        // accepts the connection, then closes it on the first request, which
        // looks like "uVision died" rather than "the port belongs to someone
        // else". Probing the version before returning the client turns that
        // into a retry, so a fresh process gets the next port instead.
        const probe = new UvSocketClient(socket, port, child, options.uv4);
        const version = await probe.send(OP.GEN_GET_VERSION, Buffer.alloc(0), 4_000);
        if (version.ok) return probe;
        probe.close();
        await new Promise((resolve) => setTimeout(resolve, 400));
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
    return null;
  };

  const client = await Promise.race([attempt(), spawnError.then((failure) => failure)]);
  if (client && "ok" in client) {
    try {
      killTree(child.pid ?? 0);
    } catch {
      /* nothing to kill */
    }
    return client;
  }
  if (client) return { ok: true, client };
  try {
    if (child.pid) killTree(child.pid);
  } catch {
    /* already gone */
  }
  return {
    ok: false,
    reason: `UV4.exe started but nothing accepted a connection on port ${port} within ${Math.round(((options.startTimeoutMs ?? 25_000) / 1000))} s. A modal dialog (licence, device pack, update) suppresses the socket; open the project in uVision once, dismiss it, then retry.`,
  };
}
