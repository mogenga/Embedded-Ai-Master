import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { signalProcessTree, isProcessAlive } from "../src/tools/process-tree.js";

/**
 * 终止进程树的**不阻塞**版本（D-229）。
 *
 * 原来的 `taskkill /T /F` 走 `spawnSync`，在 Windows 上单次约 1 s（对**不存在的
 * pid** 也要 0.95–1.22 s，实测 10 次——那是进程启动 + 杀软扫描的成本，与负载无关）。
 * 一次 `killAllBackgroundJobs()` 对每个残留作业连做两次，而它挂在每个用例的
 * `afterEach` 上：38 个用例串起来就是 38–76 s 的同步阻塞。
 *
 * 阻塞期间 `waitForExit(pid)` 的 25 ms 轮询根本跑不动，它的 10 s 预算在阻塞中
 * 就被花光了——这就是并行全量下 `background-terminal` / `shell` 报
 * `process N still running` 的机制。
 *
 * **不能**改成「只对直接子进程 SIGKILL」：`shell: true` 时直接子进程是 cmd.exe，
 * 真正的命令是孙进程。实测只杀 cmd.exe（无论 detached 与否），500 ms 后孙子
 * **仍然存活**——所以 `/T` 的树遍历是必需的，不能省。
 *
 * 所以这里做的是：**发起**回收但不阻塞。`taskkill` 在后台自己跑完，调用方立刻
 * 拿到「信号已发出」。这与 `McpManager.reapProcessTree`（批次 6）是同一姿态。
 */

const tempDirs: string[] = [];

afterEach(async () => {
  // 子进程被 taskkill 之后，它的 cwd 可能还被 Windows 短暂占着：立刻删会 EPERM。
  // 这不属于被测行为，所以重试几次；仍失败就留给系统临时目录（不能因为清理
  // 失败把一条已经通过的用例判红）。
  for (const dir of tempDirs.splice(0)) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        rmSync(dir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
});

/** A real command that records its own pid and then sleeps. */
async function sleepingCommandOn(dir: string): Promise<{ pid: number; child: ReturnType<typeof spawn> }> {
  const exe = /\s/.test(process.execPath) ? `"${process.execPath}"` : process.execPath;
  const command = `${exe} -e "require('fs').writeFileSync('pid.txt', String(process.pid)); setTimeout(()=>{}, 60000)"`;
  const child = spawn(command, {
    shell: true,
    cwd: dir,
    env: process.env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const pidFile = path.join(dir, "pid.txt");
  const deadline = Date.now() + 10_000;
  while (!existsSync(pidFile) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!existsSync(pidFile)) throw new Error("the child never wrote its pid");
  return { pid: Number(readFileSync(pidFile, "utf8")), child };
}

async function until(predicate: () => boolean, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

describe("signalProcessTree 不阻塞事件循环", () => {
  it("对一个真实 pid 调用时立即返回（远低于 taskkill 自身的 ~1 s）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "eam-tree-"));
    tempDirs.push(dir);
    const { pid, child } = await sleepingCommandOn(dir);
    try {
      const started = Date.now();
      const signalled = signalProcessTree(pid);
      const elapsed = Date.now() - started;

      expect(signalled).toBe(true);
      // taskkill 的启动成本约 1 s；不阻塞的实现在这里应该是个位数毫秒。
      // 阈值取 200 ms：远高于调用成本，远低于 taskkill 的一次启动。
      expect(elapsed).toBeLessThan(200);
    } finally {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
  }, 40_000);

  it("调用之后事件循环仍在转：等待期间定时器照常触发", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "eam-tree-"));
    tempDirs.push(dir);
    const { pid, child } = await sleepingCommandOn(dir);
    try {
      signalProcessTree(pid);

      // 阻塞实现下这个 100 ms 的定时器会被 taskkill 拖到 1 s 之后；
      // 不阻塞的实现里它应当在接近 100 ms 时到达。
      const started = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const elapsed = Date.now() - started;

      expect(elapsed).toBeLessThan(600);
    } finally {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }
  }, 40_000);

  it("整棵树最终真的会消失（不是「发了信号就算完」）", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "eam-tree-"));
    tempDirs.push(dir);
    const { pid, child } = await sleepingCommandOn(dir);
    try {
      expect(signalProcessTree(pid)).toBe(true);

      // 孙进程（真正的命令）也在树里。`/T` 会枚举它；这一步正是
      // 「只对直接子进程 SIGKILL」做不到的事。
      //
      // 窗口取 60 s：空闲时这一步约 950 ms，但并行全量下 `taskkill` 的启动会被
      // 争用拖到十几秒（实测最慢 15.7 s）。这条测的是**最终会消失**，不是
      // 「多快消失」——把窗口卡在 20 s 等于在测机器负载。
      const gone = await until(() => isProcessAlive(pid), 60_000);
      expect(gone).toBe(true);
    } finally {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }, 90_000);

  it("对已经消失的 pid 不抛错", async () => {
    // **不能断言返回值是 false**：异步 `spawn` 对不存在的 pid 也会成功启动
    // （它只知道「有没有把 taskkill 拉起来」，不知道目标在不在）。返回值表达
    // 的就是这个意思——「回收器已发出」，不是「进程已终止」。要判断后者，
    // 调用方用 `isProcessAlive` 轮询。
    expect(() => signalProcessTree(999_999_999)).not.toThrow();
  });

  it("对 undefined / 非正数 pid 不做事，返回 false", () => {
    // 这三种不是「发出去了」，是根本没有可操作的 pid——返回值在这里是真的。
    expect(signalProcessTree(undefined)).toBe(false);
    expect(signalProcessTree(0)).toBe(false);
    expect(signalProcessTree(-1)).toBe(false);
  });

  it("isProcessAlive 对不存在的 pid 返回 false，对当前进程返回 true", () => {
    expect(isProcessAlive(999_999_999)).toBe(false);
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(undefined)).toBe(false);
  });
});
