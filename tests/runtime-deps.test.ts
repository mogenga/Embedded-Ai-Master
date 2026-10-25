import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RuntimeDepsError,
  collectSpecifiers,
  computeClosure,
  parseArgs,
  planCopies,
  resolveKey,
  stageRuntimeDeps,
} from "../scripts/runtime-deps.mjs";

/**
 * 打包前置脚本（运行时依赖闭包）测试。
 *
 * 全部在 `mkdtemp` 临时目录内，**绝不读真实 `node_modules`、绝不触网、绝不跑 npm**：
 * 每个用例造一份合成的 `package-lock.json` 与几个假包目录。理由与
 * `tests/corpus-stage.test.ts` 一致——用真实依赖会让「算法对不对」与「当前装了
 * 什么」纠缠在一起，机器一换结果就变。
 */

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function tempRoot(prefix = "eam-rtdeps-") {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/**
 * 造一个仓库布局：`package-lock.json` + `dist/` + `dist-mcp/` + 假的 `node_modules`。
 *
 * `lockPackages` 直接写进 lockfile 的 `packages` 段；`onDisk` 是实际创建目录的
 * 落点路径 —— 两者分开传，才能测「lockfile 里有但盘上没有」这类错配。
 */
type MakeRepoOptions = {
  lockPackages?: Record<string, unknown>;
  onDisk?: string[];
  lockfileVersion?: number;
  distFiles?: Record<string, string>;
  distMcpFiles?: Record<string, string>;
};

async function makeRepo({
  lockPackages,
  onDisk,
  lockfileVersion = 3,
  distFiles = { "index.js": "export const x = 1;\n" },
  distMcpFiles = {},
}: MakeRepoOptions = {}) {
  const root = await tempRoot();
  await writeFileAt(
    root,
    "package-lock.json",
    JSON.stringify({ lockfileVersion, packages: lockPackages ?? {} }, null, 2),
  );
  await writeTree(root, "dist", distFiles);
  await writeTree(root, "dist-mcp", distMcpFiles);
  for (const key of onDisk ?? []) {
    await mkdir(path.join(root, ...key.split("/")), { recursive: true });
    await writeFile(path.join(root, ...key.split("/"), "package.json"), '{"name":"x"}\n', "utf8");
  }
  return root;
}

async function writeTree(root: string, dir: string, files: Record<string, string>) {
  await mkdir(path.join(root, dir), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(root, dir, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }
}

async function writeFileAt(root: string, relative: string, content: string) {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

/** 一件包的 lockfile 条目。 */
function pkg(version: string, dependencies: Record<string, string> = {}) {
  return { version, ...(Object.keys(dependencies).length > 0 ? { dependencies } : {}) };
}

describe("collectSpecifiers", () => {
  it("取出静态、导出、动态三种写法的包名", async () => {
    const root = await tempRoot();
    const file = path.join(root, "a.js");
    await writeFile(
      file,
      [
        'import { z } from "zod";',
        'import { Client } from "@modelcontextprotocol/client";',
        'export { thing } from "some-pkg/deep/path.js";',
        'const lazy = await import("lazy-pkg");',
        'import "./relative.js";',
        'import "/abs/path.js";',
        'import "node:fs";',
      ].join("\n"),
      "utf8",
    );

    expect(await collectSpecifiers([file])).toEqual([
      "@modelcontextprotocol/client",
      "lazy-pkg",
      "some-pkg",
      "zod",
    ]);
  });

  it("不把注释与字符串里的引号当成 import", async () => {
    // 这条是为一个实测撞到的假阳性留的：早期版本在整份文件里搜引号，
    // 把一条 throw new Error("...") 里的括注当成了包名。
    const root = await tempRoot();
    const file = path.join(root, "b.js");
    await writeFile(
      file,
      [
        "// import { z } from \"not-a-package\"",
        'const message = "from \\"also-not-a-package\\"";',
        'throw new Error("failed: see \\"docs/page.md\\"");',
        'import { z } from "zod";',
      ].join("\n"),
      "utf8",
    );

    expect(await collectSpecifiers([file])).toEqual(["zod"]);
  });

  it("同一包被多次 import 只出现一次", async () => {
    const root = await tempRoot();
    const file = path.join(root, "c.js");
    await writeFile(file, 'import "zod";\nimport { z } from "zod";\n', "utf8");

    expect(await collectSpecifiers([file])).toEqual(["zod"]);
  });

  it("没有 import 时返回空数组", async () => {
    const root = await tempRoot();
    const file = path.join(root, "d.js");
    await writeFile(file, "export const x = 1;\n", "utf8");

    expect(await collectSpecifiers([file])).toEqual([]);
  });
});

describe("resolveKey", () => {
  it("在根 node_modules 找到", () => {
    const packages = { "node_modules/zod": pkg("4.0.0") };
    expect(resolveKey(packages, "zod", "")).toBe("node_modules/zod");
  });

  it("优先找依赖自己的嵌套 node_modules", () => {
    const packages = {
      "node_modules/a": pkg("1.0.0"),
      "node_modules/a/node_modules/b": pkg("2.0.0"),
      "node_modules/b": pkg("1.0.0"),
    };
    expect(resolveKey(packages, "b", "node_modules/a")).toBe("node_modules/a/node_modules/b");
    // 从根出发仍是根那份 —— 嵌套只对它自己的父包生效。
    expect(resolveKey(packages, "b", "")).toBe("node_modules/b");
  });

  it("从深层依赖逐级向上找", () => {
    const packages = {
      "node_modules/a/node_modules/b/node_modules/c": pkg("1.0.0"),
      "node_modules/zod": pkg("4.0.0"),
    };
    expect(resolveKey(packages, "zod", "node_modules/a/node_modules/b/node_modules/c")).toBe(
      "node_modules/zod",
    );
  });

  it("找不到时返回 null", () => {
    expect(resolveKey({ "node_modules/zod": pkg("4.0.0") }, "absent", "")).toBeNull();
  });
});

describe("computeClosure", () => {
  it("沿 dependencies 走到头", () => {
    const packages = {
      "node_modules/a": pkg("1.0.0", { b: "^1.0.0" }),
      "node_modules/b": pkg("1.0.0", { c: "^1.0.0" }),
      "node_modules/c": pkg("1.0.0"),
      "node_modules/unrelated": pkg("1.0.0"),
    };

    expect(computeClosure(packages, ["a"])).toEqual({
      keys: ["node_modules/a", "node_modules/b", "node_modules/c"],
      missing: [],
    });
  });

  it("重复依赖不会无限循环", () => {
    const packages = {
      "node_modules/a": pkg("1.0.0", { b: "^1.0.0" }),
      "node_modules/b": pkg("1.0.0", { a: "^1.0.0" }),
    };

    const result = computeClosure(packages, ["a"]);
    expect(result.keys).toEqual(["node_modules/a", "node_modules/b"]);
  });

  it("optionalDependencies 里装了的一并带上", () => {
    const packages = {
      "node_modules/a": { ...pkg("1.0.0"), optionalDependencies: { opt: "^1.0.0" } },
      "node_modules/opt": pkg("1.0.0"),
    };

    expect(computeClosure(packages, ["a"]).keys).toEqual(["node_modules/a", "node_modules/opt"]);
  });

  it("入口解析不出时记进 missing，不静默跳过", () => {
    const packages = { "node_modules/a": pkg("1.0.0") };

    expect(computeClosure(packages, ["a", "absent"])).toEqual({
      keys: ["node_modules/a"],
      missing: ["absent"],
    });
  });

  it("嵌套依赖指向嵌套落点而不是根", () => {
    const packages = {
      "node_modules/a": pkg("1.0.0", { b: "^2.0.0" }),
      "node_modules/a/node_modules/b": pkg("2.0.0"),
      "node_modules/b": pkg("1.0.0"),
    };

    expect(computeClosure(packages, ["a"]).keys).toEqual([
      "node_modules/a",
      "node_modules/a/node_modules/b",
    ]);
  });
});

describe("planCopies", () => {
  it("剥掉根 node_modules 前缀，保留嵌套", () => {
    const plan = planCopies("E:/repo", [
      "node_modules/zod",
      "node_modules/a/node_modules/b",
    ]);

    expect(plan).toEqual([
      { from: path.join("E:/repo", "node_modules", "zod"), to: "zod" },
      { from: path.join("E:/repo", "node_modules", "a", "node_modules", "b"), to: "a/node_modules/b" },
    ]);
  });
});

describe("parseArgs", () => {
  it("--help", () => {
    expect(parseArgs(["--help"])).toEqual({ help: true });
    expect(parseArgs(["-h"])).toEqual({ help: true });
  });

  it("--out 与 --repo-root", () => {
    expect(parseArgs(["--out", "x", "--repo-root", "y"])).toEqual({
      verifyOnly: false,
      out: "x",
      repoRoot: "y",
    });
  });

  it("--verify-only", () => {
    expect(parseArgs(["--verify-only"])).toEqual({ verifyOnly: true });
  });

  it("--verify-only 与 --out 同时给报错", () => {
    expect(() => parseArgs(["--verify-only", "--out", "x"])).toThrow(RuntimeDepsError);
  });

  it("缺 --out 且不是 --verify-only 时报错", () => {
    expect(() => parseArgs([])).toThrow(/--out/);
  });

  it("--out 缺少值时报错", () => {
    expect(() => parseArgs(["--out"])).toThrow(RuntimeDepsError);
    expect(() => parseArgs(["--out", "--verify-only"])).toThrow(RuntimeDepsError);
  });

  it("不认识的参数报错", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/不认识的参数/);
  });
});

describe("stageRuntimeDeps", () => {
  /** 一份最小可用的仓库：dist import zod，lockfile 里 zod 在根。 */
  async function minimalRepo() {
    return makeRepo({
      lockPackages: { "node_modules/zod": pkg("4.0.0") },
      onDisk: ["node_modules/zod"],
      distFiles: { "index.js": 'import { z } from "zod";\nexport const x = z;\n' },
    });
  }

  it("装上闭包里的包，其它不装", async () => {
    const root = await minimalRepo();
    const out = path.join(root, "out");

    const result = await stageRuntimeDeps({ repoRoot: root, outDir: out, log: () => {} });

    expect(result.packages).toEqual(["node_modules/zod"]);
    expect(result.verifyOnly).toBe(false);
    const entries = (await readdir(out)).sort();
    expect(entries).toEqual(["runtime-deps.json", "zod"]);
    expect(await readFile(path.join(out, "zod", "package.json"), "utf8")).toBe('{"name":"x"}\n');
  });

  it("写出 runtime-deps.json 记录版本", async () => {
    const root = await minimalRepo();
    const out = path.join(root, "out");

    await stageRuntimeDeps({ repoRoot: root, outDir: out, log: () => {} });

    const manifest = JSON.parse(await readFile(path.join(out, "runtime-deps.json"), "utf8"));
    expect(manifest.packageCount).toBe(1);
    expect(manifest.packages).toEqual([{ path: "node_modules/zod", version: "4.0.0" }]);
  });

  it("--verify-only 不写任何字节", async () => {
    const root = await minimalRepo();
    const out = path.join(root, "out");

    const result = await stageRuntimeDeps({ repoRoot: root, outDir: out, verifyOnly: true, log: () => {} });

    expect(result).toMatchObject({ verifyOnly: true, outDir: null, fileCount: 0 });
    await expect(stat(out)).rejects.toThrow();
  });

  it("输出目录已存在时拒绝，且不改动原内容", async () => {
    const root = await minimalRepo();
    const out = path.join(root, "out");
    await mkdir(out, { recursive: true });
    await writeFile(path.join(out, "keep.txt"), "untouched\n", "utf8");

    await expect(stageRuntimeDeps({ repoRoot: root, outDir: out, log: () => {} })).rejects.toThrow(
      /已存在/,
    );
    expect(await readFile(path.join(out, "keep.txt"), "utf8")).toBe("untouched\n");
    // 没有留下暂存目录。
    const siblings = (await readdir(root)).filter((name) => name.startsWith("out.staging"));
    expect(siblings).toEqual([]);
  });

  it("lockfile 里有但盘上没有 → 失败并点名，不产出目录", async () => {
    const root = await makeRepo({
      lockPackages: { "node_modules/zod": pkg("4.0.0") },
      onDisk: [], // 故意不建
      distFiles: { "index.js": 'import "zod";\n' },
    });
    const out = path.join(root, "out");

    await expect(stageRuntimeDeps({ repoRoot: root, outDir: out, log: () => {} })).rejects.toThrow(
      /依赖目录\s*不存在/,
    );
    await expect(stat(out)).rejects.toThrow();
  });

  it("产物 import 的包不在 lockfile 里 → 失败并点名", async () => {
    const root = await makeRepo({
      lockPackages: { "node_modules/zod": pkg("4.0.0") },
      onDisk: ["node_modules/zod"],
      distFiles: { "index.js": 'import "ghost-pkg";\n' },
    });

    await expect(
      stageRuntimeDeps({ repoRoot: root, outDir: path.join(root, "out"), log: () => {} }),
    ).rejects.toThrow(/ghost-pkg/);
  });

  it("dist-mcp 里的 import 也算数（MCP server 也要能起来）", async () => {
    const root = await makeRepo({
      lockPackages: {
        "node_modules/zod": pkg("4.0.0"),
        "node_modules/@modelcontextprotocol/server": pkg("2.3.1"),
      },
      onDisk: ["node_modules/zod", "node_modules/@modelcontextprotocol/server"],
      distFiles: { "index.js": 'import "zod";\n' },
      distMcpFiles: { "kb/server.js": 'import { McpServer } from "@modelcontextprotocol/server";\n' },
    });
    const out = path.join(root, "out");

    const result = await stageRuntimeDeps({ repoRoot: root, outDir: out, log: () => {} });

    expect(result.packages).toEqual([
      "node_modules/@modelcontextprotocol/server",
      "node_modules/zod",
    ]);
  });

  it("嵌套安装按原样落位", async () => {
    const root = await makeRepo({
      lockPackages: {
        "node_modules/a": pkg("1.0.0", { b: "^2.0.0" }),
        "node_modules/a/node_modules/b": pkg("2.0.0"),
      },
      onDisk: ["node_modules/a", "node_modules/a/node_modules/b"],
      distFiles: { "index.js": 'import "a";\n' },
    });
    const out = path.join(root, "out");

    await stageRuntimeDeps({ repoRoot: root, outDir: out, log: () => {} });

    expect(await stat(path.join(out, "a", "node_modules", "b", "package.json"))).toBeTruthy();
  });

  it("产物里没有任何 import → 失败（产物可能不是预期构建结果）", async () => {
    const root = await makeRepo({
      lockPackages: { "node_modules/zod": pkg("4.0.0") },
      onDisk: ["node_modules/zod"],
      distFiles: { "index.js": "export const x = 1;\n" },
    });

    await expect(
      stageRuntimeDeps({ repoRoot: root, outDir: path.join(root, "out"), log: () => {} }),
    ).rejects.toThrow(/没有找到任何裸说明符/);
  });

  it("dist/ 不存在 → 失败", async () => {
    const root = await tempRoot();
    await writeFile(path.join(root, "package-lock.json"), '{"lockfileVersion":3,"packages":{}}', "utf8");

    await expect(
      stageRuntimeDeps({ repoRoot: root, outDir: path.join(root, "out"), log: () => {} }),
    ).rejects.toThrow(/内核产物目录\s*不存在/);
  });

  it("lockfileVersion 不是 2/3 → 拒绝（v1 的树形结构与落点算法不兼容）", async () => {
    const root = await makeRepo({
      lockPackages: { "node_modules/zod": pkg("4.0.0") },
      onDisk: ["node_modules/zod"],
      distFiles: { "index.js": 'import "zod";\n' },
      lockfileVersion: 1,
    });

    await expect(
      stageRuntimeDeps({ repoRoot: root, outDir: path.join(root, "out"), log: () => {} }),
    ).rejects.toThrow(/lockfileVersion/);
  });

  it("缺 --out 且不是 verify-only → 失败", async () => {
    await expect(stageRuntimeDeps({ log: () => {} })).rejects.toThrow(/--out/);
  });
});
