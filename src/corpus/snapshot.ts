import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

/**
 * 语料快照目录与 `current` 指针——OTA 的落地层（契约见 `docs/corpus-ota.md` §3/§6）。
 *
 * 这一层只做三件事：把版本目录建出来、把 `current` 指过去、把过期快照清掉。
 * 它不校验签名、不下载、不决定「要不要更新」——那些属于 manifest 与 OTA 客户端。
 * 分开的原因：切换指针是**会影响正在运行的会话**的动作，必须是一个能被单独
 * 测试、单独审查的小动作，而不是混在一大段下载逻辑里。
 *
 * 两条贯穿全文件的硬规则：
 * 1. 删除只发生在 `snapshots/v<数字>` 上，且删除前必须重新校验路径。
 * 2. `inbox/`（用户本地沉淀）、`state.json`、`.lock` 在任何情况下都不动——
 *    用户的笔记不能因为一次清理快照就没了。
 */

/** 契约 §3 的目录布局。路径一律内部按 POSIX 风格拼接，出口由 path 模块转换。 */
export interface KbLayout {
  /** `$HARNESS_HOME/kb` */
  kbRoot: string;
  /** `$HARNESS_HOME/kb/snapshots` */
  snapshotsDir: string;
  /** `$HARNESS_HOME/kb/current`，junction 指向某个快照 */
  currentLink: string;
  /** `$HARNESS_HOME/kb/inbox`，永不进快照、永不被覆盖 */
  inboxDir: string;
  /** `$HARNESS_HOME/kb/state.json` */
  stateFile: string;
}

/** 上次检查时间与结果。字段全部可选，因为首次启动时什么都没发生过。 */
export interface CorpusState {
  lastCheckedAt?: string;
  lastResult: "never" | "up_to_date" | "update_available" | "check_failed" | "verify_failed";
  corpusVersion?: number;
  /**
   * 发现新版时的文件总数。
   *
   * 存它是为了让 `readCorpusStatus` 能把 `update_available` 完整还原——不存的话
   * 只能拿 `fileCount: 0` 顶上，那是撒谎（R3）。只在 `lastResult: "update_available"`
   * 时有意义。
   */
  fileCount?: number;
  detail?: string;
}

/** 同一时刻只允许一个实例更新语料；抢不到锁时抛这个，而不是排队或静默跳过。 */
export class CorpusLockError extends Error {
  readonly code = "corpus_locked";
  readonly lockPath: string;

  constructor(lockPath: string) {
    super(`另一个实例正在更新知识库（锁文件：${lockPath}）`);
    this.name = "CorpusLockError";
    this.lockPath = lockPath;
  }
}

/**
 * `v<数字>`，且必须是规范写法：`v01` 会被当作无法识别而忽略。
 *
 * 为什么不容忍前导零：清理时要靠「版本号 → 目录名」反推路径，
 * 若 `v01` 被解析成 1，反推出的 `v1` 就不是刚列出来的那个目录，
 * 校验必然对不上。与其在删除时才发现，不如在识别时就不认。
 */
const SNAPSHOT_DIR_NAME = /^v(0|[1-9]\d*)$/;

const LAST_RESULTS: ReadonlySet<string> = new Set([
  "never",
  "up_to_date",
  "update_available",
  "check_failed",
  "verify_failed",
]);

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** Windows 上路径大小写不敏感，比较目录归属前先折叠。 */
function samePath(left: string, right: string): boolean {
  if (process.platform === "win32") return left.toLowerCase() === right.toLowerCase();
  return left === right;
}

function snapshotDirName(version: number): string {
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new Error(`快照版本号必须是非负整数，实际收到：${String(version)}`);
  }
  return `v${version}`;
}

/**
 * 纯函数：只算路径，不碰磁盘。
 *
 * 空 `HARNESS_HOME` 直接拒绝：`path.join("", "kb")` 是相对路径，落到进程当前目录
 * 就会把快照写进仓库里（D-170 的同类事故：测试写穿了用户的真实配置）。
 */
export function getKbLayout(harnessHome: string): KbLayout {
  if (typeof harnessHome !== "string" || harnessHome.trim() === "") {
    throw new Error("HARNESS_HOME 不能为空：知识库布局需要显式的主目录，不能落到进程当前目录");
  }
  const kbRoot = path.resolve(harnessHome, "kb");
  return {
    kbRoot,
    snapshotsDir: path.join(kbRoot, "snapshots"),
    currentLink: path.join(kbRoot, "current"),
    inboxDir: path.join(kbRoot, "inbox"),
    stateFile: path.join(kbRoot, "state.json"),
  };
}

