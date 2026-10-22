/**
 * A Keil debug session the agent can drive.
 *
 * The plain-GDB path in `debug.ts` covers probes that expose a GDB server. A
 * Keil project often does not: the debugger is uVision's own, configured in
 * the `.uvoptx`, and on an MDK-only machine there is no OpenOCD, no pyOCD and
 * no `arm-none-eabi-gdb` at all. Before this, "debug the Keil project" meant
 * "install a second toolchain and hope the chip is supported".
 *
 * This drives the same debugger uVision itself uses, through UVSOCK, so the
 * project's own device, flash algorithm and probe configuration are the ones
 * in effect. That is the difference between debugging *the* Keil project and
 * debugging *a* board.
 *
 * Real target or simulator is a property of the project target and is switched
 * explicitly, because the two answer completely differently when a register is
 * read twice and the difference matters to whoever asked.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fromelfFor } from "./fromelf.js";
import { decodeGbk, encodeGbk } from "./gbk.js";
import { decodeXmlText } from "./xmlText.js";
import { findUv4 } from "./keilInstall.js";
import { findUvprojx } from "./projectLookup.js";
import {
  connect,
  isStopNotification,
  stopReason,
  type AsyncFrame,
  type Reply,
  type UvSocketClient,
  OPT,
  OP,
  TARGET,
  asyncText,
  breakpointParam,
  commandWindowText,
  fixedString,
  readCountedString,
  memoryRequest,
  memoryWrite,
  BREAK,
  prjData,
  readMemoryReply,
  readSstr,
  readTrnOpt,
  readVtrFrame,
  trnOptValue,
  sstr,
  trnOpt,
  ivarEnum,
  varVal,
  vset,
  vsetWithValue,
  readVset,
  type OptionName,
} from "./uvsock.js";

export type { OptionName };

/** The result of a write the debugger accepted: whether it actually took. */
export interface WriteOutcome {
  ok: boolean;
  detail: string;
}

export interface KeilSession {
  client: UvSocketClient;
  project: string;
  /** True once `DBG_ENTER` succeeded. */
  debugging: boolean;
  target: "hardware" | "simulator";
  /** True when `GEN_SET_OPTIONS` enabled extended stack mode for this socket. */
  extended: boolean;
  openedAt: number;
}

const sessions = new Map<string, KeilSession>();

/** The key a session is remembered under: the project plus its port. */
export function sessionKey(project: string, port: number): string {
  return `${project.toLowerCase()}|${port}`;
}


/**
 * Close the session, and with it the uVision that made the edits.
 *
 * Project edits live in uVision's memory: measured, `PRJ_ADD_FILE` answers
 * `SUCCESS` and the `.uvprojx` on disk does not change until that process
 * exits — killing it discards the edit, and `GEN_EXIT` writes the file on its
 * way out. So the project-session close is not housekeeping; it is the save.
 * The caller compares the file's bytes around it rather than assuming.
 */
export async function closeKeilSession(key: string): Promise<boolean> {
  const session = sessions.get(key);
  if (!session) return false;
  try {
    if (session.debugging) await session.client.send(OP.DBG_EXIT, Buffer.alloc(0), 8_000);
  } catch {
    /* the session may already be gone */
  }
  await session.client.exit();
  // `exit()` sends `GEN_EXIT` and closes the socket; uVision needs a moment
  // to rewrite the project before the file reflects the session's edits.
  await new Promise((resolve) => setTimeout(resolve, session.debugging ? 800 : 2_500));
  sessions.delete(key);
  return true;
}


/**
 * Close every session, in the order they were opened.
 *
 * Used by callers that have no session handle of their own — a probe script,
 * a test, or shutdown — and by nothing in the tool layer, which closes the
 * sessions it looks up. It stays exported because closing is how project
 * edits reach the file: a caller that forgets one leaves an edit in uVision's
 * memory and out of the `.uvprojx`.
 */
export async function closeAllKeilSessions(): Promise<void> {
  for (const key of [...sessions.keys()]) await closeKeilSession(key);
}

/**
 * 关闭某个工程的调试会话，把探针让给下载器。
 *
 * A 的适配层要求调用方先 `close` 再 `flash`；B 侧直接替调用方做，因为
 * `flash` 这个动作本身已经说清了它需要什么。实测：调试会话占着 ST-Link 时，
 * 4824 的 plain 会话下载会报 `Target DLL has been cancelled`。
 */
export async function closeDebugSessions(project: string): Promise<number> {
  let closed = 0;
  for (const entry of listKeilSessions()) {
    if (!entry.debugging) continue;
    if (entry.project.toLowerCase() !== project.toLowerCase()) continue;
    if (await closeKeilSession(entry.key)) closed += 1;
  }
  return closed;
}

export function listKeilSessions(): { key: string; project: string; target: string; debugging: boolean; openedAt: number }[] {
  return [...sessions.entries()].map(([key, session]) => ({
    key,
    project: session.project,
    target: session.target,
    debugging: session.debugging,
    openedAt: session.openedAt,
  }));
}

/**
 * The plain sessions for one project, which must be closed before a debugger
 * is entered on it.
 *
 * Project edits live in the uVision that made them and reach the `.uvprojx`
 * only when that process exits. The debugger, meanwhile, loads the project
 * **from disk** — so with an edit session still open, `keil_project add_group`
 * followed by `keil_debug open` gives a debugger that does not have the group.
 * Measured on this bench: the edit session read back its new define while a
 * fresh uVision on the debug port read the old one from the file.
 *
 * A session already in debug mode is not in this list: it is the live one, and
 * exiting it would drop its breakpoints.
 */
export function projectSessionsToFlush(
  open: { key: string; project: string; debugging: boolean }[],
  project: string,
): { key: string }[] {
  const wanted = project.toLowerCase();
  return open.filter((entry) => !entry.debugging && entry.project.toLowerCase() === wanted);
}

/** Close the edit sessions for a project so the next uVision loads its edits. */
export async function flushProjectSessions(project: string): Promise<number> {
  let closed = 0;
  for (const entry of projectSessionsToFlush(listKeilSessions(), project)) {
    if (await closeKeilSession(entry.key)) closed++;
  }
  return closed;
}

/** Where UV4.exe is, if Keil is installed. */
export async function uv4Path(): Promise<string | null> {
  return findUv4();
}

/** The project file for a workspace, when it is a Keil project. */
export function keilProjectFor(cwd: string): string | null {
  return findUvprojx(cwd);
}

export interface OpenOptions {
  cwd: string;
  /** Override the detected project file. */
  project?: string;
  target?: "hardware" | "simulator";
  port?: number;
  /** Skip `DBG_ENTER`; just connect and let the caller drive. */
  connectOnly?: boolean;
  timeoutMs?: number;
}

export interface OpenResult {
  ok: boolean;
  session?: KeilSession;
  key?: string;
  /** What happened, in the order it happened, for the transcript. */
  log: string[];
  reason?: string;
}

/**
 * Open a session, reusing one that is already running for this project.
 *
 * Re-entering uVision's debug mode drops every breakpoint and re-flashes the
 * target, so reusing the live session is not an optimisation — it is what
 * makes "set a breakpoint, run, look, step" a sequence rather than four
 * unrelated attachments.
 */
export async function openKeilSession(options: OpenOptions): Promise<OpenResult> {
  const log: string[] = [];
  const uv4 = await uv4Path();
  if (!uv4) {
    return {
      ok: false,
      log,
      reason:
        "Keil MDK is not installed on this machine (UV4.exe was not found). Its debugger is licensed and is never bundled with this app, " +
        "so headless Keil debugging needs a local MDK install. Install MDK, or use embed_debug with an OpenOCD/pyOCD/J-Link probe instead.",
    };
  }
  const project = options.project ? options.project : keilProjectFor(options.cwd);
  if (!project) {
    return {
      ok: false,
      log,
      reason: "No Keil project found in this workspace. Point `project` at the .uvprojx, or run this from the project directory.",
    };
  }
  if (!existsSync(project)) return { ok: false, log, reason: `The project file does not exist: ${project}` };

  const port = options.port && options.port > 0 ? options.port : 4823;
  const key = sessionKey(project, port);
  const existing = sessions.get(key);
  if (existing && !existing.client.closed) {
    // The key is project + port, so it says nothing about which target the
    // session is debugging. Returning it for a different `target` ran the
    // caller's `simulator` work against the real board while printing
    // "target: hardware" — a configuration mistake with hardware consequences.
    const wanted = options.target ?? "hardware";
    if (existing.target !== wanted) {
      return {
        ok: false,
        log,
        reason:
          `the open session for this project is debugging the ${existing.target}, not the ${wanted}. ` +
          `Close it first (keil_debug action \`close\`) and open it again with target \`${wanted}\`.`,
      };
    }
    log.push(`reused the open uVision session on port ${port}`);
    return { ok: true, session: existing, key, log };
  }

  // Entering the debugger loads the project from disk. Any *plain* session for
  // this project is still holding edits in its own memory (that is how
  // `keil_project` saves — see `closeKeilSession`), so it is closed first and
  // its edits written out. Without this, `keil_project add_group` followed by
  // `keil_debug open` debugs a project without the group.
  if (!options.connectOnly) {
    const flushed = await flushProjectSessions(project);
    if (flushed > 0) log.push(`closed ${flushed} project edit session(s) so their edits reach the file first`);
  }

  log.push(`${uv4} ${project} -s ${port} -j0`);
  const connection = await connect({ uv4, project, port, ...(options.timeoutMs !== undefined ? { startTimeoutMs: options.timeoutMs } : {}) });
  if (!connection.ok) return { ok: false, log, reason: connection.reason };
  const client = connection.client;
  log.push(`connected to uVision on 127.0.0.1:${port}`);

  const version = await client.send(OP.GEN_GET_VERSION, Buffer.alloc(0), 10_000);
  if (!version.ok) {
    client.close();
    return { ok: false, log, reason: `uVision did not answer the version request: ${version.message ?? version.statusName}` };
  }
  // `SUCCESS` with a short payload is this interface's other failure shape,
  // and reading it here used to throw out of `openKeilSession` — before the
  // session was registered, so nothing ever closed the socket or the UV4 it
  // spawned, and the probe stayed held. A missing version is worth a warning,
  // not an exception.
  const versionWord = version.data.length >= 4 ? version.data.readUInt32LE(0) : undefined;
  log.push(versionWord !== undefined ? `socket interface version ${versionWord / 100}` : "uVision answered the version request without a version word");

  const session: KeilSession = { client, project, debugging: false, target: "hardware", extended: false, openedAt: Date.now() };
  sessions.set(key, session);

  if (options.connectOnly) return { ok: true, session, key, log };

  const entered = await enterDebug(session, options.target ?? "hardware", options.timeoutMs ?? 40_000);
  log.push(...entered.log);
  if (!entered.ok) {
    sessions.delete(key);
    await client.exit();
    return { ok: false, log, reason: entered.reason };
  }
  return { ok: true, session, key, log };
}

/**
 * Enter (or re-enter) uVision's debug mode on the chosen target.
 *
 * `DBG_ENTER` replies `SUCCESS` immediately and then works: it resets the
 * target, flashes the image and starts execution. A failure arrives as a
 * later 0x4000 frame — `Cannot access target`, `Flash Download failed` — so
 * the outcome is read from `DBG_STATUS` and those frames, not from the reply
 * to the request.
 */
