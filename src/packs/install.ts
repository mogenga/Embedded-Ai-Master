/**
 * 以事务方式安装一个 pack。
 *
 * 这个模块存在的目的就是一条规则：**`packs/` 里永远没有不完整、未校验的
 * pack。** 其余一切都是让这条规则在中断、磁盘耗尽、损坏与取消下成立的
 * 机制。
 *
 *   preflight ─ 磁盘检查、id 检查，不写任何东西
 *   lock ────── 根目录锁（在 paths.ts）
 *   download ── 流进 tmp/txn-<random>，边流边哈希
 *   verify ──── SHA-256；不匹配则删除归档并停止
 *   list ────── 写任何文件之前校验全部成员
 *   extract ─── 解压进 tmp/txn-<random>/payload
 *   inspect ─── 检查实际落盘的东西：符号链接、setuid、数量
 *   validate ── 运行工具链并匹配它的输出
 *   commit ──── 一次原子 rename 进 packs/<id>
 *
 * 任何一步失败都只留下事务目录。rename 之前的断电留下的也是它。rename
 * 期间的断电是安全的，因为 rename 是原子的：旧目录或新目录存在，绝无
 * 混合体。
 *
 * 所有外部效果都可注入，所以整个失败矩阵不需要网络或真实的 300 MB 下载
 * 就能测试。
 *
 * （迁移自 Prometheus/src/packs/install.ts，除产品名/环境变量名与 import
 * 后缀外逐字保留。）
 */

import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { downloadVerified, importArchive } from "./download.js";
import { extractArchive, listArchive, planExtraction, tarBinary, treeHash, walkStats } from "./archive.js";
import { parseManifest, writeManifest, type PackManifest } from "./manifest.js";
import { acquireRootLock, assertPackId, ensureRoot, isOwnedRoot, packDir, packsRoot, tmpDir } from "./paths.js";

export type PackPhase = "preflight" | "download" | "verify" | "extract" | "inspect" | "validate" | "commit";

export interface PackProgress {
  id: string;
  phase: PackPhase;
  received?: number;
  total?: number;
  message?: string;
}

export interface CatalogEntry {
  manifest: PackManifest;
  /** 归档解压后的额外磁盘占用，磁盘检查用。 */
  unpackedBytes?: number;
  /** 人类可读的体积，下载前给 UI 显示。 */
  downloadBytes?: number;
}

export interface InstallDeps {
  download?: typeof downloadVerified;
  importArchive?: typeof importArchive;
  list?: typeof listArchive;
  extract?: typeof extractArchive;
  walk?: typeof walkStats;
  hashTree?: typeof treeHash;
  runValidation?: typeof runValidation;
}

export interface InstallOptions {
  root?: string;
  signal?: AbortSignal;
  replace?: boolean;
  /** 跳过目录哈希检查；仅"从文件安装"使用。 */
  allowUnverified?: boolean;
  /**
   * 代替下载使用的本地归档，与 `manifest.sources` 的条目一一对应。
   * "从文件安装"用；字节仍对照 manifest 的校验和检查。
   */
  localFiles?: string[];
  onProgress?: (progress: PackProgress) => void;
  deps?: InstallDeps;
}

export class InstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InstallError";
  }
}

/** 持有 `path` 的卷的剩余字节，读不出时为 null。 */
export function freeBytes(path: string): number | null {
  try {
    const stats = statfsSync(path, { bigint: true });
    // `bavail` 是留给非特权用户的，某些 Windows 构建上为 0；那里退回
    // `bfree`。
    const blocks = stats.bavail > 0n ? stats.bavail : stats.bfree;
    return Number(blocks * stats.bsize);
  } catch {
    return null;
  }
}

