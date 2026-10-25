import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readRingMirror, ringMirrorPath, portOwnership } from "../serial.js";
import { SERIAL_ACTIONS, SERIAL_EVIDENCE_ACTIONS, SERIAL_DESTRUCTIVE_ACTIONS, serialInputSchema } from "../actions.js";

/**
 * embed_serial 的离线单元测试：镜像读写与归属判断，全部走临时目录，
 * 不 spawn 泵、不碰真实 COM 口。泵协议本身由 tests/desktop/serial-bridge.test.js
 * 用假进程覆盖；对真实硬件的双口互发在 dev-notes 记录了实测结果。
 */

let home: string;

function writeMirror(ports: unknown) {
  mkdirSync(join(home, "serial"), { recursive: true });
  writeFileSync(ringMirrorPath(home), JSON.stringify({ updatedAt: Date.now(), ports }), "utf8");
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "embed-serial-test-"));
  process.env.HARNESS_HOME = home;
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  delete process.env.HARNESS_HOME;
});

describe("ringMirrorPath / readRingMirror", () => {
  it("mirror path is <home>/serial/ring.json", () => {
    expect(ringMirrorPath(home)).toBe(join(home, "serial", "ring.json"));
  });

  it("reads a written mirror and rejects a malformed one", () => {
    expect(readRingMirror()).toBeNull();
    writeMirror([{ port: "COM3", baud: 115200, owner: "panel", total: 2, dropped: 0, lines: [{ text: "hi", at: 1 }] }]);
    const mirror = readRingMirror();
    expect(mirror?.ports).toHaveLength(1);
    expect(mirror?.ports[0]?.port).toBe("COM3");
    // torn write / junk reads as "no mirror", not a crash
    writeFileSync(ringMirrorPath(home), "not json", "utf8");
    expect(readRingMirror()).toBeNull();
    // array missing reads as no mirror too
    writeFileSync(ringMirrorPath(home), JSON.stringify({ updatedAt: 1 }), "utf8");
    expect(readRingMirror()).toBeNull();
  });
});

describe("portOwnership", () => {
  it("panel / free / absent come out distinctly", async () => {
    expect(await portOwnership("COM3")).toBe("mirror-absent");
    writeMirror([{ port: "COM3", baud: 115200, owner: "panel", total: 0, dropped: 0, lines: [] }]);
    expect(await portOwnership("COM3")).toBe("panel");
    expect(await portOwnership("COM7")).toBe("free-or-foreign");
  });
});

describe("serial actions/whitelists", () => {
  it("actions and meta sets agree", () => {
    expect(SERIAL_ACTIONS).toEqual(["read", "write", "ports", "status", "open", "close"]);
    for (const action of ["read", "ports", "status"]) expect(SERIAL_EVIDENCE_ACTIONS.has(action)).toBe(true);
    expect(SERIAL_EVIDENCE_ACTIONS.has("write")).toBe(false);
    expect(SERIAL_DESTRUCTIVE_ACTIONS.has("write")).toBe(true);
    // open/close change who owns the port, so they are not read-only.
    expect(SERIAL_DESTRUCTIVE_ACTIONS.has("open")).toBe(true);
    expect(SERIAL_DESTRUCTIVE_ACTIONS.has("close")).toBe(true);
    for (const action of ["read", "ports", "status"]) expect(SERIAL_DESTRUCTIVE_ACTIONS.has(action)).toBe(false);
  });

  it("schema accepts hex on write, so raw bytes are expressible", () => {
    // Without this flag the only payload a caller can send is printable text:
    // "\r\n" leaves as four literal characters and a CRLF-terminated device
    // never sees a line end. Session 16c03283 burned 17 tool calls on that.
    expect(serialInputSchema.safeParse({ action: "write", port: "COM3", data: "0D0A", hex: true }).success).toBe(true);
    expect(serialInputSchema.safeParse({ action: "write", port: "COM3", data: "hi" }).success).toBe(true);
    const parsed = serialInputSchema.parse({ action: "write", port: "COM3", data: "0D0A", hex: true });
    expect(parsed.hex).toBe(true);
  });

  it("schema rejects unknown fields and out-of-range values", () => {
    expect(serialInputSchema.safeParse({ action: "read" }).success).toBe(true);
    expect(serialInputSchema.safeParse({ action: "read", port: "COM3", baud: 9600, duration_ms: 1000 }).success).toBe(true);
    expect(serialInputSchema.safeParse({ action: "reboot" }).success).toBe(false);
    expect(serialInputSchema.safeParse({ action: "write", data: "x", extra: 1 }).success).toBe(false);
    expect(serialInputSchema.safeParse({ action: "read", baud: 1 }).success).toBe(false);
    expect(serialInputSchema.safeParse({ action: "read", duration_ms: 60_000 }).success).toBe(false);
  });

  it("T-015 schema 拒绝奇数长度 hex（原来会静默截掉最后半字节）", () => {
    expect(serialInputSchema.safeParse({ action: "write", port: "COM3", data: "0D0A0", hex: true }).success).toBe(false);
    expect(serialInputSchema.safeParse({ action: "write", port: "COM3", data: "XYZ", hex: true }).success).toBe(false);
    // 合法形态仍然放行：带空格分组、大写
    expect(serialInputSchema.safeParse({ action: "write", port: "COM3", data: "0D 0A", hex: true }).success).toBe(true);
    expect(serialInputSchema.safeParse({ action: "write", port: "COM3", data: "0D0A", hex: true }).success).toBe(true);
    // hex:true 下非 hex 文本被拒绝（发送文本不该带 hex 标志）
    expect(serialInputSchema.safeParse({ action: "write", port: "COM3", data: "AT+RST", hex: true }).success).toBe(false);
    // 不带 hex 标志的文本不受影响
    expect(serialInputSchema.safeParse({ action: "write", port: "COM3", data: "AT+RST\r\n" }).success).toBe(true);
  });
});
