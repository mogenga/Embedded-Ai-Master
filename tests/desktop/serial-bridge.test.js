/**
 * Tests for desktop/host/serial-bridge.js — the in-process serialport
 * implementation. A lightweight FakePort (same surface as `serialport`'s
 * SerialPort: EventEmitter + open/write/update/setDTR/setRTS/drain/close)
 * is injected through the bridge's constructor, so no real COM port is
 * touched and nothing spawns.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const path = require_("node:path");
const os = require_("node:os");
// The bridge lives in desktop/host, outside vitest's tsconfig root; load the
// JS file directly. Its exports are plain ESM.
const { SerialBridge, listSerialPorts, RING_MAX_LINES, serialRingPath } = await import(
  "../../../../desktop/host/serial-bridge.js"
);

/** Existing paths the fake driver pretends to have. */
const fakePaths = new Set();
/** Bytes written through any fake port, in order. */
const fakeWrites = [];
/** DTR/RTS calls captured as {method, value}. */
const fakeLines = [];
/** One constructed port per path, so tests can drive device-side events. */
const fakePorts = new Map();

/**
 * The double: constructor signature `{path, baudRate, autoOpen}` and the
 * methods the bridge calls. `open(callback)` succeeds for paths in
 * `fakePaths`, errors otherwise — asynchronously, like the real driver.
 */
class FakePort extends EventEmitter {
  constructor(options) {
    super();
    this.path = options.path;
    this.baudRate = options.baudRate;
    this.isOpen = false;
    fakePorts.set(options.path, this);
  }
  open(callback) {
    setImmediate(() => {
      if (fakePaths.has(this.path)) {
        this.isOpen = true;
        callback?.(null);
        this.emit("open");
      } else {
        callback?.(new Error("Port does not exist"));
        this.emit("error", new Error("Port does not exist"));
      }
    });
  }
  write(chunk, _encoding, callback) {
    fakeWrites.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (typeof callback === "function") setImmediate(() => callback(null));
    return true;
  }
  update(options, callback) {
    this.baudRate = options.baudRate;
    if (typeof callback === "function") setImmediate(() => callback(null));
    return true;
  }
  set(options, callback) {
    // serialport v13 has no setDTR/setRTS: modem lines travel through set(),
    // which forwards to the native binding. Record them the same way.
    if ("dtr" in options) fakeLines.push({ method: "setDTR", value: Boolean(options.dtr) });
    if ("rts" in options) fakeLines.push({ method: "setRTS", value: Boolean(options.rts) });
    if (typeof callback === "function") setImmediate(() => callback(null));
    return true;
  }
  setDTR(value, callback) {
    fakeLines.push({ method: "setDTR", value: Boolean(value) });
    if (typeof callback === "function") setImmediate(() => callback(null));
    return true;
  }
  setRTS(value, callback) {
    fakeLines.push({ method: "setRTS", value: Boolean(value) });
    if (typeof callback === "function") setImmediate(() => callback(null));
    return true;
  }
  drain(callback) {
    if (typeof callback === "function") setImmediate(() => callback(null));
    return true;
  }
  close(callback) {
    if (this.isOpen) {
      this.isOpen = false;
      setImmediate(() => {
        this.emit("close");
        callback?.(null);
      });
    } else if (typeof callback === "function") {
      setImmediate(() => callback(null));
    }
    return true;
  }
}

function makeBridge() {
  const events = [];
  const bridge = new SerialBridge((m) => events.push(m), FakePort);
  return { bridge, events };
}

/** Send raw bytes out of the "device" under test. */
function deviceSend(path, text) {
  fakePorts.get(path).emit("data", Buffer.from(text, "utf8"));
}

beforeEach(() => {
  fakePaths.clear();
  fakeWrites.length = 0;
  fakeLines.length = 0;
  fakePorts.clear();
  fakePaths.add("/dev/TEST0");
  fakePaths.add("/dev/TEST1");
});

afterEach(() => {
  for (const port of fakePorts.values()) {
    port.removeAllListeners();
    if (port.isOpen) port.close();
  }
  fakePorts.clear();
});