/**
 * 建 `snapshots/v<N>` 并返回路径；已存在时原样返回既有目录，不删内容。
 *
 * 顺带建出 `inbox/`：首次启动只有这一次物化调用，`inbox/` 必须在这之后就可用，
 * 否则 `kb_propose` 第一次写本地沉淀时会找不到目录。这里只建目录，不碰内容。
 */
export async function ensureSnapshotDir(layout: KbLayout, version: number): Promise<string> {
  const target = path.join(layout.snapshotsDir, snapshotDirName(version));
  await mkdir(layout.inboxDir, { recursive: true });
  try {
    await mkdir(target, { recursive: true });
  } catch (error) {
    throw new Error(`快照目录创建失败：${target}（${messageOf(error)}）`, { cause: error });
  }
  return target;
}

/**
 * 扫描 `snapshots/` 下形如 `v<数字>` 的目录，升序返回。
 *
 * 目录不存在返回空数组——首次启动就是这种状态，不是错误。
 * 无法识别的名字（`beta`、`v1x`、`v01`）与文件一律忽略：它们不是我们放的快照，
 * 清理逻辑也就不该对它们负责。
 */
export async function listSnapshotVersions(layout: KbLayout): Promise<number[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(layout.snapshotsDir, { withFileTypes: true });
  } catch (error) {
    const code = codeOf(error);
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    // 读不动（权限/IO）不是「没有快照」，静默回空会让人以为知识库是空的（R3）。
    throw new Error(`快照目录无法读取：${layout.snapshotsDir}（${messageOf(error)}）`, { cause: error });
  }
  const versions: number[] = [];
  for (const entry of entries) {
    // isDirectory() 基于 lstat 语义：指向别处的链接不算快照目录。
    if (!entry.isDirectory()) continue;
    const match = SNAPSHOT_DIR_NAME.exec(entry.name);
    if (match === null) continue;
    versions.push(Number(match[1]));
  }
  versions.sort((left, right) => left - right);
  return versions;
}

/**
 * 删掉一个链接本身（不递归、不跟随）。
 *
 * Windows 的 junction 用 `unlink` 会报 EPERM，只能用 `rmdir`；POSIX 的符号链接
 * 正好相反，`rmdir` 报 ENOTDIR。两者都不跟随目标——这一点已被实测确认
 * （对 junction 做 rmdir/递归 rm 只移除链接，目标目录内容仍在）。
 */
async function removeLink(linkPath: string): Promise<void> {
  try {
    await unlink(linkPath);
    return;
  } catch (error) {
    const code = codeOf(error);
    if (code !== "EPERM" && code !== "EACCES" && code !== "EISDIR" && code !== "ENOTDIR") throw error;
  }
  await rmdir(linkPath);
}

/**
 * Windows 上 `rename` 不能覆盖已存在的目录（junction 表现为目录），
 * Node 文档与实测都确认这一点：报 EPERM。
 *
 * 只有「目标确实是一个已有的链接」时才走两段式替换，其他情况把原错误抛出去——
 * 把真正的权限问题当成「平台差异」吞掉，会变成最难查的一类故障。
 */
