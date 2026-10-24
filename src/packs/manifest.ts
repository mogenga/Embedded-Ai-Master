/**
 * 一个已安装 pack 的记录。
 *
 * `pack.json` 位于它所描述的目录内部。正是这一个决定让卸载既安全又完整：
 * 没有一个会失步的注册表，没有手工删目录后的幽灵条目，也没有写失败后
 * 的孤儿。删除目录即删除记录。
 *
 * 这里不存任何绝对路径。一个装在 `%LOCALAPPDATA%\Embedded-Ai-Master\
 * toolchains` 的 pack 之后被挪到 U 盘——或在 CI 里通过 `HARNESS_TOOLCHAIN_HOME`
 * 访问——解析结果完全相同。
 *
 * （迁移自 Prometheus/src/packs/manifest.ts，除注释中产品名与 import 后缀外
 * 逐字保留。）
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isInside } from "./paths.js";

export type ArchiveFormat = "zip" | "tar.xz" | "tar.gz";

export interface PackSource {
  /** 仅 https。 */
  url: string;
  archive: ArchiveFormat;
  /** 小写十六进制，64 字符。 */
  sha256: string;
  bytes: number;
  /** 重定向可以落到的主机。最终响应的主机必须在列表里。 */
  hosts: string[];
}

export interface PackLicense {
  name: string;
  url: string;
  /** 对应源码的获取地址（GPL 义务）。 */
  sourceUrl?: string;
  /** 这些工具以子进程方式调用，从不链接。 */
  separateProcess: true;
}

export interface PackExecutable {
  /** 裸名，例如 `arm-none-eabi-gcc`。 */
  name: string;
  /** 相对 payload 根的路径。 */
  path: string;
  toolchain?: string;
}

export interface PackValidation {
  /** 相对 payload 根。 */
  command: string;
  args: string[];
  /** 合并输出必须匹配的正则。 */
  expect: string;
}

export interface PackManifest {
  schema: 1;
  id: string;
  name: string;
  version: string;
  provider: string;
  platform: string;
  arch: string;
  installedAt: string;
  sources: PackSource[];
  license: PackLicense;
  /** 这个 pack 满足的工具链 kind 名，例如 `["gcc-arm"]`。 */
  provides: string[];
  executables: PackExecutable[];
  env: { pathPrepend: string[]; vars: Record<string, string> };
  validation: PackValidation;
  payload: { root: string; files: number; bytes: number; treeHash: string };
}

export class PackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackError";
  }
}

const HASH = /^[0-9a-f]{64}$/;
const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;

function str(value: unknown, field: string, source: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PackError(`${source}: "${field}" must be a non-empty string`);
  }
  return value;
}

function num(value: unknown, field: string, source: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new PackError(`${source}: "${field}" must be a non-negative number`);
  }
  return value;
}

/** 保持在根内的相对路径。 */
function safeRelative(value: unknown, field: string, source: string): string {
  const text = str(value, field, source);
  if (text.includes("\0")) throw new PackError(`${source}: "${field}" contains a NUL byte`);
  if (text.startsWith("/") || text.startsWith("\\")) {
    throw new PackError(`${source}: "${field}" must be relative, got "${text}"`);
  }
  if (/^[A-Za-z]:/.test(text)) throw new PackError(`${source}: "${field}" must not name a drive: "${text}"`);
  // 两种分隔符都查：Windows 上写的 manifest 可能用反斜杠，而 `..\..`
  // 即使不含正斜杠也是一次穿越。
  if (text.split(/[\\/]/).includes("..")) {
    throw new PackError(`${source}: "${field}" must not contain "..": "${text}"`);
  }
  return text.replace(/\\/g, "/");
}

/**
 * 校验一份解析后的 `pack.json`。
 *
 * 这些检查存在是因为这个文件从磁盘读出后没有任何对照物：如果它说一个
 * 可执行文件在 `..\..\evil.exe`，那就是它会被运行的位置。读写两侧都
 * 重新校验，因为 pack 目录可能被手工编辑过。
 */
