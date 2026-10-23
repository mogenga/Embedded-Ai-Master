import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * STM32CubeMX 无头工程生成（UM1718 §3.3.2 的 -q 脚本模式）。
 *
 * 实测（本机 CubeMX 6.18.1，G:\software\cubemx）：
 *   ./jre/bin/java -jar STM32CubeMX.exe -q <script> 成功跑完
 *   （直接 STM32CubeMX.exe -q 也可以，但 java 直调输出更干净、退出码可靠）
 * 脚本命令（Table 1 实测有效的子集）：
 *   load <MCU>            如 STM32F429IGTx（注意 x 小写尾缀）
 *   project name <name>
 *   project toolchain STM32CubeIDE
 *   project path <dir>
 *   project generate
 *   exit
 *
 * 发现：CUBEMX_HOME 环境变量 → G:\software\cubemx 等常见位 → 注册表略过
 * （安装器写的是 NSIS 卸载项，不可靠）。判定标准：目录里有 STM32CubeMX.exe
 * 和 db\mcu。
 */

export interface CubeMxTools {
  root: string;
  /** java -jar 入口（输出干净、退出码可靠，实测优于直接跑 exe）。 */
  java: string;
  exe: string;
}

export function findCubeMx(): CubeMxTools | null {
  const candidates: string[] = [];
  const env = process.env.CUBEMX_HOME;
  if (env) candidates.push(env);
  if (process.platform === "win32") {
    for (const base of ["G:\\software\\cubemx", "C:\\Program Files\\STMicroelectronics\\STM32CubeMX", "C:\\Program Files (x86)\\STMicroelectronics\\STM32CubeMX"]) {
      candidates.push(base);
    }
  }
  for (const root of candidates) {
    const exe = join(root, "STM32CubeMX.exe");
    if (existsSync(exe) && existsSync(join(root, "db", "mcu"))) {
      const java = join(root, "jre", "bin", "java.exe");
      return { root, java: existsSync(java) ? java : "", exe };
    }
  }
  return null;
}

export interface MxGenerateOptions {
  /** MCU 全名，CubeMX 数据库里的 Part number，如 STM32F429IGTx。 */
  mcu: string;
  /** 工程名（也是生成目录下的主 .ioc 名）。 */
  name: string;
  /** 生成目录（工程根）。 */
  path: string;
  /** 工具链；默认 STM32CubeIDE。 */
  toolchain?: "STM32CubeIDE" | "MDK-ARM" | "EWARM" | "Makefile" | "CMake";
  /** 附加脚本行（peripheral 配置等，按 UM1718 Table 1 语法，逐行）。 */
  extraScriptLines?: string[];
  timeoutMs?: number;
}

export interface MxGenerateResult {
  ok: boolean;
  /** 生成的 .ioc 路径。 */
  iocPath: string;
  /** CubeIDE 工程所在子目录（.project/.cproject 在 <root>/<toolchain目录>）。 */
  projectDir: string;
  log: string;
  durationMs: number;
  reason?: string;
}

function run(file: string, args: string[], timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ code, out: `${stdout ?? ""}${stderr ?? ""}` });
    });
  });
}

/** 生成完成后 CubeIDE 工具链文件所在子目录名（实测固定）。 */
export const CUBEIDE_SUBDIR = "STM32CubeIDE";

/** 通用脚本执行（config load / project generate 等自由组合用）。 */
export async function mxRunScript(mx: CubeMxTools, scriptText: string, timeoutMs = 10 * 60_000): Promise<{ ok: boolean; log: string; reason?: string }> {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "cubemx-mcp-"));
  const script = join(dir, "script.txt");
  writeFileSync(script, scriptText, "utf8");
  const args = mx.java ? ["-jar", mx.exe, "-q", script] : ["-q", script];
  const { code, out } = await run(mx.java || mx.exe, args, timeoutMs);
  rmSync(dir, { recursive: true, force: true });
  return { ok: code === 0, log: out, ...(code !== 0 ? { reason: `CubeMX exited ${code}; last output: ${out.split(/\r?\n/).filter(Boolean).slice(-4).join(" | ")}` } : {}) };
}

export async function mxGenerate(mx: CubeMxTools, options: MxGenerateOptions): Promise<MxGenerateResult> {
  const started = Date.now();
  const toolchain = options.toolchain ?? "STM32CubeIDE";
  const iocPath = join(options.path, `${options.name}.ioc`);
  const lines = [
    `load ${options.mcu}`,
    `project name ${options.name}`,
    `project toolchain ${toolchain}`,
    `project path ${options.path.replace(/\\/g, "/")}`,
    ...(options.extraScriptLines ?? []),
    "project generate",
    "exit",
  ];
  // 脚本写到临时文件（-q 从文件读，不收 stdin）。
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const dir = mkdtempSync(join(tmpdir(), "cubemx-mcp-"));
  const script = join(dir, "gen.txt");
  writeFileSync(script, lines.join("\n"), "utf8");
  const args = mx.java
    ? ["-jar", mx.exe, "-q", script]
    : ["-q", script];
  const runner = mx.java || mx.exe;
  const { code, out } = await run(runner, args, options.timeoutMs ?? 10 * 60_000);
  rmSync(dir, { recursive: true, force: true });
  const ok = code === 0 && existsSync(iocPath);
  const projectDir = toolchain === "STM32CubeIDE" ? join(options.path, CUBEIDE_SUBDIR) : options.path;
  return {
    ok,
    iocPath,
    projectDir,
    log: out,
    durationMs: Date.now() - started,
    ...(ok ? {} : { reason: `CubeMX exited ${code}${existsSync(iocPath) ? "" : ` and wrote no ${options.name}.ioc`}; last output: ${out.split(/\r?\n/).filter(Boolean).slice(-4).join(" | ")}` }),
  };
}
