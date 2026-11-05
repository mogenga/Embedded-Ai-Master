import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, utimesSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { UvSocketClient } from "../uvsock.js";

/**
 * T-022 的离线锁定：exit({settlePath}) 在强杀前等待工程文件 mtime 稳定，
 * 而不是固定 sleep。旧路径 `taskkill /F` 落在 uVision 写大工程的中途，
 * .uvprojx 可能半写截断。
 *
 * 这组用例以前跑真实的 settle 窗和真实的 `taskkill`（4 例合计约 24 s）：
 *
 * - **等待**是纯墙钟。`exit` 用 `setTimeout(200)` 轮询 + `Date.now()` 截止，
 *   `vi.useFakeTimers()` 同时伪造 `Date` 与定时器，所以虚拟时间可以任意推进。
 *   断言反而更准：`elapsed` 现在就是 settle 逻辑真正用掉的时长，不含机器调度。
 *   `statSync` / `utimesSync` 仍是真实的——文件是真的，mtime 是显式写进去的，
 *   只有「等多久」是假的。
 * - **kill** 走 `killTree()`，Windows 上是真实的 `taskkill /T /F`：对一个不存在的
 *   pid 也要约 1 s。这里把 `killTree` 换成探针，既省掉这 1 s，也让「close 确实
 *   走到了杀进程这一步」成为一条可断言的事实（以前只能间接从 `closed` 推断）。
 */

const { killTreeMock } = vi.hoisted(() => ({ killTreeMock: vi.fn() }));
vi.mock("../killTree.js", () => ({ killTree: killTreeMock }));

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

/**
 * 在假时钟上跑一段 `exit()`，返回它消耗的**虚拟**毫秒数。
 *
 * 步进推进而不是一次跳到终点：`exit` 的轮询是「两次读 mtime 之间睡 200 ms」，
 * 一次跳完会把所有轮询挤在同一微任务里，文件也就不再变化。50 ms 的步长小于
 * 任何一个被观察的间隔（轮询 200 ms、写文件 120 ms），时序与真时钟一致。
 */
async function underFakeClock<T>(
  run: () => Promise<T>,
  { stepMs = 50, setup }: { stepMs?: number; setup?: () => void } = {},
): Promise<{ result: T; elapsed: number }> {
  // 只在这里装一次假时钟：`useFakeTimers()` 会重装定时器，在已装好后
  // 再调一次会丢掉 setup 阶段注册的 interval（实测写入器一次都没跑）。
  vi.useFakeTimers();
  try {
    setup?.();
    const started = Date.now();
    let settled = false;
    const outcome = run().then(
      (result) => {
        settled = true;
        return { ok: true as const, result };
      },
      (error: unknown) => {
        settled = true;
        return { ok: false as const, error };
      },
    );
    for (let step = 0; step < 2_000 && !settled; step += 1) {
      await vi.advanceTimersByTimeAsync(stepMs);
    }
    const outcomeValue = await outcome;
    if (!outcomeValue.ok) throw outcomeValue.error;
    return { result: outcomeValue.result, elapsed: Date.now() - started };
  } finally {
    vi.useRealTimers();
  }
}

/** `exit()` 里 `send(GEN_EXIT, …, 4_000)` 的超时；假 socket 不应答时会走满。 */
const GEN_EXIT_TIMEOUT_MS = 4_000;

/** GEN_EXIT 一收到就持续改写工程文件，直到 killed 被置位；返回写入次数。 */
function writerThatKeepsWriting(path: string, state: { killed: boolean }): { writes: number } {
  const counter = { writes: 0 };
  const timer = setInterval(() => {
    if (state.killed) return;
    try {
      writeFileSync(path, `${Date.now()}\n`, "utf8");
      const now = new Date();
      utimesSync(path, now, now);
      counter.writes += 1;
    } catch {
      /* gone */
    }
  }, 120);
  timer.unref?.();
  return counter;
}

