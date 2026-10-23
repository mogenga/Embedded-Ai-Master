import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import type { CubeIdeTools } from "./cubeideInstall.js";

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

/** 复用已在跑的 gdbserver（不归属本进程时也能连，只是不负责关它）。 */
export async function reuseOrStartGdbServer(options: StartGdbServerOptions): Promise<GdbServerHandle> {
  const port = options.port ?? STLINK_GDBSERVER_DEFAULT_PORT;
  if (active?.port === port) return active;
  if (await probePort("127.0.0.1", port, 500)) {
    return { port, process: null as unknown as ChildProcess, log: [] };
  }
  return startStlinkGdbServer(options);
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
