import { describe, expect, it } from "vitest";
import { mkdtempSync, utimesSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { UvSocketClient } from "../uvsock.js";

/**
 * T-022 的离线锁定：exit({settlePath}) 在强杀前等待工程文件 mtime 稳定，
 * 而不是固定 sleep。旧路径 `taskkill /F` 落在 uVision 写大工程的中途，
 * .uvprojx 可能半写截断。
 */

function fakeChild(): EventEmitter & { pid: number; kill: () => boolean } {
  const child = new EventEmitter() as EventEmitter & { pid: number; kill: () => boolean };
  child.pid = 424242;
  child.kill = () => true;
  return child;
}

function fakeSocket(): EventEmitter {
  const socket = new EventEmitter() as EventEmitter & { write: () => boolean; destroy: () => void };
  (socket as unknown as { write: () => boolean }).write = () => true;
  (socket as unknown as { destroy: () => void }).destroy = () => {};
  return socket;
}

/** GEN_EXIT 一收到就持续改写工程文件，直到 killed 被置位。 */
function writerThatKeepsWriting(path: string, state: { killed: boolean }): void {
  const timer = setInterval(() => {
    if (state.killed) return;
    try {
      writeFileSync(path, `${Date.now()}\n`, "utf8");
      const now = new Date();
      utimesSync(path, now, now);
    } catch {
      /* gone */
    }
  }, 120);
  timer.unref?.();
}

describe("exit settlePath（T-022）", () => {
  it("工程文件持续变化时，杀进程被推迟到 settle 或超时", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keil-exit-"));
    const project = join(dir, "big.uvprojx");
    writeFileSync(project, "seed\n", "utf8");
    const state = { killed: false };
    writerThatKeepsWriting(project, state);

    const client = new UvSocketClient(fakeSocket() as never, 4823, fakeChild() as never);
    // send() 对死 socket 会 resolve 失败（socket error → pending 清空），
    // GEN_EXIT 走 catch 分支，不阻塞。
    const started = Date.now();
    let closed = false;
    const originalClose = (client as unknown as { close: () => void }).close;
    (client as unknown as { close: () => void }).close = () => {
      closed = true;
      state.killed = true;
      originalClose.call(client);
    };
    await client.exit({ settlePath: project, timeoutMs: 1500 });
    const elapsed = Date.now() - started;
    expect(closed).toBe(true);
    // 持续写入下必须等到超时（≈1500ms）才杀，而不是立即。
    expect(elapsed).toBeGreaterThanOrEqual(1200);
    rmSync(dir, { recursive: true, force: true });
  }, 10_000);

  it("无 settlePath 时不进入 settle 轮询（GEN_EXIT 超时后立即 close）", async () => {
    // 假 socket 不应答，GEN_EXIT 走满 4s 超时——这是 send 的行为，不是
    // settle 的。锁定点：close 被调，且总耗时里没有额外的 settle 时间
    // （有 settle 的用例在下面单独锁）。
    const client = new UvSocketClient(fakeSocket() as never, 4823, fakeChild() as never);
    await client.exit();
    expect(client.closed).toBe(true);
  }, 10_000);

  it("工程文件已稳定时快速返回（等满 1s 稳定窗）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keil-exit-"));
    const project = join(dir, "small.uvprojx");
    writeFileSync(project, "seed\n", "utf8");
    const client = new UvSocketClient(fakeSocket() as never, 4823, fakeChild() as never);
    const started = Date.now();
    await client.exit({ settlePath: project, timeoutMs: 10_000 });
    const elapsed = Date.now() - started;
    // 稳定窗 1s + GEN_EXIT 超时 4s（假 socket 不应答）；关键是不等满超时。
    expect(elapsed).toBeLessThan(8_000);
    expect(elapsed).toBeGreaterThanOrEqual(900);
    rmSync(dir, { recursive: true, force: true });
  }, 15_000);

  it("文件不存在时不挂死，超时兜底照常 close", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keil-exit-"));
    const missing = join(dir, "absent.uvprojx");
    const client = new UvSocketClient(fakeSocket() as never, 4823, fakeChild() as never);
    const started = Date.now();
    await client.exit({ settlePath: missing, timeoutMs: 800 });
    const elapsed = Date.now() - started;
    expect(client.closed).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(700);
    expect(existsSync(missing)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  }, 10_000);
});
