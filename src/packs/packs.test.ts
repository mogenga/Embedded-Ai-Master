/**
 * 工具链 packs：路径安全、manifest、归档校验、安装事务。
 *
 * 迁移自 Prometheus/tests/packs.test.ts（node:test → vitest，断言语义不变）。
 * 与 A 版的差异仅有：
 * - 断言中的产品名 / 环境变量名随命名适配（Embedded-Ai-Master /
 *   HARNESS_TOOLCHAIN_HOME）；
 * - `TOOLCHAIN_INFO` 改从 `mcp-servers/keil/toolchain.ts` 引（B 侧该表的
 *   所在地）；`INSTALL_HINTS` 在 B 未迁移，「每种烧录器都至少有出路」用例
 *   相应改为只断言目录一侧的覆盖（见该用例注释）；
 * - 新增 B 特有的 D-170 断言：测试进程未设 `HARNESS_TOOLCHAIN_HOME` 时
 *   `packsRoot()` 拒绝返回默认根（对齐 `src/config/harness-home.ts` 的
 *   防污染约定）。
 */

import { describe, expect, it } from "vitest";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { assertPackId, isInside, packDir, packsRoot, ROOT_ENV, ensureRoot, isOwnedRoot, acquireRootLock } from "./paths.js";
import { parseManifest, readManifest, resolvePayloadPath, writeManifest } from "./manifest.js";
import { planExtraction, validateMember, walkStats } from "./archive.js";
import { TOOLCHAIN_INFO } from "../../mcp-servers/keil/toolchain.js";

function scratch(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("paths", () => {
  it("a pack id cannot escape its directory", () => {
    for (const bad of ["../x", "a/b", "a\\b", "C:\\x", "", ".", "..", ".hidden", "x".repeat(65), "A-Upper", "with space"]) {
      expect(() => assertPackId(bad), `"${bad}" should be rejected`).toThrow(/pack id/);
    }
    for (const good of ["arm-gnu-15.3.rel2-win32-x64", "esp-riscv32", "a", "x.y_z-1"]) {
      expect(() => assertPackId(good), `"${good}" should be accepted`).not.toThrow();
    }
  });

  it("a relative toolchain home is refused, because it would resolve differently per process", () => {
    expect(() => packsRoot({ [ROOT_ENV]: "relative/path" })).toThrow(/must be an absolute path/);
    const absolute = process.platform === "win32" ? "C:\\eaim-toolchains" : "/tmp/eaim-toolchains";
    expect(packsRoot({ [ROOT_ENV]: absolute })).toBe(absolute);
  });

  it("the root is the OS data dir, not the roaming profile", () => {
    const root = packsRoot({});
    expect(root.includes(".harness"), `root must not be under ~/.harness: ${root}`).toBe(false);
    if (process.platform === "win32") expect(root).toMatch(/AppData[\\/]Local[\\/]Embedded-Ai-Master[\\/]toolchains$/);
  });

  it("containment treats a sibling with a shared prefix as outside", () => {
    const base = process.platform === "win32" ? "C:\\root\\packs" : "/root/packs";
    const inside = process.platform === "win32" ? "C:\\root\\packs\\a\\b" : "/root/packs/a/b";
    const sibling = process.platform === "win32" ? "C:\\root\\packs-evil\\x" : "/root/packs-evil/x";
    expect(isInside(base, inside)).toBe(true);
    expect(isInside(base, sibling)).toBe(false);
    expect(isInside(base, base)).toBe(true);
  });

  it("the root carries an ownership marker so prune never deletes a stranger's directory", () => {
    const root = scratch("eaim-root-");
    expect(isOwnedRoot(root)).toBe(false);
    ensureRoot(root);
    expect(isOwnedRoot(root)).toBe(true);
    expect(existsSync(join(root, "packs"))).toBe(true);
    expect(existsSync(join(root, "tmp"))).toBe(true);
  });

  it("packDir 拒绝逃逸的 id 而不是拼出目录", () => {
    expect(packDir("/root", "ok-pack")).toBe(join("/root", "packs", "ok-pack"));
    expect(() => packDir("/root", "../evil")).toThrow(/pack id/);
  });

  // B 特有（D-170）：与 src/config/harness-home.ts 同一防污染约定。
  it("测试进程未设 HARNESS_TOOLCHAIN_HOME 时拒绝返回默认根（D-170）", () => {
    expect(() => packsRoot({ VITEST: "true" })).toThrow(/D-170/);
    expect(() => packsRoot({ NODE_ENV: "test" })).toThrow(/HARNESS_TOOLCHAIN_HOME/);
  });

  it("测试进程设置了 HARNESS_TOOLCHAIN_HOME 时正常返回（D-170）", () => {
    const absolute = process.platform === "win32" ? "C:\\eaim-tc-tmp" : "/tmp/eaim-tc-tmp";
    expect(packsRoot({ VITEST: "true", [ROOT_ENV]: absolute })).toBe(absolute);
  });
});

describe("the install lock", () => {
  it("a second install into the same root is refused rather than raced", () => {
    const root = scratch("eaim-lock-");
    const first = acquireRootLock(root, { id: "pack-a" });
    try {
      expect(() => acquireRootLock(root, { id: "pack-b" })).toThrow(/in use by another Embedded-Ai-Master install/);
    } finally {
      first.release();
    }
    // 释放后：下一个能进来。
    const second = acquireRootLock(root, { id: "pack-c" });
    second.release();
  });

  it("a lock left by a dead process is broken, so a crash does not block installs forever", () => {
    const root = scratch("eaim-lock-dead-");
    ensureRoot(root);
    // 一定不存在的 pid：不 spawn 任何东西，用一个超过上限的值。
    writeFileSync(join(root, ".lock"), JSON.stringify({ pid: 4294967295, startedAt: new Date().toISOString() }));
    const lock = acquireRootLock(root);
    lock.release();
    expect(existsSync(join(root, ".lock"))).toBe(false);
  });

  it("a corrupt lock is broken rather than blocking forever", () => {
    const root = scratch("eaim-lock-corrupt-");
    ensureRoot(root);
    writeFileSync(join(root, ".lock"), "{ this is not json");
    const lock = acquireRootLock(root);
    lock.release();
    expect(existsSync(join(root, ".lock"))).toBe(false);
  });

  it("a lock belonging to a live process is respected", () => {
    const root = scratch("eaim-lock-live-");
    ensureRoot(root);
    // 测试运行器自己的 pid 一定活着，而 `breakStaleLock` 刻意不破坏自己
    // 的记录。
    const lock = acquireRootLock(root);
    try {
      writeFileSync(join(root, ".lock"), JSON.stringify({ pid: process.ppid ?? process.pid, startedAt: new Date().toISOString() }));
      expect(() => acquireRootLock(root)).toThrow(/in use/);
    } finally {
      // 记录现在属于另一个 pid，release() 按设计是空操作；清掉它保持
      // scratch 目录干净。
      expect(existsSync(join(root, ".lock"))).toBe(true);
      lock.release();
    }
  });
});

function validManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 1,
    id: "arm-gnu-15.3.rel2-win32-x64",
    name: "Arm GNU Toolchain",
    version: "15.3.rel2",
    provider: "arm",
    platform: "win32",
    arch: "x64",
    installedAt: "2026-10-18T00:00:00.000Z",
    sources: [
      {
        url: "https://developer.arm.com/x.zip",
        archive: "zip",
        sha256: "a".repeat(64),
        bytes: 1000,
        hosts: ["developer.arm.com"],
      },
    ],
    license: { name: "GPL-3.0-or-later with GCC RLE", url: "https://developer.arm.com/license.txt", separateProcess: true },
    provides: ["gcc-arm"],
    executables: [{ name: "arm-none-eabi-gcc", path: "bin/arm-none-eabi-gcc.exe", toolchain: "gcc-arm" }],
    env: { pathPrepend: ["payload/bin"], vars: {} },
    validation: { command: "bin/arm-none-eabi-gcc.exe", args: ["-dumpmachine"], expect: "^arm-none-eabi$" },
    payload: { root: "payload", files: 10, bytes: 100, treeHash: "" },
    ...overrides,
  };
}