export function parseManifest(raw: unknown, source = "pack.json"): PackManifest {
  if (!raw || typeof raw !== "object") throw new PackError(`${source}: expected an object`);
  const value = raw as Record<string, unknown>;

  if (value.schema !== 1) {
    // 更高的 schema 是更新版本的 Embedded-Ai-Master 做的 pack。照实说，
    // 而不是去猜它的含义——并且永远不删除它。
    if (typeof value.schema === "number" && value.schema > 1) {
      throw new PackError(
        `${source}: this pack uses schema ${value.schema}, which this version of Embedded-Ai-Master does not understand. ` +
          `Update Embedded-Ai-Master rather than removing the pack.`,
      );
    }
    throw new PackError(`${source}: unsupported schema ${String(value.schema)}`);
  }

  const id = str(value.id, "id", source);
  if (!ID.test(id)) throw new PackError(`${source}: invalid id "${id}"`);

  const sourcesRaw = value.sources;
  if (!Array.isArray(sourcesRaw) || sourcesRaw.length === 0) {
    throw new PackError(`${source}: "sources" must be a non-empty array`);
  }
  const sources: PackSource[] = sourcesRaw.map((entry, index) => {
    const item = (entry ?? {}) as Record<string, unknown>;
    const url = str(item.url, `sources[${index}].url`, source);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new PackError(`${source}: sources[${index}].url is not a URL: "${url}"`);
    }
    if (parsed.protocol !== "https:") {
      throw new PackError(`${source}: sources[${index}].url must be https, got ${parsed.protocol}`);
    }
    const sha256 = str(item.sha256, `sources[${index}].sha256`, source).toLowerCase();
    if (!HASH.test(sha256)) {
      throw new PackError(`${source}: sources[${index}].sha256 must be 64 lowercase hex characters`);
    }
    const archive = str(item.archive, `sources[${index}].archive`, source);
    if (!["zip", "tar.xz", "tar.gz"].includes(archive)) {
      throw new PackError(`${source}: sources[${index}].archive must be zip, tar.xz or tar.gz`);
    }
    const hosts = Array.isArray(item.hosts) ? item.hosts.map((host) => String(host)) : [parsed.host];
    if (hosts.length === 0) throw new PackError(`${source}: sources[${index}].hosts must not be empty`);
    return {
      url,
      archive: archive as ArchiveFormat,
      sha256,
      bytes: num(item.bytes ?? 0, `sources[${index}].bytes`, source),
      hosts,
    };
  });

  const licenseRaw = (value.license ?? {}) as Record<string, unknown>;
  const license: PackLicense = {
    name: str(licenseRaw.name, "license.name", source),
    url: str(licenseRaw.url, "license.url", source),
    ...(typeof licenseRaw.sourceUrl === "string" ? { sourceUrl: licenseRaw.sourceUrl } : {}),
    separateProcess: true,
  };

  const provides = Array.isArray(value.provides) ? value.provides.map((entry) => String(entry)) : [];
  if (provides.length === 0) throw new PackError(`${source}: "provides" must list at least one toolchain kind`);

  const executablesRaw = value.executables;
  if (!Array.isArray(executablesRaw) || executablesRaw.length === 0) {
    throw new PackError(`${source}: "executables" must be a non-empty array`);
  }
  const executables: PackExecutable[] = executablesRaw.map((entry, index) => {
    const item = (entry ?? {}) as Record<string, unknown>;
    return {
      name: str(item.name, `executables[${index}].name`, source),
      path: safeRelative(item.path, `executables[${index}].path`, source),
      ...(typeof item.toolchain === "string" ? { toolchain: item.toolchain } : {}),
    };
  });

  const envRaw = (value.env ?? {}) as Record<string, unknown>;
  const env = {
    pathPrepend: Array.isArray(envRaw.pathPrepend)
      ? envRaw.pathPrepend.map((entry, index) => safeRelative(entry, `env.pathPrepend[${index}]`, source))
      : [],
    vars: typeof envRaw.vars === "object" && envRaw.vars ? Object.fromEntries(Object.entries(envRaw.vars).map(([key, entry]) => [key, String(entry)])) : {},
  };

  const validationRaw = (value.validation ?? {}) as Record<string, unknown>;
  const validation: PackValidation = {
    command: safeRelative(validationRaw.command, "validation.command", source),
    args: Array.isArray(validationRaw.args) ? validationRaw.args.map((entry) => String(entry)) : [],
    expect: str(validationRaw.expect, "validation.expect", source),
  };
  try {
    new RegExp(validation.expect);
  } catch {
    throw new PackError(`${source}: validation.expect is not a valid regular expression`);
  }

  const payloadRaw = (value.payload ?? {}) as Record<string, unknown>;
  const payload = {
    root: safeRelative(payloadRaw.root ?? "payload", "payload.root", source),
    files: num(payloadRaw.files ?? 0, "payload.files", source),
    bytes: num(payloadRaw.bytes ?? 0, "payload.bytes", source),
    treeHash: typeof payloadRaw.treeHash === "string" ? payloadRaw.treeHash : "",
  };

  return {
    schema: 1,
    id,
    name: str(value.name, "name", source),
    version: str(value.version, "version", source),
    provider: str(value.provider ?? "unknown", "provider", source),
    platform: str(value.platform ?? process.platform, "platform", source),
    arch: str(value.arch ?? process.arch, "arch", source),
    installedAt: typeof value.installedAt === "string" ? value.installedAt : new Date().toISOString(),
    sources,
    license,
    provides,
    executables,
    env,
    validation,
    payload,
  };
}

export function manifestPath(packDirectory: string): string {
  return join(packDirectory, "pack.json");
}

/** 读 pack 的 manifest；缺失或不可读时返回 null。 */
export function readManifest(packDirectory: string): PackManifest | null {
  try {
    return parseManifest(JSON.parse(readFileSync(manifestPath(packDirectory), "utf8")), manifestPath(packDirectory));
  } catch {
    return null;
  }
}

/** 同 `readManifest`，但报告失败原因。 */
export function readManifestStrict(packDirectory: string): { manifest?: PackManifest; problem?: string } {
  try {
    const text = readFileSync(manifestPath(packDirectory), "utf8");
    return { manifest: parseManifest(JSON.parse(text), manifestPath(packDirectory)) };
  } catch (error) {
    return { problem: error instanceof Error ? error.message : String(error) };
  }
}

/** 原子写入：读者永远看不到写了一半的 manifest。 */
export function writeManifest(packDirectory: string, manifest: PackManifest): void {
  const target = manifestPath(packDirectory);
  const temp = `${target}.tmp-${process.pid}`;
  writeFileSync(temp, JSON.stringify(manifest, null, 2) + "\n");
  renameSync(temp, target);
}

/**
 * 解析 pack 内的相对路径，拒绝任何逃出 pack 的写法。
 *
 * 这是每一条来自 manifest 的路径的最后一道防线。
 */
export function resolvePayloadPath(packDirectory: string, manifest: PackManifest, relative: string): string {
  const base = join(packDirectory, manifest.payload.root);
  const target = join(base, relative);
  if (!isInside(base, target)) {
    throw new PackError(`"${relative}" resolves outside the pack payload (${target})`);
  }
  return target;
}