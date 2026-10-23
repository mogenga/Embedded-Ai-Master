import { spawn, type ChildProcess } from "node:child_process";
import net from "node:net";
import { GdbMi } from "../cubeide/gdbMi.js";
import { readProjectDescription } from "./idfBuild.js";
import type { IdfTools } from "./idfEnv.js";

/**
 * ESP32 调试会话：openocd-esp32 (gdbserver :3333) + esp-gdb (MI over stdio)。
 *
 * board 配置不猜：IDF 构建时把它写进 build/project_description.json 的
 * `debug_arguments_openocd`（实测 esp32s3 工程是 `-f board/esp32s3-builtin.cfg`，
 * 即芯片内置 USB-JTAG）。openocd 的 -s 指向其 scripts 目录，board 名就能相对
 * 解析。工程没构建过就没有这个字段——诚实报「先 build」。
 *
 * 单会话模型，与 cubeide 的 gdbSession 语义一致：open 保持，close 释放。
 */

export const ESP_OPENOCD_DEFAULT_PORT = 3333;

let activeGdb: { gdb: GdbMi; openocd: ChildProcess | null } | null = null;

export function activeEspSession(): { gdb: GdbMi; openocd: ChildProcess | null; port: number } | null {
  return activeGdb ? { ...activeGdb, port: ESP_OPENOCD_DEFAULT_PORT } : null;
}

function probePort(port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
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

export interface EspOpenOptions {
  tools: IdfTools;
  /** 工程目录；board cfg 与 app ELF 都从 build/project_description.json 读。 */
  projectDir: string;
  /** 显式 board cfg（如 board/esp32c3.cfg）；缺省用 project_description 的。 */
  boardCfg?: string;
  /** 复用已在跑的 openocd（外部调试器还开着时）。 */
  reuseOpenOcd?: boolean;
}

export interface EspOpenResult {
  ok: boolean;
  reason?: string;
  log: string[];
}

export async function openEspSession(options: EspOpenOptions): Promise<EspOpenResult> {
  const { tools } = options;
  const log: string[] = [];
  if (activeGdb) {
    return { ok: false, reason: "an ESP debug session is already open; close it first", log };
  }
  const desc = readProjectDescription(options.projectDir);
  if (!desc?.openocdArgs && !options.boardCfg) {
    return {
      ok: false,
      reason: `no build/project_description.json with debug_arguments_openocd in ${options.projectDir} — build the project first (idf.py build), or pass boardCfg explicitly`,
      log,
    };
  }
  if (!tools.openocd || !tools.gdb) {
    return { ok: false, reason: "openocd-esp32 or xtensa-esp-elf-gdb not found under IDF_TOOLS_PATH/tools — the IDF install looks incomplete", log };
  }
  let openocd: ChildProcess | null = null;
  try {
    const inUse = await probePort(ESP_OPENOCD_DEFAULT_PORT, 500);
    if (!inUse) {
      const cfg = options.boardCfg ?? desc!.openocdArgs!;
      // cfg 形如 "-f board/esp32s3-builtin.cfg"（可多段）；照单传给 openocd。
      const cfgArgs = cfg.split(/\s+/).filter(Boolean);
      openocd = spawn(tools.openocd, ["-s", tools.openocdScripts, ...cfgArgs], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const chunks: string[] = [];
      openocd.stderr?.setEncoding("utf8");
      openocd.stderr?.on("data", (chunk: string) => chunks.push(chunk));
      openocd.once("exit", () => {
        if (activeGdb?.openocd === openocd) activeGdb = null;
      });
      // 等 3333 端口可连（openocd 起完 gdbserver 才听）。
      const deadline = Date.now() + 15_000;
      let ready = false;
      while (Date.now() < deadline) {
        if (await probePort(ESP_OPENOCD_DEFAULT_PORT, 500)) { ready = true; break; }
        if (openocd.exitCode !== null) break;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (!ready) {
        const tail = chunks.join("").split(/\r?\n/).filter(Boolean).slice(-6).join(" | ");
        try { openocd.kill(); } catch { /* gone */ }
        return { ok: false, reason: `openocd did not open port ${ESP_OPENOCD_DEFAULT_PORT}${tail ? `; last lines: ${tail}` : ""}`, log };
      }
      log.push(`openocd: ${cfgArgs.join(" ")}`);
    } else {
      log.push(`reusing openocd already on :${ESP_OPENOCD_DEFAULT_PORT}`);
    }
    const gdb = new GdbMi({ gdbPath: tools.gdb });
    await gdb.command("-gdb-set pagination off");
    await gdb.command("-gdb-set confirm off");
    if (desc?.appElf) {
      const elf = `${options.projectDir.replace(/\\/g, "/")}/build/${desc.appElf}`;
      await gdb.command(`-file-exec-and-symbols "${elf}"`);
      log.push(`symbols: ${elf}`);
    }
    await gdb.command(`-target-select remote 127.0.0.1:${ESP_OPENOCD_DEFAULT_PORT}`, 20_000);
    log.push("attached to openocd");
    activeGdb = { gdb, openocd };
    return { ok: true, log };
  } catch (error) {
    if (openocd) try { openocd.kill(); } catch { /* gone */ }
    return { ok: false, reason: error instanceof Error ? error.message : String(error), log };
  }
}

export async function closeEspSession(): Promise<{ closed: boolean; reason?: string }> {
  if (!activeGdb) return { closed: false, reason: "no ESP debug session is open" };
  try {
    activeGdb.gdb.kill();
    if (activeGdb.openocd) try { activeGdb.openocd.kill(); } catch { /* gone */ }
    activeGdb = null;
    return { closed: true };
  } catch (error) {
    return { closed: false, reason: error instanceof Error ? error.message : String(error) };
  }
}
