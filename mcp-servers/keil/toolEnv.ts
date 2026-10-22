import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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
/**
 * `cbuild` 找到编译器的方式：`<name>_TOOLCHAIN_<major>_<minor>_<patch>` 里写
 * 编译器的 `bin` 目录。
 *
 * 这不是可选的调优项。实测：不设它，`cbuild` 对任何 csolution 工程都以
 * `error cbuild2cmake: compiler registration environment variable missing` 失败，
 * 而工具链明明已经装好、`armclang --version` 也能跑——因为 CMSIS-Toolbox 刻意
 * 不猜编译器装在哪。
 *
 * 这里只登记"检测已经找到的那个编译器"，不认识任何一家厂商的目录名：路径和
 * 版本都来自 `compilerFromDetection` 的答案。
 */
export function compilerRegistration(
  compilers: { name: string; bin: string; version: string }[],
  env: NodeJS.ProcessEnv = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { name, bin, version } of compilers) {
    const parts = version.match(/\d+/g) ?? [];
    if (parts.length < 2 || !bin) continue;
    const [major, minor, patch = "0"] = parts;
    // 已经由用户设过时不覆盖：他显式指定的那份优先。
    const key = `${name}_TOOLCHAIN_${major}_${minor}_${patch}`;
    const existing = Object.keys(env).find((name) => name.toUpperCase() === key.toUpperCase());
    if (!existing) out[key] = bin;
  }
  return out;
}

/**
 * 工具链的 `bin` 目录和版本，从检测结果里读。
 *
 * `armclang.exe` 在 `...\ARMCLANG\bin\armclang.exe`；版本串是
 * `Tool: armclang [5f371800]` 那类输出里的 `6.24`，或者 `--version` 的
 * `Product: ... 6.24`。两种都要认。
 */
export function compilerFromDetection(tools: { kind: string; path: string; version?: string }[]): { kind: string; bin: string; version: string }[] {
  const out: { kind: string; bin: string; version: string }[] = [];
  for (const tool of tools) {
    // CMSIS-Toolbox 认的是编译器家族名（AC6 / GCC / IAR / CLANG），不是可执行
    // 文件名；`armclang` 属于 AC6，`arm-none-eabi-gcc` 属于 GCC。
    // Keil's own compilers are not separate tools in the detection report: an
    // MDK install carries AC5/AC6 and the project chooses between them, so the
    // `keil` entry's install root is where they live.
    if (tool.kind === "keil") {
      for (const found of keilCompilers(dirname(tool.path))) out.push(found);
      continue;
    }
    const family = /armclang/i.test(tool.path) ? "AC6"
      : /arm-none-eabi-gcc|riscv.*gcc|(^|\\)(gcc|g\+\+)(\.exe)?$/i.test(tool.path) ? "GCC"
      : /iccarm|iar/i.test(tool.path) ? "IAR"
      : /clang/i.test(tool.path) ? "CLANG"
      : null;
    if (!family) continue;
    const version = (tool.version ?? "").match(/\d+\.\d+(\.\d+)?/)?.[0] ?? "";
    if (!version) continue;
    out.push({ kind: family, bin: dirname(tool.path), version });
  }
  return out;
}

/**
 * The Arm compilers inside a Keil install, newest AC6 first.
 *
 * `<root>\ARM\ARMCLANG\bin\armclang.exe` and `<root>\ARM\ARM_Compiler_5.06u7\
 * bin\armcc.exe`, with `UV4.exe` in `<root>\UV4\`. The version comes from
 * running the compiler, because the directory name is not part of any
 * contract (`ARM_Compiler_5.06u7` carries a vendor suffix).
 */
function keilCompilers(uv4Dir: string): { kind: string; bin: string; version: string }[] {
  const root = join(uv4Dir, "..");
  const found: { kind: string; bin: string; version: string }[] = [];
  const ac6 = join(root, "ARM", "ARMCLANG", "bin");
  if (existsSync(join(ac6, "armclang.exe"))) {
    const version = runVersion(join(ac6, "armclang.exe"));
    // `armclang --version` prints `Product: MDK Plus 5.43` on its first line,
    // which is the IDE's version, not the compiler's. The compiler version is
    // the `Component: Arm Compiler for Embedded 6.24` line; CMSIS-Toolbox
    // wants that one, and registering `AC6_TOOLCHAIN_5_43_0` registered
    // nothing at all.
    const parsed = /Arm Compiler for Embedded\s+(\d+\.\d+(?:\.\d+)?)/i.exec(version)?.[1]
      ?? /Component:.*?(\d+\.\d+(?:\.\d+)?)\s*$/im.exec(version)?.[1];
    if (parsed) found.push({ kind: "AC6", bin: ac6, version: parsed });
  }
  // AC5 (`armcc`) reports a version CMSIS-Toolbox does not register; it is
  // listed so a caller can say why an AC5 target cannot be built by `cbuild`.
  try {
    for (const entry of readdirSync(join(root, "ARM"))) {
      if (!/^ARM_Compiler_/i.test(entry)) continue;
      const bin = join(root, "ARM", entry, "bin");
      if (!existsSync(join(bin, "armcc.exe"))) continue;
      const version = runVersion(join(bin, "armcc.exe"));
      const parsed = version.match(/(\d+\.\d+(\.\d+)?)/)?.[0];
      if (parsed) found.push({ kind: "AC5", bin, version: parsed });
    }
  } catch {
    /* no ARM directory: not a Keil install */
  }
  return found;
}

function runVersion(program: string): string {
  try {
    const out = execFileSync(program, ["--version"], { encoding: "utf8", timeout: 10_000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    return out;
  } catch {
    // `armcc` prints its banner on stdout but exits non-zero for `--version`.
    return "";
  }
}