import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkRoots } from "../scripts/check-js-syntax.mjs";

/**
 * `scripts/check-js-syntax.mjs` 的行为锁定。
 *
 * 这一步存在的原因是一个实测过的盲区：`tsconfig.json` 只 include
 * `src`/`tests`/`mcp-servers`，`allowJs` 未开启，所以 `desktop/renderer/app.js`
 * 与 `settings.js` 不在 tsc 里，也没有测试导入它们。往 `app.js` 里塞一段语法
 * 错误，`npm test` 仍然全绿——CI 会放行一个打不开的应用。
 *
 * 所以这里测的不是「当前仓库干净」（那只能证明今天没坏），而是**它到底抓不抓
 * 得住**：造一个临时目录，放一个语法正确的文件与一个坏文件，断言只点名后者。
 */

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempTree(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "check-js-"));
  dirs.push(dir);
  return dir;
}

describe("checkRoots", () => {
  it("语法正确的 .js/.mjs/.cjs 全部通过", async () => {
    const dir = await tempTree();
    await writeFile(path.join(dir, "ok.js"), "export const a = 1;\n");
    await writeFile(path.join(dir, "ok.mjs"), "export const b = 2;\n");
    await writeFile(path.join(dir, "ok.cjs"), "module.exports = 3;\n");

    const { files, failures } = await checkRoots([dir], dir);

    expect(files).toHaveLength(3);
    expect(failures).toStrictEqual([]);
  });

  it("语法错误被抓到并点名，正确的文件不受牵连", async () => {
    const dir = await tempTree();
    await writeFile(path.join(dir, "good.js"), "export const ok = true;\n");
    // 未闭合的括号：这正是 2026-11-03 往 app.js 里注入的那类错误。
    await writeFile(path.join(dir, "bad.js"), "function broken( {\n");

    const { files, failures } = await checkRoots([dir], dir);

    expect(files).toHaveLength(2);
    expect(failures.map((entry) => entry.file)).toStrictEqual(["bad.js"]);
    // 报错里必须有 Node 自己算好的位置，而不是一句笼统的「失败了」。
    expect(failures[0]?.failure).toContain("bad.js");
  });

  it("非 JS 扩展名不参与", async () => {
    const dir = await tempTree();
    await writeFile(path.join(dir, "notes.md"), "function broken( {\n");
    await writeFile(path.join(dir, "data.json"), "{ not json");
    await writeFile(path.join(dir, "real.js"), "export const a = 1;\n");

    const { files } = await checkRoots([dir], dir);

    expect(files.map((file) => path.basename(file))).toStrictEqual(["real.js"]);
  });

  it("跳过 node_modules / build / dist 等产物目录", async () => {
    const dir = await tempTree();
    for (const skipped of ["node_modules", "build", "dist", "dist-mcp", "dist-installer"]) {
      await mkdir(path.join(dir, skipped), { recursive: true });
      // 产物目录里的坏文件不该让检查失败——我们不负责它们的语法。
      await writeFile(path.join(dir, skipped, "broken.js"), "function broken( {\n");
    }
    await writeFile(path.join(dir, "source.js"), "export const a = 1;\n");

    const { files, failures } = await checkRoots([dir], dir);

    expect(files.map((file) => path.basename(file))).toStrictEqual(["source.js"]);
    expect(failures).toStrictEqual([]);
  });

  it("递归进子目录", async () => {
    const dir = await tempTree();
    await mkdir(path.join(dir, "a", "b"), { recursive: true });
    await writeFile(path.join(dir, "a", "b", "deep.js"), "function nope( {\n");

    const { files, failures } = await checkRoots([dir], dir);

    expect(files).toHaveLength(1);
    expect(failures.map((entry) => entry.file.split(path.sep).join("/"))).toStrictEqual([
      "a/b/deep.js",
    ]);
  });

  it("根目录不存在时返回空结果，不抛错", async () => {
    // 与 `collect` 的 try/catch 一致：扫描一个不存在的目录是「没有文件」，
    // 不是异常——调用方靠 `files.length === 0` 报告「扫描路径写错了」。
    const missing = path.join(os.tmpdir(), `check-js-missing-${Date.now()}`);
    const { files, failures } = await checkRoots([missing], os.tmpdir());

    expect(files).toStrictEqual([]);
    expect(failures).toStrictEqual([]);
  });
});
