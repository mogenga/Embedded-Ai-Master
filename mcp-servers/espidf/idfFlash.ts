import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { IdfTools } from "./idfEnv.js";

/**
 * esptool 封装（烧录 / 整片擦除 / 芯片探测）。
 *
 * esptool v5.3.1 实测：命令用连字符风格（`write-flash`/`erase-flash`/
 * `flash-id`），`--help` 即文档。venv 里那份与 IDF 版本配套，优先用。
 *
 * 烧录参数从 `build/flasher_args.json` 读——IDF 构建时自己写的镜像偏移表
 * （bootloader/partition-table/app 各自的 0x0/0x8000/0x20000），我们照单
 * 拼 `write-flash` 命令，不自己算偏移。
 *
 * esptool 与 openocd/gdbserver 互斥（同一个串口/JTAG）：flash/erase 前要先
 * 关调试会话，与 keil/cubeide 的 forDownload 语义一致。
 */

export interface EsptoolResult {
  ok: boolean;
  command: string;
  exitCode: number | null;
  log: string;
}

function run(file: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024, env }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, out: `${stdout ?? ""}${stderr ?? ""}` });
    });
  });
}

export async function esptool(tools: IdfTools, args: string[], timeoutMs = 120_000): Promise<EsptoolResult> {
  const { code, out } = await run(tools.esptool, args, {}, timeoutMs);
  return { ok: code === 0, command: `esptool ${args.join(" ")}`, exitCode: code, log: out };
}

/** 探测芯片（不改芯片状态；串口占用时会报 port busy——这也是"有板子"的证据）。 */
export async function chipProbe(tools: IdfTools, port: string): Promise<EsptoolResult> {
  return esptool(tools, ["--port", port, "chip-id"], 30_000);
}

/** 整片擦除。声明由 declarations.ts 的 chip_erase 提供。 */
export async function eraseFlash(tools: IdfTools, port: string): Promise<EsptoolResult> {
  return esptool(tools, ["--port", port, "erase-flash"], 5 * 60_000);
}

export interface FlasherArgs {
  flashFiles: Array<{ offset: string; file: string }>;
  flashSettings: string[];
}

/**
 * 读 flasher_args.json，拼出烧录参数。
 *
 * 结构（实测）：
 *   { "flash_files": { "0x0": "bootloader/bootloader.bin", ... },
 *     "flash_settings": { "flash_mode": "dio", ... },
 *     "write_flash_args": [ "--flash-mode", "dio", ... ] }
 */
export function readFlasherArgs(projectDir: string): FlasherArgs | null {
  const file = join(projectDir, "build", "flasher_args.json");
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as {
      flash_files?: Record<string, string>;
      write_flash_args?: string[];
    };
    if (!parsed.flash_files) return null;
    const flashFiles = Object.entries(parsed.flash_files).map(([offset, file]) => ({ offset, file }));
    return { flashFiles, flashSettings: parsed.write_flash_args ?? [] };
  } catch {
    return null;
  }
}

/**
 * 烧录整个镜像组（构建产物全量）。
 *
 * 用 esptool 直接烧而不是代理 `idf.py flash`：直接烧能拿到稳定的退出码与
 * 摘要，且不需要在 flasher_args 之外再拼一遍 idf.py 的环境。
 */
export async function flashProject(
  tools: IdfTools,
  projectDir: string,
  options: { port: string; baud?: number; verify?: boolean },
): Promise<EsptoolResult> {
  const flasher = readFlasherArgs(projectDir);
  if (!flasher) {
    return { ok: false, command: "", exitCode: null, log: `no build/flasher_args.json in ${projectDir} — build the project first (idf.py build)` };
  }
  const args: string[] = ["--port", options.port];
  if (options.baud) args.push("--baud", String(options.baud));
  args.push("write-flash", ...flasher.flashSettings);
  for (const entry of flasher.flashFiles) {
    const file = join(projectDir, "build", entry.file);
    if (!existsSync(file)) {
      return { ok: false, command: "", exitCode: null, log: `flasher_args lists ${entry.file} but it does not exist under build/` };
    }
    args.push(entry.offset, file);
  }
  if (options.verify !== false) args.push("--verify");
  return esptool(tools, args, 5 * 60_000);
}
