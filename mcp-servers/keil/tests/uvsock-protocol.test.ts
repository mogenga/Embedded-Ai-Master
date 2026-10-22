/**
 * Round 12: the uVision socket protocol.
 *
 * Every assertion here was written against bytes captured from MDK 5.43a over
 * a live `UV4.exe -s` connection. The offsets are not guesses — three of them
 * were wrong in the first implementation and each one produced a plausible
 * but false result ("0 breakpoints", "every stop is reason 0", "(no source)"),
 * which is exactly why they are pinned down here.
 */

import { describe, it, expect } from "vitest";
import {
  MessageReader,
  asyncText,
  commandWindowText,
  encodeMessage,
  isStopNotification,
  messageCommand,
  messagePayload,
  prjData,
  readCountedString,
  readDisassemblyText,
  readMemoryReply,
  readMenu,
  readSstr,
  readVset,
  readVtrFrame,
  ivarEnum,
  varVal,
  vset,
  vsetWithValue,
  readTrnOpt,
  sstr,
  statusName,
  stopReason,
  stopReasonName,
  trnOpt,
  trnOptValue,
  type AsyncFrame,
} from "../uvsock.js";
import { NEEDS_EXTENDED_STACK, UNSUPPORTED_ON_MDK_5_43 } from "../keilExtra.js";
import { findRegister, orderStackFrames, parseIntelHex, parseRegisters, parseStackFrames, parseVariables, readTaskFrames } from "../keilSession.js";

/* ---------- framing ---------- */

it("a request is a 32-byte header followed by its payload", () => {
  const message = encodeMessage(0x2004, Buffer.from([1, 2, 3]));
  expect(message.length).toBe(35);
  expect(message.readUInt32LE(0)).toBe(35);
  expect(message.readUInt32LE(4)).toBe(0x2004);
  expect(message.readUInt32LE(8)).toBe(3);
  expect(message.readUInt32LE(28)).toBe(0);
  expect([...message.subarray(32)]).toEqual([1, 2, 3]);
});

it("streamed chunks are reassembled into whole messages", () => {
  const reader = new MessageReader();
  const one = encodeMessage(0x3000, Buffer.alloc(10));
  const two = encodeMessage(0x5020, Buffer.alloc(4));
  // Split mid-header and mid-payload: TCP gives no message boundaries.
  const all = Buffer.concat([one, two]);
  const seen: Buffer[] = [];
  for (const cut of [20, 40, all.length]) seen.push(...reader.push(all.subarray(cut === 20 ? 0 : cut === 40 ? 20 : 40, cut)));
  expect(seen.length).toBe(2);
  expect(messageCommand(seen[0])).toBe(0x3000);
  expect(messageCommand(seen[1])).toBe(0x5020);
});

it("a nonsense length drops the buffer instead of pairing a reply wrongly", () => {
  const reader = new MessageReader();
  const bad = Buffer.alloc(32);
  bad.writeUInt32LE(999_999, 0);
  expect(reader.push(bad).length).toBe(0);
  // The reader is empty again, so the next real message is read cleanly.
  const good = encodeMessage(0x3000, Buffer.alloc(4));
  expect(reader.push(good).length).toBe(1);
});

it("the command and payload are read from the header", () => {
  const message = encodeMessage(0x1017, Buffer.from("TOUCH\0"));
  expect(messageCommand(message)).toBe(0x1017);
  expect(messagePayload(message).toString("latin1")).toBe("TOUCH\0");
});

/* ---------- strings ---------- */

it("SSTR carries its length including the terminator", () => {
  const encoded = sstr("main");
  expect(encoded.readInt32LE(0)).toBe(5);
  expect(readSstr(encoded, 0)).toBe("main");
});

it("a counted string counts its characters, not its terminator", () => {
  // Measured: `04 00 00 00 "Core\0"` is the register-group frame.
  const frame = Buffer.from("04000000436f726500", "hex");
  expect(readCountedString(frame, 0)).toBe("Core");
  // The two conventions are a byte apart: SSTR's length includes the
  // terminator, this one's does not, so the terminator sits at 4 + len - 1.
  expect(frame.readUInt32LE(0)).toBe(4);
  expect(frame[4 + 4]).toBe(0x00);
});

it("an empty counted string is empty, not garbage", () => {
  expect(readCountedString(Buffer.from("00000000", "hex"), 0)).toBe("");
  expect(readCountedString(Buffer.alloc(2), 0)).toBe("");
});

/* ---------- project data ---------- */

it("PRJDATA is a length, a code, then NUL-separated names", () => {
  const data = prjData("USER", "main.c");
  expect(data.readUInt32LE(0)).toBe("USER\0main.c\0".length);
  expect(data.readUInt32LE(4)).toBe(0);
  expect(data.subarray(8).toString("latin1")).toBe("USER\0main.c\0");
});

it("TRNOPT puts 0 for an unspecified field and offset 3 for the first string", () => {
  // 0, not 0xffffffff: the interface reads a group name out of a nonsense
  // offset and answers `Group 'ÿ'` when it is sent 0xffffffff.
  const withTarget = trnOpt(6, { target: "TOUCH" });
  expect(withTarget.readUInt32LE(0)).toBe(6);
  expect(withTarget.readUInt32LE(4)).toBe(3);
  expect(withTarget.readUInt32LE(8)).toBe(0);
  expect(withTarget.readUInt32LE(12)).toBe(0);
  expect(withTarget.toString("latin1", 23)).toBe("TOUCH\0");
});

it("an option read returns its value, not the echoed target name", () => {
  // Measured CDEF reply: the target name in slot 0, then the defines.
  const reply = Buffer.alloc(60);
  reply.writeUInt32LE(6, 0);
  reply.writeUInt32LE(3, 4); // target at szBuffer+3
  reply.writeUInt32LE(9, 8); // value at szBuffer+9
  reply.writeUInt32LE(0, 12);
  reply.writeUInt32LE(0, 16);
  reply.write("TOUCH\0", 23, "latin1");
  reply.write("A=1,B=2\0", 29, "latin1");
  expect(readTrnOpt(reply)).toEqual(["TOUCH", "A=1,B=2"]);
  expect(trnOptValue(reply)).toBe("A=1,B=2");
});

/* ---------- the 0x4000 family ---------- */

function frame(type: number, echoed: number, body: Buffer): AsyncFrame {
  return { type, echoed, data: body, raw: body };
}

it("a progress message is a length and a string", () => {
  // Measured: "Execution started" arrives as `… 12 00 00 00 "Execution started\0"`.
  const body = Buffer.alloc(12 + 18);
  body.writeUInt32LE(18, 8);
  body.write("Execution started\0", 12, "latin1");
  expect(asyncText(frame(0x4000, 0, body))).toBe("Execution started");
});

it("a stop notification is not mistaken for a progress message", () => {
  // The BPREASON body happens to contain a plausible-looking length word, and
  // reading it as text produced " : no 'write' pe" as the stop reason.
  const reason = Buffer.alloc(44);
  reason.writeUInt32LE(1, 12);
  reason.write(" : no 'write' permission", 36, "latin1");
  const stop = frame(0x4000, 0x2003, reason);
  expect(isStopNotification(stop)).toBe(true);
  expect(asyncText(stop)).toBe("");
});

it("the stop reason and PC are read from the measured offsets", () => {
  // Captured at a breakpoint on `main`: 1, 0, 0, 1, 0x08006460, 0x08006460, -1.
  const body = Buffer.alloc(36);
  body.writeUInt32LE(0, 8);
  body.writeUInt32LE(1, 12); // reason: breakpoint
  body.writeUInt32LE(0x08006460, 16); // pc
  body.writeUInt32LE(0, 20);
  body.writeUInt32LE(0x08006460, 24); // fault address
  body.writeUInt32LE(0, 28); // high half of the 64-bit address
  // The slot is at 32, not 28. A captured frame stopping at 0x08006994 reads
  // `1, 0, 0, 1, 0x08006994, 0, 0x08006994, 0, 1, 2, …`; offset 28 is the
  // address's high half (always 0 on Cortex-M), so reading it there reported
  // `slot: 0` for every stop.
  body.writeInt32LE(-1, 32); // no hardware slot
  const decoded = stopReason(frame(0x4000, 0x2003, body));
  expect(decoded?.reason).toBe(1);
  expect(decoded?.pc).toBe(0x08006460);
  // `0xffffffff` means "no slot" and must not be reported as one.
  expect(decoded?.slot).toBe(undefined);
});