describe("exit settlePath（T-022）", () => {
  it("工程文件持续变化时，杀进程被推迟到 settle 或超时", async () => {
    killTreeMock.mockClear();
    const dir = mkdtempSync(join(tmpdir(), "keil-exit-"));
    const project = join(dir, "big.uvprojx");
    writeFileSync(project, "seed\n", "utf8");
    const state = { killed: false };

    const client = new UvSocketClient(fakeSocket() as never, 4823, fakeChild() as never);
    // send() 对死 socket 会 resolve 失败（socket error → pending 清空），
    // GEN_EXIT 走 catch 分支，不阻塞。
    let closed = false;
    const originalClose = (client as unknown as { close: () => void }).close;
    (client as unknown as { close: () => void }).close = () => {
      closed = true;
      state.killed = true;
      originalClose.call(client);
    };
    let writer: { writes: number } | undefined;
    const { elapsed } = await underFakeClock(
      () => client.exit({ settlePath: project, timeoutMs: 1500 }),
      {
        stepMs: 50,
        setup: () => {
          writer = writerThatKeepsWriting(project, state);
        },
      },
    );
    expect(closed).toBe(true);
    // 持续写入下必须等到超时（1500ms 虚拟时间）才杀，而不是立即。
    expect(elapsed).toBeGreaterThanOrEqual(1200);
    // 但也不能**只看**总数：`exit()` 先 `send(GEN_EXIT)`，假 socket 不应答，
    // 这一步自己就耗掉 4 s（实测 elapsed ≈ 5600），所以单看 elapsed 在
    // 「稳定窗被缩短到 100 ms」时也照样通过（变异验证过）。属于 settle 的
    // 那一段是 `elapsed - GEN_EXIT 超时`：持续写入下它必须把整个 1500 ms
    // 窗口耗满，而不是发现文件「没在变」就早退。
    expect(elapsed - GEN_EXIT_TIMEOUT_MS).toBeGreaterThanOrEqual(1_400);
    expect(elapsed - GEN_EXIT_TIMEOUT_MS).toBeLessThanOrEqual(2_000);
    // 虚拟时间确实流过：写入器在窗口内多次改写（证明轮询没有被短路）。
    expect(writer?.writes ?? 0).toBeGreaterThanOrEqual(5);
    expect(killTreeMock).toHaveBeenCalledWith(424242);
    rmSync(dir, { recursive: true, force: true });
  }, 10_000);

  it("无 settlePath 时不进入 settle 轮询（GEN_EXIT 超时后立即 close）", async () => {
    // 假 socket 不应答，GEN_EXIT 走满自身超时——这是 send 的行为，不是
    // settle 的。锁定点：close 被调，且**没有**额外的 settle 时间。
    // 用「同一时钟下稳定文件确实多等了 ≥1s 稳定窗」作正对照，比硬编码
    // GEN_EXIT 的 4s 常量更能说明「省掉的是 settle 那一段」。
    const bare = new UvSocketClient(fakeSocket() as never, 4823, fakeChild() as never);
    const { elapsed: bareElapsed } = await underFakeClock(() => bare.exit());
    expect(bare.closed).toBe(true);

    const dir = mkdtempSync(join(tmpdir(), "keil-exit-"));
    const project = join(dir, "stable.uvprojx");
    writeFileSync(project, "seed\n", "utf8");
    const settled = new UvSocketClient(fakeSocket() as never, 4823, fakeChild() as never);
    const { elapsed: settledElapsed } = await underFakeClock(() =>
      settled.exit({ settlePath: project, timeoutMs: 10_000 }),
    );

    expect(settledElapsed - bareElapsed).toBeGreaterThanOrEqual(1_000);
    rmSync(dir, { recursive: true, force: true });
  }, 10_000);

  it("工程文件已稳定时快速返回（等满 1s 稳定窗）", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keil-exit-"));
    const project = join(dir, "small.uvprojx");
    writeFileSync(project, "seed\n", "utf8");
    const client = new UvSocketClient(fakeSocket() as never, 4823, fakeChild() as never);
    const { elapsed } = await underFakeClock(() =>
      client.exit({ settlePath: project, timeoutMs: 10_000 }),
    );
    // 稳定窗 1s + GEN_EXIT 超时 4s（假 socket 不应答）；关键是不等满超时。
    expect(elapsed).toBeLessThan(8_000);
    expect(elapsed).toBeGreaterThanOrEqual(900);
    rmSync(dir, { recursive: true, force: true });
  }, 15_000);

  it("文件不存在时不挂死，超时兜底照常 close", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keil-exit-"));
    const missing = join(dir, "absent.uvprojx");
    const client = new UvSocketClient(fakeSocket() as never, 4823, fakeChild() as never);
    const { elapsed } = await underFakeClock(() =>
      client.exit({ settlePath: missing, timeoutMs: 800 }),
    );
    expect(client.closed).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(700);
    expect(existsSync(missing)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  }, 10_000);
});
