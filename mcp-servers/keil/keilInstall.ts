import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Keil 安装发现（精简版）。
 *
 * 摘自 Prometheus/src/embedded/toolchain.ts 的 `keilRoots` / `keilRegistryArmDirs`
 * 与 SPECS 里的 keil 项，只保留"找 UV4.exe"这一条路径 —— 完整的 9 种工具链
 * 探测属 Phase 3，Keil 闭包不需要。
 *
 * C:\Keil_v5 只是默认值。Keil 会把自己的安装根写进 UV4\ 旁边的 TOOLS.INI，
 * 注册表也要读：实测这台机器装在 G:\software\keil5，默认路径根本不存在。
 */

/** The `ARM` directories the registry names, when the keys exist. */
function keilRegistryArmDirs(): string[] {
  if (process.platform !== "win32") return [];
  if (cachedKeilRegistry) return cachedKeilRegistry;
  const dirs: string[] = [];
  for (const key of [
    "HKLM\\SOFTWARE\\WOW6432Node\\Keil\\Products\\MDK",
    "HKLM\\SOFTWARE\\Keil\\Products\\MDK",
    "HKCU\\Software\\Keil\\Products\\MDK",
  ]) {
    try {
      const out = execFileSync("reg", ["query", key, "/v", "Path"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 4000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const match = /Path\s+REG_SZ\s+(.+)$/im.exec(out);
      if (match?.[1]?.trim()) dirs.push(match[1].trim());
    } catch {
      /* the key does not exist */
    }
  }
  cachedKeilRegistry = dirs;
  return dirs;
}

/** One registry read per process. */
let cachedKeilRegistry: string[] | null = null;

/** Keil 安装根目录（含 `UV4\UV4.exe`），去重。 */
export function keilRoots(): string[] {
  const roots: string[] = [];
  const addRoot = (armDir: string) => {
    if (!armDir) return;
    const root = join(armDir.replace(/[\/]+$/, ""), "..");
    if (existsSync(join(root, "UV4", "UV4.exe"))) roots.push(root);
  };
  const fromIni = (iniPath: string) => {
    try {
      if (!existsSync(iniPath)) return;
      // INI-shaped: `PATH="G:\\software\\keil5\\ARM\\"` names the ARM
      // subdirectory, so the install root is its parent.
      const text = readFileSync(iniPath, "utf8");
      const match = /^\s*PATH\s*=\s*"([^"]+)"/im.exec(text);
      if (match?.[1]) addRoot(match[1]);
    } catch {
      /* an unreadable INI is not a failure to report */
    }
  };
  // The registry is the install that actually exists. The default locations
  // below are guesses, and on the machine this was built against the guess is
  // wrong: Keil lives in `G:\\software\\keil5`.
  for (const armDir of keilRegistryArmDirs()) {
    fromIni(join(armDir, "..", "TOOLS.INI"));
    addRoot(armDir);
  }
  const programFiles = process.env["ProgramFiles"] ?? "C:\\Program Files";
  for (const ini of [
    join(programFiles, "Keil", "TOOLS.INI"),
    join(programFiles, "Keil_v5", "TOOLS.INI"),
    "C:\\Keil",
    "C:\\Keil_v5",
  ].flatMap((entry) => (entry.toLowerCase().endsWith(".ini") ? [entry] : [join(entry, "TOOLS.INI")]))) {
    fromIni(ini);
  }
  return roots.filter((root, index, all) => all.indexOf(root) === index);
}

/**
 * Where `UV4.exe` is, if Keil is installed.
 *
 * The fixed defaults are tried last, after the registry and TOOLS.INI, because
 * they are guesses rather than facts.
 */
export function findUv4(): string | null {
  for (const root of keilRoots()) {
    const candidate = join(root, "UV4", "UV4.exe");
    if (existsSync(candidate)) return candidate;
  }
  if (process.platform !== "win32") return null;
  for (const candidate of [
    "C:\\Keil_v5\\UV4\\UV4.exe",
    "C:\\Keil\\UV4\\UV4.exe",
    "C:\\Program Files\\Keil_v5\\UV4\\UV4.exe",
    "C:\\Program Files (x86)\\Keil_v5\\UV4\\UV4.exe",
    "C:\\Program Files\\Keil\\UV4\\UV4.exe",
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}