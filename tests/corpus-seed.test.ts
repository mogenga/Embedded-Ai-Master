import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readAppConfig, writeMcpServers } from "../src/config/app-config.js";
import { seedCorpus, seedKbMcpEntry } from "../src/corpus/seed.js";
import { getKbLayout, readCurrentVersion } from "../src/corpus/snapshot.js";
import { resolveKbRoot } from "../src/server/kb-locate.js";

// 全部用例只碰 os.tmpdir() 下的临时目录。绝不读写真实 $HARNESS_HOME（D-170：
// 测试曾把 fixture 写进用户真实配置目录，改变了真实运行行为）。
//
// 也不读真实私钥、不触网：这里根本没有网络与签名的位置——种子化只复制文件。

const roots: string[] = [];

function makeDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 造一份内置语料；`files` 的键是 POSIX 相对路径。 */
async function makeBundledCorpus(files: Record<string, string>): Promise<string> {
  const dir = makeDir("corpus-seed-bundled-");
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, ...relative.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
  return dir;
}

/** 造一个含 `dist-mcp/kb/server.js` 的 kernelRoot，模拟已构建的 MCP 产物。 */
function makeKernelRoot(): string {
  const root = makeDir("corpus-seed-kernel-");
  mkdirSync(path.join(root, "dist-mcp", "kb"), { recursive: true });
  writeFileSync(path.join(root, "dist-mcp", "kb", "server.js"), "// stub\n", "utf8");
  return root;
}

function mcpPath(home: string): string {
  return path.join(home, "mcp.json");
}

function readMcp(home: string): { mcpServers: Record<string, Record<string, unknown>> } {
  return JSON.parse(readFileSync(mcpPath(home), "utf8")) as {
    mcpServers: Record<string, Record<string, unknown>>;
  };
}

/** 写 `mcp.json` 的唯一合法途径：内核自己的写入器（原子落盘 + 字段校验）。 */
async function writeRawMcp(home: string, servers: Array<Record<string, unknown>>): Promise<void> {
  await writeMcpServers(home, servers);
}

