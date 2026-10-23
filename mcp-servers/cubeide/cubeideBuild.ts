import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { toolEnv } from "../keil/toolEnv.js";
import type { CubeIdeTools } from "./cubeideInstall.js";

/**
 * CubeIDE 无头构建。
 *
 * 入口是 IDE 自带的 headlessbuild 应用：
 *
 *   stm32cubeidec.exe --launcher.suppressErrors -nosplash
 *     -application org.eclipse.cdt.managedbuilder.core.headlessbuild
 *     -data <workspace> -import <projectDir> -build <project>/<config>
 *     -printErrorMarkers
 *
 * 实测（`headless-build.bat -help`）确认的旗标：-data/-import/-importAll/
 * -build/-cleanBuild/-markerType/-no-indexer/-verbose/-printErrorMarkers/
 * -I/-include/-D/-E*。
 *
 * 每次构建用**独立 workspace**：Eclipse 会锁 workspace，共用目录会让两次
 * 构建互相踩（KEIL 侧 UV4 端口冲突的同款问题）。构建完删除。
 */

export interface HeadlessBuildOptions {
  tools: CubeIdeTools;
  /** 工程目录（含 .project）。 */
  projectDir: string;
  /** `-build`/`-cleanBuild` 的目标，即 .project 的 `<name>`。 */
  projectName: string;
  /** 构建配置名；CubeIDE 生成的工程默认是 Debug。 */
  config?: string;
  clean?: boolean;
  timeoutMs?: number;
}

export interface HeadlessBuildResult {
  ok: boolean;
  command: string;
  exitCode: number | null;
  /** stdout+stderr；-printErrorMarkers 会把错误标记打进来。 */
  log: string;
  durationMs: number;
  /** 构建失败时最后几行诊断，供直接展示。 */
  errors?: string[];
}

function run(file: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024, env: toolEnv() },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, out: `${stdout ?? ""}${stderr ?? ""}` });
      },
    );
  });
}

export async function headlessBuild(options: HeadlessBuildOptions): Promise<HeadlessBuildResult> {
  const { tools, projectDir, projectName, config } = options;
  const started = Date.now();
  let workspace: string | null = null;
  try {
    workspace = mkdtempSync(join(tmpdir(), "cubeide-mcp-ws-"));
  } catch (error) {
    return {
      ok: false,
      command: "",
      exitCode: null,
      log: "",
      durationMs: 0,
      errors: [`could not create a temporary workspace: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  const buildFlag = options.clean ? "-cleanBuild" : "-build";
  const target = config ? `${projectName}/${config}` : projectName;
  const args = [
    "--launcher.suppressErrors",
    "-nosplash",
    "-application", "org.eclipse.cdt.managedbuilder.core.headlessbuild",
    "-data", workspace,
    "-import", projectDir,
    buildFlag, target,
    "-printErrorMarkers",
  ];
  const command = `${tools.idec} ${args.join(" ")}`;
  const { code, out } = await run(tools.idec, args, join(projectDir, ".."), options.timeoutMs ?? 10 * 60_000);
  try {
    rmSync(workspace, { recursive: true, force: true });
  } catch {
    /* 删不掉就留着：临时目录不碍事 */
  }
  const lines = out.split(/\r?\n/).filter(Boolean);
  const errorLines = lines.filter((line) => /error|错误/i.test(line) || /^\s*(Severity|Description)\s*[:=]/i.test(line));
  return {
    ok: code === 0,
    command,
    exitCode: code,
    log: out,
    durationMs: Date.now() - started,
    ...(code !== 0 && errorLines.length > 0 ? { errors: errorLines.slice(-20) } : {}),
  };
}
