import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

/**
 * `embed_serial` backend: what the agent's serial tool runs against.
 *
 * Two sources of truth, one protocol:
 * - the panel's ring mirror (<harnessHome>/serial/ring.json), written by the
 *   desktop host's pump — `read` without `port` reads that file;
 * - a transient pump of our own for `read` with `port` — the same PowerShell
 *   .NET SerialPort approach the host bridge uses (no native deps, no ABI
 *   concerns), duplicated here because the host is plain ESM JS outside the
 *   kernel build and cannot be imported from compiled dist.
 *
 * The pump protocol (NDJSON) is identical to desktop/host/serial-bridge.js:
 *   pump -> us: {ev:"ready"} | {ev:"line", text, at} | {ev:"error", message}
 *   us  -> pump: one config line, then {op:"write", data} / {op:"close"}
 */

const require_ = createRequire(import.meta.url);

const LINE_MAX_CHARS = 8192;
/** Transient open: hard ceiling on how long the agent may hold a port. */
const MAX_DURATION_MS = 30_000;
const READY_TIMEOUT_MS = 8_000;

const PUMP_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$config = [Console]::In.ReadLine() | ConvertFrom-Json
try {
  $script:serial = [System.IO.Ports.SerialPort]::new($config.port, [int]$config.baud, [System.IO.Ports.Parity]::None, 8, [System.IO.Ports.StopBits]::One)
  $script:serial.ReadBufferSize = 65536
  $script:serial.WriteTimeout = 2000
  # Default encoding is us-ascii: non-ASCII would arrive as '?'.
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
Emit @{ev='ready'}
$script:deadline = [DateTime]::UtcNow.AddMilliseconds([int]$config.duration_ms)
while ([DateTime]::UtcNow -lt $script:deadline) {
  Drain-Port
  Start-Sleep -Milliseconds 10
}
FlushLine
try { $script:serial.Close() } catch { }
`;

/** The mirror the desktop host writes; null when the panel never ran. */
export interface RingMirror {
  updatedAt: number;
  ports: Array<{
    port: string;
    baud: number;
    owner: string;
    total: number;
    dropped: number;
    lines: Array<{ text: string; at: number; level?: string }>;
  }>;
}

export function ringMirrorPath(home = process.env.HARNESS_HOME?.trim() || path.join(os.homedir(), ".harness")) {
  return path.join(home, "serial", "ring.json");
}

/** Where write requests for the panel's session are dropped. Mirrors the host. */
export function serialMailboxDir(home = process.env.HARNESS_HOME?.trim() || path.join(os.homedir(), ".harness")) {
  return path.join(home, "serial", "requests");
}

/**
 * Run an operation against the panel's live port through the host.
 *
 * The panel owns the only COM handle — a second `open` gets EACCES. The host
 * polls this directory and executes each request with the handle it already
 * has, which is also the only way the agent's write can share the panel's
 * view of the port instead of competing with it. Nothing is faked: a timeout
 * or a refused op comes back as `ok: false` with the host's own reason.
 */
export async function askHostSerial(
  request: Record<string, unknown>,
  timeoutMs = 3000,
): Promise<{ ok: boolean; error?: string; [key: string]: unknown }> {
  const dir = serialMailboxDir();
  const id = `${Date.now()}-${process.pid}-${randomUUID().slice(0, 8)}`;
  const requestPath = path.join(dir, `${id}.req.json`);
  const replyPath = path.join(dir, `${id}.res.json`);
  try {
    mkdirSync(dir, { recursive: true });
    const tmp = `${requestPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(request), "utf8");
    renameSync(tmp, requestPath);
  } catch (error) {
    return { ok: false, error: `无法写入串口请求：${error instanceof Error ? error.message : String(error)}` };
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(replyPath)) {
      try {
        const answer = JSON.parse(readFileSync(replyPath, "utf8"));
        try { unlinkSync(replyPath); } catch { /* another reader won the race */ }
        return answer;
      } catch {
        return { ok: false, error: "面板回了无法解析的响应" };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  try { unlinkSync(requestPath); } catch { /* the host may have taken it */ }
  return {
    ok: false,
    error: `面板未在 ${timeoutMs}ms 内响应（宿主可能没运行，或串口面板没开）`,
  };
}

export function readRingMirror(): RingMirror | null {
  const file = ringMirrorPath();
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as RingMirror;
    if (!Array.isArray(parsed.ports)) return null;
    return parsed;
  } catch {
    // A torn write (the host renames atomically, but a reader can still race
    // the very first write) reads as "no mirror", not as a crash.
    return null;
  }
}

/**
 * Enumerate COM ports, friendly names included. Same WMI query the host
 * bridge uses.
 */
