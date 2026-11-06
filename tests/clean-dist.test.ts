import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CLEANABLE_DIRS,
  cleanTarget,
  inspectTarget,
  main,
  resolveTarget,
} from "../scripts/clean.mjs";

/**
 * 构建前清理脚本测试。
 *
 * **绝不对真实仓库根执行删除**：所有会动文件系统的用例只在 `mkdtemp` 临时目录里
 * 跑，并且 `repoRoot` 一律由测试注入（`main` 的 `repoRoot` 选项 / `resolveTarget`
 * 的第二个参数）。白名单与越界拒绝用纯函数断言覆盖，不需要任何真实删除。
 */

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function makeLayout(root: string, names: string[]): Promise<void> {
  for (const name of names) {
    const dir = path.join(root, name);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "index.js"), "export {};\n", "utf8");
  }
}

/** 收集 `main` 的输出，避免测试往 stdout 乱写。 */
function recorder() {
  const lines: string[] = [];
  return { lines, write: (line: string) => lines.push(line) };
}

describe("resolveTarget（纯函数，参数 → 目标目录）", () => {
  it("dist → 仓库根下的 dist，dist-mcp → 仓库根下的 dist-mcp", () => {
    const root = path.resolve("/tmp/repo");
    expect(resolveTarget("dist", root)).toEqual({
      name: "dist",
      target: path.join(root, "dist"),
    });
    expect(resolveTarget("dist-mcp", root)).toEqual({
      name: "dist-mcp",
      target: path.join(root, "dist-mcp"),
    });
  });

  it("白名单只有两个目录（参数化而不是一次清两个）", () => {
    expect([...CLEANABLE_DIRS]).toEqual(["dist", "dist-mcp"]);
  });

  it.each([
    ["..", "父目录"],
    ["../dist", "带 .. 的相对路径"],
    ["dist/../../..", "多级 .."],
    ["/dist", "绝对路径（POSIX）"],
    ["C:\\dist", "绝对路径（Windows）"],
    ["dist/", "带分隔符"],
    ["distx", "名字相近但不白名单"],
    ["src", "源码目录"],
    ["node_modules", "依赖目录"],
    ["desktop", "其它仓库目录"],
    ["", "空串"],
  ])("拒绝 %s（%s）", (name) => {
    expect(() => resolveTarget(name, path.resolve("/tmp/repo"))).toThrow();
  });

  it("拒绝后错误信息点名白名单（R3：说清楚为什么）", () => {
    expect(() => resolveTarget("src", path.resolve("/tmp/repo"))).toThrow(/dist-mcp/);
  });
});

