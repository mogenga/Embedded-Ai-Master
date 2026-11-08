import * as childProcess from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMessages } from "../src/context/build.js";
import { readSessionDir } from "../src/session/persistence.js";
import { createSession } from "../src/session/session.js";
import type { BackgroundResultPayload, SessionEvent } from "../src/session/types.js";
import {
  killAllBackgroundJobs,
  terminalBgCheckTool,
  terminalBgTool,
  takeBackgroundCompletions,
} from "../src/tools/background.js";
import { isDangerousCommand } from "../src/tools/shell.js";
import type { ToolCtx, ToolResult } from "../src/tools/types.js";
import {
  createContext,
  sessionEventToHostEvents,
} from "../desktop/renderer/protocol.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn(actual.spawn),
    spawnSync: vi.fn(actual.spawnSync),
  };
});

const spawnMock = vi.mocked(childProcess.spawn);
const spawnSyncMock = vi.mocked(childProcess.spawnSync);

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeWorkdir(): string {
  return makeTempDir("eam-bg-");
}

function makeCtx(workdir: string, sessionId: string): ToolCtx {
  return { sessionId, cwd: workdir };
}

function nodeCommand(script: string): string {
  const executable = /\s/.test(process.execPath) ? `"${process.execPath}"` : process.execPath;
  return `${executable} -e "${script}"`;
}

function detailOf(result: ToolResult): Record<string, unknown> {
  return (result.detail ?? {}) as Record<string, unknown>;
}

/**
 * 轮询直到 `probe` 给出值。
 *
 * 间隔从 25 ms 起步并按 1.5 倍退避（封顶 1 s）。固定 25 ms 时，一条要等
 * 500 ms 的作业会被问 20 次、一条等 5 s 的被问 200 次；每次都是一次
 * `terminalBgCheckTool.execute`，在满载机器上这些空转本身就是负载的一部分。
 * 退避让「很快就绪」仍然在 25 ms 内拿到，而「还要等很久」不再把 CPU 花在
 * 明知不会变的轮询上。判据仍是同一个谓词，只是问得少。
 */
async function waitFor<T>(
  probe: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let interval = 25;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, interval));
    interval = Math.min(Math.round(interval * 1.5), 1_000);
  }
}

/** 轮询 check 直到作业不再是 running，返回那一份报告。 */
async function waitForSettledReport(
  id: string,
  ctx: ToolCtx,
  timeoutMs = 10_000,
): Promise<ToolResult> {
  return waitFor<ToolResult>(async () => {
    const snapshot = await terminalBgCheckTool.execute(
      { id },
      ctx,
      new AbortController().signal,
    );
    return detailOf(snapshot).status === "running" ? undefined : snapshot;
  }, timeoutMs);
}

/**
 * 等一个进程真的消失。
 *
 * **超时从 10 s 放宽到 30 s，理由是语义变了而不是「机器慢」**（D-229）：
 * `terminateTree` 从「同步等 `taskkill` 跑完（约 1 s + 不确定）」改成「异步发出、
 * 立刻返回」之后，从「调用了终止」到「进程不在进程表里」中间真的隔着约 1 s
 * （实测：发信号 21 ms，消失 950 ms）。并行全量时这一段还要再被争用拉长。
 *
 * 放宽的是**等它消失**的容忍度，不是断言：进程如果真的没死，30 s 后照样报
 * `still running`。别把它调到分钟级——那会把「终止没生效」也一起藏掉。
 */
async function waitForExit(pid: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`process ${pid} still running`);
}

function fakeChild(): ChildProcess & {
  unref: ReturnType<typeof vi.fn>;
  stdout: EventEmitter & { unref: ReturnType<typeof vi.fn> };
  stderr: EventEmitter & { unref: ReturnType<typeof vi.fn> };
} {
  const child = new EventEmitter() as unknown as ChildProcess & {
    unref: ReturnType<typeof vi.fn>;
    stdout: EventEmitter & { unref: ReturnType<typeof vi.fn> };
    stderr: EventEmitter & { unref: ReturnType<typeof vi.fn> };
  };
  Object.assign(child, {
    unref: vi.fn(),
    stdout: Object.assign(new EventEmitter(), { unref: vi.fn() }),
    stderr: Object.assign(new EventEmitter(), { unref: vi.fn() }),
  });
  return child;
}