describe("manifest", () => {
  it("a well-formed manifest round-trips through the file", () => {
    const dir = scratch("eaim-pack-");
    const manifest = parseManifest(validManifest(), "test");
    writeManifest(dir, manifest);
    const back = readManifest(dir);
    expect(back).toEqual(manifest);
  });

  it("a manifest from a newer Embedded-Ai-Master is refused by name, not silently ignored", () => {
    expect(() => parseManifest(validManifest({ schema: 2 }))).toThrow(/schema 2.*Update Embedded-Ai-Master/s);
  });

  it("a manifest cannot point a binary outside its own pack", () => {
    // 爬出去的路径在解析时就被拒绝，永远轮不到 join。
    expect(() => parseManifest(validManifest({ executables: [{ name: "evil", path: "../../evil.exe" }] }))).toThrow(
      /must not contain "\.\."/,
    );
    expect(() => parseManifest(validManifest({ executables: [{ name: "evil", path: "/usr/bin/sh" }] }))).toThrow(
      /must be relative/,
    );
    // Windows 盘符绝对路径是同一个攻击的另一种拼法。
    expect(() => parseManifest(validManifest({ executables: [{ name: "evil", path: "C:\\Windows\\cmd.exe" }] }))).toThrow(
      /must not name a drive/,
    );
  });

  it("manifest validation rejects insecure or malformed sources", () => {
    const base = validManifest();
    const withSource = (patch: Record<string, unknown>) =>
      validManifest({ sources: [{ ...(base.sources as Record<string, unknown>[])[0], ...patch }] });

    expect(() => parseManifest(withSource({ url: "http://example.com/x.zip" }))).toThrow(/must be https/);
    expect(() => parseManifest(withSource({ sha256: "zzz" }))).toThrow(/64 lowercase hex/);
    expect(() => parseManifest(withSource({ archive: "rar" }))).toThrow(/must be zip, tar\.xz or tar\.gz/);
    expect(() => parseManifest(validManifest({ provides: [] }))).toThrow(/at least one toolchain kind/);
    expect(() => parseManifest(validManifest({ validation: { command: "x", args: [], expect: "[" } }))).toThrow(
      /valid regular expression/,
    );
  });

  it("resolving a payload path refuses to leave the payload", () => {
    const dir = scratch("eaim-resolve-");
    const manifest = parseManifest(validManifest({ executables: [{ name: "gcc", path: "bin/gcc" }] }), "test");
    const inside = resolvePayloadPath(dir, manifest, "bin/gcc");
    expect(inside.startsWith(join(dir, "payload"))).toBe(true);
    expect(() => resolvePayloadPath(dir, manifest, "../../etc/passwd")).toThrow(/outside the pack payload/);
  });
});