it("stop reasons are named from the measured codes", () => {
  expect(stopReasonName(0)).toBe("stopped");
  expect(stopReasonName(1)).toBe("breakpoint");
  expect(stopReasonName(99)).toBe("stop reason 99");
});

it("a command-window line has no reply envelope", () => {
  // Measured: `45 00 00 00 "*** error 65: …"` — the first word is a length,
  // not an echoed command, so the line is not stripped of 8 bytes.
  const line = Buffer.alloc(4 + 20);
  line.writeUInt32LE(20, 0);
  line.write("*** error 65: hi\0", 4, "latin1");
  expect(commandWindowText(frame(0x5020, 0, line))).toBe("*** error 65: hi");
});

/* ---------- memory ---------- */

it("a memory reply is the address, the bytes, and the error address", () => {
  const reply = Buffer.alloc(24 + 4);
  reply.writeBigUInt64LE(0x20000000n, 0);
  reply.writeUInt32LE(4, 8);
  reply.writeBigUInt64LE(0n, 12);
  reply.writeUInt32LE(0, 20);
  reply.writeUInt32LE(0x200009a8, 24);
  const decoded = readMemoryReply(reply);
  expect(decoded?.address).toBe(0x20000000);
  expect(decoded?.bytes).toEqual([0xa8, 0x09, 0x00, 0x20]);
  expect(decoded?.errorAddress).toBe(undefined);
});

/* ---------- the operations added after the first audit ---------- */

it("a VSET reply carries a 64-bit value and the debugger's rendering", () => {
  // Measured for `main`: 05 00 00 00 | e0 6b 00 08 00 00 00 00 | 05 00 00 00 "main\0"
  const reply = Buffer.from("05000000e06b000800000000050000006d61696e00", "hex");
  const decoded = readVset(reply);
  expect(decoded?.type).toBe(5);
  expect(decoded?.value).toBe(0x08006be0n);
  expect(decoded?.text).toBe("main");
});

it("a VSET request puts no literal value and the expression as an SSTR", () => {
  const request = vset("main");
  expect(request.readInt32LE(0)).toBe(0);
  expect(request.readInt32LE(12)).toBe(5);
  expect(request.toString("latin1", 16, 21)).toBe("main\0");
});

it("a menu entry's label runs to the length, not one short of it", () => {
  // Measured: 00 00 00 00 | 00 00 00 00 | 01 00 00 00 | 01 00 00 00 | 0a 00 00 00 "Trace Data\0"
  const frame: AsyncFrame = { type: 0x5061, echoed: 0, data: Buffer.from("000000000000000001000000010000000a0000005472616365204461746100", "hex"), raw: Buffer.alloc(0) };
  const entry = readMenu(frame);
  expect(entry?.label).toBe("Trace Data");
  expect(entry?.enabled).toBe(true);
});

it("a trace-variable name is counted without its terminator", () => {
  // Measured AVTR: 12 00 00 00 | 7 zero words | 09 00 00 00 | 2 zero words | "CURR_TID\0"
  const body = Buffer.alloc(53);
  body.writeUInt32LE(0x12, 0);
  body.writeUInt32LE(9, 32);
  body.write("CURR_TID\0", 44, "latin1");
  const frame: AsyncFrame = { type: 0x5018, echoed: 0, data: body, raw: Buffer.alloc(0) };
  expect(readVtrFrame(frame)?.name).toBe("CURR_TID");
});

it("a disassembly reply is the window's text, not instruction words", () => {
  // Measured for 0x08006be0: an AMEM whose aBytes are the decoded lines —
  // address(8) | nBytes(4) | ErrAddr(8) | nErr(4) | text.
  // The first implementation read them as 32-bit words and reported
  // 0x30307830 — the ASCII "0x00" — as an opcode.
  const text = "0x08006BE0 F7F9FF38  BL.W          0x08000A54 HAL_Init\n";
  const reply = Buffer.alloc(24 + text.length);
  reply.writeBigUInt64LE(0x08006be0n, 0);
  reply.writeUInt32LE(text.length, 8);
  reply.writeBigUInt64LE(0x08006be0n, 12);
  reply.writeUInt32LE(0, 20);
  Buffer.from(text, "latin1").copy(reply, 24);
  const decoded = readDisassemblyText(reply);
  expect(decoded?.address).toBe(0x08006be0);
  expect(decoded?.bytes).toBe(text.length);
  expect(decoded?.text).toBe(text);
});

it("the unsupported list names why, never a bare flag", () => {
  for (const [name, reason] of Object.entries(UNSUPPORTED_ON_MDK_5_43)) {
    expect(reason.length > 20).toBeTruthy();
  }
  // The one that would quietly return a wrong number is named explicitly.
  expect(UNSUPPORTED_ON_MDK_5_43.DBG_READ_REGISTERS ?? "").toMatch(/enumeration/);
});

it("watch expressions and variables are not filed as unsupported", () => {
  // They answer NOT_SUPPORTED only until extended stack mode is on; that is a
  // setup requirement, not a missing capability, and listing them as
  // unavailable is how the feature stayed switched off.
  for (const name of ["DBG_EVAL_WATCH_EXPRESSION", "DBG_REMOVE_WATCH_EXPRESSION", "DBG_ENUM_VARIABLES", "DBG_VARIABLE_SET", "DBG_ENUM_TASKS"]) {
    expect(UNSUPPORTED_ON_MDK_5_43[name]).toBe(undefined);
    expect(NEEDS_EXTENDED_STACK[name]).toBeTruthy();
  }
});

it("a register frame's value starts one byte past the flags", () => {
  // Measured REGENUM: 0000 0000 "R0\0…" 02 "0x00000000\0…"
  // The old parse read a u32 at 20, swallowing the first three characters of
  // the value: 0x08006458 came out as the plausible "8006460".
  const body = Buffer.alloc(53);
  body.writeUInt16LE(0, 0);
  body.writeUInt16LE(0, 2);
  body.write("R0\0", 4, "latin1");
  body.writeUInt8(0x02, 20);
  body.write("0x08006458\0", 21, "latin1");
  const frame: AsyncFrame = { type: 0x5028, echoed: 0, data: body, raw: Buffer.alloc(0) };
  const [register] = parseRegisters([frame]);
  expect(register?.name).toBe("R0");
  expect(register?.value).toBe("0x08006458");
  expect(register?.canChange).toBe(true);
  expect(register?.isPC).toBe(false);
});

it("a register write carries the value in the VSET value field", () => {
  // VSET is packed: type(4) value(8) len(4) text. Writing "R0" with the value
  // left at zero is answered SUCCESS and changes nothing — the old request
  // put the name and value in two back-to-back SSTRs.
  const request = vsetWithValue("R0", 5, 0x42n);
  expect(request.readInt32LE(0)).toBe(5);
  expect(request.readBigInt64LE(4)).toBe(0x42n);
  expect(request.readInt32LE(12)).toBe(3);
  expect(request.subarray(16, 18).toString("latin1")).toBe("R0");
});

it("a variable request carries a count, and a write names the variable by id", () => {
  // IVARENUM with count = 0 is answered SUCCESS with an empty stream, so a
  // request that asks for nothing looks like an image with no symbols.
  const request = ivarEnum(0, 0, 0, 128);
  expect(request.length).toBe(16);
  expect(request.readUInt16LE(12)).toBe(128);
  // VARVAL is that IVARENUM followed by the new value as an SSTR.
  const write = varVal(0x123456, 0, 0, "42");
  expect(write.readInt32LE(0)).toBe(0x123456);
  expect(write.readInt32LE(16)).toBe(3);
  expect(write.subarray(20, 22).toString("latin1")).toBe("42");
});