async function shouldRepairOnWindows(error: unknown, currentLink: string): Promise<boolean> {
  if (process.platform !== "win32") return false;
  const code = codeOf(error);
  if (code !== "EPERM" && code !== "EACCES" && code !== "EEXIST" && code !== "EISDIR" && code !== "ENOTEMPTY") {
    return false;
  }
  try {
    return (await lstat(currentLink)).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * 原子地把 `current` 指向 `snapshots/v<N>`，返回解析后的真实路径供调用方核对。
 *
 * 顺序的意义：**先建新链接，再替换旧的**。绝不能「先删再建」——两个 syscall 之间
 * 正在跑的服务会找不到 KB。文件内容一个字节都不动，切换的只是指针。
 *
 * 平台差异（实测 + Node 文档）：POSIX 上 `rename(tmp, current)` 可以直接覆盖旧链接，
 * 一步完成；Windows 上 `rename` 不允许覆盖已存在的目录，只能退化成「把旧链接挪开
 * → 新链接就位 → 删掉挪开的链接」。退化的中间窗口同样是两个 syscall 之间，
 * 比「先删再建」短，且旧链接始终以可回滚的形式存在（失败时会被挪回去）。
 */
export async function setCurrent(layout: KbLayout, version: number): Promise<string> {
  const target = path.join(layout.snapshotsDir, snapshotDirName(version));

  // 目标必须是已经存在的目录：一个指不到东西的 `current` 比没有 `current` 更糟，
  // 它会让 KbService 的 realpathSync 在启动时抛错，而不是回落到「没有知识库」。
  let info;
  try {
    info = await stat(target);
  } catch (error) {
    throw new Error(`快照目录不存在，拒绝切换 current：${target}（${messageOf(error)}）`, { cause: error });
  }
  if (!info.isDirectory()) {
    throw new Error(`快照路径不是目录，拒绝切换 current：${target}`);
  }

  await mkdir(layout.kbRoot, { recursive: true });
  const tmpLink = `${layout.currentLink}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
  await symlink(path.resolve(target), tmpLink, "junction");

  let swapped = false;
  try {
    try {
      await rename(tmpLink, layout.currentLink);
    } catch (error) {
      if (!(await shouldRepairOnWindows(error, layout.currentLink))) throw error;
      const parked = `${layout.currentLink}.old-${process.pid}-${randomUUID().slice(0, 8)}`;
      await rename(layout.currentLink, parked);
      try {
        await rename(tmpLink, layout.currentLink);
      } catch (inner) {
        // 回滚：旧指针必须回到原位，否则这里会变成一个「知识库突然消失」的事故。
        await rename(parked, layout.currentLink).catch(() => undefined);
        throw new Error(
          `切换 current 失败，已尝试恢复原指针：${layout.currentLink}（${messageOf(inner)}；旧链接留在 ${parked}）`,
          { cause: inner },
        );
      }
      // 只删链接本身；目标快照内容不受影响。
      await removeLink(parked).catch(() => undefined);
    }
    swapped = true;
  } finally {
    if (!swapped) await removeLink(tmpLink).catch(() => undefined);
  }

  try {
    return await realpath(layout.currentLink);
  } catch (error) {
    throw new Error(`current 已切换但无法解析真实路径：${layout.currentLink}（${messageOf(error)}）`, {
      cause: error,
    });
  }
}

/**
 * 读 `current` 指向的版本；没有指针、指针坏了、指向的不是快照目录，一律返回 null。
 *
 * 不抛错是刻意的：这个函数最常见的调用场景是「显示当前版本」和「清理时保护当前版本」，
 * 两者都不该因为一个坏指针而让整个知识库不可用。
 */
export async function readCurrentVersion(layout: KbLayout): Promise<number | null> {
  let canonical: string;
  try {
    canonical = await realpath(layout.currentLink);
  } catch {
    // 不存在、坏链（目标已删）、根本不是链接（EINVAL）：都按「没有指针」处理。
    return null;
  }
  let snapshotsReal: string;
  try {
    snapshotsReal = await realpath(layout.snapshotsDir);
  } catch {
    return null;
  }
  // 必须真的落在 snapshots/ 下：一个指向别处的 `current` 不该被当成合法版本。
  if (!samePath(path.dirname(canonical), snapshotsReal)) return null;
  const match = SNAPSHOT_DIR_NAME.exec(path.basename(canonical));
  if (match === null) return null;
  return Number(match[1]);
}

/**
 * 删除前的最后一道校验：路径必须**正好**是 `snapshots/` 的直接子目录，且名字是规范的 `v<数字>`。
 *
 * 这不是形式主义——这个路径下面紧跟着一个递归删除。任何一次拼接失误
 * （版本号带分隔符、快照目录被替换成链接）都会变成删掉别的东西。
 */
function assertSnapshotDirPath(layout: KbLayout, version: number): string {
  const name = snapshotDirName(version);
  const snapshotsAbs = path.resolve(layout.snapshotsDir);
  const targetAbs = path.resolve(snapshotsAbs, name);
  if (path.dirname(targetAbs) !== snapshotsAbs) {
    throw new Error(`拒绝删除：路径不在快照目录下 ${targetAbs}`);
  }
  if (path.basename(targetAbs) !== name) {
    throw new Error(`拒绝删除：目录名不是快照版本格式 ${targetAbs}`);
  }
  return targetAbs;
}

/**
 * 只保留最新的 `keep` 个快照，删除更早的；返回被删的版本号（升序）。
 *
 * **当前指针指向的版本永远保留**，无论它多旧：删掉它等于让 `current` 变成坏链，
 * 正在跑的服务与下一次启动都会找不到知识库。因此实际保留数可能是 `keep + 1`。
 *
 * 只动 `snapshots/` 下的版本目录。`inbox/`、`state.json`、`.lock` 以及其他任何
 * 无法识别的条目都不在删除范围内。
 */
export async function pruneSnapshots(layout: KbLayout, keep: number): Promise<number[]> {
  if (!Number.isSafeInteger(keep) || keep < 1) {
    throw new Error(`保留数量必须是不小于 1 的整数，实际收到：${String(keep)}`);
  }
  const versions = await listSnapshotVersions(layout);
  const currentVersion = await readCurrentVersion(layout);

  const keepSet = new Set<number>(versions.slice(-keep));
  if (currentVersion !== null) keepSet.add(currentVersion);

  const removed: number[] = [];
  for (const version of versions) {
    if (keepSet.has(version)) continue;
    const target = assertSnapshotDirPath(layout, version);
    let info;
    try {
      info = await lstat(target);
    } catch (error) {
      const code = codeOf(error);
      // 列目录与删除之间被别的实例清掉了：如实视为已不存在，不算本次删除。
      if (code === "ENOENT") continue;
      throw new Error(`快照无法访问：${target}（${messageOf(error)}）`, { cause: error });
    }
    // 只删真正的目录。若有人把快照换成了链接，先停下来让人看一眼，
    // 而不是顺着链接删到别处去。
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`拒绝删除：${target} 不是普通目录`);
    }
    try {
      await rm(target, { recursive: true, force: false });
    } catch (error) {
      throw new Error(`快照删除失败：${target}（${messageOf(error)}）`, { cause: error });
    }
    removed.push(version);
  }
  return removed;
}

function parseState(text: string): CorpusState {
  let value: unknown;
  try {
    // 记事本存过的 JSON 常带 BOM，JSON.parse 会直接拒绝。
    value = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    return { lastResult: "never" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { lastResult: "never" };
  const record = value as Record<string, unknown>;
  const result = record.lastResult;
  // 认不出的结果比「没检查过」更不可信：宁可说 never，也不猜一个状态。
  if (typeof result !== "string" || !LAST_RESULTS.has(result)) return { lastResult: "never" };

  const state: CorpusState = { lastResult: result as CorpusState["lastResult"] };
  if (typeof record.lastCheckedAt === "string") state.lastCheckedAt = record.lastCheckedAt;
  if (typeof record.corpusVersion === "number" && Number.isSafeInteger(record.corpusVersion)) {
    state.corpusVersion = record.corpusVersion;
  }
  // 非负整数才算数：0 个文件也是一种真实状态（空清单），负数或小数是坏数据。
  if (
    typeof record.fileCount === "number"
    && Number.isSafeInteger(record.fileCount)
    && record.fileCount >= 0
  ) {
    state.fileCount = record.fileCount;
  }
  if (typeof record.detail === "string") state.detail = record.detail;
  return state;
}

/**
 * 读状态文件；文件缺失或损坏时返回 `{ lastResult: "never" }`，不抛错。
 *
 * 状态文件只是「上次检查的备注」，它坏了不该让知识库不可用——语料本身还在
 * `snapshots/` 里。真正需要报错的是语料读取（R3 管的是「不能把失败说成成功」，
 * 不是「任何文件坏了都要中断」）。
 */
export async function readState(layout: KbLayout): Promise<CorpusState> {
  let text: string;
  try {
    text = await readFile(layout.stateFile, "utf8");
  } catch {
    return { lastResult: "never" };
  }
  return parseState(text);
}

/** 原子写状态文件：临时文件 + fsync + rename，断电后不会留下半截 JSON。 */
export async function writeState(layout: KbLayout, state: CorpusState): Promise<void> {
  const text = `${JSON.stringify(state, null, 2)}\n`;
  const tmpPath = `${layout.stateFile}.${randomUUID()}.tmp`;
  await mkdir(layout.kbRoot, { recursive: true });
  try {
    await writeFile(tmpPath, text, { encoding: "utf8", flag: "wx" });
    const handle = await open(tmpPath, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmpPath, layout.stateFile);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw new Error(`状态文件写入失败：${layout.stateFile}（${messageOf(error)}）`, { cause: error });
  }
}

/**
 * 单实例锁：持有 `kb/.lock` 期间执行 `fn`，无论成败都释放。
 *
 * 为什么需要：两个实例同时下载/切换快照，`snapshots/v3` 会写进两份互不相同的内容，
 * 而签名只覆盖文件清单、不覆盖「谁先写完」。锁必须在 `fn` 之前拿到，
 * 抢不到就抛 `CorpusLockError`，让调用方如实告诉用户「另一个实例正在更新」。
 *
 * 已知限制：持有者崩溃会留下陈旧锁，此后更新一律被拒（诊断只能靠错误里的锁路径）。
 * 当前不做按 PID 回收：更新是用户显式触发的短动作，误判「对方已死」而抢锁的代价
 * 比手工删锁大。
 */
export async function withUpdateLock<T>(layout: KbLayout, fn: () => Promise<T>): Promise<T> {
  const lockPath = path.join(layout.kbRoot, ".lock");
  await mkdir(layout.kbRoot, { recursive: true });

  let handle;
  try {
    handle = await open(lockPath, "wx");
  } catch (error) {
    if (codeOf(error) === "EEXIST") throw new CorpusLockError(lockPath);
    throw new Error(`更新锁创建失败：${lockPath}（${messageOf(error)}）`, { cause: error });
  }

  try {
    await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, "utf8");
    return await fn();
  } finally {
    // 先关句柄再删文件：Windows 上打开中的文件删不掉。
    await handle.close().catch(() => undefined);
    await rm(lockPath, { force: true }).catch(() => undefined);
  }
}