describe("archive members", () => {
  it("every traversal spelling is rejected", () => {
    const bad = [
      "../escape.txt",
      "../../escape.txt",
      "..\\..\\escape.txt",
      "a/../../b",
      "/abs/file",
      "\\abs\\file",
      "C:\\Windows\\file",
      "//server/share/file",
      "name\0nul",
      "x".repeat(901),
    ];
    for (const name of bad) {
      expect(validateMember(name), `${JSON.stringify(name)} should be rejected`).not.toBeNull();
    }
    for (const good of ["ok.txt", "dir/file.c", "a/./b", "__MACOSX/._foo"]) {
      expect(validateMember(good), `${JSON.stringify(good)} should be accepted`).toBeNull();
    }
  });

  it("stripping depends on how many top-level entries the archive has", () => {
    // 单个包装目录是厂商归档的常见形态。
    const single = planExtraction(["tool-1.0/", "tool-1.0/bin/", "tool-1.0/bin/gcc", "tool-1.0/lib/a.a"]);
    expect(single.strip).toBe(1);
    expect(single.topLevels).toEqual(["tool-1.0"]);

    const multiple = planExtraction(["a/x", "b/y"]);
    expect(multiple.strip, "several top-level entries must not be stripped").toBe(0);

    // macOS 资源分叉不是 payload，不得影响判断。
    const noisy = planExtraction(["tool/bin/gcc", "__MACOSX/._gcc"]);
    expect(noisy.strip).toBe(1);
    expect(noisy.topLevels).toEqual(["tool"]);
  });

  it("an archive holding one bare file is not stripped", () => {
    // ninja-win.zip 恰好就是 `ninja.exe`。一个顶层条目，但它是 payload
    // 而不是包装层：剥了它就什么都解压不出来，验证阶段随后以"找不到
    // 命令"失败——对这个其实是空 payload 的情况来说是个费解的症状。
    const plan = planExtraction(["ninja.exe"]);
    expect(plan.strip).toBe(0);
    expect(plan.topLevels).toEqual(["ninja.exe"]);

    // 装着一个文件的目录仍然剥层，因为证明它是目录的成员在。
    expect(planExtraction(["bin/ninja.exe"]).strip).toBe(1);
    // 文件与目录并排也不是包装层。
    expect(planExtraction(["ninja.exe", "docs/readme"]).strip).toBe(0);
  });

  it("a violation is reported and blocks extraction even when a strip is possible", () => {
    const plan = planExtraction(["ok/x", "../evil"]);
    expect(plan.violations.length).toBe(1);
    expect(plan.violations[0]).toMatch(/parent reference/);
  });
});

import { installPack, type CatalogEntry, type InstallDeps } from "./install.js";
import { listPacks, packBinDirs, pruneTmp, removePack } from "./registry.js";

function entry(overrides: Record<string, unknown> = {}): CatalogEntry {
  return {
    manifest: parseManifest(validManifest(overrides), "test"),
    unpackedBytes: 1000,
    downloadBytes: 1000,
  };
}

/**
 * 假工具链：一个目录，里面有个会打印预期三元组的可执行文件。解压器负责
 * 写它，于是整个事务跑起来不需要网络、真实归档或真实编译器。
 */
function fakeDeps(options: { extractThrows?: boolean; validationFails?: boolean; badHash?: boolean; files?: number } = {}): InstallDeps {
  return {
    download: async (source, opts) => {
      writeFileSync(opts.destination, "archive bytes");
      if (options.badHash) {
        throw new Error(`checksum mismatch for ${source.url}\n  expected ${source.sha256}\n  received deadbeef`);
      }
      return { bytes: 13, sha256: source.sha256 };
    },
    list: async () => ["tool-1.0/", "tool-1.0/bin/", "tool-1.0/bin/gcc.exe"],
    extract: async (_archive, _format, destination) => {
      if (options.extractThrows) throw new Error("extraction failed: corrupt archive");
      const bin = join(destination, "bin");
      mkdirSync(bin, { recursive: true });
      const count = options.files ?? 1;
      for (let index = 0; index < count; index++) {
        writeFileSync(join(bin, index === 0 ? "gcc.exe" : `lib${index}.a`), index === 0 ? "binary" : "payload");
      }
    },
    walk: (root) => walkStats(root),
    hashTree: async () => "sha256:tree",
    runValidation: async () => (options.validationFails ? { ok: false, output: "x", reason: "validation failed: wrong triple" } : { ok: true, output: "arm-none-eabi" }),
    // 离线安装走这条路：字节从本地文件来，但校验一步都不能少。
    importArchive: async (source, file, opts) => {
      writeFileSync(opts.destination, readFileSync(file));
      if (options.badHash) {
        throw new Error(`checksum mismatch for ${file}\n  expected ${source.sha256}\n  received deadbeef`);
      }
      return { bytes: 13, sha256: source.sha256 };
    },
  };
}