/**
 * 一个「真的会结束」的假子进程：收到终止请求后按脚本自行退出。
 *
 * ## 为什么需要它（D-229）
 *
 * `taskkill /T /F` 在 Windows 上固定约 1 s 启动成本，而这次全量跑挂在
 * `--maxWorkers=4` 下时，十几个真实进程树同时回收会把单次拖到十几秒。
 * 于是「等进程真的消失」变成了在测机器负载，不是测代码。
 *
 * **判据**：只有断言**依赖「进程表里真的少了这个 pid」** 时才必须用真进程
 * （`kill 请求真实结束进程` / `超时终止整棵进程树` / 一个新的回收冒烟用例）。
 * 其余用例验的是「发出终止 → 作业状态与回报」，用假子进程更准也更快——
 * 真进程那点延迟只会给断言加噪声。
 *
 * `onTerminate` 由测试注入：假 pid 上 `taskkill` 必然失败，所以这里直接模拟
 * 「信号生效后子进程自己 close」，与真实 child 的 `exit` → `close` 顺序一致。
 */
function scriptedChild(options: {
  pid?: number;
  /** 终止请求到达后多久发出 close（0 = 下一个 tick）。 */
  exitAfterMs?: number;
  exitCode?: number | null;
  signal?: string | null;
} = {}) {
  const child = fakeChild();
  const pid = options.pid ?? 616_000;
  Object.assign(child, { pid });
  const exitCode = options.exitCode ?? null;
  const signal = options.signal ?? "SIGKILL";
  return {
    child,
    /** 让子进程「跑完」：发 exit 再发 close，与 Node 的顺序一致。 */
    finish(): void {
      (child as unknown as EventEmitter).emit("exit", exitCode, signal);
      (child as unknown as EventEmitter).emit("close", exitCode, signal);
    },
    /** 安排一次自动结束（用于「被杀之后确实结束」的场景）。 */
    scheduleExit(ms = 0): void {
      setTimeout(() => this.finish(), ms).unref?.();
    },
  };
}

afterEach(async () => {
  killAllBackgroundJobs();
  spawnMock.mockReset();
  spawnSyncMock.mockReset();
  // **清理失败不得判红**（D-229）。`killAllBackgroundJobs()` 现在是「发出回收
  // 就返回」而不是「等到回收完成」：taskkill 真正让进程消失还要约 1 s，并行
  // 全量下实测最慢到过 15.7 s。在这段时间里 Windows 会把该进程的 cwd 占住，
  // 立刻 `rmSync` 就是 EPERM——而 afterEach 抛错会让**下一条用例**也红，
  // 于是一条真实失败会放大成一片。
  //
  // 重试几次拿掉绝大多数情况；仍失败就放着——目录在系统临时目录里，不归仓库管。
  for (const dir of tempDirs.splice(0)) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      }
    }
  }
});