describe("inspectTarget（临时目录内）", () => {
  it("不存在 → exists=false", async () => {
    const root = await tempDir("clean-dist-");
    expect(await inspectTarget(path.join(root, "dist"))).toEqual({ exists: false, symlink: false });
  });

  it("普通目录 → exists=true, symlink=false", async () => {
    const root = await tempDir("clean-dist-");
    await makeLayout(root, ["dist"]);
    expect(await inspectTarget(path.join(root, "dist"))).toEqual({ exists: true, symlink: false });
  });

  it("符号链接 / 目录联接 → symlink=true", async (ctx) => {
    const root = await tempDir("clean-dist-");
    const elsewhere = await tempDir("clean-dist-target-");
    try {
      await symlink(elsewhere, path.join(root, "dist"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      // Windows 上创建 junction 需要权限；拿不到就跳过，不伪造结果。
      if (error instanceof Error && "code" in error && ["EPERM", "EACCES"].includes(String(error.code))) {
        ctx.skip();
        return;
      }
      throw error;
    }
    expect(await inspectTarget(path.join(root, "dist"))).toEqual({ exists: true, symlink: true });
  });
});

describe("cleanTarget / main（只在注入的临时 root 上删除）", () => {
  it("只删目标目录，同级的另一个构建目录与普通文件不受影响", async () => {
    const root = await tempDir("clean-dist-");
    await makeLayout(root, ["dist", "dist-mcp"]);
    await writeFile(path.join(root, "package.json"), "{}\n", "utf8");

    const result = await cleanTarget(resolveTarget("dist", root));

    expect(result.removed).toBe(true);
    expect(await inspectTarget(path.join(root, "dist"))).toEqual({ exists: false, symlink: false });
    // dist-mcp 必须还在——这是「参数化、互不删除」的核心断言。
    expect((await readdir(path.join(root, "dist-mcp"))).sort()).toEqual(["index.js"]);
    expect((await readdir(root)).sort()).toEqual(["dist-mcp", "package.json"]);
  });

  it("清理 dist-mcp 时不动 dist", async () => {
    const root = await tempDir("clean-dist-");
    await makeLayout(root, ["dist", "dist-mcp"]);

    await cleanTarget(resolveTarget("dist-mcp", root));

    expect(await inspectTarget(path.join(root, "dist-mcp"))).toEqual({ exists: false, symlink: false });
    expect((await readdir(path.join(root, "dist"))).sort()).toEqual(["index.js"]);
  });

  it("目标不存在 → 静默成功（removed=false，不抛错）", async () => {
    const root = await tempDir("clean-dist-");
    const result = await cleanTarget(resolveTarget("dist", root));
    expect(result.removed).toBe(false);
  });

  it("符号链接目标被拒绝，链接指向的目录原样保留", async (ctx) => {
    const root = await tempDir("clean-dist-");
    const victim = await tempDir("clean-dist-victim-");
    await writeFile(path.join(victim, "precious.txt"), "keep me\n", "utf8");
    try {
      await symlink(victim, path.join(root, "dist"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (error instanceof Error && "code" in error && ["EPERM", "EACCES"].includes(String(error.code))) {
        ctx.skip();
        return;
      }
      throw error;
    }

    await expect(cleanTarget(resolveTarget("dist", root))).rejects.toThrow(/符号链接/);
    expect(await readdir(victim)).toEqual(["precious.txt"]);
  });

  it("main 收到越界参数 → 退出码 1，且不删除任何东西", async () => {
    const root = await tempDir("clean-dist-");
    await makeLayout(root, ["dist"]);
    const out = recorder();
    const err = recorder();

    const code = await main([".."], { repoRoot: root, log: out.write, errorLog: err.write });

    expect(code).toBe(1);
    expect(err.lines.join("\n")).toContain("dist-mcp");
    expect((await readdir(path.join(root, "dist"))).sort()).toEqual(["index.js"]);
  });

  it("main 参数个数不对 → 退出码 1（不允许一次清两个）", async () => {
    const root = await tempDir("clean-dist-");
    await makeLayout(root, ["dist", "dist-mcp"]);
    const err = recorder();

    const code = await main(["dist", "dist-mcp"], { repoRoot: root, errorLog: err.write });

    expect(code).toBe(1);
    expect(await inspectTarget(path.join(root, "dist"))).toEqual({ exists: true, symlink: false });
    expect(await inspectTarget(path.join(root, "dist-mcp"))).toEqual({ exists: true, symlink: false });
  });

  it("main 正常路径 → 退出码 0 并点名删掉的目录", async () => {
    const root = await tempDir("clean-dist-");
    await makeLayout(root, ["dist"]);
    const out = recorder();

    const code = await main(["dist"], { repoRoot: root, log: out.write, errorLog: recorder().write });

    expect(code).toBe(0);
    expect(out.lines.join("\n")).toContain(path.join(root, "dist"));
  });

  it("main 目标不存在 → 退出码 0，说明「无需清理」", async () => {
    const root = await tempDir("clean-dist-");
    const out = recorder();

    const code = await main(["dist-mcp"], { repoRoot: root, log: out.write, errorLog: recorder().write });

    expect(code).toBe(0);
    expect(out.lines.join("\n")).toContain("无需清理");
  });

  it("main --help → 退出码 0，打印用法", async () => {
    const out = recorder();
    const code = await main(["--help"], { repoRoot: await tempDir("clean-dist-"), log: out.write });
    expect(code).toBe(0);
    expect(out.lines.join("\n")).toContain("dist-mcp");
  });
});
