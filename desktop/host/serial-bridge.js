/**
 * Serial bridge for the host.
 *
 * Opens a real COM port through a PowerShell child process (the "pump"):
 * .NET's `System.IO.Ports.SerialPort` needs no native module, no Electron ABI
 * match and no npm dependency, and the pump was proven against this machine's
 * adapters during the F429 debugging sessions. Bytes read from the port flow
 * out as NDJSON on the pump's stdout; writes and the close op flow in on
 * stdin.
 *
 * Pump protocol (one JSON object per line):
 *   pump -> host: {ev:"ready"} | {ev:"line", text, at} | {ev:"error", message}
 *   host -> pump: {op:"write", data} | {op:"close"}  (EOF closes too)
 *
 * Concurrency: the pump's main thread blocks on stdin (`ReadLine`), while
 * `SerialPort.DataReceived` fires on a threadpool thread and writes lines
 * straight to stdout — `Console.Out` is synchronized, so the two never
 * interleave mid-line. The host is the only one splitting/deciding.
 *
 * Line discipline: a line ends on CR, LF or CRLF. An unterminated partial is
 * held until more bytes arrive or the port closes — a periodic idle flush
 * would duplicate the tail in the ring every 50ms.
 */

import childProcess from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
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
/** Max characters buffered for one line, both sides of the pump. */
const LINE_MAX_CHARS = 8192;
/** How long the pump gets to report `ready` before the open is declared failed. */
const READY_TIMEOUT_MS = 8000;

// The config line arrives on stdin first; the port must be open before the
// pump reports ready, so the host never shows a connected state too early.
const PUMP_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
# Console.Out under a piped host is the system ANSI codepage (gb2312 here):
# every non-ASCII line would leave the pump mis-encoded for the UTF-8 reader.
# Pin both console encodings to UTF-8 before anything is emitted.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$config = [Console]::In.ReadLine() | ConvertFrom-Json
try {
  $script:serial = [System.IO.Ports.SerialPort]::new($config.port, [int]$config.baud, [System.IO.Ports.Parity]::None, 8, [System.IO.Ports.StopBits]::One)
  $script:serial.ReadBufferSize = 65536
  $script:serial.WriteTimeout = 2000
  # The default encoding is ASCII: every non-ASCII byte the MCU prints
  # would arrive as '?'. UTF-8 both ways; NDJSON on stdout is UTF-8 too.
  $script:serial.Encoding = [System.Text.Encoding]::UTF8
  $script:serial.Open()
} catch {
  [Console]::Out.WriteLine((@{ev='error';message="open failed: $($_.Exception.Message)"} | ConvertTo-Json -Compress))
  exit 1
}
$script:out = [Console]::Out
$script:pending = [System.Text.StringBuilder]::new()

function Emit {
  param([hashtable]$obj)
  $script:out.WriteLine(($obj | ConvertTo-Json -Compress))
}

function FlushLine {
  if ($script:pending.Length -gt 0) {
    $text = $script:pending.ToString()
    [void]$script:pending.Clear()
    if ($text.Length -gt 8192) { $text = $text.Substring(0, 8192) }
    Emit @{ev='line'; text=$text; at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}
  }
}

function Drain-Port {
  $n = $script:serial.BytesToRead
  if ($n -le 0) { return }
  $cbuf = New-Object char[] $n
  $read = $script:serial.Read($cbuf, 0, $n)
  for ($i = 0; $i -lt $read; $i++) {
    $c = $cbuf[$i]
    if ($c -eq [char]13 -or $c -eq [char]10) { FlushLine }
    else {
      [void]$script:pending.Append($c)
      if ($script:pending.Length -ge 8192) { FlushLine }
    }
  }
}

# Stdin through BeginRead: ReadLine blocks synchronously and DataAvailable on
# OpenStandardInput() stays false for a pipe from Node (both verified). The
# async read completes on a threadpool thread; we poll IsCompleted in the
# same loop that drains the port, so neither side starves the other.
$script:stdin = [Console]::OpenStandardInput()
$script:rbuf = New-Object byte[] 4096
$script:async = $null
$script:inLine = [System.Text.StringBuilder]::new()

