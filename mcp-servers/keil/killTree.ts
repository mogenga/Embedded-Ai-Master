import { spawnSync } from "node:child_process";

/**
 * Best-effort kill of a pid and its descendants.
 *
 * 摘自 Prometheus/src/winsandbox.ts 的同名函数（逐行复制）。A 侧完整的
 * Job Object 沙箱不随迁移 —— B 的权限模型不同，MCP 进程隔离已提供崩溃边界。
 * Windows 上 UV4.exe 会派生调试器子进程，只杀父进程会留下孤儿。
 */
export function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") {
    try {
      spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { windowsHide: true, timeout: 10_000 });
    } catch {
      /* the process may already be gone */
    }
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}