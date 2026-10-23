import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * ESP-IDF 安装发现与环境拼装。
 *
 * `idf.py` 不是独立可执行文件——它需要一组环境变量才能跑。实测（本机
 * ESP-IDF v6.0.2）最小变量集：
 *
 *   IDF_PATH             IDF 安装根
 *   IDF_PYTHON_ENV_PATH  venv 路径（含 esptool/idf_component_manager）
 *   ESP_IDF_VERSION      版本串（idf_component_manager 读它做版本比较，缺席会
 *                        TypeError；export.ps1/activate.py 会设置）
 *   PATH 前置            工具链 bin（xtensa-esp-elf/…）+ cmake + ninja
 *   （并清掉 MSYSTEM —— git-bash 的派生环境会让 idf.py 打警告且行为变怪）
 *
 * 发现顺序（与 keilInstall 同思路，注册表/固定路径只是兜底）：
 *   IDF_PATH 环境变量 → C:\Espressif\frameworks\esp-idf-* glob → ~\.espressif
 *   IDF_TOOLS_PATH 环境变量 → ~\.espressif（IDF 的默认值）
 *
 * venv 里必有 esptool；openocd-esp32 与 gdb 在 tools\ 下按目录名 glob。
 */

export interface IdfTools {
  idfPath: string;
  idfVersion: string;
  pythonEnv: string;
  venvPython: string;
  esptool: string;
  openocd: string;
  /** openocd scripts 根（-s 参数用，board cfg 相对它解析）。 */
  openocdScripts: string;
  gdb: string;
  /** 工具链 bin 目录列表（PATH 前置用）。 */
  pathPrepend: string[];
}

const ESPRESSIF_DEFAULT = join(homedir(), ".espressif");

function idfRoots(): string[] {
  const roots: string[] = [];
  const env = process.env.IDF_PATH;
  if (env && existsSync(join(env, "tools", "idf.py"))) roots.push(env);
  for (const base of ["C:\\Espressif\\frameworks", join(homedir(), "esp"), join(homedir(), ".espressif", "frameworks")]) {
    try {
      if (!existsSync(base)) continue;
      for (const entry of readdirSync(base)) {
        const dir = join(base, entry);
        if (/^esp-idf-v?\d/i.test(entry) && existsSync(join(dir, "tools", "idf.py"))) roots.push(dir);
      }
    } catch {
      /* unreadable base: skip */
    }
  }
  return roots.filter((root, index, all) => all.indexOf(root) === index);
}

