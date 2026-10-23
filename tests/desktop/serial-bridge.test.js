/**
 * Tests for desktop/host/serial-bridge.js — the pump protocol, the ring and
 * the lifecycle, all against an injected fake pump. The real PowerShell path
 * is exercised separately against real hardware; here nothing opens a port.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
// The bridge lives in desktop/host, outside vitest's tsconfig root; load the
// JS file directly. Its exports are plain ESM.
const { SerialBridge, listSerialPorts, RING_MAX_LINES } = await import(
  "../../../../desktop/host/serial-bridge.js"
);

/**
 * A fake pump that speaks the pump protocol: `spawn` is stubbed so `open`
 * gets a process we control, and the tests drive it through `pump.hostSend`.
 */
class FakePump {
  constructor() {
    this.stdout = { on: vi.fn(), removeAllListeners: vi.fn() };
    this.stderr = { on: vi.fn() };
    this.stdin = { write: vi.fn(), end: vi.fn() };
    this.listeners = {};
    this.killed = false;
  }
  on(event, cb) {
    (this.listeners[event] ??= []).push(cb);
  }
  once(event, cb) {
    this.on(event, (...args) => {
      cb(...args);
      this.listeners[event] = this.listeners[event].filter((entry) => entry !== undefined);
    });
  }
  emit(event, ...args) {
    for (const cb of this.listeners[event] ?? []) cb(...args);
  }
  /** The host -> pump direction: what the bridge wrote to our stdin. */
  wroteOps() {
    return this.stdin.write.mock.calls.map(([line]) => JSON.parse(line));
  }
  /** pump -> host direction. */
  hostSend(obj) {
    for (const call of this.stdout.on.mock.calls) {
      if (call[0] !== "data") continue;
      call[1](Buffer.from(`${JSON.stringify(obj)}\n`, "utf8"));
    }
  }
  kill() {
    this.killed = true;
  }
}

/** Install the spawn stub and return the handle to the next pump. */
function stubSpawn(nextPump) {
  const childProcess = require_("node:child_process");
  return vi.spyOn(childProcess, "spawn").mockImplementation(() => nextPump);
}

