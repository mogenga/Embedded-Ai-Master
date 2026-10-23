import { execFile } from "node:child_process";
import { toolEnv } from "../keil/toolEnv.js";
import type { CubeIdeTools } from "./cubeideInstall.js";

/**
 * STM32_Programmer_CLI 封装（烧录 / 整片擦除 / 目标探测）。
 *
 * 用的是 IDE 内置那份 CLI（cubeprogrammer externaltools 插件），不是独立
 * 安装的 CubeProgrammer —— 装了 CubeIDE 它就必然在（用户决策，见
 * cubeide-porting-spec.md）。这也顺带补上了 keil 后端的整片擦除缺口
 * （D-201）：`-e all` 在这里是可用的。
 *
 * 探针独占性：CLI 与 gdbserver 不能同时占用 ST-Link。烧录/擦除前调用方
 * 要先关调试会话（同 keil flash 的 forDownload 语义）。
 */

export interface ProgrammerResult {
  ok: boolean;
  command: string;
  exitCode: number | null;
  log: string;
}

function run(file: string, args: string[], timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024, env: toolEnv() },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, out: `${stdout ?? ""}${stderr ?? ""}` });
      },
    );
  });
}

export async function programmerCli(
  tools: CubeIdeTools,
  args: string[],
  timeoutMs = 120_000,
): Promise<ProgrammerResult> {
  const { code, out } = await run(tools.programmerCli, args, timeoutMs);
  return { ok: code === 0, command: `${tools.programmerCli} ${args.join(" ")}`, exitCode: code, log: out };
}

/** 探测目标：`-l`（list）只列接口，不碰芯片。 */
export async function probeTarget(tools: CubeIdeTools): Promise<ProgrammerResult> {
  return programmerCli(tools, ["-l"], 30_000);
}

/**
 * 整片擦除。这是 keil 后端（UVSOCK PRJ_FLASH_ERASE 无响应，D-201）做不到、
 * 这里做得到的动作。声明由 declarations.ts 的 chip_erase 提供。
 */
export async function chipErase(tools: CubeIdeTools): Promise<ProgrammerResult> {
  const connect = await programmerCli(tools, ["-c", "SWD"], 30_000);
  if (!connect.ok) return connect;
  return programmerCli(tools, ["-c", "SWD", "-e", "all"], 5 * 60_000);
}

/**
 * 烧写镜像并回读校验。`address` 缺省由 CLI 按镜像格式自选（hex 带地址，
 * bin 默认 0x08000000）。
 */
export async function flashImage(
  tools: CubeIdeTools,
  image: string,
  options: { address?: number; verify?: boolean } = {},
): Promise<ProgrammerResult> {
  const args = ["-c", "SWD"];
  if (options.address !== undefined) args.push(...["-w", image, `0x${options.address.toString(16)}`]);
  else args.push(...["-w", image]);
  if (options.verify !== false) args.push("-v");
  return programmerCli(tools, args, 5 * 60_000);
}

/** 从 `-l` 输出里摘探针/芯片线索，供 identify 与错误信息使用。 */
export function summarizeProbeList(log: string): { stlink: boolean; jlink: boolean; lines: string[] } {
  const lines = log.split(/\r?\n/).filter(Boolean);
  return {
    stlink: /ST-?Link/i.test(log) && !/No ST-?Link detected/i.test(log),
    jlink: /J-?Link/i.test(log) && !/No J-?Link/i.test(log),
    lines: lines.filter((line) => /interface|detected|serial|SN|Board/i.test(line)).slice(0, 12),
  };
}
