/**
 * 装了什么、是否还能用、以及怎么摆脱它。
 *
 * 目录列表就是索引。没有会失步的 `packs.json`，这让它通常有的两种失败
 * 模式——手工删目录后的幽灵条目、写失败后的孤儿——在这里不可能发生。
 *
 * 卸载先改名再删除。Windows 上 pack 里的文件可能被占用（调试器握着
 * 二进制、杀毒软件在扫描），删一半失败的目录看起来像装着的。先改名让
 * pack 立刻且确定地从列表消失；字节随句柄释放而走。
 *
 * （迁移自 Prometheus/src/packs/registry.ts，除 import 后缀外逐字保留。）
 */

import { existsSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { treeHash, walkStats } from "./archive.js";
import { readManifest, readManifestStrict, type PackManifest } from "./manifest.js";
import { packsDir, packsRoot, tmpDir } from "./paths.js";
import { directoryBytes, freeBytes, runValidation, type PackProgress } from "./install.js";

export type PackStatus = "ok" | "broken";

export interface InstalledPack {
  manifest: PackManifest;
  dir: string;
  /** 磁盘总占用，含 payload。 */
  bytes: number;
  status: PackStatus;
  /** 损坏时的原因。 */
  problem?: string;
}

/**
 * 根目录里的每个 pack，只做最廉价的检查。
 *
 * manifest 缺失或不可解析的 pack 以 broken 状态连同目录名一起上报——绝不
 * 静默跳过，因为用户看不见的目录就是用户清理不了的目录。
 */
export function listPacks(root: string = packsRoot()): InstalledPack[] {
  const base = packsDir(root);
  let names: string[];
  try {
    names = readdirSync(base);
  } catch {
    return [];
  }

  const packs: InstalledPack[] = [];
  for (const name of names) {
    // `.trash-*` 目录是待删除项，不是 pack。
    if (name.startsWith(".")) continue;
    const dir = join(base, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }

    const { manifest, problem } = readManifestStrict(dir);
    if (!manifest) {
      packs.push({
        manifest: {
          schema: 1,
          id: name,
          name,
          version: "unknown",
          provider: "unknown",
          platform: process.platform,
          arch: process.arch,
          installedAt: "",
          sources: [],
          license: { name: "unknown", url: "", separateProcess: true },
          provides: [],
          executables: [],
          env: { pathPrepend: [], vars: {} },
          validation: { command: "", args: [], expect: "" },
          payload: { root: "payload", files: 0, bytes: 0, treeHash: "" },
        },
        dir,
        bytes: directoryBytes(dir),
        status: "broken",
        problem: problem ?? "pack.json is missing",
      });
      continue;
    }

    const payload = join(dir, manifest.payload.root);
    const payloadProblem = existsSync(payload) ? undefined : `payload directory ${manifest.payload.root} is missing`;
    packs.push({
      manifest,
      dir,
      bytes: directoryBytes(dir),
      status: payloadProblem ? "broken" : "ok",
      ...(payloadProblem ? { problem: payloadProblem } : {}),
    });
  }

  return packs.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
}

/**
 * 重新检查一个 pack。
 *
 * 浅检查是 UI 即时可负担的：可执行文件都在、工具链还应答。深检查对整个
 * payload 重新哈希——正确，但对多 GB 的工具链是数分钟的 I/O——所以只在
 * 显式要求时进行。
 */
export async function verifyPack(
  id: string,
  options: { root?: string; deep?: boolean; signal?: AbortSignal; onProgress?: (progress: PackProgress) => void } = {},
): Promise<{ ok: boolean; problems: string[] }> {
  const root = options.root ?? packsRoot();
  const dir = join(packsDir(root), id);
  const manifest = readManifest(dir);
  if (!manifest) return { ok: false, problems: [`${id}: pack.json is missing or unreadable`] };

  const problems: string[] = [];
  const payload = join(dir, manifest.payload.root);
  if (!existsSync(payload)) {
    return { ok: false, problems: [`${id}: payload directory is missing`] };
  }

  for (const executable of manifest.executables) {
    const full = join(payload, executable.path);
    if (!existsSync(full)) problems.push(`${executable.name} is missing (${executable.path})`);
  }

  const walk = walkStats(payload);
  if (manifest.payload.files > 0 && walk.files !== manifest.payload.files) {
    problems.push(`expected ${manifest.payload.files} files, found ${walk.files}`);
  }
  if (walk.unsafe.length > 0) problems.push(`${walk.unsafe.length} symlink(s) point outside the pack`);

  if (problems.length === 0) {
    const validation = await runValidation(payload, manifest, options.signal ? { signal: options.signal } : {});
    if (!validation.ok) problems.push(validation.reason ?? "the toolchain no longer runs");
  }

  if (options.deep && problems.length === 0 && manifest.payload.treeHash) {
    options.onProgress?.({ id, phase: "verify", message: "hashing payload" });
    const hash = await treeHash(payload);
    if (hash !== manifest.payload.treeHash) {
      problems.push(`payload hash changed (expected ${manifest.payload.treeHash.slice(0, 19)}…, got ${hash.slice(0, 19)}…)`);
    }
  }

  return { ok: problems.length === 0, problems };
}

/**
 * 移除一个 pack。
 *
 * 先改名挪出 `packs/`，让 pack 对其他一切而言立即不存在，然后删除。
 * 删除失败时——Windows 上文件被锁——trash 目录留给 `pruneTmp`。
 */
export async function removePack(id: string, options: { root?: string } = {}): Promise<void> {
  const root = options.root ?? packsRoot();
  const dir = join(packsDir(root), id);
  if (!existsSync(dir)) return;

  const trash = join(packsDir(root), `.trash-${id}-${Date.now()}`);
  renameSync(dir, trash);
  try {
    rmSync(trash, { recursive: true, force: true });
  } catch {
    /* 文件被锁：pack 已不可见；prune 会重试 */
  }
}

/**
 * 清理遗留：被放弃的事务目录与 trash 目录。
 *
 * 只删本应用创建的目录，且只在它们老到不可能还有安装在使用时。进行中的
 * 事务由它的年龄保护，因为一次真实的安装绝不需要一天。
 */
export async function pruneTmp(
  options: { root?: string; txnOlderThanMs?: number; trashOlderThanMs?: number } = {},
): Promise<{ removed: string[]; bytes: number }> {
  const root = options.root ?? packsRoot();
  const txnAge = options.txnOlderThanMs ?? 24 * 60 * 60 * 1000;
  const trashAge = options.trashOlderThanMs ?? 60 * 60 * 1000;
  const removed: string[] = [];
  let bytes = 0;

  const sweep = (dir: string, prefix: string, maxAge: number) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.startsWith(prefix)) continue;
      const full = join(dir, name);
      let age = 0;
      let size = 0;
      try {
        age = Date.now() - statSync(full).mtimeMs;
        size = directoryBytes(full);
      } catch {
        continue;
      }
      if (age < maxAge) continue;
      try {
        rmSync(full, { recursive: true, force: true });
        removed.push(full);
        bytes += size;
      } catch {
        /* 下次再试 */
      }
    }
  };

  sweep(tmpDir(root), "txn-", txnAge);
  sweep(packsDir(root), ".trash-", trashAge);
  return { removed, bytes };
}

