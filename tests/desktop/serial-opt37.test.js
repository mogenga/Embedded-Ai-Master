/**
 * Measurements for BACKLOG 5.6 items 1 and 2 (OPT-37), pinned as assertions.
 *
 * Item 1 — "ring replacement is silent": the host ring caps at
 * `RING_MAX_LINES` and increments `session.dropped`. The renderer shows
 * `state.serial.dropped`, and its only source is the `dropped` field of a
 * `serial_lines` event (`app.js`), so that field is the whole chain. These
 * cases pin that every flush carries the host's running total — if the field
 * were dropped from the event the counter would silently stop moving.
 *
 * Item 2 — "baud cannot change while the port is open": the renderer never
 * sends `serialBaud` (and disables the select while open), so the host path is
 * the only thing that can be verified here. A live change must reconfigure the
 * open port, keep the ring, and keep decoding what arrives afterwards.
 *
 * A fake `serialport` is injected through the bridge's constructor: no COM
 * port is touched and nothing spawns.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { SerialBridge, RING_MAX_LINES } = await import(
  "../../../desktop/host/serial-bridge.js"
);

/** Paths the fake driver pretends to have open. */
const fakePaths = new Set();
/** One constructed port per path, so tests can drive device-side events. */
const fakePorts = new Map();
/** Set by a test to make the next `update()` call fail, as a driver may. */
let updateError = null;

/** Minimal `serialport` v13 surface: EventEmitter + open/write/update/drain/close. */
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
  write(_chunk, _encoding, callback) {
    if (typeof callback === "function") setImmediate(() => callback(null));
    return true;
  }
  update(options, callback) {
    // v13's contract: resolves asynchronously; without a callback a failure is
    // emitted on the port's `error` event (`@serialport/stream` `_error`). The
    // fake mirrors that so the bridge is exercised the way it calls it.
    setImmediate(() => {
      if (updateError !== null) {
        if (typeof callback === "function") callback(updateError);
        else this.emit("error", updateError);
        return;
      }
      this.baudRate = options.baudRate;
      if (typeof callback === "function") callback(null);
    });
    return true;
  }
  set(_options, callback) {
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

let homeDir;
let prevHome;

beforeEach(() => {
  // The bridge mirrors its ring under `HARNESS_HOME`; keep it in a temp dir so
  // no test writes into the real `~/.harness`.
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "eam-serial-measure-"));
  prevHome = process.env.HARNESS_HOME;
  process.env.HARNESS_HOME = homeDir;
  fakePaths.clear();
  fakePorts.clear();
  fakePaths.add("/dev/TEST0");
  updateError = null;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HARNESS_HOME;
  else process.env.HARNESS_HOME = prevHome;
  fs.rmSync(homeDir, { recursive: true, force: true });
  for (const port of fakePorts.values()) {
    port.removeAllListeners();
    if (port.isOpen) port.close();
  }
  fakePorts.clear();
});

function makeBridge() {
  const events = [];
  const bridge = new SerialBridge((message) => events.push(message), FakePort);
  return { bridge, events };
}

function deviceSend(text) {
  fakePorts.get("/dev/TEST0").emit("data", Buffer.from(text, "utf8"));
}

describe("环形缓冲替换必须让用户看得见（BACKLOG 5.6 ①）", () => {
  it("每次 serial_lines 都带宿主的累计 dropped，溢出的 50 行随刷新到达渲染层", async () => {
    const { bridge, events } = makeBridge();
    await bridge.open("/dev/TEST0", 115200, { encoding: "utf-8" });

    let burst = "";
    for (let i = 0; i < RING_MAX_LINES + 50; i += 1) burst += `L${i}\r\n`;
    deviceSend(burst);
    await vi.waitFor(() => {
      if (!events.some((event) => event.type === "serial_lines")) throw new Error("no flush");
    });

    const lineEvents = events.filter((event) => event.type === "serial_lines");
    // The renderer assigns `state.serial.dropped` from this field and shows it
    // in the status line; without it the replacement is silent (R3).
    expect(lineEvents.at(-1).dropped).toBe(50);
    expect(lineEvents.every((event) => typeof event.dropped === "number")).toBe(true);
    // The running total reaches the ring mirror the agent reads, too.
    expect(bridge.ringTail("/dev/TEST0", 1).dropped).toBe(50);
    await bridge.closeAll();
  });
});

describe("运行中改波特率（BACKLOG 5.6 ②）", () => {
  it("setBaud 重配置同一会话：环形缓冲保留，之后的数据继续解码、刷新", async () => {
    const { bridge, events } = makeBridge();
    await bridge.open("/dev/TEST0", 115200, { encoding: "utf-8" });
    deviceSend("before\r\n");
    await vi.waitFor(() => {
      if (!events.some((event) => event.type === "serial_lines")) throw new Error("no first flush");
    });

    expect(bridge.setBaud("/dev/TEST0", 9600)).toBe(true);
    // Same session, not a new one: this is the `reconfigured` contract the
    // renderer relies on to keep the transcript (app.js `serial_state`).
    const reconfigured = events.find(
      (event) => event.type === "serial_state" && event.mode === "reconfigured",
    );
    expect(reconfigured).toMatchObject({ open: true, port: "/dev/TEST0", baud: 9600 });
    expect(bridge.openPorts).toEqual(["/dev/TEST0"]);
    // Data received before the change stays in the ring.
    expect(bridge.ringTail("/dev/TEST0", 5).lines.map((line) => line.text)).toContain("before");

    // And the port keeps working afterwards: the session was not torn down.
    deviceSend("after\r\n");
    await vi.waitFor(() => {
      const texts = events
        .filter((event) => event.type === "serial_lines")
        .flatMap((event) => event.lines.map((line) => line.text));
      if (!texts.includes("after")) throw new Error("no line after baud change");
    });
    expect(bridge.sessionOf("/dev/TEST0").baud).toBe(9600);
    await bridge.closeAll();
  });

  it("驱动拒绝新波特率时如实报错，会话被拆除而不是假装改成功", async () => {
    const { bridge, events } = makeBridge();
    await bridge.open("/dev/TEST0", 115200, { encoding: "utf-8" });
    updateError = new Error("baud rate unsupported");
    // `update()` reports asynchronously in serialport 13 and the bridge does
    // not pass a callback, so a refusal arrives on the port's own `error`
    // event. Measured behaviour: the failed reconfigure tears the session
    // down (open:false + error) — a live panel must not keep a port whose
    // settings are not the ones it claims.
    expect(bridge.setBaud("/dev/TEST0", 9600)).toBe(true);
    await vi.waitFor(() => {
      if (!events.some((event) => event.type === "serial_state" && event.error)) {
        throw new Error("no failure reported");
      }
    });
    // R3: an unsupported rate is not a silent success.
    const failure = events.find((event) => event.type === "serial_state" && event.error);
    expect(failure.open).toBe(false);
    expect(failure.error).toContain("baud rate unsupported");
    expect(bridge.sessionOf("/dev/TEST0")).toBeNull();
  });
});
