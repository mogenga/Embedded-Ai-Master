import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * STM32CubeIDE 安装发现。
 *
 * 与 keilInstall.ts 同一个思路：注册表是事实来源，固定路径只是兜底猜测。
 * 实测这台机器 CubeIDE 2.2.0 装在 `G:\software\STM32CubeIDE_2.2.0`，默认
 * 路径 `C:\ST\STM32CubeIDE_*` 根本不存在，所以发现逻辑不能只猜 C 盘。
 *
 * 判定"安装根"的标准：目录下有 `stm32cubeidec.exe` 和 `plugins\`。
 * 五个 externaltools 插件是带版本号的目录名，必须 glob，不能写死：
 *
 *   gnu-tools-for-stm32.*.win32_*  → tools\bin\arm-none-eabi-gdb.exe 等
 *   stlink-gdb-server.win32_*      → tools\bin\ST-LINK_gdbserver.exe
 *   openocd.win32_*                → tools\bin\openocd.exe
 *   jlink.win32_*                  → tools\bin（JLink gdbserver 套件）
 *   cubeprogrammer.win32_*         → tools\bin\STM32_Programmer_CLI.exe
 *
 * 独立安装的 STM32CubeProgrammer（`C:\Program Files\STMicroelectronics\...`）
 * **不用**：只用 IDE 内置那份，保持"装了 IDE 就有全部二进制"（用户决策，
 * 见 keil 的 D-201 与 cubeide-porting-spec.md）。
 */

export interface CubeIdeTools {
  /** 安装根（含 stm32cubeidec.exe 与 plugins\）。 */
  root: string;
  idec: string;
  gdb: string;
  gdbToolchainBin: string;
  stlinkGdbServer: string;
  openocd: string;
  jlinkBin: string;
  programmerCli: string;
  cubeprogrammerBin: string;
}

function registryIdeaRoots(): string[] {
  if (process.platform !== "win32") return [];
  const dirs: string[] = [];
  // CubeIDE 的安装器写 HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall
  // 下的 Location，这里不猜键名版本号：查卸载表里 Displayname 含 STM32CubeIDE
  // 的项。reg query 一次整表，输出里再解析。
  try {
    const out = execFileSync("reg", ["query", "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall", "/s", "/f", "STM32CubeIDE", "/d"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 8000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    for (const match of out.matchAll(/^(HKEY[^ ]+)\\(\S*STM32CubeIDE\S*)$/gim)) {
      dirs.push(match[1]);
    }
  } catch {
    /* 键不存在或 reg 不可用：走兜底路径 */
  }
  return dirs;
}

function looksLikeRoot(dir: string): boolean {
  return existsSync(join(dir, "stm32cubeidec.exe")) && existsSync(join(dir, "plugins"));
}

/**
 * 候选安装根，按可信度排序：`CUBEIDE_HOME` 环境变量 > 注册表 > 默认路径。
 */
export function cubeIdeRootCandidates(): string[] {
  const roots: string[] = [];
  const envHome = process.env.CUBEIDE_HOME;
  if (envHome) {
    // 允许用户给到 STM32CubeIDE_2.2.0 这一层（安装器建的父目录），
    // 也允许直接给安装根。
    for (const dir of [envHome, join(envHome, "STM32CubeIDE")]) {
      if (looksLikeRoot(dir)) roots.push(dir);
    }
  }
  for (const base of [
    "C:\\ST",
    "C:\\Program Files\\STMicroelectronics",
    "C:\\Program Files (x86)\\STMicroelectronics",
  ]) {
    try {
      if (!existsSync(base)) continue;
      for (const entry of readdirSync(base)) {
        const dir = join(base, entry, "STM32CubeIDE");
        if (looksLikeRoot(dir)) roots.push(dir);
      }
    } catch {
      /* 不可读的目录跳过 */
    }
  }
  // G:\software 一类自选安装位无法穷举；CUBEIDE_HOME 就是给这种机器用的。
  return roots.filter((root, index, all) => all.indexOf(root) === index);
}

/** glob 出某类 externaltools 插件目录，多个时取版本串最大的一个。 */
export function newestPlugin(pluginsDir: string, prefix: string): string | null {
  try {
    // 只要目录（`*.win32_*` 带原生工具的那份），不要同名 `.jar`（只有 Java
    // 代码，二进制不在里面）。实测：字符串排序会把 `....jar` 排在 `....win32_`
    // 之后，不排除 jar 就会拿到一个没有 tools/bin 的路径。
    const entries = readdirSync(pluginsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
      .map((entry) => entry.name)
      .sort()
      .reverse();
    return entries[0] ? join(pluginsDir, entries[0]) : null;
  } catch {
    return null;
  }
}

/**
 * 解析安装根里的全部工具路径；缺任何一样返回 null（调用方据此报
 * "安装不完整"，而不是拿着半个安装去 spawn）。
 */
export function resolveCubeIdeTools(root: string): CubeIdeTools | null {
  if (!looksLikeRoot(root)) return null;
  const plugins = join(root, "plugins");
  const gnu = newestPlugin(plugins, "com.st.stm32cube.ide.mcu.externaltools.gnu-tools-for-stm32.");
  const stlink = newestPlugin(plugins, "com.st.stm32cube.ide.mcu.externaltools.stlink-gdb-server.");
  const openocd = newestPlugin(plugins, "com.st.stm32cube.ide.mcu.externaltools.openocd.");
  const jlink = newestPlugin(plugins, "com.st.stm32cube.ide.mcu.externaltools.jlink.");
  const cp = newestPlugin(plugins, "com.st.stm32cube.ide.mcu.externaltools.cubeprogrammer.");
  if (!gnu || !stlink || !cp) return null;
  const gdbToolchainBin = join(gnu, "tools", "bin");
  const stlinkBin = join(stlink, "tools", "bin");
  const cpBin = join(cp, "tools", "bin");
  const tools: CubeIdeTools = {
    root,
    idec: join(root, "stm32cubeidec.exe"),
    gdb: join(gdbToolchainBin, "arm-none-eabi-gdb.exe"),
    gdbToolchainBin,
    stlinkGdbServer: join(stlinkBin, "ST-LINK_gdbserver.exe"),
    openocd: openocd ? join(openocd, "tools", "bin", "openocd.exe") : "",
    jlinkBin: jlink ? join(jlink, "tools", "bin") : "",
    programmerCli: join(cpBin, "STM32_Programmer_CLI.exe"),
    cubeprogrammerBin: cpBin,
  };
  for (const required of [tools.idec, tools.gdb, tools.stlinkGdbServer, tools.programmerCli]) {
    if (!existsSync(required)) return null;
  }
  return tools;
}

/** 找到第一个可用安装，返回解析好的工具路径；没有返回 null。 */
export function findCubeIdeTools(): CubeIdeTools | null {
  for (const root of cubeIdeRootCandidates()) {
    const tools = resolveCubeIdeTools(root);
    if (tools) return tools;
  }
  return null;
}

export { registryIdeaRoots };
