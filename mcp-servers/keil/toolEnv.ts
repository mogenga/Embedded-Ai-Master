import { homedir } from "node:os";

/**
 * 子进程的环境构造（精简版）。
 *
 * 从 Prometheus/src/embedded/toolEnv.ts 抽出，去掉 packs 与 sandbox 模块依赖：
 * - `packBinDirs()` 在 packs 迁移前恒为空（TODO: Phase 3 接回）；
 * - `sandboxEnv` 的键名白名单原样内联（A 的 sandbox.ts:386 起）。
 *
 * 硬规则保持不变：**绝不修改 process.env**，只给某一次 spawn 用的副本。
 * Windows 键名大小写不敏感（系统给 `Path`，再写 `PATH` 会出现两个键），
 * 查找已有键时统一按大写比较。
 */

const WINDOWS_KEYS = [
  "SystemRoot",
  "windir",
  "PATHEXT",
  "ComSpec",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramFiles",
] as const;

/** 与 Prometheus/src/sandbox.ts 的 sandboxEnv({ mode: "enforce", network: "off" }) 等价。 */
export function sandboxEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    LANG: process.env.LANG ?? "en_US.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "",
    TMPDIR: process.env.TMPDIR ?? "",
    TEMP: process.env.TEMP ?? "",
    TMP: process.env.TMP ?? "",
    NO_COLOR: "1",
    CI: "1",
    FORCE_COLOR: "0",
  };
  if (process.platform === "win32") {
    for (const key of WINDOWS_KEYS) {
      env[key] = process.env[key] ?? (key === "USERPROFILE" ? homedir() : key === "PATHEXT" ? ".COM;.EXE;.BAT;.CMD" : key === "ComSpec" ? "cmd.exe" : "");
    }
  }
  // 与 A 一致：network: "off" 时用不可达代理阻断子进程的 HTTP 出口。
  env.HTTP_PROXY = "http://127.0.0.1:9";
  env.HTTPS_PROXY = "http://127.0.0.1:9";
  env.http_proxy = env.HTTP_PROXY;
  env.https_proxy = env.HTTPS_PROXY;
  env.NO_PROXY = "";
  env.no_proxy = "";
  return env;
}

/**
 * 把目录前置到 PATH。
 *
 * 查找已有键时不区分大小写：Windows 上是 `Path`，Linux/macOS 上是 `PATH`。
 * 去重但保持调用方给的顺序（先给的优先）。
 */
export function prependPath(env: NodeJS.ProcessEnv, dirs: string[]): NodeJS.ProcessEnv {
  if (dirs.length === 0) return env;

  const existingKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH");
  const key = existingKey ?? "PATH";
  const current = env[key] ?? "";

  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const dir of dirs) {
    const normalized = dir.replace(/[\\/]+$/, "");
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      ordered.push(normalized);
    }
  }

  const sep = process.platform === "win32" ? ";" : ":";
  const rest = current
    .split(sep)
    .filter(Boolean)
    .filter((dir) => !seen.has(dir.replace(/[\\/]+$/, "")));

  return { ...env, [key]: [...ordered, ...rest].join(sep) };
}

/** 所有 pack 提供的 bin 目录。packs 未迁移前为空（TODO: Phase 3）。 */
export function allPackBinDirs(): string[] {
  return [];
}

/**
 * 给嵌入式工具用的环境。
 *
 * 基础环境是白名单那份，不是 `process.env`：编译器和烧录器同样是 agent 让它
 * 跑的命令，没有理由比 `bash` 多拿一份 API key。
 */
export function toolEnv(_kinds?: string[], base: NodeJS.ProcessEnv = sandboxEnv()): NodeJS.ProcessEnv {
  return prependPath({ ...base }, allPackBinDirs());
}