describe("terminal_bg 元数据与 schema", () => {
  it("名称、注解与默认访问级别", () => {
    expect(terminalBgTool.name).toBe("terminal_bg");
    expect(terminalBgTool.annotations).toEqual({ readOnly: false, destructive: true });
    expect(terminalBgTool.access?.({ command: "x" })).toBe("write");
  });

  it("check 工具的访问级别随 kill 变化", () => {
    expect(terminalBgCheckTool.name).toBe("terminal_bg_check");
    // 静态注解无法描述「带 kill 才是写」的工具,所以两者都不声明注解:
    // 声明 readOnly 会对 kill 路径说谎,声明 destructive 会误标一次纯状态读取。
    expect(terminalBgCheckTool.annotations).toBeUndefined();
    expect(terminalBgCheckTool.access?.({ id: "x" })).toBe("read");
    expect(terminalBgCheckTool.access?.({ id: "x", kill: true })).toBe("write");
  });

  it.each<[unknown, string]>([
    [{}, "缺 command"],
    [{ command: "" }, "空 command"],
    [{ command: "x", cwd: 1 }, "cwd 非字符串"],
    [{ command: "x", timeoutMs: 0 }, "timeoutMs 为 0"],
    [{ command: "x", timeoutMs: -5 }, "timeoutMs 为负"],
    [{ command: "x", timeoutMs: 1.5 }, "timeoutMs 非整数"],
  ])("拒绝非法输入 %j（%s）", (input) => {
    expect(terminalBgTool.schema.safeParse(input).success).toBe(false);
  });

  it("接受最小输入与可选 cwd/timeoutMs", () => {
    expect(terminalBgTool.schema.safeParse({ command: "x" }).success).toBe(true);
    expect(terminalBgTool.schema.safeParse({ command: "x", cwd: "sub" }).success).toBe(true);
    expect(terminalBgTool.schema.safeParse({ command: "x", timeoutMs: 600_000 }).success).toBe(true);
  });

  it("check 工具接受空输入、id 与 kill", () => {
    expect(terminalBgCheckTool.schema.safeParse({}).success).toBe(true);
    expect(terminalBgCheckTool.schema.safeParse({ id: "bg_0123456789ab" }).success).toBe(true);
    expect(terminalBgCheckTool.schema.safeParse({ id: "bg_0123456789ab", kill: true }).success).toBe(true);
    expect(terminalBgCheckTool.schema.safeParse({ id: "" }).success).toBe(false);
    expect(terminalBgCheckTool.schema.safeParse({ kill: "yes" }).success).toBe(false);
  });
});

