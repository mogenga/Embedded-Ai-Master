import os from "node:os";
import path from "node:path";

/**
 * 测试运行器的环境标记。出现任一即视为「在测试进程里」。
 *
 * `VITEST` 由 vitest 注入；`NODE_ENV=test` 覆盖其他以 Node 约定标记测试的运行器。
 */
function testRunner(env: NodeJS.ProcessEnv): string | undefined {
  const vitest = env.VITEST?.trim();
  if (vitest !== undefined && vitest !== "") return `VITEST=${vitest}`;
  if (env.NODE_ENV === "test") return "NODE_ENV=test";
  return undefined;
}

/**
 * 解析 `$HARNESS_HOME`：显式配置优先，否则用用户目录下的 `.harness`。
 *
 * **测试环境例外（D-170）**：在测试进程里，没有显式 `HARNESS_HOME` 时直接抛错，
 * 而不是返回用户的真实配置目录。理由是该失败模式不可逆——测试 fixture 会静默写进
 * 用户真实配置（`~/.harness/mcp.json`、`run.json` 曾因此被污染），事后只能靠文件内容
 * 反推来源。把「忘了隔离」变成硬失败，比让它写穿更诚实（R3）。
 *
 * 非测试环境行为不变。
 */
export function resolveHarnessHome(env: NodeJS.ProcessEnv = process.env): string {
  const configuredHome = env.HARNESS_HOME?.trim();
  if (configuredHome) return configuredHome;

  const runner = testRunner(env);
  if (runner !== undefined) {
    throw new Error(
      `resolveHarnessHome() 拒绝在测试环境返回默认 home：检测到 ${runner}，但没有设置 HARNESS_HOME。`
      + "测试必须显式传 harnessHome（或把 HARNESS_HOME 指向临时目录），"
      + "否则配置与会话会写进用户的真实配置目录（D-170）。",
    );
  }

  return path.join(os.homedir(), ".harness");
}
