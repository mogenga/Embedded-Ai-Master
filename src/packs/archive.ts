/**
 * 零依赖地读取与解包归档。
 *
 * 每个桌面平台都自带 tar。Windows 的 `%SystemRoot%\System32\tar.exe` 是
 * bsdtar（libarchive）——本仓库移植时在 B 机器上实测（2026-10-25，
 * bsdtar 3.5.2 - libarchive 3.5.2）：对 `.zip` 与 `.tar.xz` 的列表（`-tf`）
 * 与解压（`-xf -C`）均正常，`--version` 退出码 0。macOS 和 Linux 自带
 * bsdtar 与 GNU tar。为此引入一个 zip 库是更差的交易：在一个零依赖的项目
 * 里加一个真实依赖，换一个 OS 已经有的能力。
 *
 * OS 的 tar *不会*给我们的是"这次解压是否安全"的可信答案。bsdtar 拒绝
 * `..` 成员，但会剥掉前导 `/` 继续解压，而半解压的树正是这个功能绝不能
 * 产生的半安装 pack。所以设计是：
 *
 *   1. 先列表，由我们自己校验每个成员名；
 *   2. 解压进暂存目录，永远不直接进目标；
 *   3. 遍历结果检查实际落盘的东西——指向外部的符号链接、setuid 位、
 *      文件数。
 *
 * tar 二进制永远用绝对路径。通过 `PATH` 解析 `tar` 恰好会在这个功能制造
 * 的场景里变成注入向量。
 *
 * （迁移自 Prometheus/src/packs/archive.ts，除本段头注释的实测记录与
 * import 后缀外逐字保留。）
 */

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, existsSync, lstatSync, readdirSync, readlinkSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { ArchiveFormat } from "./manifest.js";
import { isInside } from "./paths.js";

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveError";
  }
}

/**
 * 系统 tar，以绝对路径。
 *
 * Windows 查 `%SystemRoot%` 而不是硬编码 `C:\Windows`，因为机器可能装在
 * 别处，而 `SystemRoot` 是 OS 自己用的那个值。
 */
export function tarBinary(platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") {
    const root = process.env.SystemRoot?.trim() || process.env.windir?.trim() || "C:\\Windows";
    const candidate = join(root, "System32", "tar.exe");
    if (!existsSync(candidate)) {
      throw new ArchiveError(`no tar found at ${candidate}; Windows 10 1803 or later is required to install packs`);
    }
    return candidate;
  }
  // macOS 10.15+ 与任何现代 Linux 都把 bsdtar/GNU tar 放在这里。
  if (existsSync("/usr/bin/tar")) return "/usr/bin/tar";
  throw new ArchiveError("no system tar found at /usr/bin/tar");
}

/** tar 子进程的环境：安静、可预测、不继承任何选项。 */
function tarEnv(txnHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C", LANG: "C", HOME: txnHome };
  // `TAR_OPTIONS` 会被 GNU tar 读取，一个杂散值就能改变成员的处理方式。
  // 清掉它，是我们的 flags 还是别人的 flags 的全部差别。
  delete env.TAR_OPTIONS;
  return env;
}

function run(program: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number }): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(program, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
    });

    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill();
        }, options.timeoutMs)
      : undefined;

    const onAbort = () => child.kill();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolvePromise({ code: null, out, err: `${err}${error.message}` });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolvePromise({ code, out, err });
    });
  });
}

/**
 * 成员名为什么不安全，或 null 表示没问题。
 *
 * 两种分隔符都拆分：Windows 上写的归档可能带 `..\..\evil`，它不含正斜杠
 * 却同样是一次穿越。
 */
export function validateMember(name: string): string | null {
  if (!name) return "empty name";
  if (name.includes("\0")) return "contains a NUL byte";
  if (name.length > 900) return "name is longer than 900 characters";
  // 控制字符不该出现在文件名里，还会干扰简单的解析器。
  if (/[\u0000-\u001f]/.test(name)) return "contains a control character";
  if (name.startsWith("/") || name.startsWith("\\")) return "absolute path";
  if (/^[A-Za-z]:/.test(name)) return "names a drive";
  if (name.split(/[\\/]/).some((segment) => segment === "..")) return "contains a parent reference";
  return null;
}