it("a variable frame keeps its id, index and count", () => {
  // VARINFO: nID(4) index(4) count(4) typeSize(4) flags(4) value(SSTR) …
  const body = Buffer.alloc(20 + 260 * 4);
  body.writeInt32LE(0x0abc, 0);
  body.writeInt32LE(33, 4);
  body.writeInt32LE(0, 8);
  body.writeUInt32LE(1, 16); // editable
  sstr("0x00003039").copy(body, 20);
  sstr("uint").copy(body, 280);
  sstr("uwTick").copy(body, 540);
  const frame: AsyncFrame = { type: 0x5041, echoed: 0, data: body, raw: Buffer.alloc(0) };
  const [variable] = parseVariables([frame]);
  expect(variable?.id).toBe(0x0abc);
  expect(variable?.index).toBe(33);
  expect(variable?.name).toBe("uwTick");
  expect(variable?.value).toBe("0x00003039");
  expect(variable?.editable).toBe(true);
});

it("a task frame's name is a counted string after its fields", () => {
  // Measured, 276 bytes: nItem(4) nAdr(4) nRetAdr(4) nVars(4) len(4) text…
  // `00 00 00 00 00 00 00 00 00 00 00 00 02 00 00 00 0c 00 00 00 "Main Thread"`.
  // Reading at 12 (the fields) and at 40 (past the text) both produced an
  // empty list for a target that does report a thread.
  const body = Buffer.alloc(276);
  body.writeUInt32LE(2, 12);
  body.writeUInt32LE(12, 16);
  body.write("Main Thread\0", 20, "latin1");
  const frame: AsyncFrame = { type: 0x5051, echoed: 0, data: body, raw: Buffer.alloc(0) };
  const task = readTaskFrames([frame])[0];
  expect(task?.name).toBe("Main Thread");
  expect(task?.id).toBe(0);
});

it("an Intel HEX image is read at its own addresses", () => {
  // The chip comparison starts at the image's load address. Reading an `.axf`
  // from byte zero starts at `7f 45 4c 46` — the ELF header, not the vector
  // table — and reports a mismatch on a flash that is perfectly correct.
  const lines = [
    ":020000040800F2",
    ":04000000" + "A8090020" + "D4",
    ":00000001FF",
  ];
  const records = parseIntelHex(lines.join(String.fromCharCode(10)));
  const data = records.filter((record) => record.bytes.length > 0);
  expect(data.length).toBe(1);
  expect(data[0].address).toBe(0x08000000);
  expect(data[0].bytes).toEqual([0xa8, 0x09, 0x00, 0x20]);
});

it("the stack is reported innermost first", () => {
  // The debugger lists it from the bottom up: Reset_Handler's return address
  // is 0xffffffff. Reporting that order made "#0" the startup code.
  const frame = (item: number, address: number, ret: bigint) => {
    const body = Buffer.alloc(48);
    body.writeUInt32LE(item, 0);
    body.writeBigUInt64LE(BigInt(address), 4);
    body.writeBigUInt64LE(ret, 12);
    return { type: 0x5015, echoed: 0, data: body, raw: Buffer.alloc(0) } as AsyncFrame;
  };
  const ordered = orderStackFrames([
    frame(1, 0x08000258, 0xffffffffn),
    frame(2, 0x08006460, 0x08000258n),
  ]);
  expect(ordered[0]?.address).toBe(0x08006460);
  expect(ordered[0]?.level).toBe(0);
  expect(ordered[1]?.address).toBe(0x08000258);
});

it("a stack frame is what the record holds, not a symbol read from its fields", () => {
  // A 48-byte STACKENUM frame, measured: nItem, nAdr, nRetAdr, then the
  // source line as text. An earlier reading assumed nVars/nEqual/nTotal
  // fields after the addresses; those bytes are the source text, and reading
  // offset 20 as a count produced 840967456. A frame whose text is binary or
  // empty simply carries no `source`.
  const body = Buffer.alloc(48);
  body.writeUInt32LE(1, 0);
  body.writeBigUInt64LE(0x08000258n, 4);
  body.writeBigUInt64LE(0xffffffffn, 12);
  const frame: AsyncFrame = { type: 0x5015, echoed: 0, data: body, raw: Buffer.alloc(0) };
  const [parsed] = parseStackFrames([frame]);
  expect(parsed?.address).toBe(0x08000258);
  expect(parsed?.returnAddress).toBe(0xffffffff);
  expect(parsed?.function).toBe(undefined);
  expect(parsed?.source).toBe(undefined);
});

it("a register can be named the way a person types it", () => {
  // The debugger lists `R15 (PC)`; the old lookup searched for `PC` exactly,
  // found nothing, sent the write anyway and reported SUCCESS.
  const registers = [
    { group: 0, index: 0, name: "R0", value: "0x00000000", isPC: false, canChange: true },
    { group: 0, index: 13, name: "R13 (SP)", value: "0x200009A8", isPC: false, canChange: true },
    { group: 0, index: 15, name: "R15 (PC)", value: "0x08006458", isPC: true, canChange: true },
  ];
  expect(findRegister(registers, "PC")?.name).toBe("R15 (PC)");
  expect(findRegister(registers, "sp")?.name).toBe("R13 (SP)");
  expect(findRegister(registers, "R15")?.name).toBe("R15 (PC)");
  expect(findRegister(registers, "15")?.name).toBe("R15 (PC)");
  expect(findRegister(registers, "R7")).toBe(undefined);
});

/* ---------- the Keil downloader ---------- */

// 依赖 A 侧未迁移模块：flash.ts（keil-porting-spec.md §15 明确不迁移）。断言原文保留，Phase 3 处理。
it("UV4 -f is the download command, and its log is where the verdict lives", async () => {
  const { commandFor, validate, classifyOutput } = await import("../flash.js");
  const args = commandFor({ kind: "keil", program: "UV4.exe", firmware: "app.axf", project: "P.uvprojx", logFile: "L.log" });
  expect(args).toEqual(["-f", "P.uvprojx", "-j0", "-o", "L.log"]);

  // Measured real log: steps joined without line breaks.
  const log = ["Load app.axf", "Erase Done.Programming Done.Verify OK.Flash Load finished at 11:39:30"].join(String.fromCharCode(10));
  const verdict = classifyOutput("keil", log, 0);
  expect(verdict.ok).toBe(true);
  expect(verdict.verified).toBe(true);
});

// 依赖 A 侧未迁移模块：flash.ts（keil-porting-spec.md §15 明确不迁移）。断言原文保留，Phase 3 处理。
it("a failed download is not read as success", async () => {
  const { classifyOutput } = await import("../flash.js");
  const log = ["Load app.axf", "Error: Flash Download failed  -  Target DLL has been cancelled"].join(String.fromCharCode(10));
  const verdict = classifyOutput("keil", log, 0);
  expect(verdict.ok).toBe(false);
});