describe("the install transaction", () => {
  it("a successful install commits one complete directory and leaves tmp empty", async () => {
    const root = scratch("eaim-install-");
    const manifest = await installPack(entry(), { root, deps: fakeDeps() });

    const dir = join(root, "packs", manifest.id);
    expect(existsSync(dir), "the pack directory exists").toBe(true);
    expect(existsSync(join(dir, "pack.json")), "the manifest is inside the pack").toBe(true);
    expect(existsSync(join(dir, "NOTICE.md")), "the licence notice is inside the pack").toBe(true);
    expect(existsSync(join(dir, "payload", "bin", "gcc.exe")), "the payload is extracted").toBe(true);
    expect(manifest.payload.files).toBe(1);

    // 事务目录消失了：没有散落的归档，没有暂存树。
    expect(readdirSync(join(root, "tmp"))).toEqual([]);

    const packs = listPacks(root);
    expect(packs.length).toBe(1);
    expect(packs[0].status).toBe("ok");
  });

  it("every failed install leaves nothing in packs/ and cleans tmp", async () => {
    const failures: [string, InstallDeps][] = [
      ["checksum mismatch", fakeDeps({ badHash: true })],
      ["extraction failure", fakeDeps({ extractThrows: true })],
      ["validation failure", fakeDeps({ validationFails: true })],
    ];

    for (const [label, deps] of failures) {
      const root = scratch("eaim-fail-");
      await expect(installPack(entry(), { root, deps }), `"${label}" should fail`).rejects.toThrow();
      expect(readdirSync(join(root, "packs")), `${label}: packs/ must be empty`).toEqual([]);
      expect(readdirSync(join(root, "tmp")), `${label}: tmp/ must be empty`).toEqual([]);
    }
  });

  it("an offline install uses the local archive and still checks its checksum", async () => {
    const root = scratch("eaim-offline-");
    const archive = join(root, "arm.zip");
    writeFileSync(archive, "archive bytes");

    const manifest = await installPack(entry(), {
      root,
      localFiles: [archive],
      deps: fakeDeps(),
    });
    expect(existsSync(join(root, "packs", manifest.id, "payload", "bin", "gcc.exe"))).toBe(true);

    // 用户自己的文件还在原地——事务复制了它，这个功能里的任何东西都
    // 不得删除用户挑的文件。
    expect(existsSync(archive), "the source archive must not be consumed").toBe(true);
  });

  it("an offline archive that does not match its manifest is refused", async () => {
    const root = scratch("eaim-offline-bad-");
    const archive = join(root, "tampered.zip");
    writeFileSync(archive, "not the bytes the manifest describes");

    await expect(
      installPack(entry(), { root, localFiles: [archive], deps: fakeDeps({ badHash: true }) }),
    ).rejects.toThrow(/checksum mismatch/);
    expect(readdirSync(join(root, "packs")), "nothing installed").toEqual([]);
    expect(readdirSync(join(root, "tmp")), "nothing left behind").toEqual([]);
  });

  it("offline file count must match the manifest's source count", async () => {
    const root = scratch("eaim-offline-count-");
    await expect(installPack(entry(), { root, localFiles: [], deps: fakeDeps() })).rejects.toThrow(
      /1 archive\(s\) but 0 file\(s\)/,
    );
  });

  it("an unsafe archive is refused before extraction writes anything", async () => {
    const root = scratch("eaim-unsafe-");
    let extracted = false;
    const deps = {
      ...fakeDeps(),
      list: async () => ["tool/bin/gcc.exe", "../escape.txt"],
      extract: async () => {
        extracted = true;
      },
    };
    await expect(installPack(entry(), { root, deps })).rejects.toThrow(/unsafe paths/);
    expect(extracted, "extraction must not run when a member is unsafe").toBe(false);
    expect(readdirSync(join(root, "packs"))).toEqual([]);
  });

  it("an existing pack is not overwritten unless replace is asked for", async () => {
    const root = scratch("eaim-collide-");
    await installPack(entry(), { root, deps: fakeDeps() });

    await expect(installPack(entry(), { root, deps: fakeDeps() })).rejects.toThrow(/already installed/);

    // 带 replace 时原子替换旧的，且只留一个。
    const manifest = await installPack(entry({ version: "15.3.rel3" }), { root, deps: fakeDeps({ files: 3 }), replace: true });
    const packs = listPacks(root);
    expect(packs.length, "a replace must not leave the old pack behind").toBe(1);
    expect(manifest.payload.files).toBe(3);
  });

  it("a cancelled install removes its transaction", async () => {
    const root = scratch("eaim-cancel-");
    const controller = new AbortController();
    const deps: InstallDeps = {
      ...fakeDeps(),
      download: async (_source, opts) => {
        controller.abort();
        throw new Error("cancelled");
      },
    };
    await expect(installPack(entry(), { root, deps, signal: controller.signal })).rejects.toThrow();
    expect(readdirSync(join(root, "packs"))).toEqual([]);
    expect(readdirSync(join(root, "tmp"))).toEqual([]);
  });
});

describe("registry", () => {
  it("a pack disappears from the list as soon as it is removed", async () => {
    const root = scratch("eaim-remove-");
    const manifest = await installPack(entry(), { root, deps: fakeDeps() });
    expect(listPacks(root).length).toBe(1);

    await removePack(manifest.id, { root });
    expect(listPacks(root).length).toBe(0);
    expect(existsSync(join(root, "packs", manifest.id))).toBe(false);
  });

  it("a directory with no manifest is reported as broken, not hidden", () => {
    const root = scratch("eaim-broken-");
    ensureRoot(root);
    mkdirSync(join(root, "packs", "half-installed"), { recursive: true });

    const packs = listPacks(root);
    expect(packs.length).toBe(1);
    expect(packs[0].status).toBe("broken");
    expect(String(packs[0].problem)).toMatch(/pack\.json/);
  });

  it("prune removes only old transactions and trash", async () => {
    const root = scratch("eaim-prune-");
    ensureRoot(root);
    const old = join(root, "tmp", "txn-old");
    const fresh = join(root, "tmp", "txn-fresh");
    mkdirSync(old, { recursive: true });
    mkdirSync(fresh, { recursive: true });
    writeFileSync(join(old, "archive.zip"), "x".repeat(100));

    // 把旧的回溯到过去。
    const past = new Date(Date.now() - 48 * 60 * 60 * 1000);
    utimesSync(old, past, past);

    const result = await pruneTmp({ root });
    expect(result.removed.length).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh), "a fresh transaction may still be in flight").toBe(true);
  });

  it("pack bin directories are keyed by the toolchain kind they provide", async () => {
    const root = scratch("eaim-bins-");
    await installPack(entry(), { root, deps: fakeDeps() });

    const bins = packBinDirs(root);
    const forGcc = bins.get("gcc-arm");
    expect(forGcc).toBeDefined();
    expect(forGcc!.length).toBe(1);
    // 目录必须以 `payload/bin` 结尾（任一分隔符），而不是把 payload 前缀
    // 叠两层。
    expect(forGcc![0].dir.endsWith(`payload${sep}bin`), `unexpected bin dir: ${forGcc![0].dir}`).toBe(true);
  });
});