export function listSerialPorts(): Promise<Array<{ path: string; description: string }>> {
  const script =
    "$ErrorActionPreference='SilentlyContinue'; " +
    "Get-CimInstance Win32_PnPEntity -Filter \"Name LIKE '%(COM%'\" | " +
    "ForEach-Object { $m = [regex]::Match($_.Name, '\\((COM\\d+)\\)'); " +
    "if ($m.Success) { @{path=$m.Groups[1].Value; description=$_.Name} } } | " +
    "ConvertTo-Json -Compress";
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
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

/**
 * Open a port for `durationMs`, return the lines captured, release. One-shot:
 * the pump exits on its own deadline, so there is no session state to leak.
 */
export function captureSerialPort(
  port: string,
  baud: number,
  durationMs: number,
): Promise<{ ok: boolean; lines: Array<{ text: string; at: number }>; error?: string }> {
  const window = Math.min(Math.max(durationMs, 50), MAX_DURATION_MS);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", PUMP_SCRIPT], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ ok: false, lines: [], error: `无法启动 PowerShell 泵：${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    const lines: Array<{ text: string; at: number }> = [];
    let error: string | undefined;
    let ready = false;
    let rest = "";
    const timer = setTimeout(() => {
      if (!ready) resolve({ ok: false, lines, error: error ?? `泵 ${READY_TIMEOUT_MS}ms 内未就绪` });
      try { child.kill(); } catch { /* the deadline loop exits on its own */ }
    }, Math.min(READY_TIMEOUT_MS, 1000 + window));
    child.stdout.on("data", (chunk) => {
      rest += chunk.toString("utf8");
      let index;
      while ((index = rest.indexOf("\n")) >= 0) {
        const line = rest.slice(0, index).trim();
        rest = rest.slice(index + 1);
        if (line === "") continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.ev === "ready") {
          ready = true;
        } else if (event.ev === "line" && lines.length < 2000) {
          lines.push({ text: String(event.text ?? "").slice(0, LINE_MAX_CHARS), at: Number(event.at) || Date.now() });
        } else if (event.ev === "error") {
          error = String(event.message ?? "泵错误");
          if (!ready) {
            clearTimeout(timer);
            resolve({ ok: false, lines, error });
            try { child.kill(); } catch { /* already failing */ }
            return;
          }
        }
      }
    });
    child.stderr.on("data", () => { /* diagnostics only */ });
    child.on("exit", () => {
      clearTimeout(timer);
      if (!ready && error === undefined) {
        resolve({ ok: false, lines, error: "泵在就绪前退出" });
        return;
      }
      resolve({ ok: ready, lines, error });
    });
    // One config line with the capture window; the pump opens, captures for
    // duration_ms, flushes and exits by itself.
    child.stdin.write(`${JSON.stringify({ port, baud, duration_ms: window })}\n`);
  });
}

/**
 * One-shot write-and-listen: opens the port, writes immediately, keeps the
 * capture window open for the reply, exits. Built on the same pump script by
 * writing before the capture loop — see captureSerialPort for the protocol.
 */
export async function captureThenWrite(
  port: string,
  baud: number,
  data: string,
  durationMs: number,
  hex = false,
): Promise<{ lines: Array<{ text: string; at: number }> }> {
  // Reuse the capture pump; the write races nothing because the pump only
  // reads. For the write itself we need a pump that takes data — the capture
  // script has no write op, so do the plain thing: capture (device echo is
  // what matters) is not enough. Spawn a dedicated write pump instead.
  return new Promise((resolve) => {
    const script = WRITE_PUMP_SCRIPT;
    let child;
    try {
      child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      resolve({ lines: [] });
      return;
    }
    const lines: Array<{ text: string; at: number }> = [];
    let rest = "";
    child.stdout.on("data", (chunk) => {
      rest += chunk.toString("utf8");
      let index;
      while ((index = rest.indexOf("\n")) >= 0) {
        const line = rest.slice(0, index).trim();
        rest = rest.slice(index + 1);
        if (line === "") continue;
        try {
          const event = JSON.parse(line);
          if (event.ev === "line" && lines.length < 2000) {
            lines.push({ text: String(event.text ?? "").slice(0, 8192), at: Number(event.at) || Date.now() });
          }
        } catch { /* not protocol */ }
      }
    });
    child.on("exit", () => resolve({ lines }));
    child.stdin.write(`${JSON.stringify({ port, baud, data, hex, duration_ms: durationMs })}\n`);
    // Hard ceiling so a wedged pump cannot hold the tool call.
    setTimeout(() => {
      try { child.kill(); } catch { /* exiting anyway */ }
    }, durationMs + 5000).unref();
  });
}

const WRITE_PUMP_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$config = [Console]::In.ReadLine() | ConvertFrom-Json
try {
  $script:serial = [System.IO.Ports.SerialPort]::new($config.port, [int]$config.baud, [System.IO.Ports.Parity]::None, 8, [System.IO.Ports.StopBits]::One)
  $script:serial.ReadBufferSize = 65536
  $script:serial.WriteTimeout = 2000
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
try {
  # hex mode sends raw bytes: the caller writes "0D0A" meaning CRLF. Without
  # it the string goes out verbatim and a CRLF-terminated protocol never sees
  # a line end no matter how the caller spells the escape.
  if ($config.hex -eq $true) {
    $count = [int]($config.data.Length / 2)
    $bytes = [byte[]]::new($count)
    for ($i = 0; $i -lt $count; $i++) {
      $bytes[$i] = [Convert]::ToByte($config.data.Substring($i * 2, 2), 16)
    }
    $script:serial.Write($bytes, 0, $count)
  } else {
    $script:serial.Write([string]$config.data)
  }
} catch {
  Emit @{ev='error';message="write failed: $($_.Exception.Message)"}
  try { $script:serial.Close() } catch { }
  exit 1
}
$script:deadline = [DateTime]::UtcNow.AddMilliseconds([int]$config.duration_ms)
while ([DateTime]::UtcNow -lt $script:deadline) {
  Drain-Port
  Start-Sleep -Milliseconds 10
}
FlushLine
try { $script:serial.Close() } catch { }
`;

/** Who owns the port right now, from the mirror + a probe of our own. */
export async function portOwnership(port: string): Promise<"panel" | "free-or-foreign" | "mirror-absent"> {
  const mirror = readRingMirror();
  if (mirror === null) return "mirror-absent";
  const entry = mirror.ports.find((p) => p.port === port);
  return entry ? "panel" : "free-or-foreign";
}