/** 不携带 payload、不应影响剥层判断的归档成员。 */
function isNoise(name: string): boolean {
  const first = name.split(/[\\/]/)[0];
  return first === "__MACOSX" || first.startsWith("._") || name === "./" || name === ".";
}

/**
 * 决定剥掉几层前导路径。
 *
 * 把所有东西包在一个目录里的归档（`arm-gnu-toolchain-…/`）需要剥掉那层
 * 才能让 payload 直接落进暂存目录。有多个顶层条目的归档不剥。
 */
export function planExtraction(names: string[]): { strip: 0 | 1; violations: string[]; topLevels: string[] } {
  const violations: string[] = [];
  const topLevels = new Set<string>();
  /** 本身是文件而非目录的顶层条目。 */
  let looseFiles = 0;

  for (const name of names) {
    const problem = validateMember(name);
    if (problem) {
      violations.push(`${name}: ${problem}`);
      continue;
    }
    if (isNoise(name)) continue;
    const segments = name.split(/[\\/]/).filter(Boolean);
    if (segments.length === 0) continue;
    topLevels.add(segments[0]);
    // 末尾斜杠显式标记目录条目；没有它时，单段名是一个文件。
    if (segments.length === 1 && !/[/\\]$/.test(name)) looseFiles++;
  }

  // 单个顶层目录包装层剥掉；其他结构保持原样。
  //
  // "单个顶层*条目*"不够：只装一个裸文件的归档（ninja-win.zip 恰好就是
  // 一个 `ninja.exe`，没有别的）也只有一个顶层，剥了它就一个文件都解压
  // 不出来。只有该条目是目录时才剥——至少有一个成员在它下面。
  const singleDirectory = topLevels.size === 1 && looseFiles === 0;
  return { strip: singleDirectory ? 1 : 0, violations, topLevels: [...topLevels] };
}

/** 这个平台的 tar 能否读该格式。探测，不假设。 */
const formatCache = new Map<string, boolean>();

export async function supportsFormat(format: ArchiveFormat, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  // zip 和 tar.gz 所有受支持的 tar 都能读。tar.xz 取决于构建时是否链接
  // liblzma——本机 Windows bsdtar 的版本串只提 zlib，却正确解压 xz，所以
  // 答案来自实际尝试而不是解析横幅。
  if (format === "zip" || format === "tar.gz") return true;
  const key = `${platform}:${format}`;
  const cached = formatCache.get(key);
  if (cached !== undefined) return cached;

  let supported = false;
  try {
    // `--help` 不打印压缩支持，所以这里只用 `--version` 证明二进制能跑，
    // xz 视为支持，除非真实解压失败。
    const binary = tarBinary(platform);
    const result = await run(binary, ["--version"], { timeoutMs: 5000 });
    supported = result.code === 0;
  } catch {
    supported = false;
  }
  formatCache.set(key, supported);
  return supported;
}

/** 重置探测缓存（测试用，及平台变更后）。 */
export function resetFormatCache(): void {
  formatCache.clear();
}