function Pump-Stdin {
  if ($script:async -eq $null) {
    $script:async = $script:stdin.BeginRead($script:rbuf, 0, $script:rbuf.Length, $null, $null)
  }
  if (-not $script:async.IsCompleted) { return }
  $got = $script:stdin.EndRead($script:async)
  $script:async = $null
  # EOF on the pipe should mean the host is gone. (Does not always fire on
  # Windows — the parent-liveness poll below is the reliable backstop.)
  if ($got -le 0) { exit 0 }
  $text = [System.Text.Encoding]::UTF8.GetString($script:rbuf, 0, $got)
  foreach ($ch in $text.ToCharArray()) {
    if ($ch -eq [char]10) {
      $raw = $script:inLine.ToString().Trim()
      [void]$script:inLine.Clear()
      if ($raw -eq '') { continue }
      try { $op = $raw | ConvertFrom-Json } catch { continue }
      if ($op.op -eq 'write') {
        try { $script:serial.Write([string]$op.data) } catch { Emit @{ev='error';message="write failed: $($_.Exception.Message)"} }
      } elseif ($op.op -eq 'close') {
        $script:closeRequested = $true
      }
    } elseif ($ch -ne [char]13) {
      [void]$script:inLine.Append($ch)
    }
  }
}

Emit @{ev='ready'}

# Orphan guard: the host polls config through stdin, but stdin EOF does not
# always fire on Windows when the parent dies (verified live: a killed host
# left the pump holding the COM port indefinitely). Poll the parent PID —
# when it is gone, release the port and exit. The host passes its PID in the
# config line; every 2s is cheap and the worst case is a 2s-orphan.
$script:parentPid = [int]$config.parent_pid
$script:lastParentCheck = [DateTime]::UtcNow