export interface PacksSummary {
  root: string;
  packs: InstalledPack[];
  totalBytes: number;
  freeBytes: number | null;
}

/** 设置页展示的内容：空间去了哪，还剩多少。 */
export function packsSummary(root: string = packsRoot()): PacksSummary {
  const packs = listPacks(root);
  return {
    root,
    packs,
    totalBytes: packs.reduce((sum, pack) => sum + pack.bytes, 0),
    freeBytes: freeBytes(existsSync(root) ? root : process.cwd()),
  };
}

/** 一组 pack 贡献的 `bin` 目录，按工具链 kind 作键。 */
export function packBinDirs(root: string = packsRoot()): Map<string, { dir: string; packId: string }[]> {
  const map = new Map<string, { dir: string; packId: string }[]>();
  for (const pack of listPacks(root)) {
    if (pack.status !== "ok") continue;
    for (const entry of pack.manifest.env.pathPrepend) {
      // `pathPrepend` 相对的是 **pack** 目录，所以 `payload/bin` 指的是
      // `<pack>/payload/bin`——不是 `<pack>/payload/payload/bin`。
      const dir = join(pack.dir, entry);
      // 一个 `provides` 条目命名的可能是 pack 装的多个可执行文件之一，
      // 而不是目录自己的名字。probe-rs 同时带 `probe-rs.exe`、
      // `cargo-flash.exe` 和 `cargo-embed.exe`，声明的是
      // `provides: ["probe-rs"]`；但 esptool 的发布声明
      // `provides: ["esptool"]` 而探测规格还会找 `esptool.py`——两种情况
      // 按 `provides` 映射都是对的。可执行文件列表先查一遍，让以可执行
      // 文件名提供 kind 的 pack 也能被找到。
      const provided = new Set(pack.manifest.provides);
      for (const executable of pack.manifest.executables) {
        if (executable.toolchain) provided.add(executable.toolchain);
      }
      for (const kind of provided) {
        const list = map.get(kind) ?? [];
        if (!list.some((hit) => hit.dir === dir && hit.packId === pack.manifest.id)) list.push({ dir, packId: pack.manifest.id });
        map.set(kind, list);
      }
    }
  }
  return map;
}