export async function enterDebug(
  session: KeilSession,
  target: "hardware" | "simulator",
  timeoutMs = 40_000,
): Promise<{ ok: boolean; log: string[]; reason?: string }> {
  const log: string[] = [];
  const { client } = session;

  // Variable, task and watch operations are refused outright unless
  // "extended stack mode" is on, and the option is only accepted **before**
  // the debugger is entered — afterwards `GEN_SET_OPTIONS` answers "Target is
  // in debug mode". Measured: without it `ENUM_VARIABLES` returns NOT_FOUND,
  // `ENUM_TASKS` NOT_SUPPORTED and `EVAL_WATCH_EXPRESSION` NOT_SUPPORTED,
  // which reads exactly like an image with no symbol table.
  const options = await client.send(OP.GEN_SET_OPTIONS, Buffer.from([1, 0, 0, 0]), 8_000);
  session.extended = options.ok;
  if (!options.ok) log.push(`extended stack mode unavailable: ${options.message ?? options.statusName}`);

  const mark = client.mark;
  const pick = Buffer.alloc(44);
  pick.writeUInt32LE(target === "simulator" ? TARGET.SIM : TARGET.HW, 0);
  const chosen = await client.send(OP.PRJ_SET_DEBUG_TARGET, pick, 10_000);
  if (!chosen.ok) return { ok: false, log, reason: `could not select the ${target}: ${chosen.message ?? chosen.statusName}` };
  session.target = target;
  log.push(`target: ${target}`);

  const enter = await client.send(OP.DBG_ENTER, Buffer.alloc(0), 15_000);
  if (!enter.ok) return { ok: false, log, reason: `the debugger refused to start: ${enter.message ?? enter.statusName}` };

  // Entering is asynchronous: poll the status and read the stream for the
  // failure frames uVision sends instead of a bad reply.
  const started = Date.now();
  const deadline = started + timeoutMs;
  let lastLines = 0;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const frames = client.since(mark);
    for (const frame of frames.slice(lastLines)) {
      const text = asyncText(frame) || commandWindowText(frame);
      if (text) log.push(text.trim());
    }
    lastLines = frames.length;

    const failure = frames.map((frame) => asyncText(frame)).find((text) => /cannot access target|flash download failed|error \d+:/i.test(text));
    if (failure) {
      session.debugging = false;
      return { ok: false, log, reason: `uVision could not start the debug session: ${failure.trim()}` };
    }

    const status = await client.send(OP.DBG_STATUS, Buffer.alloc(0), 5_000);
    if (status.ok && status.data.length >= 4 && status.data.readUInt32LE(0) === 0) {
      // A missing or unreadable image does **not** stop uVision: measured, it
      // prints `*** error 56: cannot open file` and enters debug mode anyway,
      // with nothing loaded. Reporting that as a working session made every
      // later breakpoint, register read and step answer `NOT_DEBUGGING`.
      const loadFailure = frames.map((frame) => commandWindowText(frame)).find((line) => /\*\*\* error \d+: cannot open file/i.test(line));
      if (loadFailure) {
        session.debugging = false;
        return {
          ok: false,
          log,
          reason: `the debugger entered but could not load the image: ${loadFailure.trim()}. Build first, and check that the project's output name matches a file that exists.`,
        };
      }
      session.debugging = true;
      log.push(`entered ${target} debug mode`);
      // `DBG_ENTER` answers before the download finishes, so a status of
      // "stopped" can be read while the flash algorithm is still running and
      // its failure frame has not arrived. The loop used to return here and
      // never look again, leaving `debugging` true for a session whose
      // download then failed — every later call answered `NOT_DEBUGGING`
      // while `open` had reported success. One short confirmation window
      // closes that gap.
      const confirmFrom = client.mark;
      await new Promise((resolve) => setTimeout(resolve, 800));
      const late = client.since(confirmFrom);
      for (const frame of late) {
        const text = asyncText(frame) || commandWindowText(frame);
        if (text) log.push(text.trim());
      }
      const lateFailure = late
        .map((frame) => asyncText(frame) || commandWindowText(frame))
        .find((text) => /cannot access target|flash download failed|error \d+:/i.test(text));
      if (lateFailure) {
        session.debugging = false;
        return { ok: false, log, reason: `uVision reported a failure just after entering debug mode: ${lateFailure.trim()}` };
      }
      // What a hardware session logs varies with the adapter. Measured on this
      // machine: an ST-Link session logs no adapter line at all, while a
      // ULink/other adapter does ("… DLL loaded"). So a missing message is not
      // evidence that no board answered, and it is **not** reported as one —
      // the download path carries the real evidence, and a claim made on this
      // guess would be a false alarm on a working setup.
      return { ok: true, log };
    }
    if (status.status === 6 /* NOT_DEBUGGING */ && Date.now() - started > 8_000 && frames.length === 0) {
      const detail = status.message ?? "the debugger reports it is not in a debug session";
      return { ok: false, log, reason: detail };
    }
  }
  if (session.debugging) return { ok: true, log };
  // Nothing said what went wrong but the debugger is not in a session. uVision
  // ends up here when the image it was told to load is missing or unreadable:
  // measured with the `.axf` deleted, it prints `*** error` in the command
  // window and never enters. Reporting only "no session" would send the user
  // looking for a probe problem that does not exist.
  const tail = log.slice(-3).join(" | ");
  return {
    ok: false,
    log,
    reason: `uVision did not enter debug mode within ${Math.round(timeoutMs / 1000)} s${tail ? `; last output: ${tail}` : ""}. A missing or unreadable image is the usual cause — build first, and check the project's output name.`,
  };
}

/* ---------- execution control ---------- */

export interface StopInfo {
  stopped: boolean;
  reason?: string;
  /** `STOPREASON` from the stop notification: 0 none, 1 breakpoint, 2 fault, … */
  reasonCode?: number;
  /** Where the program counter is, when the interface reports it. */
  pc?: number;
  /** Hardware breakpoint slot that fired, when the interface reports one. */
  slot?: number;
  /** The debugger's own words for the stop, when it sent any. */
  reasonText?: string;
  /** The command-window lines produced while running. */
  output: string[];
}

/**
 * Which execution path `run` takes on this attempt.
 *
 * Measured on MDK 5.43a + STM32F429: with the core halted **on** a hardware
 * breakpoint at `main`, `DBG_START_EXECUTION` answers SUCCESS, the core keeps
 * running, and no stop notification arrives — three attempts in a row timed
 * out. The debugger's own command channel (`G`) stops at the same breakpoint
 * in under a second. So the API is tried first and the command channel is the
 * second path; there is no third.
 */
export function goChannelFor(attempt: "api" | "api-timed-out" | "api-failed" | "command-timed-out"): "api" | "command" | null {
  if (attempt === "api") return "api";
  if (attempt === "command-timed-out") return null;
  return "command";
}

/** Start execution and wait until the target stops or times out. */
export async function run(session: KeilSession, timeoutMs = 30_000): Promise<StopInfo> {
  const first = await runOnce(session, "api", timeoutMs);
  if (first.stopped) return first;
  // The API path produced no stop. Measured, that is exactly what happens when
  // the core is halted on a breakpoint it is already sitting at: the start is
  // answered SUCCESS and nothing else ever arrives. The timeout is the signal
  // for that case, not a reason to skip the second path — the command channel
  // stops at the same breakpoint in under a second. (It used to be treated as
  // "not refused, so do not retry", which made `goChannelFor`'s `api-timed-out`
  // branch unreachable and left the documented failure unfixed.)
  const next = goChannelFor("api-timed-out");
  if (next === null) return first;
  // A genuine "it really is running" comes back from the command channel and
  // is reported unchanged; it costs one more wait, not a wrong answer.
  const second = await runOnce(session, next, timeoutMs);
  if (second.stopped) return second;
  return { ...first, reason: `${first.reason}; the command channel did not stop it either: ${second.reason ?? "no stop"}` };
}

/** One start attempt: through the socket API, or through the command channel. */
async function runOnce(session: KeilSession, channel: "api" | "command", timeoutMs: number): Promise<StopInfo> {
  const mark = session.client.mark;
  if (channel === "command") {
    // `G` is the Command window's "go". The module that owns the command
    // channel imports this one, so it is loaded on demand rather than at the
    // top — a static import would close the cycle.
    const { debugCommand } = await import("./keilExtra.js");
    const ran = await debugCommand(session, "G");
    if (!ran.ok) return { stopped: false, reason: ran.message ?? "the debugger refused the go command", output: ran.lines };
    return waitForStop(session, mark, timeoutMs);
  }
  const started = await session.client.send(OP.DBG_START_EXECUTION, Buffer.alloc(0), 8_000);
  // `TARGET_EXECUTING` means it is already running — which is what `run` was
  // asked to do, not a failure. Waiting for the next stop is the right answer.
  if (!started.ok && started.status !== 11) return { stopped: false, reason: started.message ?? started.statusName, output: [] };
  return waitForStop(session, mark, timeoutMs);
}

/**
 * Wait until the target is no longer executing.
 *
 * The stop is a `0x4000` frame echoing `UV_DBG_STOP_EXECUTION`, not a change
 * in `DBG_STATUS`: that reply is `SUCCESS` with a zero word whether the core
 * is running or halted, so polling it alone reported a running target as
 * stopped on the very first test. The notification is the signal; the status
 * is only used to notice that the session itself went away.
 */
export async function waitForStop(session: KeilSession, mark: number, timeoutMs = 30_000): Promise<StopInfo> {
  const { client } = session;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frames = client.since(mark);
    const output = frames.map((frame) => commandWindowText(frame)).filter(Boolean);
    const stop = frames.find((frame) => isStopNotification(frame));
    if (stop) {
      const decoded = stopReason(stop);
      // Only text from the stop frame itself describes the stop. The stream
      // also carries "Execution started" from the start of this very run, and
      // taking the last text frame made every breakpoint report
      // `reason: "Execution started"`.
      const own = asyncText(stop).trim();
      return {
        stopped: true,
        ...(decoded ? { reasonCode: decoded.reason } : {}),
        ...(decoded?.pc ? { pc: decoded.pc } : {}),
        // `0xffffffff` is "no slot"; it must not be reported as a negative one.
        ...(decoded?.slot !== undefined && decoded.slot >= 0 ? { slot: decoded.slot } : {}),
        ...(own ? { reasonText: own } : {}),
        output,
      };
    }
    const fault = frames.map((frame) => asyncText(frame)).find((text) => /cannot access target|flash download failed/i.test(text));
    if (fault) return { stopped: false, reason: fault.trim(), output };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return { stopped: false, reason: `still running after ${Math.round(timeoutMs / 1000)} s`, output: client.since(mark).map(commandWindowText).filter(Boolean) };
}

/** Halt a running target. */
export async function halt(session: KeilSession): Promise<StopInfo> {
  const mark = session.client.mark;
  const stopped = await session.client.send(OP.DBG_STOP_EXECUTION, Buffer.alloc(0), 8_000);
  // `TARGET_STOPPED` is not a failure: the caller asked for a halt and the
  // target already was halted. Reporting it as one made `embed_debug halt` on
  // a stopped target look like a broken command.
  const alreadyStopped = stopped.status === 12;
  if (!stopped.ok && !alreadyStopped) return { stopped: false, reason: stopped.message ?? stopped.statusName, output: [] };
  if (alreadyStopped) return { stopped: true, reason: "the target was already stopped", output: [] };
  return waitForStop(session, mark, 10_000);
}

export type StepKind = "over" | "into" | "instruction" | "out";

/** Step and wait for the resulting stop. */
export async function step(session: KeilSession, kind: StepKind = "over", timeoutMs = 15_000): Promise<StopInfo> {
  const command = kind === "into" ? OP.DBG_STEP_INTO : kind === "instruction" ? OP.DBG_STEP_INSTRUCTION : kind === "out" ? OP.DBG_STEP_OUT : OP.DBG_STEP_HLL;
  const mark = session.client.mark;
  const replied = await session.client.send(command, Buffer.alloc(0), 8_000);
  if (!replied.ok) return { stopped: false, reason: replied.message ?? replied.statusName, output: [] };
  return waitForStop(session, mark, timeoutMs);
}

/* ---------- breakpoints ---------- */

export interface Breakpoint {
  number: number;
  type: number;
  enabled: boolean;
  /** The interface's own handle, used to delete or toggle this breakpoint. */
  tickMark: number;
  address?: number;
  expression?: string;
}

/**
 * The breakpoint stream is `0x5004` start / `0x5005` item / `0x5006` end.
 *
 * A real item, byte for byte from `STM32F429` / `main`:
 *
 *   type(4)=1  count(4)=1  enabled(4)=1  tickMark(4)=1
 *   address(8)=0x08006be0  exprLen(4)=5  "main"
 *
 * `tickMark` is the handle `UV_DBG_CHANGE_BP` takes, so it is carried on the
 * struct: deleting a breakpoint by list position is not the same thing.
 */
export function parseBreakpoints(frames: AsyncFrame[]): Breakpoint[] {
  const out: Breakpoint[] = [];
  for (const frame of frames) {
    if (frame.type !== 0x5005 || frame.data.length < 28) continue;
    const type = frame.data.readUInt32LE(0);
    const enabled = frame.data.readUInt32LE(8) !== 0;
    const tickMark = frame.data.readUInt32LE(12);
    const address = Number(frame.data.readBigUInt64LE(16));
    const length = frame.data.readUInt32LE(24);
    const text = length > 0 && 28 + length <= frame.data.length + 1 ? decodeGbk(frame.data.subarray(28, 28 + length - 1)) : "";
    out.push({
      number: out.length + 1,
      type,
      enabled,
      tickMark,
      ...(address ? { address } : {}),
      ...(text ? { expression: text } : {}),
    });
  }
  return out;
}

/**
 * A `file:line` location, split and normalised to forward slashes.
 *
 * The forms the debugger's own interfaces accept are `file:line` and
 * `file(12)`. Neither is an expression uVision parses: measured on this bench,
 * `DBG_CREATE_BP` with `main.c:38` answers `SUCCESS`, then prints
 * `*** error 52: left side of '.' requires struct/union` into the command
 * window and creates nothing — the breakpoint silently does not exist.
 */