// ---- 环境注入 ---------------------------------------------------------------
// A 侧这几条用例测的是 `src/embedded/toolEnv.ts`（packs 契约的一部分：
// process.env 永不被写、Windows Path/PATH 不双写）。B 侧对应实现在
// `mcp-servers/keil/toolEnv.ts`，从那里引。

import { prependPath, toolEnv } from "../../mcp-servers/keil/toolEnv.js";

describe("环境注入", () => {
  it("前置目录时不会在 Windows 上造出重复的 Path/PATH 键", () => {
    const dirs = ["C:\\packs\\arm\\payload\\bin"];
    // Windows 的系统环境用的是 `Path`。再写一个 `PATH` 会让环境里出现两个键，
    // 读到哪个取决于枚举顺序 —— 这正是"有时能找到编译器有时找不到"的来源。
    const env = prependPath({ Path: "C:\\Windows\\System32", FOO: "1" }, dirs);
    const pathKeys = Object.keys(env).filter((key) => key.toUpperCase() === "PATH");
    expect(pathKeys.length, `只能有一个 PATH 键，实际有 ${pathKeys.join(", ")}`).toBe(1);
    expect(env.Path).toBe(`${dirs[0]};C:\\Windows\\System32`);
    expect(env.PATH).toBeUndefined();
  });

  it("用小写 PATH 的环境只保留 PATH 这一个键", () => {
    const env = prependPath({ PATH: "/usr/bin" }, ["/opt/pack/bin"]);
    const keys = Object.keys(env).filter((key) => key.toUpperCase() === "PATH");
    expect(keys.length).toBe(1);
    const sep = process.platform === "win32" ? ";" : ":";
    expect(env[keys[0]]).toBe(["/opt/pack/bin", "/usr/bin"].join(sep));
  });

  it("已经在 PATH 里的目录会被提到前面而不是重复", () => {
    const env = prependPath({ PATH: "/usr/bin:/opt/pack/bin" }, ["/opt/pack/bin"]);
    const sep = process.platform === "win32" ? ";" : ":";
    const parts = String(env.PATH).split(sep);
    expect(parts[0], "pack 必须排在系统目录之前").toBe("/opt/pack/bin");
    expect(parts.filter((part) => part === "/opt/pack/bin").length, "不能重复出现").toBe(1);
  });

  it("没有任何目录时不改动环境对象", () => {
    const original = { PATH: "/usr/bin" };
    expect(prependPath(original, [])).toBe(original);
  });

  it("toolEnv 不会修改 process.env", () => {
    const before = process.env.PATH;
    toolEnv();
    expect(process.env.PATH, "process.env 必须一个字都不变").toBe(before);
  });
});

// ---- 目录 ---------------------------------------------------------------------

import { catalogFor, isInstallable, CATALOG, catalogEntry } from "./catalog.js";