/** 运行 pack 自己的验证命令并匹配它的输出。 */
export async function runValidation(
  payloadRoot: string,
  manifest: PackManifest,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ ok: boolean; output: string; reason?: string }> {
  const command = join(payloadRoot, manifest.validation.command);
  if (!existsSync(command)) {
    return { ok: false, output: "", reason: `${manifest.validation.command} was not produced by the archive` };
  }

  const env = { ...process.env };
  // 二进制可能需要 PATH 上的兄弟（arm-none-eabi-gcc 在自己旁边找 `as`
  // 和 `ld`）；只给它自己的目录就能保持这一工作，又不暴露宿主的工具链。
  //
  // `pathPrepend` 相对 pack 根（`payload/bin`），而 `payloadRoot` 已经是
  // payload，所以先把 payload 前缀剥回去再 join。
  const firstBin = manifest.env.pathPrepend[0] ?? manifest.payload.root;
  const binRelative = firstBin.startsWith(manifest.payload.root + "/")
    ? firstBin.slice(manifest.payload.root.length + 1)
    : firstBin;
  env.PATH = join(payloadRoot, binRelative) + (process.platform === "win32" ? ";" : ":") + (process.env.PATH ?? "");

  const result = await new Promise<{ code: number | null; out: string; err: string }>((resolvePromise) => {
    const child = spawn(command, manifest.validation.args, {
      cwd: payloadRoot,
      env,
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
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 30_000);
    const onAbort = () => child.kill();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const finish = (code: number | null) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolvePromise({ code, out, err });
    };
    child.on("error", (error) => {
      err += error.message;
      finish(null);
    });
    child.on("close", finish);
  });

  const text = `${result.out}${result.err}`.trim();
  if (!new RegExp(manifest.validation.expect, "m").test(text)) {
    return {
      ok: false,
      output: text,
      reason: `validation failed: expected output matching /${manifest.validation.expect}/, got ${JSON.stringify(text.slice(0, 200))}`,
    };
  }

  // 与探测器同一个完整性检查：应答 `-dumpmachine` 却没有 C 库的编译器是
  // Homebrew 陷阱，装上它比拒绝更糟。
  if (manifest.provides.includes("gcc-arm")) {
    const libc = await probeLibc(command, options);
    if (libc !== null && !/[\\/]/.test(libc)) {
      return { ok: false, output: text, reason: `this toolchain has no C library (${libc}); it cannot link` };
    }
  }

  return { ok: true, output: text };
}