export function parseFileLine(location: string): { file: string; line: number } | null {
  const paren = /^\s*(.+?)\(\s*(\d+)\s*\)\s*$/.exec(location);
  const colon = paren ? null : /^\s*(.+?):\s*(\d+)\s*$/.exec(location);
  const match = paren ?? colon;
  if (!match) return null;
  const line = Number(match[2]);
  if (!Number.isInteger(line) || line <= 0) return null;
  return { file: match[1].trim().replace(/\\/g, "/").replace(/^\.\//, ""), line };
}

/**
 * `fromelf --text -g` line entries, as `{ address, file, line }`.
 *
 * The debug table prints one line per addressable statement:
 *
 *   `08006be0: main.c:35.5`
 *   `08000c42: ..\HARDWARE\LCD\ltdc.c:488.5`
 *
 * and a compile unit whose code was not laid down prints `00000000:` for its
 * header lines, which are dropped. This is the only mapping from source lines
 * to addresses that this build offers: `DBG_FILELINE_TO_ADR` answers
 * `NO_ADRMAP` for every path form tried, and the command window's `BS` takes
 * addresses and expressions, not file/line pairs.
 */
export function parseFromelfLines(text: string): { address: number; file: string; line: number }[] {
  const out: { address: number; file: string; line: number }[] = [];
  for (const match of text.matchAll(/([0-9a-f]{8}):\s+(\S[^:\r\n]*?):(\d+)\.\d+/g)) {
    const address = Number.parseInt(match[1], 16);
    if (!address) continue;
    out.push({ address, file: match[2].replace(/\\/g, "/"), line: Number(match[3]) });
  }
  return out;
}

/**
 * What to look for when a `file:line` is asked for.
 *
 * The paths in the image's debug info are the ones the compiler was given
 * (`..\USER\main.c`, `../HARDWARE/UI/ui.c`), not the absolute path a caller
 * types, and the same file name can sit in several directories. A suffix
 * match on whole segments resolves both: `main.c` finds `..\USER\main.c`, and
 * `USER/main.c` finds it without colliding with another directory's copy.
 */
function fileMatches(candidate: string, wanted: string): boolean {
  return candidate === wanted || candidate.endsWith(`/${wanted}`);
}

/**
 * The executable address of a source line, from the image's debug tables.
 *
 * `elf` is the built image; `fromelf` is the one from the same Keil install.
 */
export async function sourceLineAddress(
  elf: string,
  fromelf: string,
  file: string,
  line: number,
): Promise<{ address: number; file: string; line: number } | { error: string }> {
  if (!existsSync(elf)) return { error: `there is no built image at ${elf} to read the line table from; build first` };
  const run = await new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    execFile(
      fromelf,
      ["--text", "-g", elf],
      { windowsHide: true, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, out: stdout ?? "", err: stderr ?? "" }),
    );
  });
  if (run.code !== 0) {
    const detail = run.err.split(String.fromCharCode(10)).find((line) => line.trim()) ?? "";
    return { error: `fromelf exited ${run.code} reading the line table of ${elf}${detail ? `: ${detail.trim()}` : ""}` };
  }
  const entries = parseFromelfLines(run.out);
  if (entries.length === 0) {
    return { error: `${elf} carries no line table; build it with debug information on ("Debug Information" ticked in the target's output options)` };
  }
  const wanted = file.replace(/\\/g, "/").replace(/^\.\//, "");
  // The same line is listed once per instruction it covers; the first is the
  // one a breakpoint belongs on.
  const hit = entries.find((entry) => entry.line === line && fileMatches(entry.file, wanted));
  if (hit) return hit;
  const files = [...new Set(entries.map((entry) => entry.file))];
  const sameFile = entries.filter((entry) => fileMatches(entry.file, wanted));
  if (sameFile.length === 0) {
    return { error: `no source file matching "${file}" is in the image; it knows ${files.slice(0, 6).join(", ")}${files.length > 6 ? ", …" : ""}` };
  }
  const lines = sameFile.map((entry) => entry.line).filter((value, index, all) => all.indexOf(value) === index).sort((a, b) => a - b);
  const near = lines.slice(0, 8).join(", ");
  return { error: `${sameFile[0].file} has no line ${line}; its executable lines are ${near}${lines.length > 8 ? ", …" : ""}` };
}

/** Context this session needs to resolve `file:line`: where the image is, and how to read it. */
export interface BreakpointContext {
  elf: string;
  fromelf: string;
}

/**
 * Add a breakpoint at a function, `file:line`, `file(line)`, or `*address`.
 *
 * A `file:line` is resolved to an address first, because passing it through
 * unchanged reports success for a breakpoint that does not exist. When the
 * resolution fails, or when uVision prints an error while creating it, the
 * result is a failure carrying the debugger's own words.
 */
export async function addBreakpoint(
  session: KeilSession,
  expression: string,
  context?: BreakpointContext,
): Promise<{ ok: boolean; reply: Reply; breakpoints: Breakpoint[]; reason?: string; resolved?: { address: number; expression: string } }> {
  let target = expression;
  let resolved: { address: number; expression: string } | undefined;
  // `0x08001234` is a constant, and `*0x08001234` the dereference form; both
  // are addresses already and must not be read as `file:line`.
  const addressLike = /^\s*\*?\s*(0x[0-9a-f]+|\d+)\s*$/i.test(expression);
  const fileLine = addressLike ? null : parseFileLine(expression);
  if (fileLine) {
    if (!context) {
      return {
        ok: false,
        reply: { status: 1, statusName: "FAILED", ok: false, data: Buffer.alloc(0) },
        breakpoints: [],
        reason: `"${expression}" is a source location; resolving it needs the built image and fromelf`,
      };
    }
    const found = await sourceLineAddress(context.elf, context.fromelf, fileLine.file, fileLine.line);
    if ("error" in found) {
      return {
        ok: false,
        reply: { status: 1, statusName: "FAILED", ok: false, data: Buffer.alloc(0) },
        breakpoints: [],
        reason: found.error,
      };
    }
    target = `0x${found.address.toString(16)}`;
    resolved = { address: found.address, expression: `${found.file}:${found.line}` };
  }

  const mark = session.client.mark;
  const reply = await session.client.send(OP.DBG_CREATE_BP, breakpointParam(target), 12_000);
  // `BP_REDEFINED` (19) is success with a caveat: the same location already
  // had a breakpoint, and uVision kept it. Treating it as failure made a
  // re-add after a delete look like the delete did not work.
  let ok = reply.ok || reply.status === 19 || reply.status === 22 /* BP_CREATED */;
  // A bad expression is not a failed command: uVision answers `SUCCESS` and
  // says `*** error 34: undefined identifier` on the stream. The breakpoint
  // list is the authority on whether anything was created.
  const frames = await session.client.collect(1500, 0x5006, mark);
  const error = frames
    .map((frame) => commandWindowText(frame))
    .find((line) => /\*\*\* error \d+:/.test(line));
  const listed = parseBreakpoints(frames);
  if (ok && error && listed.length === 0) {
    ok = false;
    return { ok, reply, breakpoints: listed, reason: `uVision refused the breakpoint: ${error.trim()}`, ...(resolved ? { resolved } : {}) };
  }
  return { ok, reply, breakpoints: listed, ...(resolved ? { resolved } : {}) };
}

/** List the current breakpoints. */
export async function listBreakpoints(session: KeilSession): Promise<Breakpoint[]> {
  const mark = session.client.mark;
  await session.client.send(OP.DBG_ENUMERATE_BP, Buffer.alloc(0), 10_000);
  const frames = await session.client.collect(1500, 0x5006, mark);
  return parseBreakpoints(frames);
}

/** Delete a breakpoint by kind: `KILLBP` = 1, `ENABLEBP` = 2, `DISABLEBP` = 3. */
export async function changeBreakpoint(session: KeilSession, tickMark: number, operation: 1 | 2 | 3): Promise<Reply> {
  const payload = Buffer.alloc(4 + 4 + 32);
  payload.writeUInt32LE(operation, 0);
  payload.writeUInt32LE(tickMark, 4);
  return session.client.send(OP.DBG_CHANGE_BP, payload, 10_000);
}

/* ---------- inspection ---------- */

export interface StackFrame {
  level: number;
  address: number;
  returnAddress?: number;
  /** The source line the debugger attached to this frame, when it sent one. */
  source?: string;
  /** `STACKENUM.nVars`: how many locals this frame has. 0 without extended mode. */
  variables?: number;
  /** `STACKENUM.nTotal`: the whole stack's depth, repeated on each frame. */
  total?: number;
  function?: string;
  file?: string;
  line?: number;
}

/**
 * The `iSTKENUM` request for a stack enumeration.
 *
 * `bExtended` (bit 1) is what carries frame information. `bFull` (bit 0) is
 * documented as "Unused, kept for backward compatibility". Measured on MDK
 * 5.43.1, stopped in `main`: requesting `1` returned 2 frames of which 0
 * parsed, requesting `3` returned 3 frames and a real frame with
 * `nVars`/`nTotal`. Without it the stack reads empty on a target that has one.
 */
export function stackRequest(): Buffer {
  const payload = Buffer.alloc(32);
  payload.writeUInt32LE(3, 0); // bFull | bExtended
  return payload;
}

/**
 * Decode a `STACKENUM` frame (`0x5015`).
 *
 * The layout is the header's, packed —
 *
 *   UINT nItem(4) xU64 nAdr(8) xU64 nRetAdr(8) UINT nVars(4)
 *   UINT nEqual(4) UINT nTotal(4) UINT nTask(4) UINT nRes[3]
 *
 * — and a measured frame is exactly those fields:
 *
 *   01000000 0000000000000000 ffffffff00000000 00000000 01000000 01000000 …
 *   nItem=1  nAdr=0              nRetAdr=0xffffffff nVars=0  nEqual=1 nTotal=1
 *
 * The earlier version read the bytes at offset 20 as a source line. That offset
 * is `nVars`: a count, not text. It produced an empty `source` every time and
 * no one noticed because the line was only an optional hint.
 */
/** True when the text is ordinary source characters (not a binary record). */
function isPrintableText(text: string): boolean {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || code === 13) continue;
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

export function parseStackFrames(frames: AsyncFrame[]): StackFrame[] {
  const out: StackFrame[] = [];
  for (const frame of frames) {
    if (frame.type !== 0x5015) continue;
    const data = frame.data;
    if (data.length < 12) continue;
    const address = Number(data.readBigUInt64LE(4));
    const returnAddress = data.length >= 20 ? Number(data.readBigUInt64LE(12)) : undefined;
    const variables = data.length >= 24 ? data.readUInt32LE(20) : undefined;
    const total = data.length >= 32 ? data.readUInt32LE(28) : undefined;
    // Text, when the debugger appends any, starts after the fixed record (44
    // bytes with the three reserved words). Nothing is fabricated from the
    // count fields in between.
    const text = data.length > 44 ? decodeGbk(data.subarray(44)).replace(/\0.*$/s, "").trim() : "";
    const source = text && isPrintableText(text) ? text : "";
    out.push({
      level: out.length,
      address,
      ...(returnAddress !== undefined ? { returnAddress } : {}),
      ...(variables !== undefined ? { variables } : {}),
      ...(total !== undefined ? { total } : {}),
      ...(source ? { source } : {}),
    });
  }
  return out;
}

/**
 * Read the call stack, innermost first.
 *
 * `STACKENUM` is reported from the bottom of the stack downwards — the frame
 * whose return address is `0xffffffff` is `Reset_Handler` — so the frames are
 * reversed. Without that the "top" frame was the outermost function and `#0`
 * named the startup code instead of the line that stopped.
 */
export async function readStack(session: KeilSession): Promise<StackFrame[]> {
  const mark = session.client.mark;
  await session.client.send(OP.DBG_ENUM_STACK, stackRequest(), 10_000);
  const frames = await session.client.collect(1500, 0x5016, mark);
  return orderStackFrames(frames);
}

/** Reverse the debugger's bottom-up order and number the frames from the top. */
export function orderStackFrames(frames: AsyncFrame[]): StackFrame[] {
  return parseStackFrames(frames)
    .reverse()
    .map((frame, level) => ({ ...frame, level }));
}

export interface RegisterValue {
  group: number;
  /** The register's index within its group, as the enumeration reports it. */
  index: number;
  name: string;
  value: string;
  isPC: boolean;
  canChange: boolean;
}

/**
 * Decode `REGENUM` frames (`0x5028`).
 *
 * `REGENUM` is `{ u16 nGi; u16 nItem; char szReg[16]; u8 flags; char szVal[32] }`
 * and the interface is packed, so the value starts at 21 — one byte past the
 * flags byte, not at a 4-byte boundary:
 *
 *   group=0 item=0 "R0\0…" flags=0x02 "0x00000000\0…"
 *   group=0 item=0 "PC\0…" flags=0x03 "0x08006458\0…"
 *
 * Reading the flags as a `u32` at 20 swallowed the first three bytes of the
 * value — `0x08006458` came out as the plausible-looking `8006460`.
 */
export function parseRegisters(frames: AsyncFrame[]): RegisterValue[] {
  const out: RegisterValue[] = [];
  for (const frame of frames) {
    if (frame.type !== 0x5028) continue;
    const data = frame.data;
    if (data.length < 21) continue;
    const group = data.readUInt16LE(0);
    const index = data.readUInt16LE(2);
    const name = fixedString(data, 4, 16);
    const flags = data.readUInt8(20);
    const value = fixedString(data, 21, 32);
    if (!name) continue;
    out.push({ group, index, name, value, isPC: (flags & 1) === 1, canChange: (flags & 2) === 2 });
  }
  return out;
}

/**
 * Every register of the target, in the debugger's own groups.
 *
 * `REGENUM` ignores its `nGi`/`nItem` on this build: every request returns the
 * same set in one burst, so it is asked once and the frames are read from the
 * caller's mark — waiting for the terminator after `send()` returned was what
 * produced an empty list.
 *
 * **The enumeration is a name list, not a value list.** Measured on MDK 5.43a
 * with an STM32F429IGTx behind an ST-Link: every one of the 156 `REGENUM`
 * frames carries `szVal = "0x00000000"`, through a reset, a single-step, and a
 * run that stopped at `main` — while `DBG_STATUS` said stopped the whole time.
 * The values are filled in from `DBG_CALC_EXPRESSION`, which answers `R0`,
 * `R13`, `R15` correctly and with distinct values at each of those same
 * moments. Trusting `szVal` meant `registers` printed sixteen zeros and
 * `where` reported PC = 0 for a core that was halted in `main`.
 */
