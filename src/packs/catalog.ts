/**
 * 可以从应用里安装的工具链。
 *
 * 每一条都是一个**钉死的**版本：确切 URL、确切字节数、确切 SHA-256。没有
 * "最新版"这一说 —— 装到用户机器上的编译器必须是别人测过的那一个。
 *
 * 关于哈希：`sha256` 为空的条目不会出现在可安装列表里（`catalogFor` 会过滤
 * 掉），因为安装器拒绝无校验的包。发布前必须把哈希填上；留空的条目是明确
 * 的待办，而不是可以悄悄下载的缺省。
 *
 * 许可：这些工具都是独立的可执行文件，以子进程方式调用，不链接进
 * Embedded-Ai-Master。GPL 的义务（提供对应源码）通过 `license.sourceUrl`
 * 记录，安装时写进 pack 的 NOTICE.md。
 *
 * （迁移自 Prometheus/src/packs/catalog.ts：URL/SHA-256/字节数全部为 A 侧
 * 实测原值，**不重算**——哈希是钉死的，重算只会引入错误。A 侧全部 9 条
 * Windows x64 条目均保留；B 首期实际消费的 toolchain kind 是
 * gcc-arm / openocd / cmake / ninja（keil server 与 Tools 页探测），
 * probe-rs / pyOCD / esptool 条目按 todolist T5 本可裁剪、此处选择保留
 * 原值——条目本身不增加任何运行时成本，待 probe/cubeide 路线接入消费
 * 时无需重新实测哈希。）
 */

import type { ArchiveFormat, PackManifest } from "./manifest.js";

export interface CatalogSource {
  url: string;
  archive: ArchiveFormat;
  sha256: string;
  bytes: number;
  hosts: string[];
}

export interface CatalogEntryDef {
  id: string;
  name: string;
  version: string;
  provider: string;
  platform: NodeJS.Platform | "any";
  arch: "x64" | "arm64" | "any";
  /** 下载体积，给 UI 在下载前显示。 */
  downloadBytes: number;
  /** 解压后的体积，给磁盘检查用。 */
  unpackedBytes: number;
  sources: CatalogSource[];
  license: PackManifest["license"];
  provides: string[];
  executables: PackManifest["executables"];
  env: PackManifest["env"];
  validation: PackManifest["validation"];
  /** 同一工具链的多个版本时，数值大的优先。 */
  priority?: number;
}

const SRC = "https://gitlab.arm.com/api/v4/projects/tooling%2Fgnu-toolchains-for-arm/packages/generic/gnu-toolchain";

/**
 * GitHub release downloads redirect to `release-assets.githubusercontent.com`
 * (and older assets to `objects.githubusercontent.com`). Both are listed
 * because the host check runs against the URL that finally answered.
 */
const GITHUB_HOSTS = [
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
];

const XPACK_RELEASES = "https://github.com/xpack-dev-tools";

/**
 * Arm GNU Toolchain 15.3.rel2。
 *
 * URL 会被重定向到 AWS S3，所以两个主力域都列进 hosts —— 下载器只信任
 * 白名单里的主机，这既是安全边界，也是重定向必须被允许的原因。
 */
const ARM_HOSTS = ["gitlab.arm.com", "gitlabcommunity-eu1-eu-west-1-prod-packages.s3.eu-west-1.amazonaws.com"];

const ARM_LICENSE: PackManifest["license"] = {
  name: "GPL-3.0-or-later with GCC Runtime Library Exception; newlib BSD",
  url: `${SRC}/15.3.rel2/EULA.txt`,
  sourceUrl: `${SRC}/15.3.rel2/arm-gnu-toolchain-src-snapshot-15.3.rel2.tar.xz`,
  separateProcess: true,
};