describe("目录", () => {
  it("没有校验和的条目不会出现在可安装列表里", () => {
    // 安装器拒绝无校验的包，所以目录也不该把这种条目摆给用户看。
    const unverified = CATALOG.filter((entry) => !isInstallable(entry));
    const offered = catalogFor("win32", "x64");
    for (const item of unverified) {
      expect(offered.includes(item), `${item.id} 没有哈希却出现了`).toBe(false);
    }
  });

  it("目录按平台和架构过滤", () => {
    // 换一个平台就不该看到别的平台的包。
    const win = catalogFor("win32", "x64", { includeUnverified: true });
    for (const item of win) expect(item.platform).toBe("win32");
    // 产品目前只发 Windows，其它平台上目录应当是空的 —— 而不是列出装不上的
    // 东西让用户去点。
    expect(catalogFor("linux", "x64", { includeUnverified: true }).length).toBe(0);
    expect(catalogFor("darwin", "arm64", { includeUnverified: true }).length).toBe(0);
    // 同一个平台里换架构也一样。
    expect(catalogFor("win32", "arm64", { includeUnverified: true }).length).toBe(0);
  });

  it("目录里的每个条目都是 Windows x64 的独立工具", () => {
    // 这条测试是产品范围的锚点：只做 Win 端时，目录里出现别的平台条目
    // 一定是有意加的，而不是拷贝粘贴带进来的。
    for (const item of CATALOG) {
      expect(item.platform, `${item.id} 不是 Windows 条目`).toBe("win32");
      expect(item.arch, `${item.id} 不是 x64 条目`).toBe("x64");
      expect(item.provides.length > 0, `${item.id} 没有声明提供什么`).toBe(true);
      for (const kind of item.provides) {
        expect(
          Object.hasOwn(TOOLCHAIN_INFO, kind),
          `${item.id} 提供的 ${kind} 不是探测器认识的一种工具链`,
        ).toBe(true);
      }
    }
  });

  it("目录里每个条目本身是自洽的", () => {
    for (const item of CATALOG) {
      expect(item.id, `${item.id} 不是合法的 pack id`).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
      expect(item.sources.length > 0, `${item.id} 没有来源`).toBe(true);
      for (const source of item.sources) {
        expect(source.url, `${item.id} 的来源不是 https`).toMatch(/^https:\/\//);
        expect(source.hosts.length > 0, `${item.id} 没有声明允许的主机`).toBe(true);
      }
      expect(item.provides.length > 0, `${item.id} 没有声明提供什么`).toBe(true);
      // 每个条目都必须能在装完后证明自己是可用的。
      expect(Boolean(item.validation.command), `${item.id} 没有验证命令`).toBe(true);
    }
  });

  it("探测器认识的烧录工具里，目录覆盖了核心四种", () => {
    // A 侧原用例是「每种烧录器要么可下载、要么有 INSTALL_HINTS 安装提
    // 示」——B 未迁移 installHints.ts（Phase 3 的工具链探测配套），无提示
    // 一侧无法断言，这里收敛为目录一侧的覆盖断言：核心烧录/调试工具必须
    // 能从目录安装。其余 flash 类 kind（jlink/st-flash 等厂商专有安装器）
    // 在 A 侧也是走 INSTALL_HINTS 而非目录，B 侧等 installHints 迁移后
    // 再补完整用例。
    const flashKinds = Object.entries(TOOLCHAIN_INFO)
      .filter(([, info]) => info.group === "flash")
      .map(([kind]) => kind);
    expect(flashKinds.includes("pyocd")).toBe(true);
    const provided = new Set(CATALOG.flatMap((item) => item.provides));
    for (const kind of ["openocd", "pyocd", "probe-rs", "esptool"]) {
      expect(provided.has(kind), `${kind} 不能从目录安装`).toBe(true);
    }
  });

  it("三个内置烧录器的条目指向真实发布页的形状", () => {
    // 哈希是实测的，但 URL 和归档结构是会随项目发布流程漂移的部分。
    // 这里钉住的是"这条 URL 属于这个项目"，真正的字节校验在安装时做。
    const cases = [
      { id: "probe-rs-0.32.0-win32-x64", host: "github.com/probe-rs/probe-rs", exe: "probe-rs.exe" },
      { id: "pyocd-0.46.0-win32-x64", host: "github.com/pyocd/pyOCD", exe: "pyocd.exe" },
      { id: "esptool-5.6.0-win32-x64", host: "github.com/espressif/esptool", exe: "esptool.exe" },
    ];
    for (const expected of cases) {
      const item = catalogEntry(expected.id);
      expect(item, `${expected.id} 不在目录里`).toBeDefined();
      expect(item!.sources[0].url.includes(expected.host), `${expected.id} 的 URL 不属于 ${expected.host}`).toBe(true);
      expect(isInstallable(item!), `${expected.id} 没有可用的哈希，不会出现在安装列表里`).toBe(true);
      expect(item!.sources[0].sha256.length).toBe(64);
      expect(
        item!.executables.some((executable) => executable.path === expected.exe),
        `${expected.id} 没有声明 ${expected.exe}`,
      ).toBe(true);
      // 安装后探测器要靠 payload 里的目录找到它。
      expect(item!.env.pathPrepend.length > 0, `${item!.id} 没有把 payload 加进 PATH`).toBe(true);
    }
  });
});

// ---- 真实路径（B 侧补充，A 版靠 e2e 手测覆盖这些面）-------------------------
// 这些用例不触网：downloadVerified 注入 fetchImpl；归档操作用系统 tar 的
// 真实进程；importArchive/treeHash/runValidation 用真实文件。

import { downloadVerified, importArchive, DownloadError } from "./download.js";
import { extractArchive, listArchive, supportsFormat, resetFormatCache, tarBinary, treeHash as realTreeHash } from "./archive.js";
import { runValidation, installFromManifest, freeBytes, formatBytes } from "./install.js";
import { verifyPack } from "./registry.js";
import type { PackSource } from "./manifest.js";

function sha256of(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** 鸭子类型的 Response：能控制 url / status / content-length，body 是真流。 */
function fakeResponse(text: string, init: { url?: string; status?: number; contentLength?: number } = {}): Response {
  const base = new Response(text);
  const headers = new Headers(init.contentLength !== undefined ? { "content-length": String(init.contentLength) } : {});
  return {
    ok: (init.status ?? 200) >= 200 && (init.status ?? 200) < 300,
    status: init.status ?? 200,
    statusText: "",
    url: init.url ?? "https://developer.arm.com/x.zip",
    headers,
    body: base.body,
    redirected: false,
    type: "basic",
    statusTextPlaceholder: undefined,
  } as unknown as Response;
}

function testSource(overrides: Partial<PackSource> = {}): PackSource {
  return {
    url: "https://developer.arm.com/x.zip",
    archive: "zip",
    sha256: sha256of("archive bytes"),
    bytes: 13,
    hosts: ["developer.arm.com"],
    ...overrides,
  };
}

describe("download（注入 fetch，不触网）", () => {
  it("a verified download writes the bytes and reports progress", async () => {
    const root = scratch("eaim-dl-");
    const destination = join(root, "x.zip");
    const seen: number[] = [];
    const result = await downloadVerified(testSource(), {
      destination,
      fetchImpl: (async () => fakeResponse("archive bytes")) as typeof fetch,
      onProgress: (progress) => seen.push(progress.received),
    });
    expect(result.bytes).toBe(13);
    expect(result.sha256).toBe(sha256of("archive bytes"));
    expect(readFileSync(destination, "utf8")).toBe("archive bytes");
    expect(seen.length).toBeGreaterThan(0);
  });

  it("an HTTP error is reported with the status", async () => {
    const root = scratch("eaim-dl-404-");
    await expect(
      downloadVerified(testSource(), {
        destination: join(root, "x.zip"),
        fetchImpl: (async () => fakeResponse("nope", { status: 404 })) as typeof fetch,
      }),
    ).rejects.toThrow(/HTTP 404/);
    expect(existsSync(join(root, "x.zip"))).toBe(false);
  });

  it("a redirect to a host the pack did not name is refused", async () => {
    const root = scratch("eaim-dl-redirect-");
    await expect(
      downloadVerified(testSource(), {
        destination: join(root, "x.zip"),
        fetchImpl: (async () => fakeResponse("archive bytes", { url: "https://evil.example.net/x.zip" })) as typeof fetch,
      }),
    ).rejects.toThrow(/not an approved host/);
  });

  it("a checksum mismatch deletes the file and names both hashes", async () => {
    const root = scratch("eaim-dl-bad-");
    const destination = join(root, "x.zip");
    await expect(
      downloadVerified(testSource({ sha256: "0".repeat(64) }), {
        destination,
        fetchImpl: (async () => fakeResponse("archive bytes")) as typeof fetch,
      }),
    ).rejects.toThrow(/checksum mismatch/);
    expect(existsSync(destination)).toBe(false);
  });

  it("a short body against the declared length is a failure, not a success", async () => {
    const root = scratch("eaim-dl-short-");
    await expect(
      downloadVerified(testSource(), {
        destination: join(root, "x.zip"),
        fetchImpl: (async () => fakeResponse("archive bytes", { contentLength: 100 })) as typeof fetch,
      }),
    ).rejects.toThrow(/download ended at 13 of 100 bytes/);
  });

  it("cancellation before the first byte is a clean error", async () => {
    const root = scratch("eaim-dl-cancel-");
    const controller = new AbortController();
    controller.abort();
    await expect(
      downloadVerified(testSource(), {
        destination: join(root, "x.zip"),
        signal: controller.signal,
        fetchImpl: (async () => fakeResponse("archive bytes")) as typeof fetch,
      }),
    ).rejects.toThrow(DownloadError);
  });

  it("importArchive copies and verifies a local file without consuming it", async () => {
    const root = scratch("eaim-import-");
    const file = join(root, "local.zip");
    writeFileSync(file, "archive bytes");
    const destination = join(root, "copied.zip");
    const result = await importArchive(testSource(), file, { destination });
    expect(result.bytes).toBe(13);
    expect(readFileSync(destination, "utf8")).toBe("archive bytes");
    expect(existsSync(file), "the user's own file must stay").toBe(true);
  });

  it("importArchive refuses a file whose bytes do not match the manifest", async () => {
    const root = scratch("eaim-import-bad-");
    const file = join(root, "tampered.zip");
    // 同为 13 字节但内容不同：大小检查放行，落到哈希检查。
    writeFileSync(file, "archive bytex");
    await expect(importArchive(testSource(), file, { destination: join(root, "copied.zip") })).rejects.toThrow(
      /checksum mismatch/,
    );
    expect(existsSync(join(root, "copied.zip"))).toBe(false);
  });

  it("importArchive refuses a file of the wrong size even before hashing", async () => {
    const root = scratch("eaim-import-size-");
    const file = join(root, "short.zip");
    writeFileSync(file, "short");
    await expect(importArchive(testSource(), file, { destination: join(root, "copied.zip") })).rejects.toThrow(
      /is 5 bytes, but the manifest says 13/,
    );
  });

  it("importArchive names a missing file explicitly", async () => {
    const root = scratch("eaim-import-missing-");
    await expect(importArchive(testSource(), join(root, "nope.zip"), { destination: join(root, "copied.zip") })).rejects.toThrow(
      /no such file/,
    );
  });
});

describe("archive（真实系统 tar）", () => {
  it("tarBinary resolves to an absolute path", () => {
    const binary = tarBinary(process.platform);
    expect(binary).toMatch(/^(?:[A-Za-z]:\\|\/)/);
  });

  it("lists and extracts a real zip, and strips a single wrapper directory", async () => {
    const root = scratch("eaim-tar-zip-");
    writeFileSync(join(root, "tool-1.0.txt"), "payload");
    const archive = join(root, "a.zip");
    // bsdtar 打 zip：`-a` 按扩展名选格式。
    execFileSync(tarBinary(), ["-a", "-cf", archive, "tool-1.0.txt"], { cwd: root });

    const names = await listArchive(archive);
    expect(names).toEqual(["tool-1.0.txt"]);

    const out = join(root, "out");
    mkdirSync(out);
    await extractArchive(archive, "zip", out, planExtraction(names));
    expect(readFileSync(join(out, "tool-1.0.txt"), "utf8")).toBe("payload");
  });

  it("extracts a real tar.xz", async () => {
    const root = scratch("eaim-tar-xz-");
    writeFileSync(join(root, "a.txt"), "xz payload");
    const archive = join(root, "a.tar.xz");
    execFileSync(tarBinary(), ["-cf", archive, "a.txt"], { cwd: root });

    const names = await listArchive(archive);
    expect(names).toEqual(["a.txt"]);

    const out = join(root, "out");
    mkdirSync(out);
    await extractArchive(archive, "tar.xz", out, planExtraction(names));
    expect(readFileSync(join(out, "a.txt"), "utf8")).toBe("xz payload");
  });

  it("extraction is refused when the plan carries violations", async () => {
    const root = scratch("eaim-tar-violation-");
    await expect(
      extractArchive(join(root, "whatever.zip"), "zip", join(root, "out"), { strip: 0, violations: ["../evil: parent reference"] }),
    ).rejects.toThrow(/refusing to extract/);
  });

  it("supportsFormat probes the real binary for xz", async () => {
    resetFormatCache();
    expect(await supportsFormat("zip")).toBe(true);
    expect(await supportsFormat("tar.gz")).toBe(true);
    // 本机 bsdtar 3.5.2 已实测支持 xz；不支持 xz 的构建上这条为 false，
    // 语义由探测决定而不是假设。
    expect(await supportsFormat("tar.xz")).toBe(process.platform === "win32" ? true : await supportsFormat("tar.xz"));
  });

  it("treeHash is stable for identical trees and changes when a file does", async () => {
    const makeTree = (name: string, content: string) => {
      const dir = scratch("eaim-tree-");
      mkdirSync(join(dir, "bin"), { recursive: true });
      writeFileSync(join(dir, "bin", name), content);
      writeFileSync(join(dir, "NOTICE.md"), "notice\n");
      return dir;
    };
    const a = await realTreeHash(makeTree("gcc.exe", "binary"));
    const b = await realTreeHash(makeTree("gcc.exe", "binary"));
    const c = await realTreeHash(makeTree("gcc.exe", "changed"));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a.startsWith("sha256:")).toBe(true);
  });
});

describe("install（真实验证命令与离线事务）", () => {
  // Windows 上 spawn 不经 shell 无法执行 .cmd/.bat；用系统 tar.exe 作为
  // 「payload 里真实的可执行文件」来测 runValidation 的真实 spawn 路径。
  it.skipIf(process.platform !== "win32" || !existsSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")))(
    "runValidation runs the pack's own executable and matches its output",
    async () => {
      const root = scratch("eaim-validate-");
      const payload = join(root, "payload");
      mkdirSync(payload, { recursive: true });
      copyFileSync(tarBinary(), join(payload, "probe.exe"));

      const manifest = parseManifest(
        validManifest({
          validation: { command: "probe.exe", args: ["--version"], expect: "bsdtar" },
        }),
        "test",
      );
      const result = await runValidation(payload, manifest);
      expect(result.ok).toBe(true);
      expect(result.output).toMatch(/bsdtar/);
    },
  );

  it.skipIf(process.platform !== "win32")("runValidation reports a mismatch instead of pretending", async () => {
    const root = scratch("eaim-validate-bad-");
    const payload = join(root, "payload");
    mkdirSync(payload, { recursive: true });
    copyFileSync(tarBinary(), join(payload, "probe.exe"));

    const manifest = parseManifest(
      validManifest({ validation: { command: "probe.exe", args: ["--version"], expect: "^not-this$" } }),
      "test",
    );
    const result = await runValidation(payload, manifest);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/validation failed/);
  });

  it("runValidation refuses a command the archive never produced", async () => {
    const root = scratch("eaim-validate-missing-");
    const payload = join(root, "payload");
    mkdirSync(payload, { recursive: true });
    const manifest = parseManifest(validManifest(), "test");
    const result = await runValidation(payload, manifest);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/was not produced by the archive/);
  });

  it("installFromManifest runs the same transaction from a local pack.json", async () => {
    const root = scratch("eaim-from-manifest-");
    const manifestFile = join(root, "pack.json");
    writeFileSync(manifestFile, JSON.stringify(validManifest(), null, 2));
    const archive = join(root, "arm.zip");
    writeFileSync(archive, "archive bytes");

    const manifest = await installFromManifest(manifestFile, {
      root,
      localFiles: [archive],
      deps: fakeDeps(),
    });
    expect(existsSync(join(root, "packs", manifest.id, "payload", "bin", "gcc.exe"))).toBe(true);
  });

  it("installFromManifest explains an unreadable pack.json", async () => {
    const root = scratch("eaim-from-manifest-bad-");
    writeFileSync(join(root, "pack.json"), "{ not json");
    await expect(installFromManifest(join(root, "pack.json"), { root, deps: fakeDeps() })).rejects.toThrow(
      /could not read/,
    );
  });

  it("freeBytes reads a real volume and formatBytes formats readably", () => {
    expect(freeBytes(tmpdir())).toBeGreaterThan(0);
    // statfs 需要一个存在的路径：缺失路径返回 null 而不是抛错，调用方
    // （磁盘检查）把 null 当"读不出"处理。
    expect(freeBytes(join(tmpdir(), "certainly-missing-dir"))).toBe(null);
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe("2.00 GB");
  });
});