describe("SerialBridge", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("open settles on ready and answers a snapshot", async () => {
    const pump = new FakePump();
    stubSpawn(pump);
    const bridge = new SerialBridge(() => {});
    const pending = bridge.open("COM7", 9600);
    // The config line goes out before ready; `parent_pid` is the orphan
    // guard the pump polls (host death must release the port).
    await vi.waitFor(() => {
      expect(pump.wroteOps()[0]).toMatchObject({ port: "COM7", baud: 9600, parent_pid: expect.any(Number) });
    });
    pump.hostSend({ ev: "ready" });
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.snapshot).toEqual({ open: true, port: "COM7", baud: 9600, lines: [], dropped: 0 });
    expect(bridge.openPorts).toEqual(["COM7"]);
  });

  it("open fails when the pump reports an error (port busy case)", async () => {
    const pump = new FakePump();
    stubSpawn(pump);
    const bridge = new SerialBridge(() => {});
    const pending = bridge.open("COM7", 9600);
    pump.hostSend({ ev: "error", message: "open failed: access denied" });
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.error).toContain("access denied");
    expect(bridge.openPorts).toEqual([]);
  });

  it("open times out when the pump never reports ready", async () => {
    const pump = new FakePump();
    stubSpawn(pump);
    const bridge = new SerialBridge(() => {});
    const pending = bridge.open("COM7", 9600);
    // Real timeout is 8s; elapse the fake clock instead of waiting it out.
    await vi.advanceTimersByTimeAsync(8100);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.error).toContain("超时");
    expect(pump.killed).toBe(true);
  }, 15_000);

  it("lines land in the ring, the ring caps, and drops are counted", async () => {
    const pump = new FakePump();
    stubSpawn(pump);
    const events = [];
    const bridge = new SerialBridge((m) => events.push(m));
    const pending = bridge.open("COM1", 115200);
    pump.hostSend({ ev: "ready" });
    await pending;
    for (let i = 0; i < RING_MAX_LINES + 10; i++) {
      pump.hostSend({ ev: "line", text: `t${i}`, at: 1000 + i });
    }
    const tail = bridge.ringTail("COM1", RING_MAX_LINES);
    // `total` counts what arrived since open; the ring holds the tail.
    expect(tail.total).toBe(RING_MAX_LINES);
    expect(tail.lines.length).toBe(RING_MAX_LINES);
    expect(tail.lines[0].text).toBe("t10");
    expect(tail.dropped).toBe(10);
    // Lines flush to the renderer as they come.
    // Lines flush to the renderer as they come; the debounce empties the
    // last partial batch, so advance past it before asserting.
    await vi.advanceTimersByTimeAsync(200);
    const lineEvents = events.filter((e) => e.type === "serial_lines");
    expect(lineEvents.length).toBeGreaterThan(0);
    const allFlushed = lineEvents.flatMap((e) => e.lines.map((l) => l.text));
    expect(allFlushed.at(-1)).toBe(`t${RING_MAX_LINES + 9}`);
    expect(lineEvents.at(-1).lines.length).toBeLessThanOrEqual(200);
  });

  it("level classification drives the renderer's colours", async () => {
    const pump = new FakePump();
    stubSpawn(pump);
    const bridge = new SerialBridge(() => {});
    const pending = bridge.open("COM1", 115200);
    pump.hostSend({ ev: "ready" });
    await pending;
    pump.hostSend({ ev: "line", text: "hardfault in handler", at: 1 });
    pump.hostSend({ ev: "line", text: "low battery warning", at: 2 });
    pump.hostSend({ ev: "line", text: "all good", at: 3 });
    const tail = bridge.ringTail("COM1", 10);
    expect(tail.lines.map((l) => l.level)).toEqual(["error", "warn", undefined]);
  });

  it("ringTail honours since as a ring cursor", async () => {
    const pump = new FakePump();
    stubSpawn(pump);
    const bridge = new SerialBridge(() => {});
    const pending = bridge.open("COM1", 115200);
    pump.hostSend({ ev: "ready" });
    await pending;
    for (let i = 0; i < 5; i++) pump.hostSend({ ev: "line", text: `t${i}`, at: i });
    expect(bridge.ringTail("COM1", 100, 3).lines.map((l) => l.text)).toEqual(["t3", "t4"]);
    // since past the end reads nothing, not everything.
    expect(bridge.ringTail("COM1", 100, 99).lines).toEqual([]);
    // Unknown port is null, not an empty tail that looks like a quiet port.
    expect(bridge.ringTail("COMX", 10)).toBeNull();
  });

  it("write goes to the pump and is refused when the port is not ours", async () => {
    const pump = new FakePump();
    stubSpawn(pump);
    const bridge = new SerialBridge(() => {});
    const pending = bridge.open("COM1", 115200);
    pump.hostSend({ ev: "ready" });
    await pending;
    expect(bridge.write("COM1", "hello")).toBe(true);
    expect(pump.wroteOps().at(-1)).toEqual({ op: "write", data: "hello" });
    expect(bridge.write("COM9", "x")).toBe(false);
  });

  it("close removes the session and the reopen path is free", async () => {
    const pump = new FakePump();
    stubSpawn(pump);
    const bridge = new SerialBridge(() => {});
    const pending = bridge.open("COM1", 115200);
    pump.hostSend({ ev: "ready" });
    await pending;
    pump.hostSend({ ev: "line", text: "tail", at: 1 });
    const closing = bridge.close("COM1");
    const ops = pump.wroteOps();
    expect(ops.at(-1)).toEqual({ op: "close" });
    expect(pump.stdin.end).toHaveBeenCalled();
    pump.emit("exit", 0);
    expect(await closing).toBe(true);
    expect(bridge.openPorts).toEqual([]);
    // The pending tail was flushed so the renderer keeps the last lines.
    expect(bridge.ringTail("COM1", 10)).toBeNull();
  });

  it("an unexpected pump exit after ready sends serial_state with the error", async () => {
    const pump = new FakePump();
    stubSpawn(pump);
    const events = [];
    const bridge = new SerialBridge((m) => events.push(m));
    const pending = bridge.open("COM1", 115200);
    pump.hostSend({ ev: "ready" });
    await pending;
    pump.emit("exit", 1);
    await vi.waitFor(() => {
      const state = events.filter((e) => e.type === "serial_state").at(-1);
      expect(state).toMatchObject({ open: false, port: "COM1", error: expect.stringContaining("code=1") });
    });
    expect(bridge.openPorts).toEqual([]);
  });

  it("a duplicate open on the same port is refused with a clear error", async () => {
    const pump = new FakePump();
    stubSpawn(pump);
    const bridge = new SerialBridge(() => {});
    const pending = bridge.open("COM1", 115200);
    pump.hostSend({ ev: "ready" });
    await pending;
    const second = await bridge.open("COM1", 115200);
    expect(second.ok).toBe(false);
    expect(second.error).toContain("COM1");
  });
});

describe("listSerialPorts", () => {
  it("parses single-object and array WMI output, and tolerates junk", async () => {
    const childProcess = require_("node:child_process");
    const one = { stdout: { on: vi.fn() }, stderr: { on: vi.fn() }, on: vi.fn(), kill: vi.fn() };
    vi.spyOn(childProcess, "spawn").mockImplementation(() => one);
    const pending = listSerialPorts();
    const dataCall = one.stdout.on.mock.calls.find((call) => call[0] === "data");
    dataCall[1](Buffer.from('{"path":"COM7","description":"CH340"}'));
    one.on.mock.calls.find((call) => call[0] === "exit")[1]();
    expect(await pending).toEqual([{ path: "COM7", description: "CH340" }]);

    const many = { stdout: { on: vi.fn() }, stderr: { on: vi.fn() }, on: vi.fn(), kill: vi.fn() };
    vi.spyOn(childProcess, "spawn").mockImplementation(() => many);
    const pending2 = listSerialPorts();
    const dataCall2 = many.stdout.on.mock.calls.find((call) => call[0] === "data");
    dataCall2[1](Buffer.from('[{"path":"COM3","description":"a"},{"path":"bogus","description":"x"}]'));
    many.on.mock.calls.find((call) => call[0] === "exit")[1]();
    expect(await pending2).toEqual([{ path: "COM3", description: "a" }]);

    const bad = { stdout: { on: vi.fn() }, stderr: { on: vi.fn() }, on: vi.fn(), kill: vi.fn() };
    vi.spyOn(childProcess, "spawn").mockImplementation(() => bad);
    const pending3 = listSerialPorts();
    const dataCall3 = bad.stdout.on.mock.calls.find((call) => call[0] === "data");
    dataCall3[1](Buffer.from("not json"));
    bad.on.mock.calls.find((call) => call[0] === "exit")[1]();
    expect(await pending3).toEqual([]);
  });
});