export const CATALOG: CatalogEntryDef[] = [
  {
    id: "arm-gnu-15.3.rel2-win32-x64",
    name: "Arm GNU Toolchain",
    version: "15.3.rel2",
    provider: "arm",
    platform: "win32",
    arch: "x64",
    // 实测 Content-Length：289240072 字节
    downloadBytes: 289_240_072,
    unpackedBytes: 1_077_000_000,
    sources: [
      {
        url: `${SRC}/15.3.rel2/arm-gnu-toolchain-15.3.rel2-mingw-w64-x86_64-arm-none-eabi.zip`,
        archive: "zip",
        // 实测：2026-10-18 下载 289,240,072 字节后计算得到。
        sha256: "0daff4141d4f62ad1e9794ca8bd430ef730f07fd78f6d71d2ffdffc21db8cb9e",
        bytes: 289_240_072,
        hosts: ARM_HOSTS,
      },
    ],
    license: ARM_LICENSE,
    provides: ["gcc-arm"],
    executables: [
      { name: "arm-none-eabi-gcc", path: "bin/arm-none-eabi-gcc.exe", toolchain: "gcc-arm" },
      { name: "arm-none-eabi-gdb", path: "bin/arm-none-eabi-gdb.exe", toolchain: "gcc-arm" },
      { name: "arm-none-eabi-size", path: "bin/arm-none-eabi-size.exe", toolchain: "gcc-arm" },
    ],
    env: { pathPrepend: ["payload/bin"], vars: {} },
    validation: { command: "bin/arm-none-eabi-gcc.exe", args: ["-dumpmachine"], expect: "^arm-none-eabi$" },
    priority: 10,
  },
  {
    // xPack's Arm GCC. Listed alongside the Arm-built one as a second choice:
    // some projects pin xPack specifically, and its layout differs.
    id: "xpack-arm-none-eabi-gcc-14.2.1-1.1-win32-x64",
    name: "Arm GNU Toolchain (xPack)",
    version: "14.2.1-1.1",
    provider: "xpack",
    platform: "win32",
    arch: "x64",
    downloadBytes: 323_368_593,
    unpackedBytes: 1_200_000_000,
    sources: [
      {
        url: `${XPACK_RELEASES}/arm-none-eabi-gcc-xpack/releases/download/v14.2.1-1.1/xpack-arm-none-eabi-gcc-14.2.1-1.1-win32-x64.zip`,
        archive: "zip",
        // 实测：2026-10-19 下载 323,368,593 字节后计算得到。
        sha256: "0b2d496b383ba578182eb57b3f7d35ff510e36eda56257883b902fa07c3bba55",
        bytes: 323_368_593,
        hosts: GITHUB_HOSTS,
      },
    ],
    license: {
      name: "GPL-3.0-or-later with GCC Runtime Library Exception; newlib BSD",
      url: "https://github.com/xpack-dev-tools/arm-none-eabi-gcc-xpack/blob/v14.2.1-1.1/LICENSE",
      sourceUrl: "https://github.com/xpack-dev-tools/arm-none-eabi-gcc-xpack",
      separateProcess: true,
    },
    provides: ["gcc-arm"],
    executables: [
      { name: "arm-none-eabi-gcc", path: "bin/arm-none-eabi-gcc.exe", toolchain: "gcc-arm" },
      { name: "arm-none-eabi-gdb", path: "bin/arm-none-eabi-gdb.exe", toolchain: "gcc-arm" },
      { name: "arm-none-eabi-size", path: "bin/arm-none-eabi-size.exe", toolchain: "gcc-arm" },
    ],
    env: { pathPrepend: ["payload/bin"], vars: {} },
    validation: { command: "bin/arm-none-eabi-gcc.exe", args: ["-dumpmachine"], expect: "^arm-none-eabi$" },
    priority: 5,
  },
  {
    // CMake is the build-system front end most Cortex-M projects use. The
    // archive wraps everything in `cmake-4.2.3-windows-x86_64/`, which the
    // installer strips.
    id: "cmake-4.2.3-win32-x64",
    name: "CMake",
    version: "4.2.3",
    provider: "kitware",
    platform: "win32",
    arch: "x64",
    downloadBytes: 50_391_842,
    unpackedBytes: 190_000_000,
    sources: [
      {
        url: "https://github.com/Kitware/CMake/releases/download/v4.2.3/cmake-4.2.3-windows-x86_64.zip",
        archive: "zip",
        // 实测：2026-10-19 下载 50,391,842 字节后计算得到。
        sha256: "eb4ebf5155dbb05436d675706b2a08189430df58904257ae5e91bcba4c86933c",
        bytes: 50_391_842,
        hosts: GITHUB_HOSTS,
      },
    ],
    license: {
      name: "BSD-3-Clause",
      url: "https://github.com/Kitware/CMake/blob/v4.2.3/Copyright.txt",
      separateProcess: true,
    },
    provides: ["cmake"],
    executables: [{ name: "cmake", path: "bin/cmake.exe", toolchain: "cmake" }],
    env: { pathPrepend: ["payload/bin"], vars: {} },
    validation: { command: "bin/cmake.exe", args: ["--version"], expect: "^cmake version" },
  },
  {
    // pyOCD's Windows release is a PyInstaller one-directory build: pyocd.exe
    // plus `_internal/`. That layout is exactly what a pinned, hashed pack
    // needs — it does not depend on the user's Python being the right version,
    // which is the failure `pip install pyocd` produces most often.
    id: "pyocd-0.46.0-win32-x64",
    name: "pyOCD",
    version: "0.46.0",
    provider: "pyocd",
    platform: "win32",
    arch: "x64",
    downloadBytes: 37_011_537,
    unpackedBytes: 96_000_000,
    sources: [
      {
        url: "https://github.com/pyocd/pyOCD/releases/download/v0.46.0/pyocd-windows-0.46.0.zip",
        archive: "zip",
        // 实测：2026-10-20 下载 37,011,537 字节后计算得到。
        sha256: "bc36d0277ddf95dd2dab66f9676a779b42c59039aad08ef1493f9b67d7a75fe6",
        bytes: 37_011_537,
        hosts: GITHUB_HOSTS,
      },
    ],
    license: {
      name: "Apache-2.0",
      url: "https://github.com/pyocd/pyOCD/blob/main/LICENSE",
      sourceUrl: "https://github.com/pyocd/pyOCD",
      separateProcess: true,
    },
    provides: ["pyocd"],
    executables: [{ name: "pyocd", path: "pyocd.exe", toolchain: "pyocd" }],
    env: { pathPrepend: ["payload"], vars: {} },
    // `pyocd --version` prints the bare number.
    validation: { command: "pyocd.exe", args: ["--version"], expect: "^0\\.46\\.0" },
    priority: 10,
  },
];