describe("SerialBridge (FakePort)", () => {
  it("opens a port and reports the snapshot", async () => {
    const { bridge } = makeBridge();
    const result = await bridge.open("/dev/TEST0", 115200);
    expect(result.ok).toBe(true);
    expect(result.snapshot).toMatchObject({ open: true, port: "/dev/TEST0", baud: 115200 });
    expect(bridge.openPorts).toEqual(["/dev/TEST0"]);
    await bridge.closeAll();
  });

  it("fails honestly when the port does not exist", async () => {
    const { bridge } = makeBridge();
    const result = await bridge.open("/dev/NOPE", 115200);
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("打开串口失败");
  });

  it("rejects an invalid baud rate", async () => {
    const { bridge } = makeBridge();
    const result = await bridge.open("/dev/TEST0", 0);
    expect(result.ok).toBe(false);
    expect(String(result.error)).toContain("波特率无效");
  });

  it("refuses a second open of the same port", async () => {
    const { bridge } = makeBridge();
    const first = await bridge.open("/dev/TEST0", 115200);
    expect(first.ok).toBe(true);
    const second = await bridge.open("/dev/TEST0", 9600);
    expect(second.ok).toBe(false);
    expect(String(second.error)).toContain("端口已被本宿主打开");
    await bridge.closeAll();
  });

  it("emits serial_lines with debounced batches and UTF-8 intact", async () => {
    const { bridge, events } = makeBridge();
    await bridge.open("/dev/TEST0", 115200);
    deviceSend("/dev/TEST0", "hello world\r\n中文测试\r\n");
    await vi.waitFor(() => {
      if (!events.some((e) => e.type === "serial_lines")) throw new Error("no lines yet");
    });
    const lineEvent = events.find((e) => e.type === "serial_lines");
    expect(lineEvent.port).toBe("/dev/TEST0");
    expect(lineEvent.lines.map((l) => l.text)).toEqual(["hello world", "中文测试"]);
    expect(lineEvent.lines.every((l) => l.level === "info")).toBe(true);
    await bridge.closeAll();
  });

  it("classifies error/warn levels for the log gutter", async () => {
    const { bridge, events } = makeBridge();
    await bridge.open("/dev/TEST0", 115200);
    deviceSend("/dev/TEST0", "[E][servo] motor error\r\n[W] disk almost full\r\nplain\r\n");
    await vi.waitFor(() => {
      if (!events.some((e) => e.type === "serial_lines")) throw new Error("none");
    });
    const lineEvent = events.find((e) => e.type === "serial_lines");
    expect(lineEvent.lines.map((l) => l.level)).toEqual(["error", "warn", "info"]);
    await bridge.closeAll();
  });

  it("counts RX/TX bytes on the wire and reports serial_stats", async () => {
    const { bridge, events } = makeBridge();
    await bridge.open("/dev/TEST0", 115200);
    deviceSend("/dev/TEST0", "12345\r\n");
    await vi.waitFor(() => {
      if (!events.some((e) => e.type === "serial_stats" && e.rx === 7)) throw new Error("no rx stats");
    });
    expect(bridge.write("/dev/TEST0", "abc")).toBe(true);
    await vi.waitFor(() => {
      if (!events.some((e) => e.type === "serial_stats" && e.tx === 3)) throw new Error("no tx stats");
    });
    await bridge.closeAll();
  });

  it("writes hex payloads as raw bytes and refuses malformed hex", async () => {
    const { bridge } = makeBridge();
    // Closed port: honest refusal.
    expect(bridge.write("/dev/TEST0", "DEADBEEF", { hex: true })).toBe(false);
    await bridge.open("/dev/TEST0", 115200);
    expect(bridge.write("/dev/TEST0", "DE AD BE EF", { hex: true })).toBe(true);
    expect(bridge.write("/dev/TEST0", "XYZ", { hex: true })).toBe(false);
    expect(bridge.write("/dev/TEST0", "ABC", { hex: true })).toBe(false); // odd length
    expect(fakeWrites.at(-1)).toEqual(Buffer.from([0xde, 0xad, 0xbe, 0xef]));
    await bridge.closeAll();
  });

  it("holds an unterminated partial until more bytes arrive", async () => {
    const { bridge, events } = makeBridge();
    await bridge.open("/dev/TEST0", 115200);
    deviceSend("/dev/TEST0", "partial-no-newline");
    await new Promise((r) => setTimeout(r, 250));
    expect(events.some((e) => e.type === "serial_lines")).toBe(false);
    deviceSend("/dev/TEST0", "-tail\r\n");
    await vi.waitFor(() => {
      if (!events.some((e) => e.type === "serial_lines")) throw new Error("none");
    });
    const lineEvent = events.find((e) => e.type === "serial_lines");
    expect(lineEvent.lines[0].text).toBe("partial-no-newline-tail");
    await bridge.closeAll();
  });

  it("reconstructs multi-byte UTF-8 split across two chunks", async () => {
    const { bridge, events } = makeBridge();
    await bridge.open("/dev/TEST0", 115200);
    const full = Buffer.from("测试中文\r\n", "utf8");
    fakePorts.get("/dev/TEST0").emit("data", full.subarray(0, 4));
    fakePorts.get("/dev/TEST0").emit("data", full.subarray(4));
    await vi.waitFor(() => {
      if (!events.some((e) => e.type === "serial_lines")) throw new Error("none");
    });
    const lineEvent = events.find((e) => e.type === "serial_lines");
    expect(lineEvent.lines[0].text).toBe("测试中文");
    await bridge.closeAll();
  });

  it("caps the ring at RING_MAX_LINES and counts dropped", async () => {
    const { bridge, events } = makeBridge();
    await bridge.open("/dev/TEST0", 115200);
    let burst = "";
    for (let i = 0; i < RING_MAX_LINES + 50; i += 1) burst += `L${i}\r\n`;
    deviceSend("/dev/TEST0", burst);
    await vi.waitFor(() => {
      if (!events.some((e) => e.type === "serial_lines" && e.lines.length > 100)) throw new Error("not flushed");
    });
    const tail = bridge.ringTail("/dev/TEST0", 10);
    expect(tail.total).toBe(RING_MAX_LINES);
    expect(tail.dropped).toBe(50);
    expect(tail.lines[tail.lines.length - 1].text).toBe(`L${RING_MAX_LINES + 49}`);
    await bridge.closeAll();
  });

  it("decodes GBK output when the session is opened with encoding: gbk", async () => {
    // Keil and most Chinese MCU tutorials print GBK. Decoding those bytes as
    // UTF-8 yields replacement characters, which is what the board's panel
    // showed before the encoding option existed.
    const { bridge, events } = makeBridge();
    await bridge.open("/dev/TEST0", 115200, { encoding: "gbk" });
    const text = "请输入数据,以回车键结束\r\n";
    // GBK bytes for 请输入数据,以回车键结束 followed by CRLF (verified with
    // Python's cp936 codec).
    const gbkBytes = Buffer.from("c7ebcae4c8ebcafdbedd2cd2d4bbd8b3b5bcfcbde1caf80d0a", "hex");
    fakePorts.get("/dev/TEST0").emit("data", gbkBytes);
    await vi.waitFor(() => {
      if (!events.some((e) => e.type === "serial_lines")) throw new Error("none");
    });
    const lineEvent = events.find((e) => e.type === "serial_lines");
    expect(lineEvent.lines[0].text).toBe("请输入数据,以回车键结束");
    expect(lineEvent.lines[0].text).not.toContain("�");
    await bridge.closeAll();
  });

  it("switches encoding on a live session without dropping the port", async () => {
    const { bridge } = makeBridge();
    await bridge.open("/dev/TEST0", 115200);
    expect(bridge.setEncoding("/dev/TEST0", "gbk")).toBe(true);
    expect(bridge.sessionOf("/dev/TEST0").encoding).toBe("gbk");
    // Unknown names fall back to utf-8 rather than refusing.
    expect(bridge.setEncoding("/dev/TEST0", "latin9")).toBe(true);
    expect(bridge.sessionOf("/dev/TEST0").encoding).toBe("utf-8");
    expect(bridge.openPorts).toEqual(["/dev/TEST0"]);
    await bridge.closeAll();
  });

  it("toggles DTR/RTS and records the calls", async () => {
    const { bridge } = makeBridge();
    expect(bridge.setLine("/dev/TEST0", "dtr", true)).toBe(false); // not open
    await bridge.open("/dev/TEST0", 115200);
    expect(bridge.setLine("/dev/TEST0", "dtr", true)).toBe(true);
    expect(bridge.setLine("/dev/TEST0", "rts", false)).toBe(true);
    expect(bridge.setLine("/dev/TEST0", "bogus", true)).toBe(false);
    expect(fakeLines).toEqual([
      { method: "setDTR", value: true },
      { method: "setRTS", value: false },
    ]);
    await bridge.closeAll();
  });

  it("changes baud without dropping the line", async () => {
    const { bridge, events } = makeBridge();
    await bridge.open("/dev/TEST0", 115200);
    expect(bridge.setBaud("/dev/TEST0", 9600)).toBe(true);
    expect(bridge.setBaud("/dev/TEST0", 1)).toBe(false);
    expect(events.some((e) => e.type === "serial_state" && e.open === true && e.baud === 9600)).toBe(true);
    await bridge.closeAll();
  });

  it("closes and removes the session; ringTail answers null after", async () => {
    const { bridge } = makeBridge();
    await bridge.open("/dev/TEST0", 115200);
    expect(bridge.openPorts).toEqual(["/dev/TEST0"]);
    await bridge.close("/dev/TEST0");
    expect(bridge.openPorts).toEqual([]);
    expect(bridge.ringTail("/dev/TEST0", 5)).toBeNull();
  });

  it("reports a runtime port error as serial_state with the message", async () => {
    const { bridge, events } = makeBridge();
    await bridge.open("/dev/TEST0", 115200);
    fakePorts.get("/dev/TEST0").emit("error", new Error("driver exploded"));
    await vi.waitFor(() => {
      if (!events.some((e) => e.type === "serial_state" && e.open === false && e.error)) throw new Error("none");
    });
    const state = events.find((e) => e.type === "serial_state" && e.open === false);
    expect(state.error).toContain("driver exploded");
    expect(bridge.openPorts).toEqual([]);
  });
});

describe("listSerialPorts", () => {
  it("answers with an array or an honest error object", async () => {
    const result = await listSerialPorts();
    if (result.error !== undefined) {
      expect(typeof result.error).toBe("string");
    } else {
      expect(Array.isArray(result)).toBe(true);
      for (const entry of result) {
        expect(typeof entry.path).toBe("string");
      }
    }
  });
});

describe("serialRingPath", () => {
  it("honors HARNESS_HOME and defaults to ~/.harness/serial/ring.json", () => {
    expect(serialRingPath("/tmp/h1")).toBe(path.join("/tmp/h1", "serial", "ring.json"));
    expect(serialRingPath()).toBe(path.join(os.homedir(), ".harness", "serial", "ring.json"));
  });
});
