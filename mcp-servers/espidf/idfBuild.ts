import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { idfEnv, type IdfTools } from "./idfEnv.js";

/**
 * `idf.py` 构建封装。
 *
 * 工程判据：CMakeLists.txt 里 include `$ENV{IDF_PATH}/tools/cmake/project.cmake`
 * （IDF 工程的签名行）。构建在工程目录跑 `idf.py build`；目标芯片与工具链由
 * sdkconfig 决定，我们不猜。
 *
 * 增量构建交给 IDF 自己的 CMake 缓存：已构建的工程第二次 build 很快。
 */

/** CMakeLists 的签名行；embed_project 的路由判据用同一个函数。 */
export function isIdfProject(projectDir: string): boolean {
  try {
    const text = readFileSync(join(projectDir, "CMakeLists.txt"), "utf8");
    return /tools\/cmake\/project\.cmake/.test(text);
  } catch {
    return false;
  }
}

export interface IdfBuildResult {
  ok: boolean;
  command: string;
  exitCode: number | null;
  log: string;
  durationMs: number;
  errors?: string[];
}

function run(file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024, env }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, out: `${stdout ?? ""}${stderr ?? ""}` });
    });
  });
}

export async function idfBuild(tools: IdfTools, projectDir: string, options: { target?: string; timeoutMs?: number } = {}): Promise<IdfBuildResult> {
  const started = Date.now();
  const args = options.target ? ["-B", "build", `-DIDF_TARGET=${options.target}`, "build"] : ["build"];
  const { code, out } = await run(
    tools.venvPython,
    [join(tools.idfPath, "tools", "idf.py"), ...args],
    projectDir,
    idfEnv(tools),
    options.timeoutMs ?? 15 * 60_000,
  );
  const lines = out.split(/\r?\n/).filter(Boolean);
  const errorLines = lines.filter((line) => /error|FAILED:|fatal error/i.test(line));
  return {
    ok: code === 0,
    command: `idf.py ${args.join(" ")}`,
    exitCode: code,
    log: out,
    durationMs: Date.now() - started,
    ...(code !== 0 && errorLines.length > 0 ? { errors: errorLines.slice(-20) } : {}),
  };
}

export async function idfClean(tools: IdfTools, projectDir: string): Promise<IdfBuildResult> {
  const started = Date.now();
  const { code, out } = await run(
    tools.venvPython,
    [join(tools.idfPath, "tools", "idf.py"), "fullclean"],
    projectDir,
    idfEnv(tools),
    60_000,
  );
  return { ok: code === 0, command: "idf.py fullclean", exitCode: code, log: out, durationMs: Date.now() - started };
}

/** app ELF 的位置（project_description.json 的 app_elf 相对 build）。 */
export function appElf(projectDir: string): string | null {
  const desc = join(projectDir, "build", "project_description.json");
  try {
    const parsed = JSON.parse(readFileSync(desc, "utf8")) as { app_elf?: string };
    const elf = parsed.app_elf ? join(projectDir, "build", parsed.app_elf) : null;
    return elf && existsSync(elf) ? elf : null;
  } catch {
    return null;
  }
}

/**
 * 调试参数的现成来源：project_description.json。
 * - `debug_arguments_openocd`：openocd 的 -f 参数（如 board/esp32s3-builtin.cfg）
 * - `target`：芯片名
 * IDF 自己写它，我们读它——不猜芯片、不猜配置文件。
 */
export function readProjectDescription(projectDir: string): { target?: string; openocdArgs?: string; appElf?: string } | null {
  const desc = join(projectDir, "build", "project_description.json");
  try {
    const parsed = JSON.parse(readFileSync(desc, "utf8")) as {
      target?: string;
      debug_arguments_openocd?: string;
      app_elf?: string;
    };
    return {
      ...(parsed.target ? { target: parsed.target } : {}),
      ...(parsed.debug_arguments_openocd ? { openocdArgs: parsed.debug_arguments_openocd } : {}),
      ...(parsed.app_elf ? { appElf: parsed.app_elf } : {}),
    };
  } catch {
    return null;
  }
}
