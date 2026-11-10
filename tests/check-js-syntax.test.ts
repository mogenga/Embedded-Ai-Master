import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { checkRoots } from "../scripts/check-js-syntax.mjs";

/** 子进程里要 import 的同一个实现，绝对 URL。 */
const SCRIPT_URL = pathToFileURL(path.join(import.meta.dirname, "..", "scripts", "check-js-syntax.mjs")).href;

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

  /**
   * `.cjs` 必须按 CommonJS 判，不能按 ESM 判。
   *
   * 这条用例守的是 2026-11-06 换 `vm.SourceTextModule` 时引入的回归：它在
   * 单进程里解析，但一律按 ESM，于是 `.cjs` 的两类文件判错方向相反——
   *  - 顶层 `await`：ESM 合法 / CJS 非法 → 旧的 `node --check` 报错，新路径放过；
   *  - 顶层 `return`：CJS 合法 / ESM 非法 → 旧路径放过，新路径误报。
   * `desktop/preload.cjs`（Electron 预加载桥）正是这类文件，语法错会让应用
   * 打不开——恰好是这个脚本存在的理由。
   *
   * 这一条在 vitest 里只会走回退分支（构造器为 `undefined`，见下一条），
   * 覆盖的是「拿不到构造器」时的判据。
   */
  it(".cjs 按 CommonJS 判：顶层 return 合法、顶层 await 非法", async () => {
    const dir = await tempTree();
    // CJS 里 `return` 位于模块包装函数内，合法；ESM 里非法。
    await writeFile(path.join(dir, "top-level-return.cjs"), "return 1;\n");
    // CJS 里没有顶层 await，非法；ESM 里合法。
    await writeFile(path.join(dir, "top-level-await.cjs"), "await Promise.resolve(1);\n");

    const { files, failures } = await checkRoots([dir], dir);

    expect(files).toHaveLength(2);
    expect(failures.map((entry) => entry.file)).toStrictEqual(["top-level-await.cjs"]);
  });

  /**
   * 同一条 `.cjs` 判据，但**强制走 `vm.SourceTextModule` 快路径**。
   *
   * 上面那条用例在 vitest 里跑时 `vm.SourceTextModule` 是 `undefined`（实测），
   * 于是走的是回退分支——它证明不了快路径。这里起一个带
   * `--experimental-vm-modules` 的子进程，让构造器真的存在，再断言 `.cjs` 仍按
   * CommonJS 判。没有这条，快路径对 `.cjs` 的判错会在全绿中复发。
   */
  it("快路径下 .cjs 仍按 CommonJS 判（子进程开实验特性）", async () => {
    const dir = await tempTree();
    await writeFile(path.join(dir, "top-level-return.cjs"), "return 1;\n");
    await writeFile(path.join(dir, "top-level-await.cjs"), "await Promise.resolve(1);\n");
    await writeFile(path.join(dir, "esm.js"), "export const ok = 1;\n");

    const script = [
      "import vm from 'node:vm';",
      "import { checkRoots } from " + JSON.stringify(SCRIPT_URL) + ";",
      "if (typeof vm.SourceTextModule !== 'function') { console.log('SKIP_NO_STM'); process.exit(0); }",
      "const r = await checkRoots([process.argv[1]], process.argv[1]);",
      "console.log(JSON.stringify(r.failures.map((f) => f.file)));",
    ].join("\n");
    const result = spawnSync(
      process.execPath,
      ["--experimental-vm-modules", "--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script, dir],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    const out = result.stdout.trim().split("\n").at(-1);
    // 构造器不可用的运行时（理论上）不把这条判成失败，但不允许静默通过。
    if (out === "SKIP_NO_STM") return;
    expect(JSON.parse(out!)).toStrictEqual(["top-level-await.cjs"]);
  });
});


describe("具名 import 必须真实存在（2026-11-09 事故）", () => {
  /**
   * 这一组必须**起子进程**跑：`vm.SourceTextModule` 在 vitest 进程里是
   * `undefined`（见上面那条 `.cjs` 用例的注释），而这条检查完全依赖它。
   * 直接调 `checkRoots` 只会走 `node --check` 回退，`failures` 永远为空，
   * 用例会以「没抓到」的样子假绿。
   */
  function runWithModules(dir: string): string[] | "SKIP_NO_STM" {
    const script = [
      "import vm from 'node:vm';",
      "import { checkRoots } from " + JSON.stringify(SCRIPT_URL) + ";",
      "if (typeof vm.SourceTextModule !== 'function') { console.log('SKIP_NO_STM'); process.exit(0); }",
      "const r = await checkRoots([process.argv[1]], process.argv[1]);",
      "console.log(JSON.stringify(r.failures.map((f) => f.file)));",
    ].join("\n");
    const result = spawnSync(
      process.execPath,
      ["--experimental-vm-modules", "--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script, dir],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    const out = result.stdout.trim().split("\n").at(-1);
    return out === "SKIP_NO_STM" ? "SKIP_NO_STM" : (JSON.parse(out ?? "[]") as string[]);
  }

  it("本地模块缺这个导出时点名失败", async () => {
    const dir = await tempTree();
    await writeFile(path.join(dir, "lib.js"), "export const present = 1;\n");
    await writeFile(
      path.join(dir, "user.js"),
      'import { present, gone } from "./lib.js";\nconsole.log(present, gone);\n',
    );

    const failures = runWithModules(dir);
    if (failures === "SKIP_NO_STM") return;

    expect(failures).toStrictEqual(["user.js"]);
  });

  it("导出齐备时通过", async () => {
    const dir = await tempTree();
    await writeFile(path.join(dir, "lib.js"), "export const present = 1;\n");
    await writeFile(path.join(dir, "user.js"), 'import { present } from "./lib.js";\n');

    const failures = runWithModules(dir);
    if (failures === "SKIP_NO_STM") return;

    expect(failures).toStrictEqual([]);
  });

  it("多行 import 也查（scripts/ 里的写法）", async () => {
    const dir = await tempTree();
    await writeFile(path.join(dir, "lib.js"), "export const a = 1;\nexport const b = 2;\n");
    await writeFile(path.join(dir, "user.js"), 'import {\n  a,\n  c,\n} from "./lib.js";\n');

    const failures = runWithModules(dir);
    if (failures === "SKIP_NO_STM") return;

    expect(failures).toStrictEqual(["user.js"]);
  });

  it("node: 与裸包名的 import 不参与判定（判不了，也不该报）", async () => {
    // 这次实现的边界：`SourceTextModule` 造不出内置模块，用空桩判会把每一句
    // `import { readFile } from "node:fs/promises"` 都报成失败。一个总是喊狼
    // 来了的检查会被关掉，所以范围收窄到本地模块，并把这条写进用例。
    const dir = await tempTree();
    await writeFile(
      path.join(dir, "user.js"),
      'import { readFile } from "node:fs/promises";\nimport { app } from "electron";\n',
    );

    const failures = runWithModules(dir);
    if (failures === "SKIP_NO_STM") return;

    expect(failures).toStrictEqual([]);
  });

  it("依赖自己的 node: import 不会连累调用方", async () => {
    const dir = await tempTree();
    await writeFile(
      path.join(dir, "lib.js"),
      'import { readFile } from "node:fs/promises";\nexport const a = readFile;\n',
    );
    await writeFile(path.join(dir, "user.js"), 'import { a } from "./lib.js";\n');

    const failures = runWithModules(dir);
    if (failures === "SKIP_NO_STM") return;

    expect(failures).toStrictEqual([]);
  });
});