export async function readRegisters(session: KeilSession): Promise<RegisterValue[]> {
  const mark = session.client.mark;
  await session.client.send(OP.DBG_ENUM_REGISTERS, Buffer.alloc(48), 10_000);
  // The terminator is `0x5029`; a burst that never sends it still yields its
  // registers, so the frames are parsed whatever the collection saw.
  const frames = await session.client.collect(2000, 0x5029, mark);
  const all = session.client.since(mark);
  const merged = [...frames, ...all.filter((frame) => !frames.includes(frame))];
  const listed = parseRegisters(merged);
  if (listed.length === 0) return listed;
  return withEvaluatedValues(session, listed);
}

/**
 * How the values in a `RegisterValue` are obtained.
 *
 * Exported so a test can pin the contract: the enumeration's own `szVal` is
 * not the source. See `readRegisters`.
 */
export function registerValueSource(): "calc-expression" {
  return "calc-expression";
}

/**
 * Which expression asks the debugger for a register's value.
 *
 * The debugger names its registers `R0`…`R12`, `R13 (SP)`, `R14 (LR)`,
 * `R15 (PC)`, and evaluates the numbered form of every core register. The
 * peripheral and FPU entries (`xPSR`, `CONTROL`, `S0`, `FPSCR`) are debugger
 * state with no C expression — asking for `xPSR` is answered
 * `*** error 34: undefined identifier` — so they are deliberately absent and
 * keep whatever the enumeration said.
 */
export const REGISTER_EXPRESSIONS: Record<string, string> = Object.freeze({
  R0: "R0",
  R1: "R1",
  R2: "R2",
  R3: "R3",
  R4: "R4",
  R5: "R5",
  R6: "R6",
  R7: "R7",
  R8: "R8",
  R9: "R9",
  R10: "R10",
  R11: "R11",
  R12: "R12",
  R13: "R13",
  R14: "R14",
  R15: "R15",
  "R13 (SP)": "R13",
  "R14 (LR)": "R14",
  "R15 (PC)": "R15",
});

/** The expression for a register's name, or undefined when it has none. */
export function registerExpression(name: string): string | undefined {
  return REGISTER_EXPRESSIONS[name.trim().toUpperCase().replace(/\s+/g, " ")];
}

/**
 * Read one register's value through `DBG_CALC_EXPRESSION`.
 *
 * Kept here rather than calling `evaluate` from `keilExtra.ts`: that module
 * already imports this one, and the dynamic-import dance it forces would run
 * inside a loop that touches every register. This is the same request and the
 * same `VSET` decode — `type(4) value(8) len(4) text` — so the two cannot
 * disagree about the wire format.
 */
async function evaluateRegister(session: KeilSession, expression: string): Promise<bigint | undefined> {
  const reply = await session.client.send(OP.DBG_CALC_EXPRESSION, vset(expression), 10_000);
  if (!reply.ok) return undefined;
  const decoded = readVset(reply.data);
  if (!decoded) return undefined;
  // `SUCCESS` with `<cannot evaluate>` and a zero value is the debugger
  // saying it could not resolve the name, not a register that holds zero.
  if (/^\s*<cannot evaluate>\s*$/i.test(decoded.text)) return undefined;
  return decoded.value;
}

/**
 * Replace each register's enumerated value with the one the evaluator reports.
 *
 * A register whose expression fails keeps its enumerated value: an entry that
 * genuinely reads zero is not distinguishable from one the debugger would not
 * evaluate, and inventing a number for the second case is the failure this
 * whole path exists to avoid. The core registers all evaluate.
 */
async function withEvaluatedValues(session: KeilSession, listed: RegisterValue[]): Promise<RegisterValue[]> {
  // Sequential on purpose. The client matches replies on the echoed command
  // and there is no room for two outstanding requests of the same kind; a
  // `Promise.all` here would hand every register the first answer.
  const out: RegisterValue[] = [];
  for (const entry of listed) {
    const expression = registerExpression(entry.name);
    if (!expression) {
      out.push(entry);
      continue;
    }
    const value = await evaluateRegister(session, expression);
    if (value === undefined) {
      out.push(entry);
      continue;
    }
    const digits = value < 0n ? (-value).toString(16) : value.toString(16);
    out.push({ ...entry, value: `0x${digits.toUpperCase()}` });
  }
  return out;
}

/**
 * The `VSET` a `REGISTER_SET` request carries.
 *
 * The header says exactly what the two fields mean (`UVSOCK.h`, the `VSET`
 * doc comment):
 *
 *   @li UV_DBG_REGISTER_SET (Set @a str to the expression for register value
 *       and val to register index)
 *
 * So the **string** is the new value, written as an expression the debugger
 * evaluates, and the **value** is the register index. The previous code sent
 * the register *name* in the string and the new value in the value field;
 * measured on MDK 5.43.1 that is answered `SUCCESS` and changes nothing.
 */
export function registerSetPayload(index: number, expression: string): Buffer {
  return vsetWithValue(expression, 5, BigInt(index));
}

/**
 * What a register write amounts to, as one decision.
 *
 * `SUCCESS` is not the claim being made — "the register holds the new value"
 * is — so the outcome is decided from the read-back, and the three cases say
 * different things: written, kept the old value, or refused outright.
 */
export function describeRegisterWrite(input: {
  name: string;
  index: number;
  before: string;
  after?: string;
  wanted: number;
  accepted: boolean;
  message?: string;
}): WriteOutcome {
  if (!input.accepted) return { ok: false, detail: `${input.name} was refused: ${input.message ?? "no reason given"}` };
  const got = input.after ? parseRegisterValue(input.after) : null;
  if (got !== null && got === input.wanted) return { ok: true, detail: `${input.name} = ${input.after}` };
  return {
    ok: false,
    detail: `${input.name} was accepted but reads back ${input.after ?? "(missing)"}; the core kept its old value (some registers only take a write while the target is stopped)`,
  };
}

/**
 * Write a register.
 *
 * `REGISTER_SET` names the register by its **index** and puts the new value in
 * the string field — see `registerSetPayload`. The index is the `nItem` the
 * enumeration reported, which is the register's number within the whole set
 * (154 registers, all distinct; `R0`…`R15` are 0…15).
 *
 * Every write is read back: `SUCCESS` with an unchanged register is this
 * interface's failure shape, and it is reported as a failure.
 */
export async function setRegister(session: KeilSession, name: string, value: string): Promise<WriteOutcome> {
  if (!session.debugging) return { ok: false, detail: "not in debug mode; enter it before writing a register" };
  // An omitted value used to reach `numericValue("")`, which is `Number("")`
  // — a perfectly good integer 0 — and wrote zero into the register. Reading
  // it back confirms the zero, so the tool reported a successful write of a
  // value the caller never gave. A register write needs a value, and `0x` with
  // nothing after it is not one.
  if (!value.trim()) return { ok: false, detail: `${name} needs a value; nothing was written` };
  const wanted = numericValue(value);
  if (wanted === null) return { ok: false, detail: `${JSON.stringify(value)} is not a number; registers take a numeric value` };
  const all = await readRegisters(session);
  // The debugger names the core registers `R0`…`R12`, `R13 (SP)`, `R14 (LR)`,
  // `R15 (PC)`. Looking up a bare `PC` found nothing, and the old code sent the
  // request anyway and reported the debugger's SUCCESS as if it had written
  // something.
  const before = findRegister(all, name);
  if (!before) {
    return { ok: false, detail: `the debugger reports no register named ${name} (it lists ${all.length}: ${all.slice(0, 8).map((entry) => entry.name).join(", ")}, …)` };
  }
  if (!before.canChange) return { ok: false, detail: `${before.name} is read-only` };
  // `VTT_uint` (5) is what this build expects for a register value; the reply's
  // own type word is a number whose meaning does not match the enum, so a
  // literal integer is sent rather than echoing a decoded type back.
  const reply = await session.client.send(OP.DBG_REGISTER_SET, registerSetPayload(before.index, wanted.toString()), 10_000);
  const after = reply.ok ? findRegister(await readRegisters(session), before.name) : undefined;
  return describeRegisterWrite({
    name: before.name,
    index: before.index,
    before: before.value,
    ...(after ? { after: after.value } : {}),
    wanted,
    accepted: reply.ok,
    ...(reply.message ? { message: reply.message } : {}),
  });
}

/** Find a register by the name a person types: `PC`, `SP`, `R0`, `15`. */
export function findRegister(registers: RegisterValue[], name: string): RegisterValue | undefined {
  const upper = name.trim().toUpperCase();
  const alias: Record<string, string> = { PC: "R15", SP: "R13", LR: "R14", FP: "R11", IP: "R12" };
  return (
    registers.find((entry) => entry.name.toUpperCase() === upper) ??
    // `R15 (PC)` — the parenthesised alias is what the debugger prints.
    registers.find((entry) => entry.name.toUpperCase().startsWith(`${upper} `)) ??
    registers.find((entry) => entry.name.toUpperCase().endsWith(`(${upper})`)) ??
    // `PC` for `R15`, and the reverse: a person types the architectural name,
    // the debugger lists the numbered one.
    (alias[upper] ? registers.find((entry) => entry.name.toUpperCase().startsWith(`${alias[upper]} `)) : undefined) ??
    (alias[upper] ? registers.find((entry) => entry.name.toUpperCase() === alias[upper]) : undefined) ??
    // `R15` asked for, `R15 (PC)` listed.
    (upper.startsWith("R") && /^\d+$/.test(upper.slice(1))
      ? registers.find((entry) => entry.name.toUpperCase().startsWith(`${upper} `))
      : undefined) ??
    // A bare number is the register number: `15` is `R15`.
    (/^\d+$/.test(upper) ? registers.find((entry) => entry.name.toUpperCase() === `R${upper}`) : undefined) ??
    (/^\d+$/.test(upper) ? registers.find((entry) => entry.name.toUpperCase().startsWith(`R${upper} `)) : undefined)
  );
}