/** 归档里的成员名，按归档内顺序。 */
export async function listArchive(archive: string, options: { signal?: AbortSignal; platform?: NodeJS.Platform } = {}): Promise<string[]> {
  const binary = tarBinary(options.platform);
  const result = await run(binary, ["-tf", archive], { env: tarEnv(process.env.TEMP ?? process.cwd()), signal: options.signal, timeoutMs: 120_000 });
  if (result.code !== 0) {
    throw new ArchiveError(`could not list ${archive}: ${result.err.trim() || `tar exited ${result.code}`}`);
  }
  return result.out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

/**
 * 解压进 `destination`，它必须已存在且为空。
 *
 * 调用方已校验过成员列表；这里在 plan 报告违规时也拒绝执行，所以即使
 * 调用方忘了检查，穿越也到不了 tar 命令。
 */
export async function extractArchive(
  archive: string,
  format: ArchiveFormat,
  destination: string,
  plan: { strip: 0 | 1; violations: string[] },
  options: { signal?: AbortSignal; platform?: NodeJS.Platform } = {},
): Promise<void> {
  if (plan.violations.length > 0) {
    throw new ArchiveError(`refusing to extract: ${plan.violations.slice(0, 5).join("; ")}`);
  }
  const binary = tarBinary(options.platform);
  const args = ["-x", "-f", archive, "-C", destination];
  if (plan.strip > 0) args.push(`--strip-components=${plan.strip}`);
  // `--no-same-owner` 是 GNU tar 的旗标；bsdtar 接受但忽略。带上它，
  // root 身份在 Linux 上装的 pack 就不会带着本机不存在的 uid 的文件。
  if (options.platform !== "win32") args.push("--no-same-owner");

  const result = await run(binary, args, { env: tarEnv(process.env.TEMP ?? destination), signal: options.signal, timeoutMs: 600_000 });
  if (result.code !== 0) {
    throw new ArchiveError(`extraction failed: ${result.err.trim() || `tar exited ${result.code}`}`);
  }
}

export interface WalkResult {
  files: number;
  bytes: number;
  /** 解析到目录之外的符号链接或 junction。 */
  unsafe: string[];
  /** 发现的 setuid/setgid/sticky 条目。 */
  privileged: string[];
}

/**
 * 检查实际落盘的东西。
 *
 * 列归档说的是它声称装了什么；这里说的是磁盘上有什么。一个指向
 * `C:\Windows\System32` 的符号链接在成员列表里不可见，在这里一目了然。
 */
export function walkStats(root: string): WalkResult {
  const result: WalkResult = { files: 0, bytes: 0, unsafe: [], privileged: [] };

  const visit = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry);
      let stat;
      try {
        stat = lstatSync(full);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) {
        let target = "";
        try {
          target = readlinkSync(full);
        } catch {
          /* 读不了的链接本身不是安全问题 */
        }
        const resolved = isAbsolute(target) ? resolve(target) : resolve(dir, target);
        if (!isInside(root, resolved)) result.unsafe.push(`${full} → ${resolved}`);
        continue;
      }
      if (stat.isDirectory()) {
        visit(full);
        continue;
      }
      result.files++;
      result.bytes += stat.size;
      // setuid/setgid 旁的执行位在 Unix 上是提权；pack 里没有这种文件
      // 是合法的。
      if (process.platform !== "win32" && (stat.mode & 0o7000) !== 0) result.privileged.push(full);
    }
  };

  visit(root);
  return result;
}

/**
 * payload 树的稳定哈希。
 *
 * 按路径排序使它不依赖目录顺序，并包含每个文件的哈希，使被改动的二进制
 * 改变结果。排除 `state/`，因为它是运行时可写的。
 */
export async function treeHash(root: string, options: { exclude?: string[] } = {}): Promise<string> {
  const excluded = new Set((options.exclude ?? ["state"]).map((entry) => entry.replace(/\\/g, "/")));
  const entries: { rel: string; full: string; size: number }[] = [];

  const visit = (dir: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      const rel = full.slice(root.length + 1).replace(/\\/g, "/");
      if (excluded.has(rel.split("/")[0])) continue;
      let stat;
      try {
        stat = lstatSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) visit(full);
      else if (stat.isFile()) entries.push({ rel, full, size: stat.size });
    }
  };
  visit(root);

  entries.sort((a, b) => a.rel.localeCompare(b.rel));

  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(entry.rel);
    hash.update("\0");
    const fileHash = createHash("sha256");
    await new Promise<void>((resolvePromise, reject) => {
      const stream = createReadStream(entry.full);
      stream.on("data", (chunk) => fileHash.update(chunk));
      stream.on("error", reject);
      stream.on("end", () => resolvePromise());
    });
    hash.update(fileHash.digest("hex"));
    hash.update("\n");
  }
  return `sha256:${hash.digest("hex")}`;
}