/** 一个条目是否具备安装条件：有哈希才可能出现给用户。 */
export function isInstallable(entry: CatalogEntryDef): boolean {
  return entry.sources.length > 0 && entry.sources.every((source) => /^[0-9a-f]{64}$/.test(source.sha256));
}

/**
 * 可以装到这台机器上的条目。
 *
 * 只有 Windows 版本：这是产品的决定，不是疏忽。多一个平台就要多一套实测
 * 过的哈希、多一次发布验证，而没验过的条目装到用户机器上只会以"解压成功
 * 但跑不起来"的方式失败。等某个平台真的要发，再把它的条目连哈希一起加进来。
 *
 * 参数保留成显式的 platform/arch 是为了让测试能在任何一台机器上验证过滤
 * 逻辑，而不是让运行时去猜。
 */
export function catalogFor(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  options: { includeUnverified?: boolean } = {},
): CatalogEntryDef[] {
  return CATALOG.filter((entry) => {
    if (entry.platform !== "any" && entry.platform !== platform) return false;
    if (entry.arch !== "any" && entry.arch !== arch) return false;
    return options.includeUnverified ? true : isInstallable(entry);
  }).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.name.localeCompare(b.name));
}

export function catalogEntry(id: string): CatalogEntryDef | undefined {
  return CATALOG.find((entry) => entry.id === id);
}

/** 把目录条目变成安装器要的 manifest + 体积。 */
export function toInstallEntry(entry: CatalogEntryDef): {
  manifest: PackManifest;
  unpackedBytes: number;
  downloadBytes: number;
} {
  const manifest: PackManifest = {
    schema: 1,
    id: entry.id,
    name: entry.name,
    version: entry.version,
    provider: entry.provider,
    platform: String(entry.platform),
    arch: String(entry.arch),
    installedAt: new Date().toISOString(),
    sources: entry.sources,
    license: entry.license,
    provides: entry.provides,
    executables: entry.executables,
    env: entry.env,
    validation: entry.validation,
    payload: { root: "payload", files: 0, bytes: 0, treeHash: "" },
  };
  return { manifest, unpackedBytes: entry.unpackedBytes, downloadBytes: entry.downloadBytes };
}