/** A register value string (`0x…` or decimal) as a number, or null. */
export function parseRegisterValue(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const parsed = /^0x/i.test(trimmed) ? Number.parseInt(trimmed.slice(2), 16) : Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function numericValue(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  // The hex branch used to return `parseInt` straight through, and
  // `parseInt("", 16)` is `NaN` — so `"0x"` sailed past the null check and
  // `BigInt(NaN)` threw a `RangeError` out of `REGISTER_SET`. A malformed
  // number is a refusal, not an exception.
  if (/^-?0x/i.test(trimmed)) {
    const digits = trimmed.replace(/^-?0x/i, "");
    if (!/^[0-9a-f]+$/i.test(digits)) return null;
    const parsed = Number.parseInt(digits, 16);
    return Number.isInteger(parsed) ? (trimmed.startsWith("-") ? -parsed : parsed) : null;
  }
  if (!/^-?\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) ? parsed : null;
}


/** Read memory through the debugger. */
export async function readMemory(session: KeilSession, address: number, bytes: number): Promise<{ bytes: number[]; errorAddress?: number } | null> {
  const reply = await session.client.send(OP.DBG_MEM_READ, memoryRequest(address, Math.max(1, Math.min(bytes, 0x2000))), 12_000);
  if (!reply.ok) return null;
  const decoded = readMemoryReply(reply.data);
  return decoded ? { bytes: decoded.bytes, ...(decoded.errorAddress !== undefined ? { errorAddress: decoded.errorAddress } : {}) } : null;
}

/**
 * Write memory through the debugger, then read it back.
 *
 * The write is only reported as done when the read-back matches. A mismatch
 * means the region refused the bytes (read-only, write-protected, or a
 * register with masked bits), and calling that "wrote" is the failure mode
 * this interface produces most often: `SUCCESS` with no effect.
 */
/**
 * Whether a read-back can be trusted as evidence about the chip.
 *
 * The debugger keeps its own view of memory and answers a read from it, so a
 * write followed by a read in the **same session** proves only that the write
 * reached that view. Measured on STM32F429: writing `de ad be ef` to
 * `0x08000000` answered "wrote 4 byte(s) and read them back" with the new bytes
 * in the same session, the next session read the original vector table, and
 * STM32CubeProgrammer read the original from the chip. A read-back therefore
 * confirms RAM-like regions and does **not** confirm flash.
 */
export function readBackConfirmsChip(address: number): boolean {
  // The Arm private peripheral bus and RAM are read straight from the core;
  // the code region at 0x00000000-0x1fffffff includes aliased flash.
  if (address >= 0xe0000000 && address <= 0xe00fffff) return true;
  if (address >= 0x20000000 && address <= 0x3fffffff) return true;
  return false;
}

/**
 * Write memory through the debugger, then read it back.
 *
 * The write is only reported as done when the read-back matches. A mismatch
 * means the region refused the bytes (read-only, write-protected, or a
 * register with masked bits), and calling that "wrote" is the failure mode
 * this interface produces most often: `SUCCESS` with no effect.
 *
 * A match is **not** the same as "the chip holds these bytes": for flash the
 * debugger answers from its own view (see `readBackConfirmsChip`), so the
 * detail says which of the two it is.
 */
export async function writeMemory(session: KeilSession, address: number, bytes: number[]): Promise<{ ok: boolean; readBack: number[] | null; detail: string }> {
  const wrote = await session.client.send(OP.DBG_MEM_WRITE, memoryWrite(address, bytes), 12_000);
  if (!wrote.ok) return { ok: false, readBack: null, detail: wrote.message ?? wrote.statusName };
  const back = await readMemory(session, address, bytes.length);
  const readBack = back?.bytes ?? null;
  const same = readBack !== null && readBack.length >= bytes.length && bytes.every((byte, index) => readBack[index] === byte);
  const chip = readBackConfirmsChip(address);
  return {
    ok: same,
    readBack,
    detail: same
      ? chip
        ? `wrote ${bytes.length} byte(s) and read them back`
        : `wrote ${bytes.length} byte(s) and this session reads them back, but that is the debugger's own view of ` +
          `0x${address.toString(16)} — measured on flash, a fresh session and the chip both still hold the old bytes. ` +
          "Use `flash` to change the image; this write cannot be taken as evidence about the chip."
      : readBack === null
        ? `wrote ${bytes.length} byte(s) but could not read them back; the write is unconfirmed`
        : `wrote ${bytes.length} byte(s) but the read-back differs (${readBack.map((byte) => byte.toString(16).padStart(2, "0")).join(" ")}) — the region may be read-only or mask bits`,
  };
}

/**
 * Where the program is stopped, as `file:line` when the symbols allow it.
 *
 * The file name is read the same way `addressToSource` reads it. This function
 * looked for the name after the first NUL past offset 36, and on a real reply
 * that found nothing — `where` printed a bare address while `addressToSource`
 * on the same address answered `../HARDWARE/UI/ui.c:497 UI_Update`.
 */
export async function currentLocation(session: KeilSession): Promise<{ address: number; file?: string; line?: number } | null> {
  const registers = readPCFrom(await readRegisters(session));
  if (registers === null) return null;
  const source = await addressToSource(session, registers);
  if (!source) return { address: registers };
  return {
    address: registers,
    ...(source.file ? { file: source.file } : {}),
    ...(source.line ? { line: source.line } : {}),
  };
}

/**
 * Why an evaluator's text is an error rather than a value, or undefined.
 *
 * Both evaluators answer a bad expression with the debugger's own diagnostic:
 * `_____^ *** error 34: undefined identifier`, or `<cannot evaluate>`. Printed
 * as a result it reads like a computed value, so it is turned into a failure
 * that names the reason.
 */
export function evaluationError(text: string): string | undefined {
  const trimmed = text.trim();
  const error = /\*\*\*\s*error\s*\d+\s*:\s*(.*)$/i.exec(trimmed);
  if (error) return error[1]!.trim() || "the debugger refused the expression";
  if (/^<cannot evaluate>$/i.test(trimmed)) return "<cannot evaluate>";
  return undefined;
}

/** The PC register from a register list, whichever name the core uses. */
function readPCFrom(registers: RegisterValue[]): number | null {
  const pc = registers.find((entry) => entry.isPC) ?? registers.find((entry) => /^(PC|R15)$/i.test(entry.name));
  if (!pc) return null;
  const value = Number.parseInt(pc.value.replace(/^0x/i, ""), pc.value.trim().toLowerCase().startsWith("0x") ? 16 : /^[0-9a-f]+$/i.test(pc.value.trim()) ? 16 : 10);
  return Number.isFinite(value) ? value : null;
}

/* ---------- project editing ---------- */

/** The project's targets, as uVision reports them. */
/**
 * The project's targets, as uVision reports them.
 *
 * Measured on MDK 5.43a: this answers only while the debugger is **not**
 * entered. In a debug session the reply is `DEBUGGING` (status 36) with 36
 * bytes of payload and no enumeration frames at all, so waiting for the
 * terminator produced an empty list that read exactly like "the project has no
 * targets". The project file is the authority, and reading it works in either
 * state — see `readProjectFacts`.
 */
export async function projectTargets(session: KeilSession): Promise<string[]> {
  const mark = session.client.mark;
  const reply = await session.client.send(OP.PRJ_ENUM_TARGETS, Buffer.alloc(0), 10_000);
  if (!reply.ok) return [];
  const frames = await session.client.collect(1200, 0x5023, mark);
  return frames
    .filter((frame) => frame.type === 0x5022)
    .map((frame) => decodeGbk(frame.data.subarray(4)).replace(/\0.*$/s, ""))
    .filter(Boolean);
}

/** The project's groups, in order. */
export async function projectGroups(session: KeilSession): Promise<string[]> {
  const mark = session.client.mark;
  await session.client.send(OP.PRJ_ENUM_GROUPS, Buffer.alloc(0), 10_000);
  const frames = await session.client.collect(1200, 0x5009, mark);
  const fromStream = frames
    .filter((frame) => frame.type === 0x5008)
    .map((frame) => decodeGbk(frame.data.subarray(4)).replace(/\0.*$/s, ""))
    .filter(Boolean);
  if (fromStream.length > 0) return fromStream;
  // A plain session refuses the enumeration; the project file is the same list.
  return groupsInProject(session.project);
}

/**
 * The `<Target>` block for one target, or the first one when none is named.
 *
 * A multi-target `.uvprojx` holds one block per target, each with its own
 * `<Groups>`, `<OutputDirectory>` and `<OutputName>`. Every reader below that
 * works on the file has to start here: reading the whole document returned
 * each group once per target.
 */
export function targetBlock(xml: string, wanted?: string): string {
  const blocks = [...xml.matchAll(/<Target>([\s\S]*?)<\/Target>/g)].map((match) => match[1]);
  if (blocks.length === 0) return xml;
  if (!wanted) return blocks[0]!;
  const nameOf = (body: string) => decodeXmlText(/<TargetName>([^<]*)<\/TargetName>/.exec(body)?.[1] ?? "").trim();
  return blocks.find((body) => nameOf(body) === wanted) ?? blocks[0]!;
}

/** The project's groups, read from the `.uvprojx`. */
export function groupsInProject(projectFile: string, target?: string): string[] {
  let text = "";
  try {
    text = readFileSync(projectFile, "utf8").replace(/^﻿/, "");
  } catch {
    return [];
  }
  // One target's block only: every target lists the same groups, so reading
  // the document returned `USER, CORE, USER, CORE` on a two-target project.
  const body = targetBlock(text, target);
  return [...body.matchAll(/<GroupName>([^<]*)<\/GroupName>/g)].map((match) => decodeXmlText(match[1]!)).filter(Boolean);
}


/** One group's files from the `.uvprojx`, as `{ name, path }`. */
export function filePathsInGroup(projectFile: string, group: string, target?: string): { name: string; path: string }[] {
  let text = "";
  try {
    text = readFileSync(projectFile, "utf8").replace(/^﻿/, "");
  } catch {
    return [];
  }
  const groups = [...targetBlock(text, target).matchAll(/<Group>([\s\S]*?)<\/Group>/g)].map((match) => match[1]);
  // The comparison is between two decoded names. Matching the caller's text
  // against the raw XML meant `Drivers & BSP` was looked for as `Drivers &amp;
  // BSP` and the group read as empty.
  const wanted = groups.find((body) => decodeXmlText(/<GroupName>([\s\S]*?)<\/GroupName>/.exec(body)?.[1] ?? "").trim() === group);
  if (!wanted) return [];
  return [...wanted.matchAll(/<File>([\s\S]*?)<\/File>/g)]
    .map((match) => ({
      name: decodeXmlText(/<FileName>([^<]*)<\/FileName>/.exec(match[1])?.[1] ?? ""),
      path: decodeXmlText(/<FilePath>([^<]*)<\/FilePath>/.exec(match[1])?.[1] ?? ""),
    }))
    .filter((entry) => entry.name);
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function addGroup(session: KeilSession, group: string): Promise<Reply> {
  return session.client.send(OP.PRJ_ADD_GROUP, prjData(group), 12_000);
}

/**
 * Every file the project lists, in any group.
 *
 * `PRJ_ADD_FILE` refuses a file that is already in the project — measured,
 * "File 'X:../USER/main.c'" → `ALREADY_PRESENT` — and uVision will not list
 * one file twice, so "add a file that is already built as part of another
 * group" is not something this interface can do. Knowing that up front turns
 * an opaque refusal into an answer.
 */
export function allProjectFiles(projectFile: string, target?: string): { group: string; name: string; path: string }[] {
  let text = "";
  try {
    text = readFileSync(projectFile, "utf8").replace(/^﻿/, "");
  } catch {
    return [];
  }
  const out: { group: string; name: string; path: string }[] = [];
  for (const match of targetBlock(text, target).matchAll(/<Group>([\s\S]*?)<\/Group>/g)) {
    const body = match[1];
    const group = decodeXmlText(/<GroupName>([^<]*)<\/GroupName>/.exec(body)?.[1] ?? "");
    for (const file of body.matchAll(/<File>([\s\S]*?)<\/File>/g)) {
      out.push({
        group,
        name: /<FileName>([^<]*)<\/FileName>/.exec(file[1])?.[1] ?? "",
        path: /<FilePath>([^<]*)<\/FilePath>/.exec(file[1])?.[1] ?? "",
      });
    }
  }
  return out;
}

/**
 * A file path as the `.uvprojx` stores it: relative to the **project file**.
 *
 * uVision resolves `<FilePath>` against the directory the `.uvprojx` sits in,
 * and writes whatever it is given. The tool takes paths the way a person types
 * them — often relative to the workspace — so a project that lives in `USER\`
 * turns `USER\probe_add.c` into `USER\USER\probe_add.c`, a file that does not
 * exist. Measured: `add_file` answered "added", the entry was dead, and the
 * only mention of it was a build failure much later.
 *
 * "Relative to the project" is ambiguous on disk — `USER/probe_add.c` is a
 * legal path inside `USER\` whether or not it exists. The file is therefore
 * **located** the way a reader would: the workspace interpretation when that
 * is the one that exists, then the project one. Only what actually exists is
 * written into the project.
 */
export function projectRelativeFile(projectFile: string, file: string, workspace = process.cwd()): string {
  const dir = dirname(projectFile);
  if (isAbsolute(file)) return relative(dir, resolve(file)).replace(/\//g, "\\");
  const fromProject = resolve(dir, file);
  const fromWorkspace = resolve(workspace, file);
  const absolute = existsSync(fromProject) || !existsSync(fromWorkspace) ? fromProject : fromWorkspace;
  const rel = relative(dir, absolute);
  return rel === "" ? "." : rel.replace(/\//g, "\\");
}

/**
 * Whether `projectRelativeFile` located a file that is actually on disk.
 *
 * The function above resolves an ambiguous relative path without claiming the
 * result exists; `add_file` needs to know which it got. A misspelt name used
 * to be accepted by uVision (`SUCCESS`), written into the `.uvprojx`, and
 * reported as "added" — the dead entry only surfaced as a build failure much
 * later, with nothing pointing at the add.
 *
 * `workspace` is the tool's own working directory, not the process's. In the
 * desktop app the process starts somewhere else entirely, and checking the
 * workspace path against `process.cwd()` made a file that exists look absent.
 */
export function resolvesToExistingFile(projectFile: string, file: string, workspace = process.cwd()): boolean {
  const dir = dirname(projectFile);
  const absolute = isAbsolute(file)
    ? resolve(file)
    : existsSync(resolve(dir, file))
      ? resolve(dir, file)
      : resolve(workspace, file);
  return existsSync(absolute);
}

export async function addFile(session: KeilSession, group: string, file: string, workspace = process.cwd()): Promise<Reply> {
  // uVision answers `SUCCESS` for a `<FilePath>` that does not exist, so the
  // existence check has to happen here or not at all.
  if (!resolvesToExistingFile(session.project, file, workspace)) {
    const dir = dirname(session.project);
    return {
      ok: false,
      status: 9,
      statusName: "NOT_FOUND",
      message: `${file} is not on disk (looked relative to the workspace and to ${dir}); nothing was added`,
      data: Buffer.alloc(0),
    } as Reply;
  }
  const stored = projectRelativeFile(session.project, file, workspace);
  // uVision's own `ALREADY_PRESENT` names the group it was given, which reads
  // like "it is already in this group" — it is not; it is in whichever group
  // had it first. Say which one.
  const base = (stored.split(/[\\/]/).pop() ?? stored).toLowerCase();
  const existing = allProjectFiles(session.project).find(
    (entry) =>
      entry.name.toLowerCase() === base ||
      entry.path.toLowerCase() === stored.toLowerCase() ||
      entry.path.toLowerCase().endsWith(`\\${base}`),
  );
  if (existing && existing.group !== group) {
    return {
      ok: false,
      status: 7,
      statusName: "ALREADY_PRESENT",
      data: Buffer.alloc(0),
      message: `${existing.path} is already in the project, under ${existing.group}. uVision will not list one file twice, so it cannot be added to ${group} as well.`,
    };
  }
  return session.client.send(OP.PRJ_ADD_FILE, prjData(group, stored), 12_000);
}

/**
 * Remove one file from the project.
 *
 * `PRJ_DEL_FILE` takes a `PRJDATA` of **group and file**, the same pair
 * `PRJ_ADD_FILE` takes. Measured on a clean project: the pair deletes the
 * file (`SUCCESS`, gone from the `.uvprojx` after the session closes); a
 * single name is tried as a group and answered `NOT_FOUND: Group 'x'`.
 */
export async function removeFile(session: KeilSession, group: string, file: string): Promise<Reply> {
  return session.client.send(OP.PRJ_DEL_FILE, prjData(group, file), 12_000);
}

export async function removeGroup(session: KeilSession, group: string): Promise<Reply> {
  return session.client.send(OP.PRJ_DEL_GROUP, prjData(group), 12_000);
}

/** The current target's name. */
export async function currentTarget(session: KeilSession): Promise<string> {
  const reply = await session.client.send(OP.PRJ_GET_CUR_TARGET, Buffer.alloc(4), 8_000);
return reply.ok ? decodeGbk(reply.data.subarray(4)).replace(/\0.*$/s, "") : "";
}

export async function setTarget(session: KeilSession, target: string): Promise<Reply> {
  return session.client.send(OP.PRJ_SET_TARGET, prjData(target), 10_000);
}

/** Read a per-target option (defines, include paths, optimisation, …). */
export async function getOption(session: KeilSession, option: OptionName, target?: string): Promise<{ ok: boolean; values: string[]; message?: string }> {
  const name = target ?? (await currentTarget(session));
  const reply = await session.client.send(OP.PRJ_GET_OPTITEM, trnOpt(OPT[option], { target: name }), 10_000);
  return {
    ok: reply.ok,
    values: reply.ok ? [trnOptValue(reply.data)].filter(Boolean) : [],
    ...(!reply.ok ? { message: reply.message ?? reply.statusName } : {}),
  };
}

/** Write a per-target option. The value replaces the current one wholesale. */
export async function setOption(session: KeilSession, option: OptionName, value: string, target?: string): Promise<Reply> {
  const name = target ?? (await currentTarget(session));
  return session.client.send(OP.PRJ_SET_OPTITEM, trnOpt(OPT[option], { target: name, item: value }), 10_000);
}

/** Build through the running uVision, returning its output lines. */
export async function buildInIde(session: KeilSession, rebuild = false, timeoutMs = 10 * 60_000): Promise<{ ok: boolean; status: number; lines: string[] }> {
  const mark = session.client.mark;
  const started = Date.now();
  const reply = await session.client.send(rebuild ? OP.PRJ_REBUILD : OP.PRJ_BUILD, Buffer.alloc(0), 15_000);
  if (!reply.ok) return { ok: false, status: reply.status, lines: [reply.message ?? reply.statusName] };
  let status = 0;
  while (Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const frames = session.client.since(mark);
    // `0x5000` is "build complete" and its payload starts with the build code.
    const done = frames.find((frame) => frame.type === 0x5000);
    if (done && done.data.length >= 8) {
      status = done.data.readUInt32LE(4);
      break;
    }
  }
  const lines: string[] = [];
  for (const frame of session.client.since(mark)) {
    if (frame.type === 0x5001 || frame.type === 0x5020) {
      const text = frame.type === 0x5020 ? commandWindowText(frame) : decodeGbk(frame.data.subarray(8)).replace(/\0+$/, "");
      if (text) lines.push(text);
    }
  }
  // UVBUILDCODES: 1 ok, 2 warnings, 3 errors, 4 cancelled, 5 cleaned.
  return { ok: status === 1 || status === 2, status, lines: dedupe(lines) };
}

/** The NUL-terminated printable strings in a buffer, in order. */
function printableRuns(buffer: Buffer): string[] {
  const out: string[] = [];
  let current = "";
  for (const byte of buffer) {
    if (byte >= 0x20 && byte <= 0x7e) {
      current += String.fromCharCode(byte);
      continue;
    }
    if (current.length > 1) out.push(current);
    current = "";
  }
  if (current.length > 1) out.push(current);
  return out;
}

function dedupe(lines: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const key = line.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** Ask uVision to download the built image to flash on its configured target. */
/**
 * Clean the current target through the socket.
 *
 * `PRJ_CLEAN` is answered `SUCCESS` and streams the same report `UV4 -c`
 * writes into its log — measured: `Clean started: Project: 'TOUCH'`, the
 * per-target line, then the `0x5000` completion frame, in 0.4 s. `keil_debug
 * clean` spawned a second UV4 for the same job while this session was already
 * open, which is slower and can collide with the probe the session holds.
 */
export async function cleanInIde(session: KeilSession, timeoutMs = 5 * 60_000): Promise<{ ok: boolean; status: number; lines: string[] }> {
  const mark = session.client.mark;
  const reply = await session.client.send(OP.PRJ_CLEAN, Buffer.alloc(0), 15_000);
  if (!reply.ok) return { ok: false, status: reply.status, lines: [reply.message ?? reply.statusName] };
  const started = Date.now();
  let status = 0;
  while (Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const done = session.client.since(mark).find((frame) => frame.type === 0x5000);
    if (done && done.data.length >= 8) {
      status = done.data.readUInt32LE(4);
      break;
    }
  }
  const lines = session.client
    .since(mark)
    .filter((frame) => frame.type === 0x5001)
    .map((frame) => decodeGbk(frame.data.subarray(8)).replace(/\0+$/, ""))
    .filter(Boolean);
  // UVBUILDCODES: 1 ok, 2 warnings, 3 errors, 4 cancelled, 5 cleaned.
  return { ok: status === 1 || status === 2 || status === 5, status, lines: dedupe(lines) };
}

/**
 * Download the current target's image through uVision.
 *
 * Measured constraint: this is a **project** operation, not a debugger one. In
 * a debug session `PRJ_FLASH_DOWNLOAD` answers "Target is in debug mode" and
 * nothing is written; it only runs on a connected, non-debugging uVision.
 *
 * The reply comes back at once and the real outcome arrives on the stream:
 * progress frames on `0x4000`, `Flashed OK` when the debugger considers the
 * download done, then `0x5001` carrying `Flash Load finished at HH:MM:SS`.
 *
 * **`0x5001` alone is not the verdict.** It is the same frame a failed
 * download ends with, so the text frames are read for a failure before the
 * finish is accepted — and `verifyFlash` cross-checks the chip.
 */
export async function flashInIde(session: KeilSession, timeoutMs = 5 * 60_000): Promise<{ ok: boolean; lines: string[]; verified?: boolean }> {
  if (session.debugging) {
    return {
      ok: false,
      lines: [
        "a download cannot run in a debug session — uVision refuses it with \"Target is in debug mode\". " +
          "It runs on the plain project session; call `flash` with the session closed, or flash from the shell with UV4 -f.",
      ],
    };
  }
  const mark = session.client.mark;
  const reply = await session.client.send(OP.PRJ_FLASH_DOWNLOAD, Buffer.alloc(0), 20_000);
  if (!reply.ok) return { ok: false, lines: [reply.message ?? reply.statusName] };
  const text = () => dedupe(session.client.since(mark).map((frame) => asyncText(frame) || commandWindowText(frame)).filter(Boolean));
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const frames = session.client.since(mark);
    const failed = frames
      .map((frame) => asyncText(frame) || commandWindowText(frame))
      .find((line) => /flash download failed|error \d+:|cannot access target|target dll has been cancelled/i.test(line));
    if (failed) return { ok: false, lines: text() };
    const finished = frames.find((frame) => frame.type === 0x5001);
    if (finished) {
      // The finish frame carries the same "Flash Load finished at …" line a
      // successful run does; the difference is whether a failure line came
      // first, which was checked above.
      const reported = (asyncText(finished) || decodeGbk(finished.data.subarray(8)).replace(/\0.*$/s, "")).trim();
      return { ok: true, lines: [...text(), ...(reported ? [reported] : [])] };
    }
  }
  return { ok: false, lines: text() };
}

/**
 * Read the image back from flash and compare it with the file that was built.
 *
 * The downloader reporting `Verify OK` is the debugger's claim; this is the
 * chip's. Measured on this bench: after a download the first 16 bytes at the
 * image's load address match the `.hex` record byte for byte, which is what
 * turns "the log said OK" into "the flash holds this image".
 *
 * The comparison starts at the image's own start address (from the `.hex`
 * record), not at byte zero of the file — an `.axf` is an ELF and its first
 * bytes are `7f 45 4c 46`, not the vector table.
 */
export async function verifyFlash(session: KeilSession, hexPath: string, bytes = 64): Promise<{ ok: boolean; detail: string; expected?: string; got?: string }> {
  let records: { address: number; bytes: number[] }[] = [];
  try {
    const raw = readFileSync(hexPath);
    // A project without "Create HEX File" has only the `.axf`. That is an ELF,
    // so it is turned into the same records `fromelf --i32` would write rather
    // than skipping the chip comparison entirely.
    if (/\.(axf|elf|out)$/i.test(hexPath) || (raw[0] === 0x7f && raw.subarray(1, 4).toString("ascii") === "ELF")) {
      const fromelf = fromelfFor(session.client.programPath);
      if (!fromelf) return { ok: false, detail: `this image is an ELF and fromelf was not found to convert it to Intel HEX` };
      const converted = await new Promise<{ code: number | null; out: string }>((resolveRun) => {
        execFile(fromelf, ["--i32", "--output", `${hexPath}.verify.hex`, hexPath], { windowsHide: true, timeout: 120_000 }, (error, stdout) =>
          resolveRun({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, out: `${stdout ?? ""}` }),
        );
      });
      if (converted.code === 0) records = parseIntelHex(readFileSync(`${hexPath}.verify.hex`, "latin1"));
      if (records.length === 0) return { ok: false, detail: `could not convert ${hexPath} to Intel HEX to compare against flash` };
    } else {
      records = parseIntelHex(raw.toString("latin1"));
    }
  } catch {
    return { ok: false, detail: `could not read ${hexPath} to compare against flash` };
  }
  if (records.length === 0) return { ok: false, detail: `${hexPath} has no data records` };
  const image = new Map<number, number>();
  for (const record of records) record.bytes.forEach((byte, index) => image.set(record.address + index, byte));
  // Compare a contiguous run from the lowest address; the image is laid out
  // from there and a gap would be its own answer.
  const all = [...image.keys()].sort((a, b) => a - b);
  const start = all[0];
  const addresses: number[] = [];
  for (let offset = 0; offset < Math.min(bytes, all.length); offset++) {
    if (!image.has(start + offset)) break;
    addresses.push(start + offset);
  }
  const memory = await readMemory(session, addresses[0], addresses[addresses.length - 1] - addresses[0] + 1);
  if (!memory) return { ok: false, detail: `the debugger could not read flash at 0x${addresses[0].toString(16)}` };
  const got = memory.bytes;
  const mismatched = addresses.findIndex((address, index) => got[index] !== image.get(address));
  const expectedText = addresses.map((address) => image.get(address)!.toString(16).padStart(2, "0")).join(" ");
  const gotText = addresses.map((_, index) => (got[index] ?? -1).toString(16).padStart(2, "0")).join(" ");
  if (mismatched >= 0) {
    return {
      ok: false,
      detail: `flash differs from ${hexPath} at 0x${addresses[mismatched].toString(16)} (byte ${mismatched + 1} of ${addresses.length})`,
      expected: expectedText,
      got: gotText,
    };
  }
  return {
    ok: true,
    detail: `flash at 0x${addresses[0].toString(16)} matches ${hexPath} for ${addresses.length} byte(s)`,
    expected: expectedText,
    got: gotText,
  };
}

/** Intel HEX records that carry data, with their load addresses. */
export function parseIntelHex(text: string): { address: number; bytes: number[] }[] {
  const records: { address: number; bytes: number[] }[] = [];
  // A 64-bit base: the type-04 upper address is unsigned, and `0xFFFF << 16`
  // is negative in 32-bit bitwise arithmetic. Images mapped above 0x8000_0000
  // (QSPI/HyperFlash) went in with negative addresses, and the read-back then
  // compared them against address 0.
  let upper = 0n;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith(":") || line.length < 11) continue;
    const count = parseInt(line.slice(1, 3), 16);
    const address = parseInt(line.slice(3, 7), 16);
    const type = parseInt(line.slice(7, 9), 16);
    if (!Number.isFinite(count) || !Number.isFinite(address) || !Number.isFinite(type)) continue;
    // A truncated record has fewer characters than its byte count claims;
    // reading past them produced `NaN` bytes that travelled into the compare.
    if (line.length < 9 + count * 2 + 2) continue;
    const data: number[] = [];
    let complete = true;
    for (let index = 0; index < count; index++) {
      const byte = parseInt(line.slice(9 + index * 2, 11 + index * 2), 16);
      if (!Number.isFinite(byte)) complete = false;
      data.push(byte);
    }
    if (!complete) continue;
    if (type === 0) records.push({ address: Number(upper + BigInt(address)), bytes: data });
    else if (type === 4) upper = BigInt(parseInt(line.slice(9, 13), 16) || 0) << 16n;
    else if (type === 2) upper = BigInt(parseInt(line.slice(9, 13), 16) || 0) << 4n;
  }
  return records;
}



export interface Variable {
  /** The debugger's id for this variable; what `VARIABLE_SET` takes. */
  id: number;
  /** Position in the enumerated list, 0-based. */
  index: number;
  /** Element count for an array, 0 for a scalar. */
  count: number;
  name: string;
  value: string;
  type?: string;
  /** Set when the debugger marks the value editable. */
  editable?: boolean;
  pointer?: boolean;
  struct?: boolean;
  array?: boolean;
  global?: boolean;
  static?: boolean;
}

/**
 * Decode `VARINFO` frames (`0x5041`).
 *
 * Layout after the reply envelope:
 *
 *   nID(4) index(4) count(4) typeSize(4) flags(4) value(SSTR) type(SSTR) name(SSTR) qualified(SSTR)
 *
 * The `SSTR`s are fixed 260-byte blocks, so they are read by offset rather
 * than by scanning for NULs — a struct's rendered value contains plenty of
 * them.
 */
export function parseVariables(frames: AsyncFrame[]): Variable[] {
  const out: Variable[] = [];
  for (const frame of frames) {
    if (frame.type !== 0x5041) continue;
    const data = frame.data;
    if (data.length < 20) continue;
    const id = data.readInt32LE(0);
    const index = data.readInt32LE(4);
    const count = data.readInt32LE(8);
    const flags = data.readUInt32LE(16);
    const value = readSstr(data, 20);
    const type = readSstr(data, 280);
    const name = readSstr(data, 540);
    const qualified = readSstr(data, 800);
    const label = name || qualified;
    if (!label) continue;
    out.push({
      id,
      index,
      count,
      name: label,
      value,
      ...(type ? { type } : {}),
      editable: (flags & 1) === 1,
      pointer: (flags & 2) === 2,
      struct: (flags & 4) === 4,
      array: (flags & 64) === 64,
      global: (flags & 1024) === 1024,
      static: (flags & 512) === 512,
    });
  }
  return out;
}

/**
 * One variable's value as a line a reader will not misread.
 *
 * The enumeration's `value` field is the address for anything the debugger
 * renders by reference: measured, `LTDC_Handler` comes back as
 * `0x20000240 &LTDC_Handler` and `ltdc_lcd_framebuf` as `0xC0000000`. Printed
 * as a value, that array's address reads like the number 3221225472. The
 * address is useful — `read` takes it — so it is kept and labelled.
 */
export function describeVariableValue(variable: { name: string; value: string; type?: string; count?: number }): string {
  const value = variable.value.trim();
  const type = variable.type ?? "";
  const address = /^(0x[0-9a-f]+)/i.exec(value)?.[1] ?? value;
  if (/^struct/i.test(type)) return `struct at ${address} (the address; fields are not listed here)`;
  if (variable.count && variable.count > 0) return `array at ${address} (${variable.count} element(s); element values are not listed here)`;
  return value;
}

/**
 * The variables the debugger can enumerate for one frame, or the globals.
 *
 * Two measured requirements that are easy to miss:
 *
 *  - The request must carry a **count**. `IVARENUM` with `count = 0` — what a
 *    zeroed 20-byte buffer holds — is answered `SUCCESS` with an empty stream,
 *    so "the image has no symbols" and "the request asked for nothing" look
 *    identical. This asks for `VARIABLE_BATCH` at a time.
 *  - Variable, task and watch operations need **extended stack mode**, which
 *    `GEN_SET_OPTIONS` turns on and which is only accepted before the
 *    debugger is entered. Without it every one of them answers
 *    `NOT_FOUND`/`NOT_SUPPORTED` and the debugger looks like it has no symbol
 *    table at all.
 *
 * Whether a second batch can be asked for is not established: the field that
 * would page (`nID` or the task slot) has no measured meaning here, and
 * inventing one would be a guess. What is certain is that a batch that comes
 * back exactly full is indistinguishable from a batch that was cut off, so
 * `readVariablesTruncated` says so and the caller repeats it.
 */
export const VARIABLE_BATCH = 128;

export function readVariablesTruncated(list: Variable[]): boolean {
  return list.length >= VARIABLE_BATCH;
}

export async function readVariables(session: KeilSession, frame = 0): Promise<Variable[]> {
  const mark = session.client.mark;
  const reply = await session.client.send(OP.DBG_ENUM_VARIABLES, ivarEnum(0, frame, 0, VARIABLE_BATCH), 10_000);
  // `NOT_FOUND` here means the debugger has nothing to enumerate at this
  // frame — an image without debug info, or a frame with no locals. That is
  // an empty list, not a transport failure.
  if (!reply.ok && reply.status !== 9) return [];
  const frames = await session.client.collect(3000, 0x5042, mark);
  return parseVariables(frames);
}

/**
 * Set a variable by the id the enumeration reported.
 *
 * `VARIABLE_SET` takes a `VARVAL`: the `IVARENUM` that names the variable plus
 * the new value. Sending a bare name failed with `NOT_FOUND`, and the old code
 * reported the debugger's `SUCCESS` for a request that carried no value at all.
 * The write is read back, so a value the core refused is not reported as done.
 */
export async function setVariableById(session: KeilSession, variable: Variable, value: string, frame = 0): Promise<WriteOutcome> {
  if (!session.debugging) return { ok: false, detail: "not in debug mode; enter it before writing a variable" };
  if (variable.editable === false) return { ok: false, detail: `${variable.name} is not marked editable by the debugger` };
  const reply = await session.client.send(OP.DBG_VARIABLE_SET, varVal(variable.id, frame, 0, value), 10_000);
  if (!reply.ok) return { ok: false, detail: `${variable.name} was refused: ${reply.message ?? reply.statusName}` };
  const after = (await readVariables(session, frame)).find((entry) => entry.id === variable.id);
  return variableWriteVerdict(variable, value, after?.value);
}

/**
 * Whether a `VARIABLE_SET` that answered `SUCCESS` actually changed anything.
 *
 * This interface's characteristic failure is `SUCCESS` with no effect, and a
 * variable write is one of the places it happens. The old check compared the
 * read-back against the value *before* the write and called the result a
 * success either way — so a write the core ignored was reported as
 * "`uwTick` = 0x64 (unchanged)", which reads like a confirmation. What counts
 * is the value that was asked for: anything else is a refusal, including a
 * variable that could not be read back at all.
 */
export function variableWriteVerdict(variable: { name: string; value: string }, wanted: string, readBack: string | undefined): WriteOutcome {
  if (readBack === undefined) {
    return { ok: false, detail: `${variable.name} was sent ${wanted}, but the debugger did not list it again to read back — the write is unconfirmed` };
  }
  if (sameValue(readBack, wanted)) return { ok: true, detail: `${variable.name} = ${readBack}` };
  if (sameValue(readBack, variable.value)) {
    return { ok: false, detail: `${variable.name} was accepted but still reads ${readBack}; the core kept its old value` };
  }
  return { ok: false, detail: `${variable.name} was sent ${wanted} but reads back ${readBack}` };
}

/** Two values the debugger printed are the same number, whatever the radix. */
export function sameValue(a: string, b: string): boolean {
  const parse = (text: string): bigint | undefined => {
    const trimmed = text.trim();
    if (!trimmed) return undefined;
    try {
      if (/^0x[0-9a-f]+$/i.test(trimmed)) return BigInt(trimmed);
      if (/^-?\d+$/.test(trimmed)) return BigInt(trimmed);
    } catch {
      return undefined;
    }
    return undefined;
  };
  const left = parse(a);
  const right = parse(b);
  if (left !== undefined && right !== undefined) return left === right;
  return a.trim() === b.trim();
}

/**
 * Tasks, for an RTOS-aware target (RTX, or FreeRTOS with its awareness plugin).
 *
 * The frame is `STACKENUM` followed by the task name, measured as 276 bytes:
 *
 *   nItem(4) nAdr(8) nRetAdr(8) nVars(4) nEqual(4) nTotal(4) nTask(4)
 *   nRes[3](12) name[256]
 *
 * The name is at 48. Reading it at 12 — right after `nAdr` — produced a task
 * list of empty strings, which the caller then filtered away, so a target with
 * a real thread reported "no tasks".
 */
export async function readTasks(session: KeilSession): Promise<{ id: number; name: string }[]> {
  const mark = session.client.mark;
  // `iSTKENUM::bExtended`, which is what asks for the task fields.
  const request = Buffer.alloc(40);
  request.writeUInt32LE(2, 0);
  await session.client.send(OP.DBG_ENUM_TASKS, request, 10_000);
  const frames = await session.client.collect(1500, 0x5052, mark);
  return readTaskFrames(frames);
}

/** Decode task frames (`0x5051`), which are `STACKENUM` plus the task name. */
/**
 * Decode task frames (`0x5051`).
 *
 * Measured on MDK 5.43a, a 276-byte frame:
 *
 *   nItem(4)=0  nAdr(4)=0  nRetAdr(4)=0  nVars(4)=2  len(4)=12  "Main Thread\0"
 *
 * so the name is a counted string at 16 and its text at 20. Two earlier
 * readings were wrong in different ways — at 12 (the fields) and at 40 (past
 * the text) — and both produced an empty list for a target that does report a
 * thread, which then read as "this board has no RTOS tasks".
 */
export function readTaskFrames(frames: AsyncFrame[]): { id: number; name: string }[] {
  return frames
    .filter((frame) => frame.type === 0x5051 && frame.data.length >= 20)
    .map((frame) => {
      const data = frame.data;
      // This build leaves the address words zero for the main thread; the
      // name and the variable count are what it fills. Reporting 0 as an
      // address would be inventing one.
      const id = data.readUInt32LE(0);
      const length = data.readUInt32LE(16);
      const name =
        length > 0 && length < 256
? decodeGbk(data.subarray(20, Math.min(20 + length, data.length))).replace(/\0.*$/s, "")
          : "";
      return { id, name };
    })
    .filter((task) => task.name);
}

/** The trace/VTR items the target exposes. */
export async function readVtr(session: KeilSession): Promise<{ name: string; type: number }[]> {
  const mark = session.client.mark;
  await session.client.send(OP.DBG_ENUM_VTR, Buffer.alloc(32), 10_000);
  const frames = await session.client.collect(1500, 0x5019, mark);
  return frames
    .map(readVtrFrame)
    .filter((entry): entry is { name: string; type: number } => entry !== null)
    // The same variables are reported more than once in one burst.
    .filter((entry, index, all) => all.findIndex((other) => other.name === entry.name) === index);
}

/* ---------- registers, memory, addresses ---------- */

/** Register groups (`0x5025`), as the debugger's own panels name them. */
export async function readRegisterGroups(session: KeilSession): Promise<string[]> {
  // Request is a `VSET`; the reply frames are `{ u32 len, char name[] }`
  // (`04 00 00 00 "Core"`), measured against a Cortex-M4 target.
  const mark = session.client.mark;
  await session.client.send(OP.DBG_ENUM_REGISTER_GROUPS, Buffer.alloc(260), 10_000);
  const frames = await session.client.collect(1500, 0x5026, mark);
  return frames
    .filter((frame) => frame.type === 0x5025)
    .map((frame) => readCountedString(frame.data, 0))
    .filter(Boolean);
}


/**
 * Resolve an address to `file:line`.
 *
 * `AFLMAP`: `{ u32 nLine, u64 nAdr, u32 iFile, u32 iFunc, i32 nRes[5], char szFile[] }`,
 * so the line is at 0 and the file name starts at 40.
 */
export async function addressToSource(session: KeilSession, address: number): Promise<{ file?: string; line?: number; function?: string } | null> {
  const payload = Buffer.alloc(4 + 8 + 4 + 4 + 20 + 260);
  payload.writeUInt32LE(0, 0);
  payload.writeBigUInt64LE(BigInt(address), 4);
  const reply = await session.client.send(OP.DBG_ADR_TOFILELINE, payload, 8_000);
  if (!reply.ok) return null;
  const data = reply.data;
  if (data.length < 20) return null;
  const line = data.readUInt32LE(0);
  // Measured reply for `0x08006460`: the line, the address, a file index, a
  // function index, then reserved zeros, then `"system_stm32f4xx.cSystemInit"`.
  // The reserved words are not a fixed size this header documents, so the two
  // strings are found by scanning for the first printable runs rather than by
  // trusting an offset — which is what made every stop report "(no source)".
  const [file, func] = printableRuns(data.subarray(20));
  return { ...(file ? { file } : {}), ...(line ? { line } : {}), ...(func ? { function: func } : {}) };
}

/** Watch an address for reads, writes, or both (hardware watchpoint). */
/**
 * Whether a watchpoint exists after the request, judged by the debugger's list.
 *
 * `DBG_CREATE_BP` answers `SUCCESS` for every one of these requests, including
 * one whose expression it could not resolve: measured with `{type: 3,
 * expr: "uwTick"}` the reply is SUCCESS and `DBG_ENUMERATE_BP` comes back
 * empty — the name was evaluated as a C expression, produced nothing, and no
 * watchpoint was created. With a literal address the entry appears. So the
 * list is the authority, exactly as it is for a `file:line` breakpoint.
 */
export function accessBreakpointCreated(before: Breakpoint[], after: Breakpoint[]): boolean {
  const key = (entry: Breakpoint) => `${entry.type}:${entry.address ?? ""}:${entry.expression ?? ""}`;
  const had = new Set(before.map(key));
  const now = new Set(after.map(key));
  // Only an entry that was not there before is evidence. The second half of
  // this test used to be `[...had].some(entry => now.has(entry))`, which is
  // true whenever *any* pre-existing breakpoint survived — so with `main`
  // already set, a watchpoint request that created nothing was reported as a
  // breakpoint on the symbol, and `run` then never stopped on it.
  return [...now].some((entry) => !had.has(entry));
}

export async function addAccessBreakpoint(
  session: KeilSession,
  expression: string,
  kind: "read" | "write" | "readwrite",
  accessSize = 4,
): Promise<Reply & { created?: boolean; listed?: Breakpoint[] }> {
  const type = kind === "read" ? BREAK.READ : kind === "write" ? BREAK.WRITE : BREAK.READWRITE;
  const before = await listBreakpoints(session);
  const reply = await session.client.send(OP.DBG_CREATE_BP, breakpointParam(expression, { type, accessSize }), 12_000);
  const listed = await listBreakpoints(session);
  return { ...reply, created: accessBreakpointCreated(before, listed), listed };
}

/* ---------- project management ---------- */


/**
 * Cancel a build in progress.
 *
 * Measured on MDK 5.43a with no build running: `FAILED` with a 12-byte body,
 * so the answer is passed through rather than assumed. Not wired to an action
 * because a build runs inside one call and there is no window in which a
 * second call could reach it — cancelling is what the timeout does.
 */
export async function cancelBuild(session: KeilSession): Promise<Reply> {
  return session.client.send(OP.PRJ_BUILD_CANCEL, Buffer.alloc(0), 8_000);
}

/**
 * What a flash download does and does not erase.
 *
 * `UV_PRJ_FLASH_ERASE` is documented in `UVSOCK.h` as answering
 * `CMD_RESPONSE --> no data`, with an async `ERROR_RESPONSE` possible. Measured
 * on MDK 5.43.1 it answers neither, under every condition tried: no reply
 * frame, no async frame, no message box; 5 s through 60 s; a plain project
 * session and an entered debug session; `UV_GEN_UI_LOCK` set and
 * `UV_GEN_UI_UNLOCK` set; an empty payload and a four-byte one; and a session
 * whose every message was observed from `PRJ_LOAD` onward. The command number
 * and payload match the header (`0x1013`, no data), so this is a gap in the
 * build rather than a malformed request.
 *
 * The other route — the download — was measured for its **scope**. It reports
 * `Erase Done. Programming Done. Verify OK.`, but the erase is per sector and
 * covers only the sectors the image occupies:
 *
 * | where | written before | after a `-f` download |
 * |---|---|---|
 * | `0x08010000`, past a 32 KB image | `0x5A5A5A5A` | still `0x5A5A5A5A` |
 * | `0x080C0000`, past a 32 KB image | `0xDEADBEEF` | still `0xDEADBEEF` |
 * | sector 0, whole 16 KB filled | `0xAAAAAAAA` | erased, image written |
 *
 * An earlier version of this comment claimed the download "leaves the chip
 * erased". That was wrong: it read `0xFF` at `0x08080000` and concluded the
 * chip had been erased, when an erased chip reads `0xFF` everywhere — the
 * reading said nothing about what the download did. The markers above are the
 * evidence that replaced it.
 *
 * So: a download erases and writes its own sectors. It is *not* a substitute
 * for a full-chip erase, and nothing in the UVSOCK interface or in `UV4`'s
 * documented switches offers one on this target.
 */
export const FLASH_ERASE_LIMITATION =
  "uVision 5.43.1 never answers PRJ_FLASH_ERASE (no reply, no error frame, no message box), " +
  "and a download is not a full-chip erase: it erases only the sectors its own image occupies " +
  "(measured — a marker at 0x08010000 survived `UV4 -f` untouched). " +
  "What does work: download to clear the image's sectors, or mass-erase the chip with " +
  "`STM32_Programmer_CLI -c port=SWD -e all` (measured on this bench).";

/**
 * Erase the target's flash.
 *
 * The socket request is tried first and its result passed through unchanged;
 * this build is not expected to answer, and a future one that does needs no
 * code change. See `FLASH_ERASE_LIMITATION` for the measured substitute.
 */
export async function eraseFlash(session: KeilSession): Promise<Reply> {
  const reply = await session.client.send(OP.PRJ_FLASH_ERASE, Buffer.alloc(0), 20_000);
  if (reply.timedOut) return { ...reply, ok: false, message: FLASH_ERASE_LIMITATION };
  return reply;
}

/**
 * The command that really erases the whole chip.
 *
 * uVision offers no full-chip erase on this target: `PRJ_FLASH_ERASE` never
 * answers, and a download erases only its own image's sectors (measured — see
 * `FLASH_ERASE_LIMITATION`). The chip's own mass-erase command is reached
 * through ST's CLI, which talks to the same ST-Link:
 *
 *   STM32_Programmer_CLI -c port=SWD -e all
 *
 * Measured on this bench: after writing markers at `0x08010000` and
 * `0x080C0000`, running this left both reading `0xFF`, along with the image at
 * `0x08000000`.
 */
export function massEraseCommand(input: { cli: string; port?: string; sn?: string }): string[] {
  const connect = [`port=${input.port ?? "SWD"}`];
  // With more than one probe attached ST's CLI refuses to guess and asks for
  // the serial number; naming it is the only way to pick one.
  if (input.sn) connect.push(`sn=${input.sn}`);
  return [input.cli, "-c", connect.join(" "), "-e", "all"];
}

/** Whether the CLI's own output says the chip was erased. */
export function massEraseSucceeded(output: string): boolean {
  return /mass erase successfully achieved/i.test(output);
}

/** Why a mass erase cannot run here, and what it would take. */
export function massEraseUnavailableReason(): string {
  return (
    "a full-chip erase needs STM32_Programmer_CLI (STM32CubeProgrammer), and it was not found. " +
    "uVision cannot do it on this target: it never answers PRJ_FLASH_ERASE, and a download only erases " +
    "the sectors its own image occupies — measured, a marker past the image survived a download untouched. " +
    "With the CLI installed, `-c port=SWD -e all` erases the whole chip."
  );
}

/* ---------- struct members ---------- */

export interface StructMember {
  id: number;
  /** Byte offset within the struct, as the debugger reports it. */
  offset: number;
  /** Size in bytes; 0 for a member the debugger does not size. */
  size: number;
  name: string;
}

/**
 * The `ENUMTPM` request that asks for a struct's members.
 *
 * The name goes at **offset 44**, where `szID` starts:
 *
 *   ENTPJOB Job(4)  UINT nOffs(4)  UINT nSize(4)  UINT nRes[8](32)  char szID[512]
 *
 * Placing it at 48 — as one earlier attempt did — shifts it four bytes past the
 * start, so the debugger reads a name that begins with the tail of a previous
 * field and answers `PARSE_ERROR: Identifier not found` for every struct. That
 * refusal was recorded as "needs a symbol-table id this build does not expose";
 * it was a wrong offset.
 */
export function symtpRequest(symbol: string): Buffer {
  const payload = Buffer.alloc(44 + 512);
  payload.writeUInt32LE(1, 0); // UV_TPENUM_MEMBERS
  payload.writeUInt32LE(0, 4); // nOffs
  payload.writeUInt32LE(0, 8); // nSize
  encodeGbk(symbol).copy(payload, 44);
  return payload;
}

/**
 * Decode `0x5012` member frames.
 *
 * The fixed record is 44 bytes and the name starts exactly there — measured,
 * byte for byte, for `lcddev`'s `width`:
 *
 *   01000000 00000000 02000000 01000000 e06b0008… e06b0008… ffffffff 00000000
 *   00000000 7769647468 00
 *   ID=1     offset=0  size=2   …                                    "width"
 *
 * `offset` and `size` are the fields that matter and they are the second and
 * third words. Reading the name from 12 — where the fixed part was assumed to
 * end — picked up six words of counters and returned labels like
 * `Entered Debug Mode OK`.
 *
 * The burst is bracketed by `0x5011` (start) and `0x5013` (end); neither
 * carries a member, and a frame shorter than the fixed record is skipped rather
 * than read as one.
 */
export function parseStructMembers(frames: AsyncFrame[]): StructMember[] {
  const out: StructMember[] = [];
  for (const frame of frames) {
    if (frame.type !== 0x5012) continue;
    const data = frame.data;
    if (data.length <= 44) continue;
    const id = data.readUInt32LE(0);
    const offset = data.readUInt32LE(4);
    const size = data.readUInt32LE(8);
    const name = decodeGbk(data.subarray(44)).replace(/\0.*$/s, "").trim();
    if (!name) continue;
    out.push({ id, offset, size, name });
  }
  return out;
}

/**
 * The members of a struct/union variable.
 *
 * `DBG_ENUM_SYMTP` is not listed as unsupported: measured on 5.43.1 it answers
 * a struct name with its whole member list. A scalar (`uwTick`) still gets
 * `Identifier not found`, which is the right answer — a scalar has no members.
 */
export async function readStructMembers(session: KeilSession, symbol: string): Promise<{ ok: boolean; members: StructMember[]; message?: string }> {
  const mark = session.client.mark;
  const reply = await session.client.send(OP.DBG_ENUM_SYMTP, symtpRequest(symbol), 10_000);
  if (!reply.ok) return { ok: false, members: [], ...(reply.message ? { message: reply.message } : {}) };
  const frames = await session.client.collect(2_000, 0x5013, mark);
  return { ok: true, members: parseStructMembers(frames) };
}

/** The current target's output file name. */
export async function getOutputName(session: KeilSession): Promise<string> {
  const reply = await session.client.send(OP.PRJ_GET_OUTPUTNAME, Buffer.alloc(4), 8_000);
  return reply.ok ? readSstr(reply.data, 0) : "";
}

/**
 * Whether the debugger's output-name reply is the name that was written.
 *
 * The reply carries the whole path — measured, setting `app.axf` answers
 * `..\OBJ\app.axf` — because uVision prepends the target's `OutputDirectory`.
 * Comparing it with the bare name the caller sent made every successful rename
 * report "still reports ..., nothing was changed". The comparison is therefore
 * on the last path segment, case-insensitively, which is the rule Windows
 * itself applies to the file it names.
 */
export function sameOutputName(stored: string, wanted: string): boolean {
  const base = (value: string) => (value.split(/[\\/]/).pop() ?? value).trim().toLowerCase();
  if (!stored.trim()) return false;
  return base(stored) === base(wanted);
}

/**
 * The built image a `file:line` breakpoint is resolved against, and the
 * `fromelf` that reads its line table.
 *
 * The path comes from the project's own `OutputName` and `OutputDirectory`,
 * the same two fields the build writes through — not from a guess at the
 * traditional `OBJ\` layout, which an edited project does not have.
 */
export interface ImageLocation {
  elf: string;
  fromelf: string;
}

export async function imageLocation(session: KeilSession): Promise<ImageLocation | { error: string }> {
  const projectFile = session.project;
  let xml = "";
  try {
    xml = readFileSync(projectFile, "utf8").replace(/^﻿/, "");
  } catch {
    return { error: `could not read ${projectFile} to find the output image` };
  }
  // A multi-target project has one `<Target>` block per target, each with its
  // own `<OutputDirectory>` and `<OutputName>`. Reading the first one in the
  // file would resolve a `file:line` against the wrong image after
  // `set_target`; measured on a two-target project, the targets write to
  // `..\OBJ\` and `..\OBJ_SIM\`.
  const active = await currentTarget(session).catch(() => "");
  const blocks = [...xml.matchAll(/<Target>([\s\S]*?)<\/Target>/g)].map((match) => match[1]);
  const block = blocks.find((body) => {
    const name = /<TargetName>([^<]*)<\/TargetName>/.exec(body)?.[1]?.trim();
    return name !== undefined && name === active;
  }) ?? blocks[0] ?? xml;
  const outputName = /<OutputName>([^<]*)<\/OutputName>/.exec(block)?.[1]?.trim() || (projectFile.split(/[\\/]/).pop() ?? "project").replace(/\.uvprojx?$/i, "");
  const outputDir = /<OutputDirectory>([^<]*)<\/OutputDirectory>/.exec(block)?.[1]?.trim() || ".";
  // `join(projectFile, "..", output)` happens to work for `..\OBJ` and
  // `Objects`, but an absolute or UNC output directory becomes
  // `<projectDir>/D:/build/obj/app.axf`. The rule is the same one
  // `keilOutputDirs` uses: resolve against the project file's directory.
  const elf = resolve(dirname(projectFile), outputDir.replace(/\\/g, "/"), `${outputName}.axf`);
  const fromelf = fromelfFor(session.client.programPath);
  if (!fromelf) return { error: "fromelf was not found in this Keil install, so the image's line table cannot be read" };
  return { elf, fromelf };
}

/* ---------- operations beyond the core loop ---------- */

export {
  addWatch,
  debugCommand,
  debugTargetKind,
  disassemble,
  evalInWindow,
  evaluate,
  execMenu,
  ideVersion,
  ideVersionText,
  licenseInfo,
  NEEDS_EXTENDED_STACK,
  readMenus,
  readScvdFiles,
  readVtrValue,
  closeProject,
  readNamedRegisters,
  registerItm,
  removeWatch,
  resetTarget,
  runToAddress,
  setEventRecorder,
  setOutputName,
  setVariable,
  setVtr,
  showCodeAt,
  stepMany,
  timeInfo,
  UNSUPPORTED_ON_MDK_5_43,
  windowState,
  writeRegister,
} from "./keilExtra.js";