$script:closeRequested = $false
while (-not $script:closeRequested) {
  Drain-Port
  Pump-Stdin
  if (($script:closeRequested -eq $false) -and (([DateTime]::UtcNow - $script:lastParentCheck).TotalMilliseconds -ge 2000)) {
    $script:lastParentCheck = [DateTime]::UtcNow
    $parentAlive = Get-Process -Id $script:parentPid -ErrorAction SilentlyContinue
    if (-not $parentAlive) {
      FlushLine
      try { $script:serial.Close() } catch { }
      exit 0
    }
  }
  Start-Sleep -Milliseconds 10
}
FlushLine
try { $script:serial.Close() } catch { }
`;

/**
 * One open port per `open`; torn down by `close` or when the pump dies.
 * Events leave through the `send` callback the host provides.
 */
export class SerialBridge {
  /** @type {Map<string, {pump: import("node:child_process").ChildProcess, port: string, baud: number, ring: object[], dropped: number, dead: boolean, ready: boolean, pending: object[], stderrTail: string}>} */
  #sessions = new Map();
  /** Ring-mirror write failures since construction; surfaced for honesty. */
  #mirrorFailures = 0;
  /** @type {(message: object) => void} */
  #send;

  constructor(send) {
    this.#send = send;
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
   */
  async open(port, baud) {
    if (this.#sessions.has(port)) {
      return { ok: false, error: `端口已被本宿主打开：${port}` };
    }
    const session = {
      pump: null,
      port,
      baud,
      ring: [],
      dropped: 0,
      dead: false,
      ready: false,
      pending: [],
      flushTimer: null,
      stderrTail: "",
    };
    return new Promise((resolve) => {
      let settled = false;
      const settle = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(readyTimer);
        resolve(result);
      };
      const readyTimer = setTimeout(() => {
        const tail = session.stderrTail.trim().split("\n").pop() ?? "";
        session.dead = true;
        this.#teardown(session);
        settle({ ok: false, error: `打开串口超时（${READY_TIMEOUT_MS}ms 内泵未就绪）${tail ? `：${tail}` : ""}` });
      }, READY_TIMEOUT_MS);

      let pump;
      try {
        // `-NoProfile` keeps startup fast and the environment clean; the
        // script goes over stdin (`-Command -`) because embedding it in the
        // command line fights quoting for every backtick and quote inside.
        pump = childProcess.spawn("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", PUMP_SCRIPT], {
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        clearTimeout(readyTimer);
        settle({ ok: false, error: `无法启动 PowerShell 泵：${error instanceof Error ? error.message : String(error)}` });
        return;
      }
      session.pump = pump;

      const failBeforeReady = (message) => {
        if (settled) {
          // Ready already answered: this is a runtime failure, not an open one.
          this.#send({ type: "serial_state", open: false, port: session.port, baud: session.baud, error: message });
          return;
        }
        session.dead = true;
        this.#teardown(session);
        clearTimeout(readyTimer);
        settle({ ok: false, error: message });
      };

      pump.on("error", (error) => failBeforeReady(`泵进程错误：${error.message}`));
      pump.stderr.on("data", (chunk) => {
        // Diagnostics only; the protocol lives on stdout. The last line is
        // what surfaces when the pump dies without ever reporting ready.
        session.stderrTail = `${session.stderrTail}${chunk}`.slice(-400);
      });
      pump.stdout.on("data", createLineSplitter((line) => {
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          return; // Not protocol; ignore rather than guess.
        }
        if (event.ev === "ready") {
          session.ready = true;
          this.#sessions.set(port, session);
          settle({ ok: true, snapshot: { open: true, port, baud, lines: session.ring, dropped: session.dropped } });
        } else if (event.ev === "line") {
          this.#acceptLine(session, event);
        } else if (event.ev === "error") {
          failBeforeReady(String(event.message ?? "串口泵错误"));
        }
      }));
      pump.on("exit", (code) => {
        if (!settled) {
          const tail = session.stderrTail.trim().split("\n").pop() ?? "";
          failBeforeReady(`泵在就绪前退出（code=${code}）${tail ? `：${tail}` : ""}`);
          return;
        }
        session.dead = true;
        this.#teardown(session);
        this.#sessions.delete(session.port);
        this.#send({
          type: "serial_state",
          open: false,
          port: session.port,
          baud: session.baud,
          error: code === 0 ? undefined : `串口泵退出（code=${code}）`,
        });
      });

      // One config line, then the pump opens the port and reports ready.
      // `parent_pid` is the orphan guard: when this host dies, the pump
      // polls the PID and releases the port (stdin EOF alone is unreliable).
      pump.stdin.write(`${JSON.stringify({ port, baud, parent_pid: process.pid })}\n`);
    });
  }

  /** Write raw data out the port. False when the port is not open here. */
  write(port, data) {
    const session = this.#sessions.get(port);
    if (session === undefined || !session.ready || session.dead) return false;
    try {
      session.pump.stdin.write(`${JSON.stringify({ op: "write", data: String(data) })}\n`);
      return true;
    } catch {
      return false;
    }
  }

  /** Close one port; resolves once the session is gone. */
  close(port) {
    const session = this.#sessions.get(port);
    if (session === undefined) return Promise.resolve(false);
    return new Promise((resolve) => {
      const pump = session.pump;
      const done = () => {
        // The `exit` handler has already cleaned the ring/state; a second
        // teardown from here would double-send, so just confirm.
        resolve(this.#sessions.get(port) === undefined);
      };
      pump.once("exit", done);
      try {
        pump.stdin.write(`${JSON.stringify({ op: "close" })}\n`);
        pump.stdin.end();
      } catch {
        pump.kill();
      }
      // A wedged pump must not hold the close forever; force it.
      setTimeout(() => {
        if (this.#sessions.get(port) === session) pump.kill();
      }, 1000).unref();
      setTimeout(() => resolve(false), 2500).unref();
    });
  }

  /** Shutdown path: every session goes, and the pending tails flush first. */
  closeAll() {
    const ports = [...this.#sessions.keys()];
    return Promise.all(ports.map((port) => this.close(port)));
  }

  #acceptLine(session, event) {
    const line = {
      text: String(event.text ?? ""),
      at: Number(event.at) || Date.now(),
      level: levelOf(event.text),
    };
    session.ring.push(line);
    if (session.ring.length > RING_MAX_LINES) {
      const excess = session.ring.length - RING_MAX_LINES;
      session.ring.splice(0, excess);
      session.dropped += excess;
    }
    session.pending.push(line);
    if (session.pending.length >= FLUSH_MAX_LINES) {
      this.#flushPending(session);
    } else if (session.flushTimer === null) {
      // Small lines trickle: batch them, but never hold the tail hostage —
      // a 150ms debounce keeps bursts coalesced and stragglers visible.
      session.flushTimer = setTimeout(() => {
        session.flushTimer = null;
        this.#flushPending(session);
      }, FLUSH_DEBOUNCE_MS);
    }
  }

  #flushPending(session) {
    if (session.pending.length === 0 && session.flushTimer === null) return;
    if (session.flushTimer !== null) {
      clearTimeout(session.flushTimer);
      session.flushTimer = null;
    }
    if (session.pending.length === 0) return;
    const lines = session.pending;
    session.pending = [];
    this.#send({ type: "serial_lines", port: session.port, lines, dropped: 0 });
    this.#mirrorRing();
  }

  /**
   * Rewrite the ring mirror. The agent reads the ring through the
   * `embed_serial` MCP tool, which is a different process: the file is the
   * only channel. Failure is swallowed-with-a-count — serial data must not
   * die because a mirror write hit a lock; the next flush retries.
   */
  #mirrorRing() {
    try {
      const file = serialRingPath();
      mkdirSync(path.dirname(file), { recursive: true });
      const ports = [...this.#sessions.entries()].map(([port, session]) => ({
        port,
        baud: session.baud,
        owner: "panel",
        total: session.ring.length + session.dropped,
        dropped: session.dropped,
        lines: session.ring,
      }));
      const payload = JSON.stringify({ updatedAt: Date.now(), ports });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, payload, "utf8");
      renameSync(tmp, file);
    } catch {
      this.#mirrorFailures += 1;
    }
  }

  /**
   * Flush the pending tail so close/exit never loses the last lines. Called
   * at most once per session from teardown.
   */
  #teardown(session) {
    this.#flushPending(session);
    try {
      session.pump?.kill();
    } catch {
      // Already gone; nothing to report — the exit event owns the notice.
    }
  }
}

/** Split an NDJSON stream on \n, feeding complete lines to `onLine`. */
function createLineSplitter(onLine) {
  let rest = "";
  return (chunk) => {
    rest += chunk.toString("utf8");
    let index;
    while ((index = rest.indexOf("\n")) >= 0) {
      const line = rest.slice(0, index).trim();
      rest = rest.slice(index + 1);
      if (line !== "") onLine(line);
    }
  };
}

/** A line that looks like a warning or an error gets the renderer's colour. */
function levelOf(text) {
  const t = String(text ?? "").toLowerCase();
  if (/(^|\W)(error|err|assert|failed|fault|hardfault)(\W|$)/.test(t)) return "error";
  if (/(^|\W)(warn|warning)(\W|$)/.test(t)) return "warn";
  return undefined;
}

/**
 * Enumerate COM ports, friendly names included (CH340 vs ST-Link VCP is the
 * difference the user actually needs). WMI in a short-lived PowerShell —
 * the same zero-dependency route as the pump.
 */
export async function listSerialPorts() {
  const script =
    "$ErrorActionPreference='SilentlyContinue'; " +
    "Get-CimInstance Win32_PnPEntity -Filter \"Name LIKE '%(COM%'\" | " +
    "ForEach-Object { $m = [regex]::Match($_.Name, '\\((COM\\d+)\\)'); " +
    "if ($m.Success) { @{path=$m.Groups[1].Value; description=$_.Name} } } | " +
    "ConvertTo-Json -Compress";
  return new Promise((resolve) => {
    let child;
    try {
      child = childProcess.spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      resolve([]);
      return;
    }
    let out = "";
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* racing an exit is fine */ }
      resolve([]);
    }, 5000);
    child.stdout.on("data", (chunk) => {
      out += chunk.toString("utf8");
    });
    child.on("exit", () => {
      clearTimeout(timer);
      const text = out.trim();
      if (text === "") {
        resolve([]);
        return;
      }
      try {
        // One entry comes back as a bare object, several as an array.
        const parsed = JSON.parse(text);
        const ports = (Array.isArray(parsed) ? parsed : [parsed])
          .map((entry) => ({ path: String(entry.path ?? ""), description: String(entry.description ?? "") }))
          .filter((entry) => /^COM\d+$/.test(entry.path));
        resolve(ports);
      } catch {
        resolve([]);
      }
    });
  });
}