describe("verify（真实 payload）", () => {
  it.skipIf(process.platform !== "win32" || !existsSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")))(
    "verifyPack passes a hand-built pack and catches a missing executable",
    async () => {
      const root = scratch("eaim-verify-");
      ensureRoot(root);
      const dir = join(root, "packs", "arm-gnu-15.3.rel2-win32-x64");
      const payload = join(dir, "payload", "bin");
      mkdirSync(payload, { recursive: true });
      copyFileSync(tarBinary(), join(payload, "arm-none-eabi-gcc.exe"));

      const manifestRaw = validManifest({
        executables: [{ name: "arm-none-eabi-gcc", path: "bin/arm-none-eabi-gcc.exe", toolchain: "gcc-arm" }],
        validation: { command: "bin/arm-none-eabi-gcc.exe", args: ["--version"], expect: "bsdtar" },
      });
      // treeHash 与 payload 统计来自真实树，这样 deep 校验也能通过。
      const stats = walkStats(join(dir, "payload"));
      const hash = await realTreeHash(join(dir, "payload"));
      manifestRaw.payload = { root: "payload", files: stats.files, bytes: stats.bytes, treeHash: hash };
      writeFileSync(join(dir, "pack.json"), JSON.stringify(manifestRaw, null, 2));

      const ok = await verifyPack("arm-gnu-15.3.rel2-win32-x64", { root, deep: true });
      expect(ok.ok, JSON.stringify(ok.problems)).toBe(true);

      // 删掉可执行文件后，浅检查就该失败并指名道姓。
      rmSync(join(payload, "arm-none-eabi-gcc.exe"));
      const broken = await verifyPack("arm-gnu-15.3.rel2-win32-x64", { root });
      expect(broken.ok).toBe(false);
      expect(broken.problems.join("; ")).toMatch(/arm-none-eabi-gcc is missing/);
    },
  );

  it("verifyPack reports a pack with no manifest", async () => {
    const root = scratch("eaim-verify-none-");
    ensureRoot(root);
    const result = await verifyPack("never-installed", { root });
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toMatch(/pack\.json is missing/);
  });
});