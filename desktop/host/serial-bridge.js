/**
 * Serial bridge for the host — in-process, backed by the `serialport` package.
 *
 * History: this was a PowerShell child process ("pump") to avoid a native
 * dependency. It died four times in the field — PS event quirks, orphaned
 * pumps wedging the CH340 driver, `$script:` scoping crashes, and finally
 * Kaspersky killing inline `-Command` scripts mid-session plus UTF-8
 * corruption on multi-byte characters split across read boundaries. The
 * user's verdict was right: mature serial assistants all use `serialport`,
 * so the bridge now opens the port directly in the host process. No child,
 * no AV interaction, native binary-safe reads.
 *
 * The external contract is unchanged:
 *   open/close/write/setLine/setBaud/ringTail/listSerialPorts
 *   events: serial_lines (debounced batches) | serial_stats | serial_state | serial_snapshot
 *   ring mirror: the agent's embed_serial MCP tool reads ring.json
 */

import { SerialPort } from "serialport";
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Ring kept by the host so an agent can read the tail without owning the port. */
export const RING_MAX_LINES = 500;
/** One `serial_lines` event carries at most this many lines. */
const FLUSH_MAX_LINES = 200;
/** Idle time before a partial batch flushes anyway. */
const FLUSH_DEBOUNCE_MS = 150;
/**
 * Where the ring is mirrored for the agent. The MCP server is a separate
 * process — it cannot read this host's memory — so every flush rewrites one
 * small JSON file (atomic via rename) and `embed_serial` reads that. Global,
 * not per-session: the monitor outlives any one conversation.
 */
export function serialRingPath(home = process.env.HARNESS_HOME?.trim() || path.join(os.homedir(), ".harness")) {
  return path.join(home, "serial", "ring.json");
}

/**
 * Where the agent's MCP server drops write requests for the panel's session.
 *
 * The panel owns the COM handle, so `embed_serial write` cannot open a second
 * one — Windows refuses. The MCP tool therefore writes a request file and the
 * host, which already owns the port, executes it and writes the reply. One
 * consumer per file: the host drains the requests directory every tick.
 */
export function serialMailboxDir(home = process.env.HARNESS_HOME?.trim() || path.join(os.homedir(), ".harness")) {
  return path.join(home, "serial", "requests");
}
/** Max characters buffered for one line. */
const LINE_MAX_CHARS = 8192;
/** How long the port gets to report open success before the open is declared failed. */
const READY_TIMEOUT_MS = 8000;

/**
 * Normalize a caller's encoding name to the two the decoder supports.
 * Unknown names fall back to utf-8 rather than failing the open: the port is
 * still usable, and the pane shows what it decoded.
 */
function normalizeEncoding(value) {
  const name = String(value ?? "").trim().toLowerCase().replace(/[_-]/g, "");
  if (name === "gbk" || name === "gb2312" || name === "gb18030") return "gbk";
  return "utf-8";
}

/**
 * Level classification for the log gutter. Matches the renderer's filters
 * (全部 / 警告+ / 错误) — the same heuristic the pump used to apply.
 */
function levelOf(text) {
  const t = String(text).toLowerCase();
  if (t.includes("error") || t.includes("err") || t.includes("fail") || t.includes("assert") || t.includes("panic") || t.includes("hardfault") || t.includes("oops")) return "error";
  // "[W]" / "W:" prefixes are common MCU log styles alongside the full word.
  if (t.includes("warn") || t.includes("[w]") || t.startsWith("w:") || t.includes("注意") || t.includes("警告")) return "warn";
  return "info";
}

export async function listSerialPorts() {
  try {
    const ports = await SerialPort.list();
    return ports
      .map((p) => ({ path: p.path, vendorId: p.vendorId ?? "", productId: p.productId ?? "", friendly: p.friendlyName ?? p.path }))
      .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }));
  } catch (error) {
    // R3: report the failure instead of an empty list that reads as "none".
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Split a text chunk into complete lines. A line ends on CR, LF or CRLF; the
 * final unterminated fragment is returned as `rest` and held until more bytes
 * arrive or the port closes. Binary chunks that don't decode as UTF-8 are
 * passed through with replacement characters rather than dropped.
 */
function splitLines(text) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch !== "\r" && ch !== "\n") continue;
    let end = i;
    if (ch === "\r" && text[i + 1] === "\n") i += 1;
    lines.push(text.slice(start, end));
    start = i + 1;
  }
  return { lines, rest: text.slice(start) };
}

