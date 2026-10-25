import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

const { spawn } = await import("node:child_process");
const { captureThenWrite } = await import("../serial.js");

/**
 * T-014/T-016 行为锁定：泵子进程的异步 error 事件必须落到返回值
 * （原来：error 事件无监听 → uncaughtException 杀死整个 MCP server；
 * 写失败的 ev:'error' 事件被丢弃 → 写失败报成功，违反 R3）。
 */

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: EventEmitter & { write: (s: string) => void };
    kill: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter() as EventEmitter & { write: (s: string) => void };
  (child.stdin as unknown as { write: (s: string) => void }).write = () => true;
  child.kill = () => child.emit("exit", 1);
  return child;
}

beforeEach(() => {
  vi.mocked(spawn).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("captureThenWrite 泵失败路径（T-014/T-016）", () => {
  it("spawn 异步 error 事件进入返回值而非崩溃", async () => {
    const child = fakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const pending = captureThenWrite("COM3", 115200, "hi", 100);
    // The spawn failure lands as an 'error' event, not a synchronous throw.
    child.emit("error", new Error("ENOENT: powershell blocked"));
    const result = await pending;
    expect(result.error).toContain("ENOENT");
    expect(result.lines).toEqual([]);
  });

  it("泵的 ev:'error' 事件使返回值携带 error（不再被丢弃）", async () => {
    const child = fakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const pending = captureThenWrite("COM3", 115200, "ZZ", 100, true);
    child.stdout.emit(
      "data",
      Buffer.from(`${JSON.stringify({ ev: "error", message: "write failed: invalid hex" })}\n`, "utf8"),
    );
    child.emit("exit", 1);
    const result = await pending;
    expect(result.error).toContain("write failed");
  });

  it("正常退出且无 error 事件时返回值不带 error", async () => {
    const child = fakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const pending = captureThenWrite("COM3", 115200, "AT\r\n", 100);
    child.stdout.emit(
      "data",
      Buffer.from(`${JSON.stringify({ ev: "line", text: "OK", at: 1 })}\n`, "utf8"),
    );
    child.emit("exit", 0);
    const result = await pending;
    expect(result.error).toBeUndefined();
    expect(result.lines.map((l) => l.text)).toEqual(["OK"]);
  });
});
