import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import net from "node:net";
import { createRequire } from "node:module";
import type { CubeIdeTools } from "./cubeideInstall.js";

const require_ = createRequire(import.meta.url);

/**
 * gdbserver 启动与探针独占。
 *
 * ST-LINK_gdbserver 参数实测自其 --help 与 IDE 自带 config.txt 示例：
 *   -p <port>        GDB 端口（默认 61234）
 *   -cp <dir>        CubeProgrammer bin（必需——Flash 算法与目标数据库在那边）
 *   -g               不在启动时 halt 目标（open 会话更可预测，保持 halt 默认）
 *   -l <level>       日志级别
 *
 * 探针独占：一个 ST-Link 只能被一个 gdbserver 占用。本服务同时最多起一个
 * gdbserver；烧录（STM32_Programmer_CLI）前必须先关调试会话，与 keil 的
 * flash 语义一致。
 */

export const STLINK_GDBSERVER_DEFAULT_PORT = 61234;

export interface GdbServerHandle {
  port: number;
  process: ChildProcess;
  log: string[];
}

let active: GdbServerHandle | null = null;

export function activeGdbServer(): GdbServerHandle | null {
  return active;
}

/** 端口上有东西可连（等待 gdbserver 就绪）。 */
function probePort(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function waitForPort(port: number, deadline: number): Promise<boolean> {
  for (;;) {
    if (Date.now() > deadline) return false;
    if (await probePort("127.0.0.1", port, 500)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

export interface StartGdbServerOptions {
  tools: CubeIdeTools;
  port?: number;
  /** ST-Link 序列号（多探针机器用）。 */
  serial?: string;
  timeoutMs?: number;
  /** ST gdbserver 起不来时的 OpenOCD 回退（S7 固件克隆必需，见上）。 */
  openocdFallback?: {
    openocd: string;
    scripts: string;
    target: string;
  };
  /** pyOCD gdbserver（S7 克隆上唯一稳定的 server，优先于 ST gdbserver）。 */
  pyocdFallback?: PyOcdFallbackOptions;
}

export async function startStlinkGdbServer(options: StartGdbServerOptions): Promise<GdbServerHandle> {
  if (active) return active;
  const port = options.port ?? STLINK_GDBSERVER_DEFAULT_PORT;
  const args = ["-p", String(port), "-cp", options.tools.cubeprogrammerBin];
  if (options.serial) args.push(...["-i", options.serial]);
  const child = spawn(options.tools.stlinkGdbServer, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const handle: GdbServerHandle = { port, process: child, log: [] };
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => handle.log.push(chunk));
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => handle.log.push(chunk));
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  const ready = await waitForPort(port, deadline);
  if (!ready) {
    const tail = handle.log.join("").split(/\r?\n/).filter(Boolean).slice(-8).join(" | ");
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    // ST-Link 固件带 "S7" 后缀（如 V2J48S7）时，gdbserver 会被 ST 的固件限制
    // 挡住（"No device found on target"），而 STM32_Programmer_CLI 与 OpenOCD
    // 都能正常连接——S7 检测克隆只拒绝自家的 gdbserver（ST 社区多个同款案例）。
    // 回退 OpenOCD（espidf 后端那份带全部脚本），失败才真正报错。
    if (options.openocdFallback) {
      try {
        const fallback = await startOpenOcdServer({
          openocd: options.openocdFallback.openocd,
          scripts: options.openocdFallback.scripts,
          target: options.openocdFallback.target,
          port,
        });
        return fallback;
      } catch (fallbackError) {
        throw new Error(
          `ST-LINK_gdbserver did not open port ${port} in time${tail ? `; its last lines: ${tail}` : "; no output"}. ` +
            `OpenOCD fallback also failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
        );
      }
    }
    throw new Error(
      `ST-LINK_gdbserver did not open port ${port} in time${tail ? `; its last lines: ${tail}` : "; no output"}`,
    );
  }
  active = handle;
  child.once("exit", () => {
    if (active === handle) active = null;
  });
  return handle;
}

export interface OpenOcdFallbackOptions {
  openocd: string;
  scripts: string;
  /** target cfg 名（如 stm32f4x.cfg）；由调用方从芯片族给。 */
  target: string;
}

export interface StartOpenOcdOptions extends OpenOcdFallbackOptions {
  port?: number;
  timeoutMs?: number;
}

/** OpenOCD 起 gdbserver（绕开 ST gdbserver 的 S7 固件限制，实测可用）。 */
export async function startOpenOcdServer(options: StartOpenOcdOptions): Promise<GdbServerHandle> {
  if (active) return active;
  const port = options.port ?? STLINK_GDBSERVER_DEFAULT_PORT;
  const args = [
    "-s", options.scripts,
    "-f", "interface/stlink.cfg",
    "-f", `target/${options.target}.cfg`,
    "-c", `gdb_port ${port}`,
  ];
  const child = spawn(options.openocd, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const handle: GdbServerHandle = { port, process: child, log: [] };
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => handle.log.push(chunk));
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => handle.log.push(chunk));
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  const ready = await waitForPort(port, deadline);
  if (!ready) {
    const tail = handle.log.join("").split(/\r?\n/).filter(Boolean).slice(-6).join(" | ");
    try { child.kill(); } catch { /* gone */ }
    throw new Error(`openocd did not open port ${port} in time${tail ? `; last lines: ${tail}` : ""}`);
  }
  active = handle;
  child.once("exit", () => {
    if (active === handle) active = null;
  });
  return handle;
}

/** 复用已在跑的 gdbserver（不归属本进程时也能连，只是不负责关它）。 */
export async function reuseOrStartGdbServer(options: StartGdbServerOptions): Promise<GdbServerHandle> {
  const port = options.port ?? STLINK_GDBSERVER_DEFAULT_PORT;
  if (active?.port === port) return active;
  if (await probePort("127.0.0.1", port, 500)) {
    return { port, process: null as unknown as ChildProcess, log: [] };
  }
  // server 优先级（真机实测定）：
  // 1. **pyOCD**：自带 ST-Link 驱动、无 ST 的 S7 克隆检查；S7 克隆上唯一
  //    稳定的 gdbserver（裸 RSP 实测读内存/断点全通）。
  // 2. ST gdbserver：官方探针用。S7 克隆会报 "No device found"。
  // 3. OpenOCD 回退：这颗克隆上 disconnect 会把目标 SWD 拉死（实测反复），
  //    只在 pyOCD 也没有时兜底。
  if (options.pyocdFallback) {
    try {
      return await startPyOcdGdbServer({ pyocd: options.pyocdFallback.pyocd, target: options.pyocdFallback.target, port });
    } catch {
      /* fall through to ST server */
    }
  }
  return startStlinkGdbServer(options);
}

export interface PyOcdFallbackOptions {
  /** pyOCD 可执行文件路径。 */
  pyocd: string;
  /** target 名（cortex_m 通用型即可全功能调试）。 */
  target: string;
}

export interface StartPyOcdOptions extends PyOcdFallbackOptions {  port?: number;
  timeoutMs?: number;
}

let pyocdPath: string | null = null;

/** 找 pyOCD：PATH 里 pyocd.exe（`where pyocd`）。每进程缓存一次。 */
export function findPyOcd(): string | null {
  if (pyocdPath !== null) return pyocdPath;
  try {
    const found = require_("node:child_process").execFileSync("where", ["pyocd"], { encoding: "utf8", timeout: 5000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    pyocdPath = found.split(/\r?\n/).filter(Boolean)[0] ?? null;
  } catch {
    pyocdPath = null;
  }
  return pyocdPath;
}

export async function startPyOcdGdbServer(options: StartPyOcdOptions): Promise<GdbServerHandle> {
  if (active) return active;
  const port = options.port ?? 3333;
  const args = ["gdbserver", "--target", options.target, "--persist", "--port", String(port)];
  const child = spawn(options.pyocd, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const handle: GdbServerHandle = { port, process: child, log: [] };
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => handle.log.push(chunk));
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => handle.log.push(chunk));
  const deadline = Date.now() + (options.timeoutMs ?? 20_000);
  const ready = await waitForPort(port, deadline);
  if (!ready) {
    const tail = handle.log.join("").split(/\r?\n/).filter(Boolean).slice(-6).join(" | ");
    try { child.kill(); } catch { /* gone */ }
    throw new Error(`pyocd gdbserver did not open port ${port}${tail ? `; last lines: ${tail}` : ""}`);
  }
  active = handle;
  child.once("exit", () => {
    if (active === handle) active = null;
  });
  return handle;
}

export function stopGdbServer(): boolean {
  const handle = active;
  if (!handle?.process) return false;
  try {
    handle.process.kill();
  } catch {
    /* already gone */
  }
  active = null;
  return true;
}

/**
 * OpenOCD 的优雅关闭：tcl 端口（gdb_port+6666-3333 的默认布局里是 6666）
 * 发 shutdown，让它走正常 detach 序列把 SWD 释放干净。gdb_port 非默认时
 * tcl 端口仍按 6666 起（openocd 默认），除非显式改过。
 */
export async function shutdownOpenOcdGracefully(tclPort = 6666, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: tclPort });
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      socket.write("shutdown\r\n");
      setTimeout(() => finish(true), 300);
    });
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}