/**
 * One open port per `open`; torn down by `close` or when the port errors.
 * Events leave through the `send` callback the host provides.
 */
export class SerialBridge {
  /** @type {Map<string, {port: object, name: string, baud: number, ring: object[], dropped: number, dead: boolean, ready: boolean, pending: object[], flushTimer: any, partial: string, rxBytes: number, txBytes: number}>} */
  #sessions = new Map();
  /** Ring-mirror write failures since construction; surfaced for honesty. */
  #mirrorFailures = 0;
  /** @type {(message: object) => void} */
  #send;
  /** Port constructor; injectable for tests (SerialPortMock). */
  #PortCtor;
  /** Mailbox poll timer; started lazily by `startMailbox`. */
  #mailboxTimer = null;

  constructor(send, portCtor = SerialPort) {
    this.#send = send ?? (() => {});
    this.#PortCtor = portCtor;
  }

  /**
   * Start serving the agent's write requests.
   *
   * The MCP server cannot open the panel's port, so `embed_serial write`
   * leaves a request file here; this loop — running in the process that does
   * own the handle — executes it and writes the answer beside it. Started by
   * the host at boot and never stopped: an idle tick costs one readdir.
   */
  startMailbox(intervalMs = 120) {
    if (this.#mailboxTimer !== null) return;
    this.#mailboxTimer = setInterval(() => this.#drainMailbox(), intervalMs);
    this.#mailboxTimer.unref?.();
  }

  stopMailbox() {
    if (this.#mailboxTimer === null) return;
    clearInterval(this.#mailboxTimer);
    this.#mailboxTimer = null;
  }

  /** Handle every pending request; each one is deleted after its reply lands. */
  #drainMailbox() {
    const dir = serialMailboxDir();
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return; // No directory yet: nobody has asked for a write.
    }
    for (const name of entries) {
      if (!name.endsWith(".req.json")) continue;
      const requestPath = path.join(dir, name);
      const replyPath = path.join(dir, name.replace(/\.req\.json$/, ".res.json"));
      let request;
      try {
        request = JSON.parse(readFileSync(requestPath, "utf8"));
      } catch {
        // A half-written request (the writer renames atomically, but an old
        // file from a crashed writer is possible) is dropped, not retried
        // forever.
        try { renameSync(requestPath, `${requestPath}.bad`); } catch { /* ignore */ }
        continue;
      }
      const answer = this.#serveMailboxRequest(request);
      try {
        const tmp = `${replyPath}.tmp`;
        writeFileSync(tmp, JSON.stringify(answer), "utf8");
        renameSync(tmp, replyPath);
        unlinkSync(requestPath);
      } catch {
        // If the reply cannot land, leave the request for the next tick
        // rather than losing the write silently.
      }
    }
  }

  /** Execute one request against the panel's live session (R3: never fake it). */
  #serveMailboxRequest(request) {
    const port = String(request.port ?? "");
    const session = this.#sessions.get(port);
    if (session === undefined || !session.ready || session.dead) {
      return { ok: false, error: `面板未打开 ${port}（或已断开）；先在面板里开始串口` };
    }
    const before = session.rxBytes;
    if (request.op === "write") {
      const data = String(request.data ?? "");
      // The pane replays the agent's write as a real user action — typing into
      // the input, then pressing Send — so the operator can see who sent what
      // instead of characters appearing from nowhere. The event goes out
      // BEFORE the bytes so the animation starts as the port transmits.
      this.#send({
        type: "serial_agent_write",
        port,
        data,
        hex: request.hex === true,
        source: String(request.source ?? "agent"),
      });
      const ok = this.write(port, data, { hex: request.hex === true });
      if (!ok) return { ok: false, error: "写入失败：面板拒绝（会话已断或数据为空）" };
      return { ok: true, port, wrote: data.length, rxBefore: before };
    }
    if (request.op === "setLine") {
      const ok = this.setLine(port, String(request.line ?? ""), request.value === true);
      return ok ? { ok: true, port } : { ok: false, error: "设置 DTR/RTS 失败" };
    }
    if (request.op === "setEncoding") {
      const ok = this.setEncoding(port, String(request.encoding ?? ""));
      return ok ? { ok: true, port, encoding: session.encoding } : { ok: false, error: "切换编码失败" };
    }
    return { ok: false, error: `未知请求 op=${String(request.op)}` };
  }

  /** Ports this bridge currently holds. */
  get openPorts() {
    return [...this.#sessions.keys()];
  }

  sessionOf(port) {
    return this.#sessions.get(port) ?? null;
  }

  /**
   * Ring tail for the agent. `maxLines` from the end, or everything after
   * ring index `since` — the ring index, not `line.at`, is the cursor
   * because burst arrivals can share a timestamp.
   */
  ringTail(port, maxLines, since = 0) {
    const session = this.#sessions.get(port);
    if (session === undefined) return null;
    const ring = session.ring;
    const start = since > 0 ? Math.min(since, ring.length) : Math.max(0, ring.length - maxLines);
    return {
      port: session.port,
      baud: session.baud,
      connected: session.ready && !session.dead,
      lines: ring.slice(start, start + maxLines),
      total: ring.length,
      dropped: session.dropped,
    };
  }

  /**
   * Open `port` at `baud`. Answers `{ok:true, snapshot}` or `{ok:false, error}`;
   * the snapshot is what the renderer's first `serial_snapshot` carries.
   *
   * `options.encoding` picks the RX text codec: `utf-8` (default) or `gbk`.
   * Keil and most Chinese MCU tutorials print in GBK, and decoding those bytes
   * as UTF-8 turns every Chinese message into replacement characters — the
   * board's output is correct, the codec was wrong.
   */
  async open(port, baud, options = {}) {
    if (this.#sessions.has(port)) {
      return { ok: false, error: `端口已被本宿主打开：${port}` };
    }
    const rate = Number(baud);
    if (!Number.isInteger(rate) || rate < 300 || rate > 4_000_000) {
      return { ok: false, error: `波特率无效：${baud}` };
    }
    const encoding = normalizeEncoding(options.encoding);
    const session = {
      port: null,
      name: port,
      baud: rate,
      encoding,
      ring: [],
      dropped: 0,
      dead: false,
      ready: false,
      pending: [],
      flushTimer: null,
      partial: "",
      rxBytes: 0,
      txBytes: 0,
      // Streaming decoder: the TextDecoder carries partial multi-byte
      // sequences between chunks, so a character split across reads
      // reassembles. Node ships built-in decoders for utf-8 and gbk.
    };
    session.decoder = new TextDecoder(encoding === "gbk" ? "gbk" : "utf-8");
    // False positives only: paths in server / kernel error strings stay ASCII.
    /* eslint-disable-next-line no-irregular-whitespace */
    return new Promise((resolve) => {
      let settled = false;
      const settle = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(readyTimer);
        resolve(result);
      };
      const readyTimer = setTimeout(() => {
        session.dead = true;
        try { session.port?.close(); } catch { /* already gone */ }
        settle({ ok: false, error: `打开串口超时（${READY_TIMEOUT_MS}ms）` });
      }, READY_TIMEOUT_MS);

      let sp;
      try {
        sp = new this.#PortCtor({ path: port, baudRate: rate, autoOpen: false });
      } catch (error) {
        settle({ ok: false, error: `无法创建串口：${error instanceof Error ? error.message : String(error)}` });
        return;
      }
      session.port = sp;

      sp.on("open", () => {
        session.ready = true;
        this.#sessions.set(port, session);
        settle({ ok: true, snapshot: { open: true, port, baud: rate, lines: session.ring, dropped: session.dropped } });
      });

      sp.on("error", (error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (!settled) {
          session.dead = true;
          clearTimeout(readyTimer);
          settle({ ok: false, error: `打开串口失败：${message}` });
          return;
        }
        if (!session.dead) {
          this.#teardown(session);
          this.#sessions.delete(port);
          this.#send({ type: "serial_state", open: false, port, baud: session.baud, error: `串口错误：${message}` });
        }
      });

      sp.on("close", () => {
        if (!settled) {
          session.dead = true;
          clearTimeout(readyTimer);
          settle({ ok: false, error: "串口在打开过程中被关闭" });
          return;
        }
        if (!session.dead) {
          this.#teardown(session);
          this.#sessions.delete(port);
          this.#send({ type: "serial_state", open: false, port, baud: session.baud });
        }
      });

      // Binary-safe RX: decode per-chunk with a streaming TextDecoder held in
      // the session, so multi-byte UTF-8 sequences split across reads
      // reassemble (the pump's fatal flaw). Invalid bytes become U+FFFD.
      sp.on("data", (chunk) => {
        session.rxBytes += chunk.length;
        const text = session.decoder.decode(chunk, { stream: true });
        const { lines, rest } = splitLines(text);
        const buffer = session.partial + (lines.length > 0 ? lines.shift() : "");
        session.partial = rest;
        if (buffer.length > 0 || lines.length > 0) {
          this.#acceptLine(session, buffer, lines);
        }
        this.#sendStats(session);
      });

      sp.open((error) => {
        if (error) {
          const message = error instanceof Error ? error.message : String(error);
          session.dead = true;
          clearTimeout(readyTimer);
          settle({ ok: false, error: `打开串口失败：${message}` });
        }
        // Success path is the `open` event above.
      });
    });
  }

  /**
   * Write text (UTF-8) or raw bytes (`hex: true`). Returns false when the
   * port is not ours or the data is empty; the caller surfaces the refusal.
   */
  write(port, data, { hex = false } = {}) {
    const session = this.#sessions.get(port);
    if (session === undefined || !session.ready || session.dead) return false;
    const text = String(data ?? "");
    if (text.length === 0) return false;
    try {
      if (hex) {
        const clean = text.replace(/\s+/g, "");
        if (!/^[0-9a-fA-F]+$/.test(clean) || clean.length % 2 !== 0) return false;
        const bytes = Buffer.from(clean, "hex");
        if (bytes.length === 0) return false;
        session.port.write(bytes);
        session.txBytes += bytes.length;
      } else {
        const bytes = Buffer.from(text, "utf8");
        session.port.write(bytes);
        session.txBytes += bytes.length;
      }
      this.#sendStats(session);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Toggle a modem line (board reset).
   *
   * `serialport` v13 removed `setDTR`/`setRTS` from the port: modem lines now
   * go through `set()`, which forwards the options to the native binding. The
   * callback form mirrors `update()`; a throw means the driver refused.
   */
  setLine(port, line, value) {
    const session = this.#sessions.get(port);
    if (session === undefined || !session.ready || session.dead) return false;
    if (line !== "dtr" && line !== "rts") return false;
    try {
      session.port.set({ [line]: Boolean(value) }, () => {});
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Switch the RX text codec on a live session. The decoder is replaced (not
   * flushed): a half-received character in the old codec would otherwise
   * poison the first line after the switch.
   */
  setEncoding(port, encoding) {
    const session = this.#sessions.get(port);
    if (session === undefined || !session.ready || session.dead) return false;
    const next = normalizeEncoding(encoding);
    session.encoding = next;
    session.decoder = new TextDecoder(next === "gbk" ? "gbk" : "utf-8");
    session.partial = "";
    this.#send({ type: "serial_state", open: true, port, baud: session.baud, encoding: next });
    return true;
  }

  /** Change baud rate without dropping the line. */
  setBaud(port, baud) {
    const session = this.#sessions.get(port);
    if (session === undefined || !session.ready || session.dead) return false;
    const rate = Number(baud);
    if (!Number.isInteger(rate) || rate < 300 || rate > 4_000_000) return false;
    try {
      session.port.update({ baudRate: rate });
      session.baud = rate;
      this.#send({ type: "serial_state", open: true, port, baud: rate });
      return true;
    } catch {
      return false;
    }
  }

  /** Close one port; resolves once the session is gone. */
  async close(port) {
    const session = this.#sessions.get(port);
    if (session === undefined) return false;
    if (!session.dead) {
      this.#teardown(session);
      this.#sessions.delete(port);
    }
    await new Promise((resolve) => {
      try {
        session.port.drain(() => {
          session.port.close(() => resolve());
        });
      } catch {
        resolve();
      }
      // A wedged driver must not hold the close forever; force it.
      setTimeout(resolve, 1500).unref();
    });
    try { session.port.close(() => {}); } catch { /* second close is a no-op */ }
    this.#send({ type: "serial_state", open: false, port, baud: session.baud });
    return true;
  }

  /** Shutdown path: every session goes, and the pending tails flush first. */
  closeAll() {
    const ports = [...this.#sessions.keys()];
    return Promise.all(ports.map((port) => this.close(port)));
  }

  /** Flush pending lines, then mark the session dead so `data` stops flowing. */
  #teardown(session) {
    session.dead = true;
    this.#flushPending(session);
    if (session.flushTimer !== null) {
      clearTimeout(session.flushTimer);
      session.flushTimer = null;
    }
  }

  /**
   * Accept one complete line (the carried partial) plus any further complete
   * lines from the same chunk. The pending batch flushes on count or debounce.
   */
  #acceptLine(session, first, rest) {
    const lines = first.length > 0 ? [first, ...rest] : rest;
    for (const raw of lines) {
      const text = raw.length > LINE_MAX_CHARS ? raw.slice(0, LINE_MAX_CHARS) : raw;
      const line = { text, at: Date.now(), level: levelOf(text) };
      session.ring.push(line);
      if (session.ring.length > RING_MAX_LINES) {
        const excess = session.ring.length - RING_MAX_LINES;
        session.ring.splice(0, excess);
        session.dropped += excess;
      }
      session.pending.push(line);
    }
    if (session.pending.length >= FLUSH_MAX_LINES) {
      this.#flushPending(session);
    } else if (session.flushTimer === null) {
      // Small lines trickle: batch them, but never hold the tail hostage —
      // a 150ms debounce keeps bursts coalesced and stragglers visible.
      session.flushTimer = setTimeout(() => {
        session.flushTimer = null;
        this.#flushPending(session);
      }, FLUSH_DEBOUNCE_MS);
      session.flushTimer.unref?.();
    }
  }

  /** Send the batch out and refresh the agent's ring mirror. */
  #flushPending(session) {
    if (session.flushTimer !== null) {
      clearTimeout(session.flushTimer);
      session.flushTimer = null;
    }
    if (session.pending.length === 0) return;
    const batch = session.pending.splice(0, session.pending.length);
    this.#send({ type: "serial_lines", port: session.name, lines: batch, dropped: session.dropped });
    this.#writeMirror();
  }

  /** RX/TX byte counters for the status bar (XCOM's S:/R: pair). */
  #sendStats(session) {
    this.#send({ type: "serial_stats", port: session.name, rx: session.rxBytes, tx: session.txBytes });
  }

  /**
   * Mirror the whole ring to disk for the MCP side. Atomic via tmp+rename;
   * failures count but never throw — the mirror is a side channel, and the
   * failure surfaces through `mirrorState` instead of a silent success.
   */
  #writeMirror() {
    const file = serialRingPath();
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      const ports = [...this.#sessions.values()].map((session) => ({
        port: session.name,
        baud: session.baud,
        owner: "panel",
        total: session.ring.length,
        dropped: session.dropped,
        lines: session.ring.slice(-100),
      }));
      const payload = JSON.stringify({ updatedAt: Date.now(), ports }, null, 1);
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, payload, "utf8");
      renameSync(tmp, file);
    } catch {
      this.#mirrorFailures += 1;
    }
  }

  /** Mirror health for honesty surfaces: 0 means every write succeeded. */
  get mirrorState() {
    return { failures: this.#mirrorFailures };
  }
}
