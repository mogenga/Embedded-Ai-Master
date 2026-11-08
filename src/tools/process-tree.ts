import { spawn } from "node:child_process";

/**
 * 终止一棵进程树，**不阻塞事件循环**（D-229）。
 *
 * ## 为什么不是 `spawnSync("taskkill", …)`
 *
 * 实测（2026-11-08，本机 Windows，10 次）：`taskkill /T /F` 对**一个不存在的
 * pid** 也要 953–1218 ms。那不是遍历成本，是进程启动 + 杀软扫描的成本——所以
 * 无论目标是什么，同步等它回来就是固定 1 s 的事件循环停摆。
 *
 * 一次 `killAllBackgroundJobs()` 对每个残留作业连做两次（温和 + 强制），而它挂在
 * 每个用例的 `afterEach` 上。同步实现的后果不只是慢：阻塞期间 25 ms 的轮询
 * `waitForExit` 一次都跑不到，它的 10 s 预算在阻塞里花光，出来就报
 * `process N still running`。并行全量下 `background-terminal` / `shell` 的
 * 「偶发红」就是这条机制，不是机器慢。
 *
 * ## 为什么不能只对直接子进程 `process.kill`
 *
 * `shell: true` 时直接子进程是 `cmd.exe`，真正跑的是**孙进程**。实测只杀
 * `cmd.exe`（`detached` 与非 `detached` 都是），500 ms 后孙子仍然存活、且不会
 * 自己退出。所以 `/T` 的树遍历不能省。
 *
 * ## 因此这里做的是什么
 *
 * 起一个**异步** `taskkill /T /F` 并 `unref`，不等它退出；调用方立刻拿回
 * 「信号已发出」。进程真正消失由调用方自己的 `exit` 事件或轮询确认。
 *
 * 与 `McpManager.reapProcessTree`（批次 6，`5d42e38`）同一姿态：那里证明过
 * 「等 taskkill 起身」会让关闭从 26 s 涨到 49 s。
 *
 * @returns `true` = 回收器已发出；`false` = 没有可回收的 pid，或回收器起不来。
 *   **`false` 不代表进程还在**，也不代表它一定在——它只说明这一发没打出去。
 */
export function signalProcessTree(pid: number | undefined): boolean {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return false;

  if (process.platform !== "win32") {
    // POSIX：先试进程组（仓库里 `shell` / `background` 的 spawn 在非 Windows
    // 上都带 `detached: true`，所以它自己是组长）。失败再单杀 pid。
    try {
      process.kill(-pid, "SIGKILL");
      return true;
    } catch {
      try {
        process.kill(pid, "SIGKILL");
        return true;
      } catch {
        return false;
      }
    }
  }

  try {
    const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    // 回收器起不来（ENOENT 等）时不要留一个未处理的 `error` 事件把宿主带走。
    killer.on("error", () => undefined);
    // 不阻止宿主退出：宿主退出时它会被 Job Object 一起带走。
    killer.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * pid 现在是否还存在。
 *
 * `process.kill(pid, 0)` 不发送信号，只做存在性检查；Windows 上它对已终止但
 * 尚未被回收的进程也可能返回成功，所以它回答的是「还在不在进程表里」，不是
 * 「还能不能被操作」。用于轮询「有没有消失」时这个语义是对的。
 */
export function isProcessAlive(pid: number | undefined): boolean {
  if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
