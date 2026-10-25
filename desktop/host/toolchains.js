import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Tools 设置页的"本机探测"数据源。
 *
 * 从 Prometheus/src/embedded/toolchain.ts 的 SPECS 摘出轻量探测表：kind →
 * 候选可执行名 + 版本参数。完整的多根安装扫描（A 的 windowsDirs / unixDirs）
 * 属 Phase 3 工具链探测，这里只做 Tools 页需要的两件事：pack 提供的目录、
 * PATH。Keil 例外——它的安装根只写在注册表和 TOOLS.INI 里，PATH 上没有，
 * 探测直接借用 keil server 的 `findUv4`（dist-mcp/keil/keilInstall.js）。
 *
 * Windows 上候选名统一补 `.exe` 变体：A 的 PATH 扫描对无扩展名的名字会
 * miss（cmd 的 where 会自动试 PATHEXT，直接 existsSync 不会）。
 */

/** kind → 探测规格。names 原序即优先序。 */
const SPECS = [
  { kind: "gcc-arm", names: ["arm-none-eabi-gcc"], versionArgs: ["--version"] },
  { kind: "gcc-riscv", names: ["riscv64-unknown-elf-gcc", "riscv32-esp-elf-gcc"], versionArgs: ["--version"] },
  { kind: "cmake", names: ["cmake"], versionArgs: ["--version"] },
  { kind: "ninja", names: ["ninja"], versionArgs: ["--version"] },
  { kind: "make", names: ["make", "gmake"], versionArgs: ["--version"] },
  { kind: "west", names: ["west"], versionArgs: ["--version"] },
  { kind: "idf", names: ["idf.py"], versionArgs: ["--version"] },
  { kind: "pio", names: ["pio", "platformio"], versionArgs: ["--version"] },
  { kind: "arduino-cli", names: ["arduino-cli"], versionArgs: ["version", "--format", "json"] },
  { kind: "cargo", names: ["cargo"], versionArgs: ["--version"] },
  { kind: "cbuild", names: ["cbuild"], versionArgs: ["--version"] },
  { kind: "cpackget", names: ["cpackget"], versionArgs: ["--version"] },
  { kind: "svdconv", names: ["SVDConv", "svdconv"], versionArgs: [] },
  { kind: "openocd", names: ["openocd"], versionArgs: ["--version"] },
  { kind: "pyocd", names: ["pyocd"], versionArgs: ["--version"] },
  { kind: "probe-rs", names: ["probe-rs"], versionArgs: ["--version"] },
  { kind: "jlink", names: ["JLinkExe", "JLink"], versionArgs: [] },
  { kind: "esptool", names: ["esptool.py", "esptool"], versionArgs: ["version"] },
  { kind: "st-flash", names: ["st-flash"], versionArgs: ["--version"] },
  { kind: "stm32-programmer", names: ["STM32_Programmer_CLI"], versionArgs: ["--version"] },
  { kind: "dfu-util", names: ["dfu-util"], versionArgs: ["--version"] },
  { kind: "avrdude", names: ["avrdude"], versionArgs: ["-?"] },
  { kind: "qemu", names: ["qemu-system-arm"], versionArgs: ["--version"] },
  { kind: "renode", names: ["renode"], versionArgs: ["--version"] },
  { kind: "sigrok", names: ["sigrok-cli"], versionArgs: ["--version"] },
  { kind: "cppcheck", names: ["cppcheck"], versionArgs: ["--version"] },
  { kind: "clang-tidy", names: ["clang-tidy"], versionArgs: ["--version"] },
];

const isWindows = process.platform === "win32";

/** 候选可执行名的全部拼写（含平台扩展名变体）。 */
function candidateNames(names) {
  const out = [];
  for (const name of names) {
    out.push(name);
    if (isWindows && !/\.[a-z]+$/i.test(name)) out.push(`${name}.exe`);
  }
  return out;
}

/** PATH 目录列表（Windows 键可能是 Path，大小写不敏感地找）。 */
function pathDirs(env = process.env) {
  const key = Object.keys(env).find((entry) => entry.toUpperCase() === "PATH");
  const value = key ? env[key] : "";
  const sep = isWindows ? ";" : ":";
  return String(value ?? "")
    .split(sep)
    .map((dir) => dir.trim())
    .filter(Boolean);
}

function runVersion(program, args) {
  return new Promise((resolve) => {
    execFile(program, args, { timeout: 10_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      // 工具把版本打到 stderr（openocd）或退出码非零（avrdude -?）都算成功：
      // 版本串取合并输出的第一行，拿不到就空串——"找到了"这个事实比版本号
      // 更重要，页面会照常显示路径。
      const text = `${stdout ?? ""}${stderr ?? ""}`.trim();
      resolve(text.split(/\r?\n/)[0] ?? "");
    });
  });
}

/**
 * 探测本机工具链。
 *
 * 搜索顺序与 A 的 toolchain.ts 一致：**pack 目录 → PATH**（pack 是应用可以
 * 校验的显式安装；PATH 最不可信——Homebrew 的 arm-none-eabi-gcc 是没有
 * C 库的编译器，找到它比找不到更糟）。Keil 走注册表发现，不在 PATH 上。
 *
 * @param {{ packDirs?: string[], findUv4?: (() => string | null) | null }} options
 *   `packDirs` 是 pack 贡献的 bin 目录（来自 registry.packBinDirs）；
 *   `findUv4` 由调用方注入（dist-mcp/keil/keilInstall.js），缺失时 Keil 行
 *   显示为未安装而不是假装探测过。
 */
export async function detectToolchains(options = {}) {
  const packDirs = options.packDirs ?? [];
  const pathDirectories = pathDirs();
  const tools = [];
  const missing = [];
  const searchPaths = [...packDirs];

  for (const spec of SPECS) {
    const names = candidateNames(spec.names);
    let found = null;
    let source = "path";

    for (const dir of packDirs) {
      for (const name of names) {
        const full = join(dir, name);
        if (existsSync(full)) {
          found = full;
          source = "pack";
          break;
        }
      }
      if (found) break;
    }
    if (!found) {
      for (const dir of pathDirectories) {
        for (const name of names) {
          const full = join(dir, name);
          if (existsSync(full)) {
            found = full;
            source = "path";
            break;
          }
        }
        if (found) break;
      }
    }

    if (found) {
      const version = spec.versionArgs.length > 0 ? await runVersion(found, spec.versionArgs) : "";
      tools.push({ kind: spec.kind, path: found, version, source });
    } else {
      missing.push(spec.kind);
    }
  }

  // Keil：注册表 + TOOLS.INI 发现（findUv4 由调用方注入）。它不在 PATH 上，
  // 也不由 pack 提供（授权软件，目录条目里没有它）。
  if (typeof options.findUv4 === "function") {
    try {
      const uv4 = options.findUv4();
      if (uv4) {
        tools.push({ kind: "keil", path: uv4, version: "", source: "registry" });
        searchPaths.push(dirname(uv4));
      } else {
        missing.push("keil");
      }
    } catch {
      missing.push("keil");
    }
  } else {
    missing.push("keil");
  }

  // IAR 与 Keil 同理是授权软件，只认常见安装根的猜测位（A 的 SPECS 有一串
  // 版本化路径）；Phase 3 全量探测接入前，先按"未安装"上报——比拿猜错
  // 的路径冒充探测结果诚实（R3）。
  missing.push("iar");

  return { tools, missing, searchPaths };
}