describe("seedCorpus", () => {
  it("没有内置语料时返回 no_bundled_corpus，且不创建任何目录", async () => {
    const home = makeDir("corpus-seed-home-");
    const result = await seedCorpus({ harnessHome: home });
    expect(result).toStrictEqual({ seeded: false, reason: "no_bundled_corpus" });
    // 开发形态就是这样：一个字节都不该落盘。
    expect(existsSync(path.join(home, "kb"))).toBe(false);
  });

  it("resourcesRoot 下没有 corpus/ 时同样按 no_bundled_corpus 处理", async () => {
    const home = makeDir("corpus-seed-home-");
    const resources = makeDir("corpus-seed-resources-");
    const result = await seedCorpus({ harnessHome: home, resourcesRoot: resources });
    expect(result).toStrictEqual({ seeded: false, reason: "no_bundled_corpus" });
    expect(existsSync(path.join(home, "kb"))).toBe(false);
  });

  it("有内置语料时复制到 snapshots/v1，current 可解析，inbox 就位", async () => {
    const home = makeDir("corpus-seed-home-");
    const bundled = await makeBundledCorpus({
      "index.yaml": "version: 1\n",
      "protocols/uart/no-output.md": "# 无输出\n",
    });

    const result = await seedCorpus({ harnessHome: home, bundledCorpusDir: bundled });
    expect(result).toStrictEqual({ seeded: true, version: 1, fileCount: 2 });

    const layout = getKbLayout(home);
    expect(await readCurrentVersion(layout)).toBe(1);
    // `current` 真的指向 v1，而不是一个指不到东西的链接。
    expect(await realpath(layout.currentLink)).toBe(await realpath(path.join(layout.snapshotsDir, "v1")));
    expect(existsSync(layout.inboxDir)).toBe(true);
    expect(readFileSync(path.join(layout.snapshotsDir, "v1", "index.yaml"), "utf8")).toBe("version: 1\n");
    expect(
      readFileSync(path.join(layout.snapshotsDir, "v1", "protocols", "uart", "no-output.md"), "utf8"),
    ).toBe("# 无输出\n");
  });

  it("resourcesRoot 形态取 <resourcesRoot>/corpus 作为内置语料", async () => {
    const home = makeDir("corpus-seed-home-");
    const resources = makeDir("corpus-seed-resources-");
    const corpus = path.join(resources, "corpus");
    await mkdir(corpus, { recursive: true });
    await writeFile(path.join(corpus, "index.yaml"), "version: 1\n", "utf8");

    const result = await seedCorpus({ harnessHome: home, resourcesRoot: resources });
    expect(result).toStrictEqual({ seeded: true, version: 1, fileCount: 1 });
  });

  it("已存在 current 时返回 already_present，且一个字节都不改动", async () => {
    const home = makeDir("corpus-seed-home-");
    const bundled = await makeBundledCorpus({
      "index.yaml": "version: 1\n",
      "bundled-only.md": "# 随包版本\n",
    });
    const layout = getKbLayout(home);

    // 先物化一次，再改掉其中一个文件，模拟「用户已经通过 OTA 装过一版」。
    const first = await seedCorpus({ harnessHome: home, bundledCorpusDir: bundled });
    expect(first.seeded).toBe(true);
    const snapshotFile = path.join(layout.snapshotsDir, "v1", "index.yaml");
    writeFileSync(snapshotFile, "version: 99\n", "utf8");

    const second = await seedCorpus({ harnessHome: home, bundledCorpusDir: bundled });
    expect(second).toStrictEqual({ seeded: false, reason: "already_present", version: 1 });
    // 关键断言：没有被重新复制覆盖。
    expect(readFileSync(snapshotFile, "utf8")).toBe("version: 99\n");
    // 也没有多出内置语料里才有、快照里本来没有的文件。
    expect(existsSync(path.join(layout.snapshotsDir, "v1", "bundled-only.md"))).toBe(true);
  });

  it("current 存在时即便内置语料版本更高也不动它（种子化不是更新）", async () => {
    const home = makeDir("corpus-seed-home-");
    const firstBundled = await makeBundledCorpus({ "index.yaml": "version: 1\n" });
    await seedCorpus({ harnessHome: home, bundledCorpusDir: firstBundled });

    const newerBundled = await makeBundledCorpus({
      "index.yaml": "version: 1\n",
      "latest.json": JSON.stringify({
        manifestVersion: 1,
        corpusVersion: 5,
        publishedAt: "2026-10-23T12:00:00Z",
        files: [],
        signature: "AAAA",
      }),
    });
    const result = await seedCorpus({ harnessHome: home, bundledCorpusDir: newerBundled });
    expect(result).toStrictEqual({ seeded: false, reason: "already_present", version: 1 });
    // v5 根本不该被建出来。
    expect(existsSync(path.join(getKbLayout(home).snapshotsDir, "v5"))).toBe(false);
  });

  it("内置 latest.json 的 corpusVersion 决定快照目录名", async () => {
    const home = makeDir("corpus-seed-home-");
    const bundled = await makeBundledCorpus({
      "index.yaml": "version: 1\n",
      "latest.json": JSON.stringify({
        manifestVersion: 1,
        corpusVersion: 5,
        publishedAt: "2026-10-23T12:00:00Z",
        files: [{ path: "index.yaml", sha256: "0".repeat(64) }],
        signature: "AAAA",
      }),
    });

    const result = await seedCorpus({ harnessHome: home, bundledCorpusDir: bundled });
    expect(result).toStrictEqual({ seeded: true, version: 5, fileCount: 1 });
    const layout = getKbLayout(home);
    expect(await readCurrentVersion(layout)).toBe(5);
    expect((await readdir(layout.snapshotsDir)).sort()).toStrictEqual(["v5"]);
  });

  it("内置语料没有 latest.json 时只复制文件，不生成清单", async () => {
    const home = makeDir("corpus-seed-home-");
    const bundled = await makeBundledCorpus({
      "index.yaml": "version: 1\n",
      "protocols/i2c.md": "# i2c\n",
    });

    const result = await seedCorpus({ harnessHome: home, bundledCorpusDir: bundled });
    expect(result).toStrictEqual({ seeded: true, version: 1, fileCount: 2 });
    const snapshotDir = path.join(getKbLayout(home).snapshotsDir, "v1");
    // 客户端现算的清单没有签名，写进去只会被验签拒绝 —— 所以一份都不许有。
    expect(existsSync(path.join(snapshotDir, "latest.json"))).toBe(false);
    expect((await readdir(snapshotDir)).sort()).toStrictEqual(["index.yaml", "protocols"]);
  });

  it("内置 latest.json 存在时也不会被复制进快照（与 OTA 产物保持一致）", async () => {
    const home = makeDir("corpus-seed-home-");
    const bundled = await makeBundledCorpus({
      "index.yaml": "version: 1\n",
      "latest.json": JSON.stringify({
        manifestVersion: 1,
        corpusVersion: 2,
        publishedAt: "2026-10-23T12:00:00Z",
        files: [{ path: "index.yaml", sha256: "0".repeat(64) }],
        signature: "AAAA",
      }),
    });

    const result = await seedCorpus({ harnessHome: home, bundledCorpusDir: bundled });
    expect(result).toStrictEqual({ seeded: true, version: 2, fileCount: 1 });
    const snapshotDir = path.join(getKbLayout(home).snapshotsDir, "v2");
    expect((await readdir(snapshotDir)).sort()).toStrictEqual(["index.yaml"]);
  });

  it("同版本号的残留是链接时拒绝，不顺着链接删到别处", async () => {
    const home = makeDir("corpus-seed-home-");
    const bundled = await makeBundledCorpus({ "index.yaml": "version: 1\n" });
    const layout = getKbLayout(home);
    const elsewhere = makeDir("corpus-seed-elsewhere-");
    writeFileSync(path.join(elsewhere, "keep.md"), "# 别处的东西\n", "utf8");
    mkdirSync(layout.snapshotsDir, { recursive: true });
    // 一个指向别处的 `v1`：递归删除跟过去就会删掉别的目录。
    await symlink(elsewhere, path.join(layout.snapshotsDir, "v1"), "junction");

    await expect(seedCorpus({ harnessHome: home, bundledCorpusDir: bundled })).rejects.toThrow(
      /是链接/,
    );
    // 目标目录一个字节都没少。
    expect(readFileSync(path.join(elsewhere, "keep.md"), "utf8")).toBe("# 别处的东西\n");
  });

  it("内置语料里的 _inbox.md / _reviewed.md 不进快照", async () => {
    const home = makeDir("corpus-seed-home-");
    const bundled = await makeBundledCorpus({
      "index.yaml": "version: 1\n",
      "_inbox.md": "# inbox\n",
      "_reviewed.md": "# reviewed\n",
    });

    const result = await seedCorpus({ harnessHome: home, bundledCorpusDir: bundled });
    expect(result).toStrictEqual({ seeded: true, version: 1, fileCount: 1 });
    const snapshotDir = path.join(getKbLayout(home).snapshotsDir, "v1");
    expect((await readdir(snapshotDir)).sort()).toStrictEqual(["index.yaml"]);
  });

  it("同版本号的残留快照被清掉，物化结果正好等于内置语料", async () => {
    const home = makeDir("corpus-seed-home-");
    const bundled = await makeBundledCorpus({ "index.yaml": "version: 1\n" });
    // 上次被杀掉的物化留下的垃圾：不清理就会混进「完整快照」里。
    const staleDir = path.join(getKbLayout(home).snapshotsDir, "v1");
    mkdirSync(staleDir, { recursive: true });
    writeFileSync(path.join(staleDir, "stale.md"), "# 残留\n", "utf8");

    const result = await seedCorpus({ harnessHome: home, bundledCorpusDir: bundled });
    expect(result).toStrictEqual({ seeded: true, version: 1, fileCount: 1 });
    expect((await readdir(staleDir)).sort()).toStrictEqual(["index.yaml"]);
  });

  it("内置清单的 corpusVersion 不合法时抛错，且不留下半个 kb/", async () => {
    const home = makeDir("corpus-seed-home-");
    const bundled = await makeBundledCorpus({
      "index.yaml": "version: 1\n",
      "latest.json": JSON.stringify({ manifestVersion: 1, corpusVersion: 0 }),
    });

    await expect(seedCorpus({ harnessHome: home, bundledCorpusDir: bundled })).rejects.toThrow(
      /corpusVersion/,
    );
    expect(existsSync(path.join(home, "kb"))).toBe(false);
  });

  it("内置清单不是合法 JSON 时抛错（安装包坏了不能静默当成没有清单）", async () => {
    const home = makeDir("corpus-seed-home-");
    const bundled = await makeBundledCorpus({
      "index.yaml": "version: 1\n",
      "latest.json": "{ not json",
    });

    await expect(seedCorpus({ harnessHome: home, bundledCorpusDir: bundled })).rejects.toThrow(
      /不是合法 JSON/,
    );
    expect(existsSync(path.join(home, "kb"))).toBe(false);
  });

  it("空 HARNESS_HOME 直接拒绝，避免把快照写进进程当前目录", async () => {
    const bundled = await makeBundledCorpus({ "index.yaml": "version: 1\n" });
    await expect(seedCorpus({ harnessHome: "", bundledCorpusDir: bundled })).rejects.toThrow(
      /HARNESS_HOME/,
    );
  });
});

