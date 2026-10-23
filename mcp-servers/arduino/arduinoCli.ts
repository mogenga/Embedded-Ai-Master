import { existsSync, readdirSync } from "node:fs";
import { execFile, execFileSync } from "node:child_process";
import { join } from "node:path";

/**
 * Arduino CLI 发现与板卡/库查询。
 *
 * 实测（本机）：`arduino-cli.exe` 1.4.1 由 Arduino IDE 自带，在
 * `<IDE>\resources\app\lib\backend\resources\` 下——单独安装 arduino-cli 的
 * 机器走 PATH 或 `ARDUINO_CLI` 环境变量。默认配置目录
 * `~\AppData\Local\Arduino15`（cli 自己知道，我们不用拼）。
 *
 * 已装核心与板卡用 `core list` / `board listall` 现查——装了什么核心就支持
 * 什么板，不写死。
 */

export interface ArduinoCli {
  path: string;
  version: string;
}

function looksLikeCli(file: string): boolean {
  if (!existsSync(file)) return false;
  try {
    const out = execFileSync(file, ["version"], { encoding: "utf8", timeout: 15_000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    return /Version:/.test(out);
  } catch {
    return false;
  }
}

/** 找 arduino-cli；返回 null = 本机没有（诚实报）。 */
export function findArduinoCli(): ArduinoCli | null {
  const env = process.env.ARDUINO_CLI;
  if (env && looksLikeCli(env)) return fromPath(env);
  if (process.platform === "win32") {
    const candidates = [
      join(process.env["ProgramFiles"] ?? "C:\\Program Files", "Arduino IDE", "resources", "app", "lib", "backend", "resources", "arduino-cli.exe"),
      join(process.env["LOCALAPPDATA"] ?? "", "Programs", "Arduino IDE", "resources", "app", "lib", "backend", "resources", "arduino-cli.exe"),
    ];
    for (const candidate of candidates) {
      if (looksLikeCli(candidate)) return fromPath(candidate);
    }
  } else {
    for (const candidate of ["/usr/local/bin/arduino-cli", "/usr/bin/arduino-cli", join(process.env.HOME ?? "", ".local/bin/arduino-cli")]) {
      if (looksLikeCli(candidate)) return fromPath(candidate);
    }
  }
  // PATH 里找（looksLikeCli 需要绝对路径；windows where 由 execFile 解析）
  try {
    const out = execFileSync(process.platform === "win32" ? "where" : "which", ["arduino-cli"], { encoding: "utf8", timeout: 10_000, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    for (const line of out.split(/\r?\n/).filter(Boolean)) {
      if (looksLikeCli(line.trim())) return fromPath(line.trim());
    }
  } catch {
    /* not on PATH */
  }
  return null;
}

function fromPath(path: string): ArduinoCli {
  let version = "";
  try {
    version = /Version:\s*(\S+)/.exec(execFileSync(path, ["version"], { encoding: "utf8", timeout: 15_000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }))?.[1] ?? "";
  } catch {
    /* version unknown */
  }
  return { path, version };
}

export interface SketchInfo {
  /** sketch 目录（目录名 = 主 .ino 文件名的那个）。 */
  dir: string;
  name: string;
  inoFile: string;
}

/**
 * 识别 sketch：目录里有一个与目录同名的 .ino。
 * （Arduino 的硬规则：Blink/Blink.ino 才是 sketch，Blink/other.ino 不编译。）
 */
export function findSketch(root: string): SketchInfo | null {
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return null;
  }
  const name = root.split(/[\\/]/).filter(Boolean).pop() ?? "";
  const primary = join(root, `${name}.ino`);
  if (entries.includes(`${name}.ino`) && existsSync(primary)) {
    return { dir: root, name, inoFile: primary };
  }
  return null;
}

export interface CliResult {
  ok: boolean;
  command: string;
  exitCode: number | null;
  out: string;
}

export function runCli(
  cli: ArduinoCli,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      cli.path,
      args,
      { cwd: options.cwd, timeout: options.timeoutMs ?? 120_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ ok: code === 0, command: `arduino-cli ${args.join(" ")}`, exitCode: code, out: `${stdout ?? ""}${stderr ?? ""}` });
      },
    );
  });
}

/** 已安装核心（`core list`）；JSON 实测形状是 { platforms: [{ id, releases: { <ver>: {...} } }] }。 */
export async function coreList(cli: ArduinoCli): Promise<Array<{ id: string; installed: string; name: string }>> {
  const result = await runCli(cli, ["core", "list", "--format", "json"], { timeoutMs: 30_000 });
  try {
    const parsed = JSON.parse(result.out) as {
      platforms?: Array<{ id: string; releases?: Record<string, { name?: string; version?: string }> }>;
    };
    return (parsed.platforms ?? []).map((platform) => {
      // Installed 的 release 带 installed 标记；取它，缺省取最大版本名。
      const releases = Object.entries(platform.releases ?? {});
      const installed = releases.find(([, release]) => (release as { installed?: boolean }).installed)
        ?? releases.filter(([, release]) => (release as { name?: string }).name).sort((a, b) => b[0].localeCompare(a[0]))[0];
      return { id: platform.id, installed: installed?.[0] ?? "", name: installed?.[1]?.name ?? "" };
    });
  } catch {
    return [];
  }
}