function probeLibc(gcc: string, options: { signal?: AbortSignal; timeoutMs?: number }): Promise<string | null> {
  return new Promise((resolvePromise) => {
    const child = spawn(gcc, ["-print-file-name=libc.a"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 15_000);
    options.signal?.addEventListener("abort", () => child.kill(), { once: true });
    const finish = () => {
      clearTimeout(timer);
      resolvePromise(out.trim() || null);
    };
    child.on("error", () => {
      clearTimeout(timer);
      resolvePromise(null);
    });
    child.on("close", finish);
  });
}

/**
 * 安装一个 pack。
 *
 * `entry.manifest` 是将要写入的 manifest；它的 `installedAt` 在这里盖章，
 * 而不是信任来自目录的值。
 */
export async function installPack(entry: CatalogEntry, options: InstallOptions = {}): Promise<PackManifest> {
  const root = options.root ?? packsRoot();
  const id = entry.manifest.id;
  const phase = (name: PackPhase, extra: Omit<PackProgress, "id" | "phase"> = {}) =>
    options.onProgress?.({ id, phase: name, ...extra });

  const deps: Required<InstallDeps> = {
    download: options.deps?.download ?? downloadVerified,
    importArchive: options.deps?.importArchive ?? importArchive,
    list: options.deps?.list ?? listArchive,
    extract: options.deps?.extract ?? extractArchive,
    walk: options.deps?.walk ?? walkStats,
    hashTree: options.deps?.hashTree ?? treeHash,
    runValidation: options.deps?.runValidation ?? runValidation,
  };

  // ---- preflight：写任何东西之前先拒绝 -------------------------------
  phase("preflight");
  assertPackId(id);

  const manifest = parseManifest(entry.manifest, `catalog:${id}`);
  if (!options.allowUnverified && manifest.sources.some((source) => !source.sha256)) {
    throw new InstallError(`${id} has no checksum; refusing to install an unverified pack`);
  }

  const destination = packDir(root, id);
  if (existsSync(destination) && !options.replace) {
    throw new InstallError(`${id} is already installed at ${destination}. Remove it first, or install with replace.`);
  }

  const archiveBytes = manifest.sources.reduce((sum, source) => sum + source.bytes, 0);
  const installedBytes = entry.unpackedBytes ?? archiveBytes * 4;
  // 15% 余量：replace 期间暂存树与最终树短暂共存，且文件系统报告的可用
  // 空间比实际少。
  const needed = Math.ceil(archiveBytes + installedBytes * 1.15);
  const free = freeBytes(existsSync(root) ? root : process.cwd());
  if (free !== null && free < needed) {
    throw new InstallError(
      `not enough disk space in ${root}: need about ${formatBytes(needed)}, ${formatBytes(free)} free. ` +
        `Nothing was downloaded. Free some space, or point ${"HARNESS_TOOLCHAIN_HOME"} at another volume.`,
    );
  }

  ensureRoot(root);
  if (!isOwnedRoot(root)) {
    throw new InstallError(`${root} exists but is not an Embedded-Ai-Master toolchain directory; refusing to write into it`);
  }

  // 锁覆盖从下载第一个字节到 commit 的全部。刻意在无写入的检查之后才拿，
  // 这样坏 id 或满磁盘的拒绝不用等另一个窗口。
  const lock = acquireRootLock(root, { id });

  // ---- 事务 --------------------------------------------------------------
  // 在 `try` 内创建，这样这里的失败也能到达 `finally` 并释放锁。`txn` 在
  // 目录存在之前保持 null。
  let txn: string | null = null;

  try {
    txn = mkdtempSync(join(tmpDir(root), "txn-"));
    // pack 目录是 `pack.json` + `NOTICE.md` + `payload/`。解压落进
    // `payload`，让提交后的树直接就是最终形态——布局要等一次移动才正确
    // 的 pack 目录，就是能被观察到错误状态的 pack 目录。
    const payloadStage = join(txn, manifest.payload.root);
    // tar 的 `-C` 要求目标目录已经存在；不建的话它会 chdir 失败，而错误信息
    // 出现在下载和校验都成功之后 —— 那是最让人困惑的失败位置。
    mkdirSync(payloadStage, { recursive: true });
    // 下载每个 source；复合 pack（Zephyr）不止一个。
    const archives: { path: string; format: PackManifest["sources"][number]["archive"] }[] = [];
    if (options.localFiles && options.localFiles.length !== manifest.sources.length) {
      throw new InstallError(
        `this pack is built from ${manifest.sources.length} archive(s) but ${options.localFiles.length} file(s) were given`,
      );
    }
    for (const [index, source] of manifest.sources.entries()) {
      phase("download", { received: 0, ...(source.bytes ? { total: source.bytes } : {}) });
      const archivePath = join(txn, `archive-${index}.${source.archive.replace(".", "")}`);
      const onProgress = (progress: { received: number; total?: number }) =>
        phase("download", { received: progress.received, ...(progress.total ? { total: progress.total } : {}) });
      const local = options.localFiles?.[index];
      if (local) {
        await deps.importArchive(source, local, {
          destination: archivePath,
          ...(options.signal ? { signal: options.signal } : {}),
          onProgress,
        });
      } else {
        await deps.download(source, {
          destination: archivePath,
          ...(options.signal ? { signal: options.signal } : {}),
          onProgress,
        });
      }
      archives.push({ path: archivePath, format: source.archive });
    }

    phase("verify");
    // 每个归档在各自的下载期间已哈希；到达这里意味着校验和都匹配。

    phase("extract");
    for (const archive of archives) {
      const names = await deps.list(archive.path, options.signal ? { signal: options.signal } : {});
      const plan = planExtraction(names);
      if (plan.violations.length > 0) {
        throw new InstallError(
          `the archive contains unsafe paths and was not extracted: ${plan.violations.slice(0, 5).join("; ")}`,
        );
      }
      await deps.extract(archive.path, archive.format, payloadStage, plan, options.signal ? { signal: options.signal } : {});
    }

    phase("inspect");
    const walk = deps.walk(payloadStage);
    if (walk.unsafe.length > 0) {
      throw new InstallError(`the archive contains symlinks pointing outside the pack: ${walk.unsafe.slice(0, 5).join("; ")}`);
    }
    if (walk.privileged.length > 0) {
      throw new InstallError(`the archive contains setuid/setgid files: ${walk.privileged.slice(0, 5).join("; ")}`);
    }
    if (walk.files === 0) {
      throw new InstallError("the archive extracted no files; it may be empty or in an unsupported format");
    }

    phase("validate");
    const validation = await deps.runValidation(payloadStage, manifest, options.signal ? { signal: options.signal } : {});
    if (!validation.ok) {
      throw new InstallError(validation.reason ?? `validation failed: ${validation.output.slice(0, 300)}`);
    }

    // ---- commit -----------------------------------------------------------
    phase("commit");
    const finalManifest: PackManifest = {
      ...manifest,
      installedAt: new Date().toISOString(),
      payload: {
        ...manifest.payload,
        files: walk.files,
        bytes: walk.bytes,
        treeHash: await deps.hashTree(payloadStage),
      },
    };
    // manifest 在 rename 之前写入，所以没有观察者会看到没有记录的 pack
    // 目录。
    writeManifest(txn, finalManifest);
    writeNotice(txn, finalManifest);

    mkdirSync(join(root, "packs"), { recursive: true });
    if (existsSync(destination)) {
      // 先把旧 pack 挪开：下面的 rename 需要这个名字空着，且删旧的失败
      // 不得毁掉新的。
      const trash = join(root, "packs", `.trash-${id}-${Date.now()}`);
      await renameWithRetry(destination, trash);
      await renameWithRetry(txn, destination);
      try {
        rmSync(trash, { recursive: true, force: true });
      } catch {
        /* 稍后清理 */
      }
    } else {
      await renameWithRetry(txn, destination);
    }

    return finalManifest;
  } finally {
    // 无论发生了什么，事务目录都要清理。成功时它已被 rename 成
    // packs/<id>，`existsSync` 为 false，没有可删的东西——删除目标会毁掉
    // 刚装好的 pack。
    try {
      if (txn && existsSync(txn)) rmSync(txn, { recursive: true, force: true });
    } catch {
      /* 稍后清理 */
    }
    lock.release();
  }
}

/**
 * Windows 上刚解压出 1GB 的文件时，杀毒软件或索引器会立刻开始扫描，此时
 * 对目录改名会得到 EPERM。这不是真正的失败，等它扫完就好。
 *
 * 所以重试必须是异步的：同步的重试会把宿主的命令循环卡住最多一秒多，而这
 * 期间用户点什么都没有反应。
 */
async function renameWithRetry(from: string, to: string, attempts = 8): Promise<void> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      last = error;
      const code = (error as NodeJS.ErrnoException).code;
      // 只有瞬时的 Windows 争用值得等。目标在另一个卷上导致的权限错误
      // 不会好转。
      if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") break;
      if (attempt < attempts - 1) await sleep(120 * (attempt + 1));
    }
  }
  throw new InstallError(`could not move ${from} into place: ${last instanceof Error ? last.message : String(last)}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/** 许可与源码邀约，写在 payload 旁边。 */
function writeNotice(packDirectory: string, manifest: PackManifest): void {
  const lines = [
    `${manifest.name} ${manifest.version}`,
    "",
    `Licence: ${manifest.license.name}`,
    `Licence text: ${manifest.license.url}`,
    ...(manifest.license.sourceUrl ? ["", `Corresponding source: ${manifest.license.sourceUrl}`] : []),
    "",
    "These programs are installed as separate executables and are invoked as child",
    "processes. They are not linked into Embedded-Ai-Master.",
    "",
    `Installed: ${manifest.installedAt}`,
    `Source archive: ${manifest.sources.map((source) => source.url).join("\n")}`,
  ];
  try {
    writeFileSync(join(packDirectory, "NOTICE.md"), lines.join("\n") + "\n");
  } catch {
    /* NOTICE 是文档；写失败不得让安装失败 */
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/**
 * 从本地 `pack.json` 及其归档安装。
 *
 * 这是隔离网络路径：够不着厂商的机器得到同一个事务、同一套成员检查与
 * 同一个验证——唯一不同的是字节从哪来。校验和仍来自用户提供的文件，
 * 所以被改坏的拷贝会被抓住而不是被信任。
 *
 * `localFiles` 可选。`sources` 的归档可达的 `pack.json` 仍按常规方式安装；
 * 这个入口存在是为了让 UI 对"用户递来一个文件"只有一个命令。
 */
export async function installFromManifest(
  manifestPath: string,
  options: InstallOptions & { localFiles?: string[] } = {},
): Promise<PackManifest> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new InstallError(
      `could not read ${manifestPath}: ${error instanceof Error ? error.message : String(error)}. ` +
        `An offline install needs the pack.json that came with the archive.`,
    );
  }
  const manifest = parseManifest(raw, manifestPath);
  return installPack({ manifest }, { ...options, allowUnverified: options.allowUnverified ?? false });
}

/** 目录大小，不跟随符号链接。 */
export function directoryBytes(dir: string): number {
  let total = 0;
  const visit = (current: string) => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) visit(full);
        else total += stat.size;
      } catch {
        /* 已消失 */
      }
    }
  };
  visit(dir);
  return total;
}