describe("seedKbMcpEntry", () => {
  const modules = { readAppConfig, writeMcpServers };

  /** 建好一个「已种子化」的 home 与其 kb 路径参数。 */
  async function seededHome(): Promise<{
    home: string;
    currentKbRoot: string;
    inboxPath: string;
  }> {
    const home = makeDir("corpus-seed-home-");
    const bundled = await makeBundledCorpus({ "index.yaml": "version: 1\n" });
    await seedCorpus({ harnessHome: home, bundledCorpusDir: bundled });
    const layout = getKbLayout(home);
    return {
      home,
      currentKbRoot: layout.currentLink,
      inboxPath: path.join(layout.inboxDir, "_inbox.md"),
    };
  }

  it("没有 mcp.json 时创建它，命令、参数与环境变量都正确", async () => {
    const kernelRoot = makeKernelRoot();
    const { home, currentKbRoot, inboxPath } = await seededHome();

    const result = await seedKbMcpEntry({
      harnessHome: home,
      kernelRoot,
      currentKbRoot,
      inboxPath,
      mcpModules: modules,
      env: {},
    });
    expect(result).toStrictEqual({ seeded: true });

    const document = readMcp(home);
    expect(Object.keys(document.mcpServers)).toStrictEqual(["kb"]);
    expect(document.mcpServers.kb).toStrictEqual({
      // 用户机器不保证装了 Node 24：必须用运行时的可执行文件本身。
      command: process.execPath,
      args: [path.join(kernelRoot, "dist-mcp", "kb", "server.js")],
      env: {
        KB_ROOT: currentKbRoot,
        KB_INBOX_PATH: inboxPath,
        ELECTRON_RUN_AS_NODE: "1",
      },
    });
  });

  it("已有 mcp.json 但无 kb 时追加，其它 server 原样保留", async () => {
    const kernelRoot = makeKernelRoot();
    const { home, currentKbRoot, inboxPath } = await seededHome();
    await writeRawMcp(home, [
      { name: "probe", command: "node", args: ["probe.js"], env: { PROBE: "1" } },
      { name: "keil", command: "node", args: ["keil.js"] },
    ]);

    const result = await seedKbMcpEntry({
      harnessHome: home,
      kernelRoot,
      currentKbRoot,
      inboxPath,
      mcpModules: modules,
      env: {},
    });
    expect(result).toStrictEqual({ seeded: true });

    const document = readMcp(home);
    expect(Object.keys(document.mcpServers).sort()).toStrictEqual(["kb", "keil", "probe"]);
    expect(document.mcpServers.probe).toStrictEqual({
      command: "node",
      args: ["probe.js"],
      env: { PROBE: "1" },
    });
    expect(document.mcpServers.keil).toStrictEqual({ command: "node", args: ["keil.js"] });
  });

  it("已有 kb 条目时不动它，返回 kb_entry_exists", async () => {
    const kernelRoot = makeKernelRoot();
    const { home, currentKbRoot, inboxPath } = await seededHome();
    // 用户自己指过路径：覆盖是不可接受的。
    const userEntry = {
      name: "kb",
      command: "/opt/custom-node",
      args: ["/srv/kb/server.js"],
      env: { KB_ROOT: "/srv/corpus" },
    };
    await writeRawMcp(home, [userEntry]);
    const before = readFileSync(mcpPath(home), "utf8");

    const result = await seedKbMcpEntry({
      harnessHome: home,
      kernelRoot,
      currentKbRoot,
      inboxPath,
      mcpModules: modules,
      env: {},
    });
    expect(result).toStrictEqual({ seeded: false, reason: "kb_entry_exists" });
    // 逐字节比对：连格式都不该被重写。
    expect(readFileSync(mcpPath(home), "utf8")).toBe(before);
  });

  it("没有 current 时不写 mcp.json（指向不存在的目录比回落更糟）", async () => {
    const kernelRoot = makeKernelRoot();
    const home = makeDir("corpus-seed-home-");
    const layout = getKbLayout(home);

    const result = await seedKbMcpEntry({
      harnessHome: home,
      kernelRoot,
      currentKbRoot: layout.currentLink,
      inboxPath: path.join(layout.inboxDir, "_inbox.md"),
      mcpModules: modules,
      env: {},
    });
    expect(result).toStrictEqual({ seeded: false, reason: "no_current_snapshot" });
    expect(existsSync(mcpPath(home))).toBe(false);
  });

  it("MCP server 未编译时不写指向空文件的配置", async () => {
    const { home, currentKbRoot, inboxPath } = await seededHome();
    const emptyKernel = makeDir("corpus-seed-kernel-empty-");

    const result = await seedKbMcpEntry({
      harnessHome: home,
      kernelRoot: emptyKernel,
      currentKbRoot,
      inboxPath,
      mcpModules: modules,
      env: {},
    });
    expect(result).toStrictEqual({ seeded: false, reason: "kb_server_missing" });
    expect(existsSync(mcpPath(home))).toBe(false);
  });

  it("KB_ROOT 被环境变量接管时不写，避免两处各说一个根", async () => {
    const kernelRoot = makeKernelRoot();
    const { home, currentKbRoot, inboxPath } = await seededHome();
    const override = makeDir("corpus-seed-override-");

    const result = await seedKbMcpEntry({
      harnessHome: home,
      kernelRoot,
      currentKbRoot,
      inboxPath,
      mcpModules: modules,
      env: { KB_ROOT: override },
    });
    expect(result).toStrictEqual({ seeded: false, reason: "kb_root_env_override" });
    expect(existsSync(mcpPath(home))).toBe(false);
  });

  it("写入后 resolveKbRoot 解析到新位置，来源是 mcp.json", async () => {
    const kernelRoot = makeKernelRoot();
    const { home, currentKbRoot, inboxPath } = await seededHome();
    const repoRoot = makeDir("corpus-seed-repo-");

    // 写之前：没有 mcp.json，回落到仓库默认目录。
    const before = resolveKbRoot({ harnessHome: home, repoRoot, env: {}, cwd: repoRoot });
    expect(before.source).toBe("default");

    await seedKbMcpEntry({
      harnessHome: home,
      kernelRoot,
      currentKbRoot,
      inboxPath,
      mcpModules: modules,
      env: {},
    });

    const after = resolveKbRoot({ harnessHome: home, repoRoot, env: {}, cwd: repoRoot });
    expect(after.source).toBe("mcp.json");
    expect(after.root).toBe(currentKbRoot);
    expect(after.note).toContain('"kb"');
  });

  it("设置页实际读到的根与 OTA 写入的快照是同一处", async () => {
    const kernelRoot = makeKernelRoot();
    const home = makeDir("corpus-seed-home-");
    const bundled = await makeBundledCorpus({ "index.yaml": "version: 1\n" });
    await seedCorpus({ harnessHome: home, bundledCorpusDir: bundled });
    const layout = getKbLayout(home);

    await seedKbMcpEntry({
      harnessHome: home,
      kernelRoot,
      currentKbRoot: layout.currentLink,
      inboxPath: path.join(layout.inboxDir, "_inbox.md"),
      mcpModules: modules,
      env: {},
    });

    const located = resolveKbRoot({
      harnessHome: home,
      repoRoot: makeDir("corpus-seed-repo-"),
      env: {},
      cwd: os.tmpdir(),
    });
    expect(located.source).toBe("mcp.json");
    // resolveKbRoot 返回的是 current 这个链接本身；解析到底必须落在 snapshots/v1。
    expect(await realpath(located.root)).toBe(await realpath(path.join(layout.snapshotsDir, "v1")));
    expect(await readCurrentVersion(layout)).toBe(1);
  });

  it("kernelRoot 为空时抛错，而不是拼出一个进程当前目录下的相对产物", async () => {
    const { home, currentKbRoot, inboxPath } = await seededHome();
    await expect(
      seedKbMcpEntry({
        harnessHome: home,
        kernelRoot: "  ",
        currentKbRoot,
        inboxPath,
        mcpModules: modules,
        env: {},
      }),
    ).rejects.toThrow(/kernelRoot/);
    expect(existsSync(mcpPath(home))).toBe(false);
  });

  it("mcp.json 本身损坏时抛错，绝不拿一份默认值盖掉用户文件", async () => {
    const kernelRoot = makeKernelRoot();
    const { home, currentKbRoot, inboxPath } = await seededHome();
    // 用户手编的 mcp.json 有个逗号写错了：这正是最不该被覆盖的时刻。
    const broken = '{ "mcpServers": { "probe": { "command": "node" , } } }';
    writeFileSync(mcpPath(home), broken, "utf8");

    await expect(
      seedKbMcpEntry({
        harnessHome: home,
        kernelRoot,
        currentKbRoot,
        inboxPath,
        mcpModules: modules,
        env: {},
      }),
    ).rejects.toThrow();
    expect(readFileSync(mcpPath(home), "utf8")).toBe(broken);
  });

  it("安装形态与开发形态都写绝对路径（不随会话 cwd 漂移）", async () => {
    const kernelRoot = makeKernelRoot();
    const { home, currentKbRoot, inboxPath } = await seededHome();
    await seedKbMcpEntry({
      harnessHome: home,
      kernelRoot,
      currentKbRoot,
      inboxPath,
      mcpModules: modules,
      env: {},
    });

    const entry = readMcp(home).mcpServers.kb as { args: string[]; env: Record<string, string> };
    expect(path.isAbsolute(entry.args[0]!)).toBe(true);
    expect(path.isAbsolute(entry.env.KB_ROOT!)).toBe(true);
    expect(path.isAbsolute(entry.env.KB_INBOX_PATH!)).toBe(true);
  });
});