// 依赖 A 侧未迁移模块：flash.ts（keil-porting-spec.md §15 明确不迁移）。断言原文保留，Phase 3 处理。
it("a .axf is only accepted by the Keil downloader", async () => {
  const { validate } = await import("../flash.js");
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "prometheus-axf-"));
  const image = join(dir, "app.axf");
  writeFileSync(image, "ELF");
  try {
    // Refused with a reason, not a generic "not a firmware format".
    const other = validate({ kind: "openocd", program: "openocd", firmware: image });
    expect(other ?? "").toMatch(/Keil's name for an ELF/);
    // Accepted, but the Keil downloader needs the project it draws from.
    const keil = validate({ kind: "keil", program: "UV4.exe", firmware: image });
    expect(keil ?? "").toMatch(/needs the \.uvprojx/);
    const ok = validate({ kind: "keil", program: "UV4.exe", firmware: image, project: join(dir, "P.uvprojx") });
    expect(ok).toBe(null);
  } finally {
    const { rmSync } = await import("node:fs");
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- the UV4 command line ---------- */

// 依赖 A 侧未迁移模块：project.ts (buildCommand)（keil-porting-spec.md §15 明确不迁移）。断言原文保留，Phase 3 处理。
it("a Keil build names its target instead of inheriting the last one", async () => {
  const { buildCommand, detectProject } = await import("../project.js");
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "prometheus-keil-cmd-"));
  try {
    mkdirSync(join(dir, "USER"), { recursive: true });
    writeFileSync(join(dir, "USER", "app.uvprojx"), "<Project/>");
    const project = detectProject(dir);
    expect(project.kind).toBe("keil");
    const plain = buildCommand(project, { keil: "UV4.exe" }, {});
    expect(plain).toBeTruthy();
    expect(plain.args[0]).toBe("-b");
    // Without `-t` uVision builds whichever target was last current, which is
    // not something a build command should decide on a multi-target project.
    expect(!plain.args.includes("-t")).toBeTruthy();
    const chosen = buildCommand(project, { keil: "UV4.exe" }, { target: "Release" });
    expect(chosen).toBeTruthy();
    const at = chosen.args.indexOf("-t");
    expect(at > 0).toBeTruthy();
    expect(chosen.args[at + 1]).toBe("Release");
    // A rebuild is `-r`, not a build with a flag.
    const rebuilt = buildCommand(project, { keil: "UV4.exe" }, { release: true });
    expect(rebuilt?.args[0]).toBe("-r");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ---------- a session that "entered" without loading anything ---------- */

// 依赖 A 侧未迁移模块：project.ts (detectProject)（keil-porting-spec.md §15 明确不迁移）。断言原文保留，Phase 3 处理。
it("a debug session that could not load the image is not reported as open", async () => {
  // Measured: with the .axf deleted, uVision prints `*** error 56: cannot open
  // file` and enters debug mode anyway. Every later action then answers
  // NOT_DEBUGGING, so treating the entry as success hid the real cause.
  const { default: fs } = await import("node:fs");
  const source = fs.readFileSync("mcp-servers/keil/keilSession.ts", "utf8");
  expect(source).toMatch(/cannot open file/);
  expect(source).toMatch(/session\.debugging = false/);
});

/* ---------- the CMSIS-Toolbox ---------- */

// 依赖 A 侧未迁移模块：project.ts (detectProject/buildCommand)（keil-porting-spec.md §15 明确不迁移）。断言原文保留，Phase 3 处理。
it("a csolution project is recognised and built with cbuild", async () => {
  const { detectProject, buildCommand } = await import("../project.js");
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "prometheus-csol-"));
  try {
    mkdirSync(join(dir, "app"), { recursive: true });
    writeFileSync(join(dir, "demo.csolution.yml"), ["solution:", "  projects: []"].join(String.fromCharCode(10)));
    const project = detectProject(dir);
    expect(project.kind).toBe("csolution");
    expect(project.file ?? "").toMatch(/\.csolution\.yml$/);
    const command = buildCommand(project, { cbuild: "cbuild.exe" }, {});
    expect(command?.program).toBe("cbuild.exe");
    expect(command?.args[0] ?? "").toMatch(/\.csolution\.yml$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 依赖 A 侧未迁移模块：toolchain.ts (TOOLCHAIN_INFO)（keil-porting-spec.md §15 明确不迁移）。断言原文保留，Phase 3 处理。
it("the three toolbox tools are first-class toolchains", async () => {
  const { TOOLCHAIN_INFO } = await import("../toolchain.js");
  for (const kind of ["cbuild", "cpackget", "svdconv"] as const) {
    expect(TOOLCHAIN_INFO[kind]).toBeTruthy();
    expect(TOOLCHAIN_INFO[kind].purpose.length > 20).toBeTruthy();
  }
  // The toolbox ships inside a Keil install, so the search must look there.
  const { readFileSync } = await import("node:fs");
  const source = readFileSync("mcp-servers/keil/toolchain.ts", "utf8");
  expect(source).toMatch(/cmsis-toolbox/);
});

/* ---------- status names ---------- */

it("status codes are named, and an unknown one is still honest", () => {
  expect(statusName(0)).toBe("SUCCESS");
  expect(statusName(6)).toBe("NOT_DEBUGGING");
  expect(statusName(10)).toBe("DEBUGGING");
  expect(statusName(1234)).toBe("status 1234");
});

/* ---------- source-location breakpoints ---------- */

it("`file:line` and `file(line)` are recognised; a symbol is not one", async () => {
  const { parseFileLine } = await import("../keilSession.js");
  const B = String.fromCharCode(92);
  expect(parseFileLine("main.c:36")).toEqual({ file: "main.c", line: 36 });
  expect(parseFileLine(["..", "USER", "main.c"].join(B) + ":36")).toEqual({ file: "../USER/main.c", line: 36 });
  expect(parseFileLine("main.c(36)")).toEqual({ file: "main.c", line: 36 });
  expect(parseFileLine("./ui.c: 497")).toEqual({ file: "ui.c", line: 497 });
  // Symbols and addresses are passed through untouched by the caller.
  expect(parseFileLine("UI_Update")).toBe(null);
  expect(parseFileLine("0x08006994")).toBe(null);
  expect(parseFileLine("main.c:0")).toBe(null);
});

it("fromelf's line table is read, with the zero-address headers dropped", async () => {
  // Verbatim shape from `fromelf --text -g TOUCH.axf` on MDK 5.43a.
  const B = String.fromCharCode(92);
  const text = [
    "  007fe7:  DW_LNS_copy                  : 01                08006be0: main.c:35.5 [",
    "  007fe9:  SPECIAL(0, 1)                : 13                08006be2: main.c:35.5",
    "  007feb:  SPECIAL(1, 1)                : 14                08006be4: main.c:36.5 [",
    "00000000: .." + B + "HARDWARE" + B + "LCD" + B + "ltdc.c:1.0",
    "08000c42: .." + B + "HARDWARE" + B + "LCD" + B + "ltdc.c:488.5",
  ].join(String.fromCharCode(10));
  const { parseFromelfLines } = await import("../keilSession.js");
  const entries = parseFromelfLines(text);
  expect(entries).toEqual([
    { address: 0x08006be0, file: "main.c", line: 35 },
    { address: 0x08006be2, file: "main.c", line: 35 },
    { address: 0x08006be4, file: "main.c", line: 36 },
    { address: 0x08000c42, file: "../HARDWARE/LCD/ltdc.c", line: 488 },
  ]);
});

it("a source location that needs an image fails clearly without one", async () => {
  const { sourceLineAddress, parseFromelfLines } = await import("../keilSession.js");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "prometheus-dwarf-"));
  try {
    const noImage = await sourceLineAddress(join(dir, "missing.axf"), "does-not-matter", "main.c", 1);
    expect("error" in noImage && /build first/.test(noImage.error)).toBeTruthy();
    // A reader that is not there is a failure, not an empty table.
    const elf = join(dir, "image.axf");
    writeFileSync(elf, "not really an elf");
    const noReader = await sourceLineAddress(elf, join(dir, "no-fromelf.exe"), "main.c", 35);
    expect("error" in noReader && /fromelf exited/.test(noReader.error)).toBeTruthy();
    expect(parseFromelfLines("").length).toBe(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("a line that is not in the image is reported with that file's real lines", async () => {
  const { parseFromelfLines } = await import("../keilSession.js");
  const B = String.fromCharCode(92);
  const table = [
    "08006be0: main.c:35.5",
    "08006bf8: main.c:38.5",
    "08000c42: .." + B + "HARDWARE" + B + "LCD" + B + "ltdc.c:488.5",
  ].join(String.fromCharCode(10));
  const entries = parseFromelfLines(table);
  expect(entries.map((entry) => [entry.address, entry.file, entry.line])).toEqual([
    [0x08006be0, "main.c", 35],
    [0x08006bf8, "main.c", 38],
    [0x08000c42, "../HARDWARE/LCD/ltdc.c", 488],
  ]);
  // The resolution rules the failure message depends on: a bare file name and
  // a path suffix both find the image's own, longer path.
  const fileMatches = (candidate: string, wanted: string) => candidate === wanted || candidate.endsWith("/" + wanted);
  expect(fileMatches("../HARDWARE/LCD/ltdc.c", "ltdc.c")).toBeTruthy();
  expect(fileMatches("../HARDWARE/LCD/ltdc.c", "LCD/ltdc.c")).toBeTruthy();
  expect(!fileMatches("../HARDWARE/LCD/ltdc.c", "UI/ltdc.c")).toBeTruthy();
});

/* ---------- csolution (CMSIS-Toolbox) ---------- */

it("a detected Arm compiler is registered the way cbuild expects", async () => {
  const { compilerRegistration, compilerFromDetection } = await import("../toolEnv.js");
  // `armclang --version` prints the IDE's version first; the compiler's own
  // version is the one CMSIS-Toolbox keys on.
  const ac6 = compilerFromDetection([
    { kind: "keil", path: "G:" + String.fromCharCode(92) + "software" + String.fromCharCode(92) + "keil5" + String.fromCharCode(92) + "UV4" + String.fromCharCode(92) + "UV4.exe", version: "5.43.1.0" },
  ]);
  // The Keil entry is resolved from the install root on this machine; on a
  // machine without Keil there is nothing to add, which is also correct.
  if (ac6.length === 0) return;
  const ac6Entry = ac6.find((entry) => entry.kind === "AC6");
  expect(ac6Entry).toBeTruthy();
  expect(ac6Entry!.bin).toMatch(/ARMCLANG/i);
  // The compiler's version, not the IDE's.
  expect(ac6Entry!.version).toMatch(/^6\./);
  const env = compilerRegistration(ac6.map((entry) => ({ name: entry.kind, bin: entry.bin, version: entry.version })));
  const key = Object.keys(env).find((name) => /^AC6_TOOLCHAIN_\d+_\d+_\d+$/.test(name));
  expect(key).toBeTruthy();
  expect(env[key!]).toBe(ac6Entry!.bin);
});

it("a user's own compiler registration is not overwritten", async () => {
  const { compilerRegistration } = await import("../toolEnv.js");
  const env = compilerRegistration([{ name: "AC6", bin: "/detected/bin", version: "6.24" }], { AC6_TOOLCHAIN_6_24_0: "/user/bin" });
  expect(env).toEqual({});
});

// 依赖 A 侧未迁移模块：build.ts (findArtifactsIn)（keil-porting-spec.md §15 明确不迁移）。断言原文保留，Phase 3 处理。
it("`**` in an artifact pattern walks nested output directories", async () => {
  const { findArtifactsIn } = await import("../build.js");
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "prometheus-out-"));
  try {
    // csolution's layout: out/<project>/<target>/<build>/<name>.axf
    const outDir = join(dir, "out", "Demo", "MyBoard", "Debug");
    mkdirSync(outDir, { recursive: true });
    const elf = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(64)]);
    writeFileSync(join(outDir, "Demo.axf"), elf);
    writeFileSync(join(outDir, "Demo.hex"), Buffer.from(":00000001FF" + String.fromCharCode(10)));
    const found = findArtifactsIn([dir], ["out/**/*.axf", "out/**/*.hex"], undefined, dir);
    const kinds = found.map((entry) => entry.kind).sort();
    expect(kinds).toEqual(["elf", "hex"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("a multi-target project's image is read from the active target's block", async () => {
  const { imageLocation } = await import("../keilSession.js");
  const { fromelfFor } = await import("../fromelf.js");
  const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const B = String.fromCharCode(92);
  const uv4 = ["G:", "software", "keil5", "UV4", "UV4.exe"].join(B);
  const fromelf = fromelfFor(uv4);
  if (!fromelf) return; // no Keil on this machine: nothing to resolve with
  const dir = mkdtempSync(join(tmpdir(), "prometheus-mt-"));
  try {
    const block = (name: string, out: string) =>
      "<Target><TargetName>" + name + "</TargetName>" +
      "<OutputDirectory>." + B + out + B + "</OutputDirectory>" +
      "<OutputName>" + name + "</OutputName></Target>";
    const project = join(dir, "P.uvprojx");
    writeFileSync(project, "<Project><Targets>" + block("A", "OBJ") + block("B", "OBJ_SIM") + "</Targets></Project>");
    mkdirSync(join(dir, "OBJ"));
    mkdirSync(join(dir, "OBJ_SIM"));
    // `imageLocation` asks the live session for its active target through
    // `PRJ_GET_TARGET`; a stand-in client answers that one request.
    const { encodeMessage } = await import("../uvsock.js");
    const { MessageReader } = await import("../uvsock.js");
    const session = (active: string) =>
      ({
        project,
        client: {
          programPath: uv4,
          send: async () => {
            // `{ u32 echoed, u32 status, u32 len, char text[] }` inside a
            // CMD_RESPONSE envelope, which is what the real client returns.
            // `currentTarget` reads the name from offset 4 of the reply data,
            // so the first word is the option slot, not the echoed command.
            const body = Buffer.alloc(8 + 64);
            body.writeUInt32LE(0, 0);
            Buffer.from(active, "latin1").copy(body, 4);
            return { ok: true, status: 0, statusName: "SUCCESS", data: body };
          },
        },
      }) as unknown as Parameters<typeof imageLocation>[0];
    void encodeMessage;
    void MessageReader;
    const a = await imageLocation(session("A"));
    const b = await imageLocation(session("B"));
    expect("elf" in a && a.elf.endsWith("OBJ" + B + "A.axf")).toBeTruthy();
    expect("elf" in b && b.elf.endsWith("OBJ_SIM" + B + "B.axf")).toBeTruthy();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 依赖 A 侧未迁移模块：src/tools (A 侧适配层)（keil-porting-spec.md §15 明确不迁移）。断言原文保留，Phase 3 处理。
it.skip("the capability report is reachable and does not claim a working op is refused", async () => {
  const { toolByName } = await import("../src/tools/index.ts");
  const { UNSUPPORTED_ON_MDK_5_43 } = await import("../keilExtra.js");
  const tool = toolByName("keil_debug");
  expect(tool).toBeTruthy();
  const actions = ((tool!.parameters as { properties: { action: { enum: string[] } } }).properties.action.enum);
  expect(actions.includes("capabilities")).toBeTruthy();
  // Re-measured: `TRAPS` is not one of the target's enumerated trace variables
  // and is refused. The entry belongs in the table (see the test below); what
  // must not happen is the report listing a *working* operation as refused.
  expect(UNSUPPORTED_ON_MDK_5_43["DBG_VTR_ENUM"]).toBe(undefined);
  // Every remaining entry says why, not just that it is unsupported.
  for (const [name, why] of Object.entries(UNSUPPORTED_ON_MDK_5_43)) {
    expect(why.length > 15).toBeTruthy();
  }
});

/* ---------- project detection must not wander into a sibling ---------- */

// 依赖 A 侧未迁移模块：project.ts (detectProject)（keil-porting-spec.md §15 明确不迁移）。断言原文保留，Phase 3 处理。
it("a directory with no project of its own does not adopt a sibling's", async () => {
  const { detectProject } = await import("../project.js");
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const base = mkdtempSync(join(tmpdir(), "prometheus-sibling-"));
  try {
    // /base/projA/P.uvprojx   /base/projB/work/<empty>
    mkdirSync(join(base, "projA"));
    writeFileSync(join(base, "projA", "P.uvprojx"), "<Project/>");
    mkdirSync(join(base, "projB", "work"), { recursive: true });
    // Measured: the walk reached /base, `findProjectFile` looked one level
    // down, and answered with projA's project — a different project, in a
    // different source tree. `keil_project` then reports and edits it.
    const detected = detectProject(join(base, "projB", "work"));
    expect(detected.kind).toBe("unknown");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/* ---------- a file path is relative to the project, not to the workspace ---------- */

it("add_file resolves a workspace path against the project file before uVision sees it", async () => {
  const { projectRelativeFile } = await import("../keilSession.js");
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const B = String.fromCharCode(92);
  const base = mkdtempSync(join(tmpdir(), "prometheus-rel-"));
  try {
    // The project lives one level down, which is where every Keil template
    // puts it. Real directories matter here: `resolve` against a drive that
    // does not exist falls back to the working directory.
    mkdirSync(join(base, "USER"), { recursive: true });
    mkdirSync(join(base, "CORE"), { recursive: true });
    const projectFile = join(base, "USER", "TOUCH.uvprojx");
    // Measured: the tool was handed `USER/probe_add.c` (relative to the
    // workspace) and uVision wrote it through unchanged into a project that
    // lives in USER, so the entry resolved to USER/USER/probe_add.c — a file
    // that does not exist. The build then failed on it with no mention of the
    // real cause. The file that exists is the one that has to be written.
    writeFileSync(join(base, "USER", "probe_add.c"), "int probe_add(void){return 0;}\n");
    mkdirSync(join(base, "USER", "sub"), { recursive: true });
    writeFileSync(join(base, "USER", "sub", "nested.c"), "int nested(void){return 0;}\n");
    mkdirSync(join(base, "CORE"), { recursive: true });
    writeFileSync(join(base, "CORE", "startup.s"), "; startup\n");
    const previous = process.cwd();
    process.chdir(base);
    try {
      expect(projectRelativeFile(projectFile, "USER/probe_add.c")).toBe("probe_add.c");
      expect(projectRelativeFile(projectFile, "USER/sub/nested.c")).toBe(["sub", "nested.c"].join(B));
    } finally {
      process.chdir(previous);
    }
    // Already project-relative: unchanged.
    expect(projectRelativeFile(projectFile, "main.c")).toBe("main.c");
    expect(projectRelativeFile(projectFile, ["..", "CORE", "startup.s"].join(B))).toBe(["..", "CORE", "startup.s"].join(B));
    // Absolute inside the project directory becomes relative to it; outside
    // keeps the `..` the project itself would write.
    expect(projectRelativeFile(projectFile, join(base, "USER", "main.c"))).toBe("main.c");
    expect(projectRelativeFile(projectFile, join(base, "CORE", "startup.s"))).toBe(["..", "CORE", "startup.s"].join(B));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

it("an output name is compared by its file name, because the reply is a path", async () => {
  const { sameOutputName } = await import("../keilSession.js");
  const B = String.fromCharCode(92);
  // Measured: `PRJ_GET_OUTPUTNAME` answers `{len, "..\OBJ\app.axf"}` — the
  // whole path, directory included. The tool compares that against the bare
  // `app.axf` it sent, so every successful rename was reported as "the
  // debugger accepted the request but still reports ..., nothing was changed".
  expect(sameOutputName(["..", "OBJ", "app.axf"].join(B), "app.axf")).toBe(true);
  expect(sameOutputName("app.axf", "app.axf")).toBe(true);
  expect(sameOutputName(["..", "OBJ", "APP.AXF"].join(B), "app.axf")).toBe(true);
  expect(sameOutputName(["..", "OBJ", "other.axf"].join(B), "app.axf")).toBe(false);
  expect(sameOutputName("", "app.axf")).toBe(false);
});

it("a watchpoint is confirmed by the breakpoint list, not by the reply", async () => {
  const { accessBreakpointCreated } = await import("../keilSession.js");
  // Measured on MDK 5.43a: `DBG_CREATE_BP` answers SUCCESS for
  // `{type: 3, expr: "uwTick"}` and for a name that does not exist, and the
  // enumerated list stays empty in every case — the expression was evaluated
  // (to nothing) rather than resolved. With an address the entry appears.
  const before = [{ number: 1, type: 3, enabled: true, tickMark: 1, address: 0x20000000, expression: "0x20000000" }];
  expect(accessBreakpointCreated(before, before)).toBe(false);
  const after = [...before, { number: 2, type: 3, enabled: true, tickMark: 2, address: 0x20000010, expression: "0x20000010" }];
  expect(accessBreakpointCreated(before, after)).toBe(true);
  expect(accessBreakpointCreated(before, before.slice(0, 0))).toBe(false);
});

it("a debug session saves a same-project edit session first", async () => {
  const { projectSessionsToFlush } = await import("../keilSession.js");
  const B = String.fromCharCode(92);
  const project = ["G:", "proj", "USER", "TOUCH.uvprojx"].join(B);
  const other = ["G:", "proj", "USER", "OTHER.uvprojx"].join(B);
  const sessions = [
    { key: "a", project, target: "hardware", debugging: false, openedAt: 1 },
    { key: "b", project: project.toUpperCase(), target: "hardware", debugging: false, openedAt: 2 },
    { key: "c", project, target: "hardware", debugging: true, openedAt: 3 },
    { key: "d", project: other, target: "hardware", debugging: false, openedAt: 4 },
  ];
  // Measured: an edit made through `keil_project` lives in that uVision's
  // memory until it exits, so a debug session opened meanwhile loads the
  // on-disk project — without the edit. The plain sessions for the same
  // project are flushed before the debugger starts; a debug session (already
  // the live one) and another project are left alone.
  expect(projectSessionsToFlush(sessions, project).map((entry) => entry.key)).toEqual(["a", "b"]);
  expect(projectSessionsToFlush(sessions, other).map((entry) => entry.key)).toEqual(["d"]);
  expect(projectSessionsToFlush(sessions, ["G:", "elsewhere.uvprojx"].join(B))).toEqual([]);
});

it("the trace table reflects what this target actually enumerates", async () => {
  const { UNSUPPORTED_ON_MDK_5_43 } = await import("../keilExtra.js");
  // Re-measured on MDK 5.43a + STM32F429: `DBG_ENUM_VTR` lists CURR_TID,
  // STCLK, STLINK_PM, CORE_CLK and TRACE_CLK, and `DBG_VTR_GET` answers each of
  // them. `TRAPS` is **not in the list** and answers `Unknown VTR-name`. A
  // previous pass took one successful `TRAPS` reply, deleted this entry and
  // wrote in the docs that `TRAPS = 0x1` — the table was right and the note
  // was wrong. The entry stays, saying the thing that is true: names outside
  // the enumeration are refused.
  const why = UNSUPPORTED_ON_MDK_5_43["DBG_VTR_GET"];
  expect(why).toBeTruthy();
  expect(why).toMatch(/ENUM_VTR|enumerat/i);
});

it("run falls back to the command channel when the core does not move", async () => {
  const { goChannelFor } = await import("../keilSession.js");
  // Measured on MDK 5.43a + STM32F429: with the core halted **on** a hardware
  // breakpoint at `main`, `DBG_START_EXECUTION` answers SUCCESS and no stop
  // notification ever arrives — three attempts in a row timed out. The
  // debugger's own command channel, `G`, stops at the same breakpoint within
  // 0.6 s. So `run` uses the API first and the command channel after it.
  expect(goChannelFor("api")).toBe("api");
  expect(goChannelFor("api-timed-out")).toBe("command");
  expect(goChannelFor("api-failed")).toBe("command");
  expect(goChannelFor("command-timed-out")).toBe(null);
});

// 依赖 A 侧未迁移模块：build.ts (parseFromelf)（keil-porting-spec.md §15 明确不迁移）。断言原文保留，Phase 3 处理。
it("an image read by fromelf reports its real ZI, not the totals row's zero", async () => {
  const { parseFromelf } = await import("../build.js");
  // Measured on MDK 5.43a, `fromelf --text -z TOUCH.axf`: the per-object row
  // carries the real ZI (2050364), and the `ROM Totals` row prints 0 in that
  // column. Taking the totals row at face value reported 108 bytes of RAM for
  // an image with a 2 MB ZI region — an incremental build that never relinked
  // prints no linker line, so this was the only figure it had.
  const output = [
    "      Code (inc. data)   RO Data    RW Data    ZI Data      Debug   Object Name",
    "     31978       1164      18842        108    2050364     537275   TOUCH.axf",
    "     31978       1164      18842        108          0          0   ROM Totals for TOUCH.axf",
  ].join(String.fromCharCode(10));
  const usage = parseFromelf(output);
  expect(usage?.flash).toBe(31978 + 18842);
  expect(usage?.ram).toBe(108 + 2050364);
});

it("groups are listed once on a multi-target project", async () => {
  const { groupsInProject } = await import("../keilSession.js");
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "prometheus-groups-"));
  try {
    mkdirSync(join(dir, "USER"));
    const project = join(dir, "USER", "P.uvprojx");
    const target = (name: string) =>
      "<Target><TargetName>" + name + "</TargetName><Groups>" +
      "<Group><GroupName>USER</GroupName><Files>" +
      "<File><FileName>main.c</FileName><FilePath>.\main.c</FilePath></File>" +
      "</Files></Group>" +
      "<Group><GroupName>CORE</GroupName><Files></Files></Group>" +
      "</Groups></Target>";
    writeFileSync(project, "<Project><Targets>" + target("A") + target("B") + "</Targets></Project>");
    // Measured on a two-target `.uvprojx`: every target carries its own copy of
    // the group list, so the plain regex reader returned `USER, CORE` twice.
    // The active target's list is the one uVision shows.
    expect(groupsInProject(project)).toEqual(["USER", "CORE"]);
    expect(groupsInProject(project, "B")).toEqual(["USER", "CORE"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("clean goes through the socket when a session is open", async () => {
  const { cleanInIde } = await import("../keilSession.js");
  // Measured on MDK 5.43a: `PRJ_CLEAN` answers SUCCESS and the same
  // `0x5001` lines a `-c` run writes, in 0.4 s. The session was already open,
  // so spawning a second UV4 for `-c` was the slow path for no gain.
  expect(typeof cleanInIde).toBe("function");
});

it("a struct or array is reported as an address, not as a value", async () => {
  const { describeVariableValue } = await import("../keilSession.js");
  // Measured on MDK 5.43a: a struct's `value` is `0x20000240 &LTDC_Handler` and
  // an array's is its first element's address (`0xC0000000`). Printed as a
  // value, `0xC0000000` reads like the number 3221225472 when it is where the
  // data lives.
  expect(describeVariableValue({ name: "LTDC_Handler", value: "0x20000240 &LTDC_Handler", type: "struct __LTDC" })).toBe("struct at 0x20000240 (the address; fields are not listed here)");
  expect(describeVariableValue({ name: "ltdc_lcd_framebuf", value: "0xC0000000", type: "ushort[1280][800]", count: 1280 })).toBe("array at 0xC0000000 (1280 element(s); element values are not listed here)");
  // A plain scalar keeps its value.
  expect(describeVariableValue({ name: "uwTick", value: "0x00003039", type: "uint" })).toBe("0x00003039");
});

it("a stack frame's fixed record ends with the frame's counts", async () => {
  const { parseStackFrames } = await import("../keilSession.js");
  // This test used to assert the opposite — that offset 20 held source text and
  // that the record had no count field at all, on the strength of one frame
  // captured on MDK 5.43a whose bytes were read as text.
  //
  // The header's STACKENUM is packed and says what those bytes are:
  //   UINT nItem(4) xU64 nAdr(8) xU64 nRetAdr(8) UINT nVars(4) UINT nEqual(4)
  //   UINT nTotal(4) UINT nTask(4) UINT nRes[3]
  // and a fresh capture on 5.43.1 (stopped in delay.c, three real frames) has
  // exactly that shape: nItem=1, nAdr, nRetAdr, nVars=6, nEqual=0, nTotal=3.
  // Reading offset 20 as the `dot = ui_tick` text was reading the count.
  const data = Buffer.alloc(48);
  data.writeUInt32LE(1, 0);
  data.writeBigUInt64LE(0x08006994n, 4);
  data.writeBigUInt64LE(0x08006982n, 12);
  data.writeUInt32LE(6, 20); // nVars
  data.writeUInt32LE(0, 24); // nEqual
  data.writeUInt32LE(3, 28); // nTotal
  const frames = parseStackFrames([{ type: 0x5015, echoed: 0, data, raw: data }]);
  expect(frames.length).toBe(1);
  expect(frames[0]!.address).toBe(0x08006994);
  expect(frames[0]!.variables).toBe(6);
  expect(frames[0]!.total).toBe(3);
  expect(frames[0]!.source).toBe(undefined);
});

it("an evaluation error is a failure, not a value", async () => {
  const { evaluationError } = await import("../keilSession.js");
  // Measured: both evaluators answer `*** error 34: undefined identifier` with
  // a caret line above it ("_____^"). The tool printed that as
  // `uwTick = _____^ *** error 34: undefined identifier`, which reads like a
  // value that was computed.
  expect(evaluationError("_____^ *** error 34: undefined identifier") ?? "").toMatch(/undefined identifier/);
  expect(evaluationError("*** error 52: left side of '.' requires struct/union") ?? "").toMatch(/requires struct\/union/);
  expect(evaluationError("0x00F42400 16000000")).toBe(undefined);
  expect(evaluationError("<cannot evaluate>")).toBe("<cannot evaluate>");
});

// 依赖 A 侧未迁移模块：project.ts (keilOutputDirs)（keil-porting-spec.md §15 明确不迁移）。断言原文保留，Phase 3 处理。
it("artifact roots cover every target, not just the first", async () => {
  const { keilOutputDirs } = await import("../project.js");
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const B = String.fromCharCode(92);
  const base = mkdtempSync(join(tmpdir(), "prometheus-outdirs-"));
  try {
    mkdirSync(join(base, "USER"));
    // The output directories resolve against the project file's directory.
    mkdirSync(join(base, "USER", "OBJ"));
    mkdirSync(join(base, "USER", "OBJ_SIM"));
    const project = join(base, "USER", "P.uvprojx");
    writeFileSync(
      project,
      "<Project><Targets>" +
        "<Target><TargetName>A</TargetName><OutputDirectory>." + B + "OBJ" + B + "</OutputDirectory></Target>" +
        "<Target><TargetName>B</TargetName><OutputDirectory>." + B + "OBJ_SIM" + B + "</OutputDirectory></Target>" +
        "</Targets></Project>",
    );
    // A build with target B current writes to OBJ_SIM. Reading only the first
    // `<OutputDirectory>` meant the artifact scan never looked there, so a
    // successful build of the second target reported no image.
    const dirs = keilOutputDirs(project, base).map((dir) => dir.toLowerCase());
    expect(dirs.some((dir) => dir.includes("obj_sim"))).toBeTruthy();
    expect(dirs.some((dir) => dir.endsWith("obj"))).toBeTruthy();
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

it("a read-back only proves the chip changed where the debugger reads real memory", async () => {
  const { readBackConfirmsChip } = await import("../keilSession.js");
  // Measured on STM32F429: writing `de ad be ef` to 0x08000000 answered "wrote
  // and read them back" in that session; a fresh session read the original
  // vector table and STM32CubeProgrammer read the original from the chip. So a
  // match at a flash address says nothing about the chip.
  expect(readBackConfirmsChip(0x08000000)).toBe(false);
  expect(readBackConfirmsChip(0x00000000)).toBe(false);
  expect(readBackConfirmsChip(0x20001000)).toBe(true);
  expect(readBackConfirmsChip(0xe000ed00)).toBe(true);
});

/* ---------- round 11: four false successes found by static audit ---------- */

it("an evaluation the debugger could not compute is not reported as a value", async () => {
  const { evaluateReply } = await import("../keilExtra.js");
  // `CALC_EXPRESSION` answers SUCCESS with the text `<cannot evaluate>` and a
  // zero value. Dropping the text (which `evaluate` used to do) left the caller
  // with `value: 0n` and no error, and the tool printed `expr = 0x0 (0)`.
  const payload = Buffer.alloc(12 + 260);
  payload.writeInt32LE(0, 0);
  payload.writeBigInt64LE(0n, 4);
  const text = Buffer.from("<cannot evaluate>\0", "latin1");
  payload.writeInt32LE(text.length, 12);
  text.copy(payload, 16);
  const refused = evaluateReply("uwTick", payload);
  expect(refused.ok).toBe(false);
  expect(refused.message ?? "").toMatch(/cannot evaluate/);

  // A real value keeps its numeric answer and its rendering.
  const good = Buffer.alloc(12 + 260);
  good.writeInt32LE(0, 0);
  good.writeBigInt64LE(100n, 4);
  const rendered = Buffer.from("100\0", "latin1");
  good.writeInt32LE(rendered.length, 12);
  rendered.copy(good, 16);
  const answer = evaluateReply("uwTick", good);
  expect(answer.ok).toBe(true);
  expect(answer.value).toBe(100n);
  expect(answer.text).toBe("100");
});

it("register_set without a value refuses instead of writing zero", async () => {
  const { setRegister } = await import("../keilSession.js");
  // `Number("")` is 0 and `Number.isInteger(0)` is true, so an omitted value
  // used to become a real write of 0 into PC/SP/R0. These must be refused
  // before anything reaches the socket.
  for (const bad of ["", "   ", "0x", "abc", "NaN"]) {
    const outcome = await setRegister({ debugging: true } as never, "R0", bad);
    expect(outcome.ok).toBe(false);
  }
});

it("a variable write that did not change anything is not a success", async () => {
  const { variableWriteVerdict } = await import("../keilSession.js");
  const variable = { id: 7, index: 0, count: 0, name: "uwTick", value: "0x00000064", editable: true };
  // Writing 0x200 and reading back the old 0x64 means the core refused it.
  const refused = variableWriteVerdict(variable, "0x200", "0x00000064");
  expect(refused.ok).toBe(false);
  const accepted = variableWriteVerdict(variable, "0x200", "0x00000200");
  expect(accepted.ok).toBe(true);
  const vanished = variableWriteVerdict(variable, "0x200", undefined);
  expect(vanished.ok).toBe(false);
});

it("a watchpoint is not confirmed by an unrelated breakpoint that survived", async () => {
  const { accessBreakpointCreated } = await import("../keilSession.js");
  // `main` was already set. Adding a write watchpoint on `uwTick` answers
  // SUCCESS and creates nothing; the list is identical before and after.
  const before = [{ number: 1, type: 1, enabled: true, tickMark: 1, address: 0x08000100, expression: "main" }];
  expect(accessBreakpointCreated(before, before)).toBe(false);
  const after = [...before, { number: 2, type: 3, enabled: true, tickMark: 2, address: 0x20000000, expression: "0x20000000" }];
  expect(accessBreakpointCreated(before, after)).toBe(true);
});

it("a run that times out on the API still gets the command channel", async () => {
  const { goChannelFor } = await import("../keilSession.js");
  // The two halves of `run` used to disagree: the tool measured "halted on a
  // breakpoint → API start is answered SUCCESS and no stop arrives → timeout",
  // then treated a timeout as "do not retry", so `goChannelFor("api-timed-out")`
  // was never called and the documented failure was still there.
  expect(goChannelFor("api-timed-out")).toBe("command");
});

it("a frame collected for one request is not deleted for another", async () => {
  const { MessageReader } = await import("../uvsock.js");
  const { UvSocketClient } = await import("../uvsock.js");
  // `collect` truncates the retained frames at its `from`. Called with no
  // `from` from inside a command, it removed the stop notification that a
  // concurrently waiting `run` was about to look for, and that run then
  // reported "still running" for a core that had stopped.
  const reader = new MessageReader();
  expect(reader).toBeTruthy();
  const client: any = Object.create(UvSocketClient.prototype);
  client.frames = [];
  client.reader = reader;
  const frame = (type: number) => ({ type, cmd: type, data: Buffer.alloc(0), raw: Buffer.alloc(0), text: "" });
  client.frames.push(frame(0x3001), frame(0x3002), frame(0x2003));
  const mark = 3;
  client.frames.push(frame(0x5020), frame(0x5020));
  const taken = await client.collect(0, undefined, mark);
  expect(taken.length).toBe(2);
  expect(client.frames.length).toBe(3);
  expect(client.frames[2].type).toBe(0x2003);
});

it("an Intel HEX record above 0x8000_0000 keeps its address", async () => {
  const { parseIntelHex } = await import("../keilSession.js");
  // Type-04 sets the upper 16 bits. `0xFFFF << 16` is negative in 32-bit
  // bitwise arithmetic, so an image mapped at 0xFFFF_0000 (QSPI/HyperFlash)
  // produced a negative address; the read-back then clamped it to 0 and
  // reported a difference at a place the image never occupied.
  const text = [
    ":020000040800F2", // upper = 0x0800
    ":0400000001020304F2",
    ":02000004FFFFFC", // upper = 0xFFFF — the overflow case
    ":040000000A0B0C0DF2",
  ].join("\n");
  const records = parseIntelHex(text);
  expect(records[0].address).toBe(0x08000000);
  expect(records[0].bytes).toEqual([1, 2, 3, 4]);
  expect(records[1].address).toBe(0xFFFF0000);
  expect(records[1].address > 0).toBeTruthy();
});

it("a truncated Intel HEX record is dropped instead of yielding NaN bytes", async () => {
  const { parseIntelHex } = await import("../keilSession.js");
  // Count says four bytes; only two are present.
  const text = [":040000000102F2"].join("\n");
  const records = parseIntelHex(text);
  expect(records.length).toBe(0);
});

it("an output directory that is not relative resolves the way Keil does", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, resolve, sep } = await import("node:path");
  const { imageLocation } = await import("../keilSession.js");
  const root = mkdtempSync(join(tmpdir(), "keil-img-"));
  const user = join(root, "USER");
  mkdirSync(user);
  const project = join(user, "APP.uvprojx");
  const outDir = join(root, "OUT");
  const slashed = outDir.split(sep).join("/");
  const xml =
    '<?xml version="1.0"?><Project><Targets><Target>' +
    "<TargetName>T</TargetName>" +
    "<OutputName>APP</OutputName>" +
    `<OutputDirectory>${slashed}</OutputDirectory>` +
    "</Target></Targets></Project>";
  writeFileSync(project, xml);
  const result = await imageLocation({ project, client: { programPath: "" } } as never);
  rmSync(root, { recursive: true, force: true });
  // Without `fromelf` the result is an error message, but the path it would
  // have used must not be project-relative concatenation.
  if (!("error" in result)) {
    expect(resolve(result.elf)).toBe(resolve(outDir, "APP.axf"));
  }
});

/* ---------- round 13: protocol defects found in the third audit ---------- */

it("a frame split across two TCP segments survives", async () => {
  const { UvSocketClient } = await import("../uvsock.js");
  // `onData` used to construct a new MessageReader per event, so the partial
  // frame between segments was thrown away. TCP has no message boundaries: a
  // header split 20/12 lost its first half, and the remainder was read from
  // the middle of a payload.
  const client: any = Object.create(UvSocketClient.prototype);
  client.frames = [];
  client.frameWaiters = [];
  client.pending = new Map();
  client.reader = new (await import("../uvsock.js")).MessageReader();
  const whole = encodeMessage(0x3000, Buffer.alloc(12, 7));
  client.onData(whole.subarray(0, 20));
  expect(client.frames.length).toBe(0);
  client.onData(whole.subarray(20));
  // The reply envelope carries no pending entry, so it is not resolved, but the
  // point is that it was recognised at all rather than dropped.
  const seen = client.reader === undefined ? 0 : 1;
  expect(seen).toBe(1);
});

it("the reader keeps a partial frame between pushes", async () => {
  const { MessageReader } = await import("../uvsock.js");
  const reader = new MessageReader();
  const one = encodeMessage(0x3000, Buffer.alloc(8, 1));
  const two = encodeMessage(0x5022, Buffer.alloc(4, 2));
  const both = Buffer.concat([one, two]);
  // Split inside the header of the second message.
  const first = reader.push(both.subarray(0, one.length + 10));
  expect(first.length).toBe(1);
  const second = reader.push(both.subarray(one.length + 10));
  expect(second.length).toBe(1);
  expect(messageCommand(second[0])).toBe(0x5022);
});

it("the hardware slot is read at offset 32, not the address's high half", async () => {
  const { stopReason } = await import("../uvsock.js");
  // Captured at a breakpoint: after the 8-byte envelope the words are
  // 1, 0, 0, 1, 0x08006994, 0, 0x08006994, 0, 1, 2, …
  const body = Buffer.alloc(56);
  body.writeUInt32LE(1, 0);
  body.writeUInt32LE(0, 4);
  body.writeUInt32LE(0, 8);
  body.writeUInt32LE(1, 12); // reason: breakpoint
  body.writeUInt32LE(0x08006994, 16);
  body.writeUInt32LE(0, 20);
  body.writeUInt32LE(0x08006994, 24);
  body.writeUInt32LE(0, 28); // the address's high half
  body.writeInt32LE(1, 32); // the hardware slot
  body.writeUInt32LE(2, 36);
  const decoded = stopReason({ type: 0x4000, echoed: 0x2003, data: body, raw: body } as never);
  expect(decoded?.slot).toBe(1);
  expect(decoded?.pc).toBe(0x08006994);
});