/** tools\<tool>\<version-dir>\<inner> 下取唯一（或版本最大）的版本目录。 */
function newestVersionDir(toolDir: string, inner = ""): string | null {
  try {
    const versions = readdirSync(toolDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
    if (versions.length === 0) return null;
    const dir = join(toolDir, versions[0]!, inner);
    return existsSync(dir) ? dir : null;
  } catch {
    return null;
  }
}

/** 从 IDF 的 tools\idf.py 源码里读 __version__（idf.py 顶部有定义）。 */
function readIdfVersion(idfPath: string): string {
  try {
    const head = readFileSync(join(idfPath, "tools", "idf.py"), "utf8").slice(0, 4000);
    const match = /__version__\s*=\s*["']([^"']+)["']/.exec(head);
    if (match?.[1]) return match[1];
    const compat = readFileSync(join(idfPath, "version.txt"), "utf8").trim();
    if (compat) return compat;
  } catch {
    /* fall through */
  }
  // 目录名兜底：esp-idf-v6.0.2 → 6.0.2
  const fromDir = /esp-idf-v?(\d[\w.]*)/i.exec(idfPath)?.[1];
  return fromDir ?? "";
}

/** 工具链 bin（xtensa-esp-elf / riscv32-esp-elf / esp32ulp-elf 都要进 PATH）。 */
function toolchainBins(toolsDir: string): string[] {
  const bins: string[] = [];
  for (const tool of ["xtensa-esp-elf", "riscv32-esp-elf", "esp32ulp-elf"]) {
    const bin = newestVersionDir(join(toolsDir, tool), "bin")
      // xtensa-esp-elf 的布局多一层 <release>/xtensa-esp-elf/bin
      ?? newestVersionDir(join(toolsDir, tool), join(tool, "bin"));
    if (bin) bins.push(bin);
  }
  return bins;
}

/**
 * 解析 IDF 环境；不完整返回 null（调用方诚实报「未安装/不完整」）。
 * `idfPath` 显式传入时只解析这一份。
 */
export function resolveIdfTools(idfPath?: string): IdfTools | null {
  const roots = idfPath ? [idfPath] : idfRoots();
  for (const root of roots) {
    const version = readIdfVersion(root);
    const toolsPath = process.env.IDF_TOOLS_PATH ?? ESPRESSIF_DEFAULT;
    const pythonEnv = findPythonEnv(toolsPath, version);
    if (!pythonEnv) continue;
    const venvPython = join(pythonEnv, "Scripts", "python.exe");
    const venvEsptool = join(pythonEnv, "Scripts", "esptool.exe");
    if (!existsSync(venvPython)) continue;
    const toolsDir = join(toolsPath, "tools");
    const openocdDir = newestVersionDir(join(toolsDir, "openocd-esp32"), "openocd-esp32");
    const gdbDir = newestVersionDir(join(toolsDir, "xtensa-esp-elf-gdb"), join("xtensa-esp-elf-gdb", "bin"))
      ?? newestVersionDir(join(toolsDir, "xtensa-esp-elf-gdb"), "bin");
    const esptool = existsSync(venvEsptool) ? venvEsptool : "";
    if (!esptool) continue;
    return {
      idfPath: root,
      idfVersion: version,
      pythonEnv,
      venvPython,
      esptool,
      openocd: openocdDir ? join(openocdDir, "bin", "openocd.exe") : "",
      openocdScripts: openocdDir ? join(openocdDir, "share", "openocd", "scripts") : "",
      gdb: gdbDir ? join(gdbDir, "xtensa-esp-elf-gdb.exe") : "",
      pathPrepend: [
        ...toolchainBins(toolsDir),
        newestVersionDir(join(toolsDir, "cmake"), "bin") ?? "",
        newestVersionDir(join(toolsDir, "ninja")) ?? "",
        join(pythonEnv, "Scripts"),
      ].filter(Boolean),
    };
  }
  return null;
}

function findPythonEnv(toolsPath: string, version: string): string | null {
  const envDir = join(toolsPath, "python_env");
  try {
    // 目录名形如 idf6.0_py3.12_env；版本号对得上优先，否则取唯一/最新的。
    const entries = readdirSync(envDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
    const matching = version ? entries.find((name) => name.includes(`idf${version}`)) : undefined;
    const picked = matching ?? entries[0];
    return picked ? join(envDir, picked) : null;
  } catch {
    return null;
  }
}

/**
 * `idf.py` 需要的环境（白名单底座 + 上面实测的最小变量集）。
 *
 * 绝不修改 process.env；每次 spawn 用的副本。
 */
export function idfEnv(tools: IdfTools, base: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  // MSYSTEM 是 git-bash 的标志：idf.py 见到它就警告且行为怪（实测）。
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === "MSYSTEM") delete env[key];
  }
  env.IDF_PATH = tools.idfPath;
  env.IDF_PYTHON_ENV_PATH = tools.pythonEnv;
  env.ESP_IDF_VERSION = tools.idfVersion;
  env.IDF_TOOLS_PATH = process.env.IDF_TOOLS_PATH ?? join(homedir(), ".espressif");
  const existingKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH");
  const key = existingKey ?? "PATH";
  const current = env[key] ?? process.env.PATH ?? "";
  const sep = process.platform === "win32" ? ";" : ":";
  env[key] = [...tools.pathPrepend, current].join(sep);
  return env;
}

/**
 * 找 IDF 环境；输出一行给 version/capabilities 用的人类可读摘要。
 */
export function findIdfTools(): IdfTools | null {
  return resolveIdfTools();
}

export function describeIdf(tools: IdfTools): string[] {
  return [
    `IDF_PATH: ${tools.idfPath} (v${tools.idfVersion || "?"})`,
    `python env: ${tools.pythonEnv}`,
    `esptool: ${tools.esptool}`,
    `openocd: ${tools.openocd || "(not found — debug unavailable)"}`,
    `gdb: ${tools.gdb || "(not found — debug unavailable)"}`,
  ];
}

/** 供测试注入：不允许生产代码用。 */
export function _resetCaches(): void {
  /* 现在没有进程级缓存，占位以保持 API 稳定 */
}
