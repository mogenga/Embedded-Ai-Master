import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { McpServerConfig } from "../src/mcp/config.js";
import { McpManager } from "../src/mcp/manager.js";

/**
 * BACKLOG 6.1 的关闭时延优化（2026-11-07）。
 *
 * `terminateAndWait` 在 Windows 上原本只靠 `taskkill /T /F`，而它从 spawn 到
 * 父进程真的消失要 **890–1160 ms**（本机实测 3 轮 1029/1146/1160；对不存在的
 * pid 也要 1.2–1.3 s——是进程启动 + 杀软扫描，不是遍历）。同一次测量里
 * `process.kill(pid, "SIGKILL")` 只要 **0–3 ms**。
 *
 * 修法是两条并列发出：taskkill 先起（`/T` 靠活着的父进程枚举子进程，顺序不能
 * 反），再立刻 `process.kill` 收掉父进程本身。轮询等的是「父进程死了没有」，
 * 于是从等满 1 s 变成毫秒级返回；树仍由 taskkill 在自己时间里收完。
 *
 * **这条测试与 `mcp-manager.test.ts` 里那条超时重连用例的分工**：那条注入
 * `terminateTimeoutMs: 10_000`，所以优化前后都绿——它测的是「最终能重连」，
 * 不是「多快能确认」。这里直接测后者。
 */
const tempDirs: string[] = [];
const managers: McpManager[] = [];

function tempRoot(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mcp-terminate-speed-"));
  tempDirs.push(dir);
  return dir;
}

function config(name: string, overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    name,
    command: process.execPath,
    args: [path.join(import.meta.dirname, "fixtures", "mcp-echo-server.mjs")],
    cwd: process.cwd(),
    ...overrides,
  };
}

afterEach(async () => {
  for (const manager of managers.splice(0)) {
    await manager.close().catch(() => undefined);
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("终止一个 server 的时延（BACKLOG 6.1）", () => {
  it("确认父进程死亡的时间远小于 taskkill 的启动成本", async () => {
    // 终止预算给 10 s：这里要证明的是「不需要用满它」，而不是「预算够不够」。
    // 若只靠 taskkill，本机实测要 1 s 上下；加了直接 SIGKILL 之后是毫秒级。
    // 500 ms 是个宽松的分界：它远低于 taskkill 的 1 s，又留足了 CI 抖动的余量。
    const root = tempRoot();
    const manager = new McpManager(
      [config("echo", { timeoutMs: 100, env: { PID_LOG: path.join(root, "pid.log") } })],
      { terminateTimeoutMs: 10_000 },
    );
    managers.push(manager);
    await manager.connectAll();

    const started = Date.now();
    // 一次超时调用触发 `beginDispose`，它会等 `terminateAndWait`。
    await manager.call("echo", "slow", { ms: 5_000, tag: "slow" }, undefined);
    const elapsed = Date.now() - started;

    // 超时本身的等待（100 ms）也在这段里，但那是 `timeoutMs` 决定的常量，
    // 与本次优化无关；扣掉它之后剩下的就是「确认进程死掉」的成本。
    const confirmCost = elapsed - 100;
    expect(confirmCost).toBeLessThan(500);
  }, 30_000);

  it("旧进程确实消失了，不是只把等待跳过去", async () => {
    // 上一条测速度，这条测「快不等于没做事」：父进程必须真的不在了。
    // 两条一起才排得掉「提前返回但进程还活着」这种「快而错」的实现。
    const root = tempRoot();
    const pidLog = path.join(root, "pid.log");
    const manager = new McpManager(
      [config("echo", { timeoutMs: 100, env: { PID_LOG: pidLog } })],
      { terminateTimeoutMs: 10_000 },
    );
    managers.push(manager);
    await manager.connectAll();
    const pid = Number(readFileSync(pidLog, "utf8").trim().split("\n")[0]);

    await manager.call("echo", "slow", { ms: 5_000, tag: "slow" }, undefined);
    // 给 taskkill 一点时间做它自己的确认；进程应当已经不在。
    await new Promise((resolve) => setTimeout(resolve, 200));

    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    expect(alive).toBe(false);
  }, 30_000);
});