describe("危险命令与中止", () => {
  it("危险命令先由纯函数识别，再断言从未 spawn", async () => {
    const command = "rm -rf /";
    // 第一层:纯函数断言。绝不为制造 RED 去真实执行。
    expect(isDangerousCommand(command)).toBe(true);
    spawnMock.mockClear();

    const r = await terminalBgTool.execute(
      { command },
      makeCtx(makeWorkdir(), "s-danger"),
      new AbortController().signal,
    );

    expect(r.isError).toBe(true);
    expect(r.code).toBe("dangerous_command");
    expect(r.text).toContain("dangerous command blocked");
    // 第二层:底层 spawn 一次都没被调用。
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("危险命令的 message 截断到 200 字符", async () => {
    const command = `rm -rf / ${"x".repeat(500)}`;
    expect(isDangerousCommand(command)).toBe(true);
    spawnMock.mockClear();

    const r = await terminalBgTool.execute(
      { command },
      makeCtx(makeWorkdir(), "s-danger-long"),
      new AbortController().signal,
    );

    expect(r.code).toBe("dangerous_command");
    expect(r.message.length).toBeLessThan(240);
    expect(r.message.endsWith("...")).toBe(true);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("已中止的 signal 不启动任何进程", async () => {
    const controller = new AbortController();
    controller.abort();
    spawnMock.mockClear();

    const r = await terminalBgTool.execute(
      { command: nodeCommand("setTimeout(() => {}, 1000)") },
      makeCtx(makeWorkdir(), "s-aborted"),
      controller.signal,
    );

    expect(r.isError).toBe(true);
    expect(r.code).toBe("background_aborted");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("cwd 越界与不存在都返回 cwd_invalid，且不 spawn", async () => {
    const workdir = makeWorkdir();
    spawnMock.mockClear();

    for (const cwd of ["../", "missing"]) {
      const r = await terminalBgTool.execute(
        { command: nodeCommand("console.log(1)"), cwd },
        makeCtx(workdir, "s-cwd"),
        new AbortController().signal,
      );
      expect(r.isError).toBe(true);
      expect(r.code).toBe("cwd_invalid");
    }
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("后台作业执行", () => {
  it("立即返回 job id，不等待命令结束", async () => {
    // 假子进程（D-229）：这条验的是**立即返回**与 id 形状，与进程表无关。
    // 用真进程反而更差——「没有等它跑完」这件事，假子进程根本不会跑完。
    const workdir = makeWorkdir();
    const ctx = makeCtx(workdir, "s-immediate");
    const scripted = scriptedChild({ pid: 616_400 });
    spawnMock.mockImplementationOnce(() => scripted.child);
    const started = Date.now();

    const r = await terminalBgTool.execute(
      { command: "sleep forever" },
      ctx,
      new AbortController().signal,
    );
    const elapsed = Date.now() - started;

    expect(r.isError).toBe(false);
    expect(r.code).toBe("ok");
    expect(elapsed).toBeLessThan(3_000);
    const detail = detailOf(r);
    expect(String(detail.id)).toMatch(/^bg_[0-9a-f]{12}$/);
    expect(Number(detail.pid)).toBeGreaterThan(0);
    expect(r.text).toContain(`terminal_bg_check`);
    expect(r.text).toContain(String(detail.id));

    const running = await terminalBgCheckTool.execute(
      { id: String(detail.id) },
      ctx,
      new AbortController().signal,
    );
    expect(detailOf(running).status).toBe("running");
    expect(running.isError).toBe(false);

    // 结束它，让作业落到终局（假子进程不会自己退出）。
    await terminalBgCheckTool.execute(
      { id: String(detail.id), kill: true },
      ctx,
      new AbortController().signal,
    );
    scripted.finish();
  });

  it("cwd 生效", async () => {
    const workdir = makeWorkdir();
    const ctx = makeCtx(workdir, "s-cwd-ok");
    // 让子进程自己报出它的工作目录,再与真实的子目录路径比较。
    childProcess.spawnSync(process.execPath, ["-e", "require('node:fs').mkdirSync('sub')"], {
      cwd: workdir,
      stdio: "ignore",
    });
    const expected = realpathSync(path.join(workdir, "sub")).toLowerCase();

    const r = await terminalBgTool.execute(
      { command: nodeCommand("console.log(process.cwd())"), cwd: "sub" },
      ctx,
      new AbortController().signal,
    );
    expect(r.isError).toBe(false);

    const completion = await waitFor(() => takeBackgroundCompletions("s-cwd-ok")[0]);
    expect(completion.status).toBe("exited");
    expect(completion.exitCode).toBe(0);
    const reported = completion.text.trim().split(/\r?\n/).at(-1) ?? "";
    expect(realpathSync(reported).toLowerCase()).toBe(expected);
  });

  it("完成后回报一次，取出即消费", async () => {
    const workdir = makeWorkdir();
    const sessionId = "s-once";

    const r = await terminalBgTool.execute(
      { command: nodeCommand("console.log('done-marker')") },
      makeCtx(workdir, sessionId),
      new AbortController().signal,
    );
    expect(r.isError).toBe(false);

    const completion = await waitFor(() => takeBackgroundCompletions(sessionId)[0]);

    expect(completion.id).toBe(String(detailOf(r).id));
    expect(completion.status).toBe("exited");
    expect(completion.exitCode).toBe(0);
    expect(completion.truncated).toBe(false);
    expect(completion.bytes).toBeGreaterThan(0);
    expect(completion.capturedBytes).toBe(completion.bytes);
    expect(completion.text).toContain("done-marker");
    expect(completion.durationMs).toBeGreaterThanOrEqual(0);
    // 会话归属由队列键决定,payload 本身不带 sessionId(它会被写进该会话的事件)。
    expect(takeBackgroundCompletions(sessionId)).toEqual([]);
    expect(takeBackgroundCompletions("s-other")).toEqual([]);
  });

  it("check 先看过结果后，完成队列不再重复回报", async () => {
    const workdir = makeWorkdir();
    const sessionId = "s-check-then-queue";

    const r = await terminalBgTool.execute(
      { command: nodeCommand("process.exit(0)") },
      makeCtx(workdir, sessionId),
      new AbortController().signal,
    );
    const id = String(detailOf(r).id);

    const finished = await waitForSettledReport(id, makeCtx(workdir, sessionId));

    expect(detailOf(finished).status).toBe("exited");
    expect(finished.text).toContain("exited with code 0");
    expect(takeBackgroundCompletions(sessionId)).toEqual([]);
  });

  it("超时终止整棵进程树并回报 timed_out", async () => {
    const workdir = makeWorkdir();
    const sessionId = "s-timeout";
    const pidFile = path.join(workdir, "pid.txt");

    const r = await terminalBgTool.execute(
      {
        command: nodeCommand(
          "require('node:fs').writeFileSync('pid.txt', String(process.pid)); setTimeout(() => {}, 30000)",
        ),
        timeoutMs: 500,
      },
      makeCtx(workdir, sessionId),
      new AbortController().signal,
    );
    expect(r.isError).toBe(false);
    const id = String(detailOf(r).id);

    const pid = await waitFor(() => {
      try {
        const value = Number(readFileSync(pidFile, "utf8"));
        return Number.isInteger(value) && value > 0 ? value : undefined;
      } catch {
        return undefined;
      }
    });

    const completion = await waitFor(() => takeBackgroundCompletions(sessionId)[0], 15_000);

    expect(completion.id).toBe(id);
    expect(completion.status).toBe("timed_out");
    expect(completion.killedBy).toBe("timeout");
    await waitForExit(pid);
  }, 60_000);

  it("kill 请求真实结束进程", async () => {
    const workdir = makeWorkdir();
    const ctx = makeCtx(workdir, "s-kill");

    const r = await terminalBgTool.execute(
      { command: nodeCommand("setTimeout(() => {}, 30000)") },
      ctx,
      new AbortController().signal,
    );
    const id = String(detailOf(r).id);
    const pid = Number(detailOf(r).pid);

    const killed = await terminalBgCheckTool.execute(
      { id, kill: true },
      ctx,
      new AbortController().signal,
    );

    expect(killed.isError).toBe(false);
    expect(["signaled", "running"]).toContain(detailOf(killed).status);
    await waitForExit(pid);

    const after = await waitForSettledReport(id, ctx);
    expect(detailOf(after).status).toBe("signaled");
    expect(detailOf(after).killedBy).toBe("kill");
  }, 60_000);

  it("进程赖着不退时兜底给出终局，而不是永远 running", async () => {
    vi.useFakeTimers();
    try {
      const workdir = makeWorkdir();
      const sessionId = "s-fallback";
      const child = fakeChild();
      Object.assign(child, { pid: 616_161 });
      spawnMock.mockImplementationOnce(() => child);
      if (process.platform === "win32") {
        // taskkill 在假 pid 上必然失败;这里只关心计时器路径,别真去调它。
        spawnSyncMock.mockImplementation(
          (() => ({ status: 1 })) as unknown as typeof childProcess.spawnSync,
        );
      }

      await terminalBgTool.execute(
        { command: "echo hi", timeoutMs: 1_000 },
        makeCtx(workdir, sessionId),
        new AbortController().signal,
      );

      // 假子进程永远不发 close:超时后走到兜底分支。
      await vi.advanceTimersByTimeAsync(5_000);

      const completion = takeBackgroundCompletions(sessionId)[0];
      expect(completion?.status).toBe("timed_out");
      expect(completion?.killedBy).toBe("timeout");
      // 兜底只有一次:再推进时间不会冒出第二条通知。
      await vi.advanceTimersByTimeAsync(5_000);
      expect(takeBackgroundCompletions(sessionId)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("对已结束的作业 kill 不伪造一次新的终止，如实报告原终局", async () => {
    const workdir = makeWorkdir();
    const sessionId = "s-kill-finished";
    const child = fakeChild();
    Object.assign(child, { pid: 717_171 });
    spawnMock.mockImplementationOnce(() => child);

    const r = await terminalBgTool.execute(
      { command: "echo hi" },
      makeCtx(workdir, sessionId),
      new AbortController().signal,
    );
    const id = String(detailOf(r).id);
    child.emit("close", 0, null);

    const killed = await terminalBgCheckTool.execute(
      { id, kill: true },
      makeCtx(workdir, sessionId),
      new AbortController().signal,
    );

    expect(killed.isError).toBe(false);
    expect(detailOf(killed).killRequested).toBe(false);
    expect(detailOf(killed).status).toBe("exited");
    expect(killed.text).toContain("exited with code 0");
    // 已经报告过,完成队列不再重复。
    expect(takeBackgroundCompletions(sessionId)).toEqual([]);
  });

  it("killAllBackgroundJobs 对每个运行中的作业发出回收，并立刻清空", async () => {
    // 假子进程（D-229）：这条验的是「清空 + 计数 + 发出回收」，不验进程表。
    // 真正「进程消失了」由下面的 `kill 请求真实结束进程` 覆盖。
    const workdir = makeWorkdir();
    const ctx = makeCtx(workdir, "s-kill-all");
    const scripted = scriptedChild({ pid: 616_100 });
    spawnMock.mockImplementationOnce(() => scripted.child);

    const r = await terminalBgTool.execute(
      { command: "sleep forever" },
      ctx,
      new AbortController().signal,
    );
    expect(r.isError).toBe(false);

    expect(killAllBackgroundJobs()).toBeGreaterThanOrEqual(1);

    // 回收器发出后，作业不该再被列出——它已经 settled 并被移出表。
    const after = await terminalBgCheckTool.execute({}, ctx, new AbortController().signal);
    expect(after.text).not.toContain(String(detailOf(r).id));
  });

  it("输出超过上限时保留尾部并显式标记截断", async () => {
    const workdir = makeWorkdir();
    const sessionId = "s-truncate";

    const r = await terminalBgTool.execute(
      { command: nodeCommand("process.stdout.write('x'.repeat(100000))") },
      makeCtx(workdir, sessionId),
      new AbortController().signal,
    );
    expect(r.isError).toBe(false);

    const completion = await waitFor(() => takeBackgroundCompletions(sessionId)[0]);

    expect(completion.status).toBe("exited");
    expect(completion.truncated).toBe(true);
    expect(completion.bytes).toBe(100_000);
    expect(completion.capturedBytes).toBeLessThan(completion.bytes);
    expect(completion.capturedBytes).toBeGreaterThan(0);
    expect(completion.text).toHaveLength(completion.capturedBytes);
    expect(completion.text).toMatch(/^x+$/);
    expect(completion.text).not.toContain("�");
  });

  it("check 的正文报出字节数与截断事实，不把残缺输出说成完整", async () => {
    const workdir = makeWorkdir();
    const ctx = makeCtx(workdir, "s-truncate-text");

    const r = await terminalBgTool.execute(
      { command: nodeCommand("process.stdout.write('y'.repeat(100000))") },
      ctx,
      new AbortController().signal,
    );
    const id = String(detailOf(r).id);

    const report = await waitForSettledReport(id, ctx);

    expect(report.text).toContain("100000 bytes");
    expect(report.text).toContain("truncated");
    expect(report.text).toContain("kept the last");
    expect(detailOf(report)).toMatchObject({
      bytes: 100_000,
      truncated: true,
    });
  });

  it("进程被信号终止时回报 signaled 与信号名", async () => {
    // Windows 没有信号:一个真实的自杀进程在 `close` 里只给出退出码、signal
    // 恒为 null。这条用例要验的是**分类逻辑**（close(null, "SIGTERM") →
    // signaled），所以用假子进程喂那个真实平台给不出的形状;真实进程的终止
    // 已经由上面「kill 请求真实结束进程」覆盖。
    const workdir = makeWorkdir();
    const sessionId = "s-signal";
    const child = fakeChild();
    Object.assign(child, { pid: 515_151 });
    spawnMock.mockImplementationOnce(() => child);

    const r = await terminalBgTool.execute(
      { command: nodeCommand("whatever") },
      makeCtx(workdir, sessionId),
      new AbortController().signal,
    );
    expect(r.isError).toBe(false);

    child.stdout.emit("data", Buffer.from("boom\n"));
    child.emit("close", null, "SIGTERM");

    const completion = takeBackgroundCompletions(sessionId)[0];
    expect(completion?.status).toBe("signaled");
    expect(completion?.signal).toBe("SIGTERM");
    expect(completion?.exitCode).toBeNull();
    expect(completion?.killedBy).toBeNull();
    expect(completion?.text).toContain("boom");
  });
});

describe("terminal_bg_check 查询", () => {
  it("未知 job id 是错误而不是静默成功", async () => {
    const workdir = makeWorkdir();

    const r = await terminalBgCheckTool.execute(
      { id: "bg_000000000000" },
      makeCtx(workdir, "s-unknown"),
      new AbortController().signal,
    );

    expect(r.isError).toBe(true);
    expect(r.code).toBe("background_job_unknown");
    expect(r.text).toContain("bg_000000000000");
  });

  it("别的会话看不到本会话的作业", async () => {
    // 假子进程（D-229）：这条验的是**会话隔离**，与进程表无关。
    const workdir = makeWorkdir();
    const owner = makeCtx(workdir, "s-owner");
    const scripted = scriptedChild({ pid: 616_200 });
    spawnMock.mockImplementationOnce(() => scripted.child);
    const r = await terminalBgTool.execute(
      { command: "sleep forever" },
      owner,
      new AbortController().signal,
    );
    const id = String(detailOf(r).id);

    const other = await terminalBgCheckTool.execute(
      { id },
      makeCtx(workdir, "s-other"),
      new AbortController().signal,
    );

    expect(other.isError).toBe(true);
    expect(other.code).toBe("background_job_unknown");

    // 由属主会话收掉，而不是留给 afterEach：这条用例验的是「会话隔离」，
    // 顺手把作业结束掉，免得 afterEach 为它多跑一次回收。
    await terminalBgCheckTool.execute({ id, kill: true }, owner, new AbortController().signal);
  });

  it("不带 id 时列出本会话的作业", async () => {
    // 假子进程（D-229）：这条验的是**列表内容**，与进程表无关。
    const workdir = makeWorkdir();
    const ctx = makeCtx(workdir, "s-list");
    const scripted = scriptedChild({ pid: 616_300 });
    spawnMock.mockImplementationOnce(() => scripted.child);
    const r = await terminalBgTool.execute(
      { command: "sleep forever" },
      ctx,
      new AbortController().signal,
    );
    const id = String(detailOf(r).id);

    const list = await terminalBgCheckTool.execute({}, ctx, new AbortController().signal);

    expect(list.isError).toBe(false);
    expect(list.text).toContain(id);
    expect(list.text).toContain("running");
    expect(Array.isArray(detailOf(list).jobs)).toBe(true);

    // 在用例里收掉，别留给 afterEach。
    await terminalBgCheckTool.execute({ id, kill: true }, ctx, new AbortController().signal);
  });

  it("空会话的列表不是错误", async () => {
    const r = await terminalBgCheckTool.execute(
      {},
      makeCtx(makeWorkdir(), "s-empty"),
      new AbortController().signal,
    );

    expect(r.isError).toBe(false);
    expect(r.code).toBe("ok");
    expect(detailOf(r).jobs).toEqual([]);
    expect(r.text).toContain("没有后台作业");
  });

  it("kill 缺少 id 是输入错误", async () => {
    const r = await terminalBgCheckTool.execute(
      { kill: true },
      makeCtx(makeWorkdir(), "s-kill-no-id"),
      new AbortController().signal,
    );

    expect(r.isError).toBe(true);
    expect(r.code).toBe("invalid_input");
  });
});

describe("资源生命周期", () => {
  it("子进程与两条管道都 unref，作业结束后不留定时器", async () => {
    vi.useFakeTimers();
    try {
      const workdir = makeWorkdir();
      const sessionId = "s-unref";
      const child = fakeChild();
      Object.assign(child, { pid: 424242 });
      spawnMock.mockImplementationOnce(() => child);

      const r = await terminalBgTool.execute(
        { command: "echo hi", timeoutMs: 60_000 },
        makeCtx(workdir, sessionId),
        new AbortController().signal,
      );

      expect(r.isError).toBe(false);
      expect(child.unref).toHaveBeenCalledTimes(1);
      expect(child.stdout.unref).toHaveBeenCalledTimes(1);
      expect(child.stderr.unref).toHaveBeenCalledTimes(1);
      // 只有作业自己的超时定时器,且它也在跑完后被清掉。
      expect(vi.getTimerCount()).toBe(1);

      child.stdout.emit("data", Buffer.from("hi\n"));
      child.emit("close", 0, null);

      expect(vi.getTimerCount()).toBe(0);
      const completion = takeBackgroundCompletions(sessionId)[0];
      expect(completion?.status).toBe("exited");
      expect(completion?.text).toContain("hi");
    } finally {
      vi.useRealTimers();
    }
  });

  it("spawn 同步抛错时如实报错，不注册作业", async () => {
    const workdir = makeWorkdir();
    spawnMock.mockImplementationOnce(() => {
      throw new Error("spawn boom");
    });

    const r = await terminalBgTool.execute(
      { command: "echo hi" },
      makeCtx(workdir, "s-spawn-fail"),
      new AbortController().signal,
    );

    expect(r.isError).toBe(true);
    expect(r.code).toBe("background_spawn_failed");
    expect(r.text).toContain("spawn boom");
    expect(takeBackgroundCompletions("s-spawn-fail")).toEqual([]);
  });
});

describe("background_result 事件接线（四处缺一不可）", () => {
  const payload: BackgroundResultPayload = {
    id: "bg_0123456789ab",
    command: "npm run build",
    cwd: "/work",
    status: "exited",
    exitCode: 0,
    signal: null,
    killedBy: null,
    startedAt: "2026-10-22T00:00:00.000Z",
    finishedAt: "2026-10-22T00:10:00.000Z",
    durationMs: 600_000,
    stdoutBytes: 12,
    stderrBytes: 0,
    bytes: 12,
    capturedBytes: 12,
    truncated: false,
    text: "build ok\n",
  };

  it("持久化白名单接受 background_result（漏登记会让整份日志不可读）", async () => {
    const dir = makeTempDir("event-types-bg-");
    const session = await createSession(dir);
    await session.append({ type: "user", payload: { content: "u" } });
    await session.append({ type: "background_result", payload: { ...payload } });
    await session.close();

    const result = readSessionDir(dir);

    expect(result.events.map((event) => event.type)).toEqual(["user", "background_result"]);
    expect(result.events[1]?.payload).toStrictEqual({ ...payload });
  });

  it("投影层忽略 background_result，且它可出现在工具批次中间", () => {
    const events: SessionEvent[] = [
      {
        seq: 0,
        ts: "t",
        type: "assistant",
        payload: { content: "", toolCalls: [{ id: "c1", name: "shell", arguments: {} }] },
      },
      // 后台作业结束的时刻与本轮的工具批次无关:它可能落在 assistant 与它的
      // tool_result 之间。投影必须原位跳过,而不是把它变成一条消息。
      { seq: 1, ts: "t", type: "background_result", payload: { ...payload } },
      { seq: 2, ts: "t", type: "tool_result", payload: { id: "c1", text: "ok" }, parent: 0 },
    ];

    expect(() => buildMessages(events)).not.toThrow();
    expect(buildMessages(events).map((message) => message.role)).toEqual(["assistant", "tool"]);
  });

  it("桌面协议层把 background_result 画成 notice，而不是未识别类型", () => {
    const ctx = createContext({ sessionId: "s" });

    const out = sessionEventToHostEvents(
      { seq: 0, ts: "t", type: "background_result", payload: { ...payload } },
      ctx,
    );

    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("notice");
    expect(out[0].level).toBe("dim");
    expect(String(out[0].text)).toContain("后台任务");
    expect(String(out[0].text)).toContain("npm run build");
    expect(String(out[0].text)).toContain("退出码 0");
  });

  it("非零退出与截断在 notice 里都说清楚", () => {
    const ctx = createContext({ sessionId: "s" });

    const out = sessionEventToHostEvents(
      {
        seq: 0,
        ts: "t",
        type: "background_result",
        payload: {
          ...payload,
          status: "signaled",
          exitCode: null,
          signal: "SIGTERM",
          bytes: 100_000,
          capturedBytes: 65_536,
          truncated: true,
        },
      },
      ctx,
    );

    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("notice");
    expect(out[0].level).toBe("warn");
    expect(String(out[0].text)).toContain("SIGTERM");
    expect(String(out[0].text)).toContain("65536");
    expect(String(out[0].text)).toContain("100000");
  });

  it("超时状态有独立文案", () => {
    const ctx = createContext({ sessionId: "s" });

    const out = sessionEventToHostEvents(
      {
        seq: 0,
        ts: "t",
        type: "background_result",
        payload: { ...payload, status: "timed_out", exitCode: null },
      },
      ctx,
    );

    expect(out[0].type).toBe("notice");
    expect(out[0].level).toBe("warn");
    expect(String(out[0].text)).toContain("超时");
  });
});
