#!/usr/bin/env node
/**
 * 对 `desktop/` 与 `scripts/` 下的每个 JS 文件跑一次 `node --check`。
 *
 * **为什么需要它**：`tsconfig.json` 只 include `src` / `tests` / `mcp-servers`，
 * 而 `allowJs` 未开启——`desktop/renderer/app.js`（7561 行）与 `settings.js`
 * （4609 行）因此不在任何静态检查里。vitest 也不导入它们（只有 `protocol.js`
 * 这类纯函数有测试）。实测：往 `app.js` 末尾塞一段语法错误，`npm test` 仍然
 * 468 passed 全绿，CI 一句话不说——而那是一个会让应用打不开的错误。
 *
 * `main.js` 的 `stopHost` 事故（D-220）是同一盲区的另一面：主进程脚本既不在
 * tsc 里，也没有运行时测试加载它。`node --check` 只查语法、不查作用域，但那
 * 一类错误已经有 `tests/desktop/main-scope.test.js` 用静态解析兜住。
 *
 * **为什么是独立脚本而不是 CI 里写一段 PowerShell**：CI 与本地要跑同一个实现，
 * 否则「本地绿、CI 红」这类问题会转移到这里来。
 *
 * 退出码：0 = 全部通过；1 = 有文件不通过（逐个点名，不静默）。
 */

import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** 要扫的目录。刻意只列这两个：`src/` 有 tsc，`.tmp/` 是临时产物。 */
const ROOTS = ["desktop", "scripts"];

/**
 * 不扫的目录。`node_modules` 是依赖，`build` / `dist-installer` 是产物，
 * `dist*` 由 tsc 写出——它们都不用我们来判语法。
 */
const SKIP_DIRS = new Set(["node_modules", "build", "dist-installer", "dist", "dist-mcp", ".git"]);

const EXTENSIONS = new Set([".js", ".cjs", ".mjs"]);

export async function collect(dir) {
  const found = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      found.push(...(await collect(full)));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!EXTENSIONS.has(path.extname(entry.name))) continue;
    found.push(full);
  }
  return found;
}

/**
 * `node --check` 的退出码是唯一判据；stdout/stderr 里是 Node 自己报的行号，
 * 原样转给用户即可（重新格式化只会丢掉它已经算好的位置）。
 */
export async function checkFile(file) {
  try {
    await execFileAsync(process.execPath, ["--check", file], { cwd: ROOT });
    return undefined;
  } catch (error) {
    const detail = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
    return detail === "" ? `node --check 退出码 ${error.code}` : detail;
  }
}

async function main() {
  const { files, failures } = await checkRoots(
    ROOTS.map((root) => path.join(ROOT, root)),
    ROOT,
  );

  if (files.length === 0) {
    console.error("check-js-syntax: 没找到任何 JS 文件——扫描路径写错了？");
    process.exit(1);
  }

  if (failures.length === 0) {
    console.log(`check-js-syntax: ${files.length} 个文件全部通过`);
    return;
  }

  console.error(`check-js-syntax: ${failures.length}/${files.length} 个文件不通过`);
  for (const { file, failure } of failures) {
    console.error(`\n${file}\n${failure.split("\n").map((line) => `  ${line}`).join("\n")}`);
  }
  // 非零退出交给调用方（npm script / CI）当失败处理。
  process.exitCode = 1;
}

/**
 * 扫一组根目录并逐个检查。返回不通过的文件（相对 `baseDir`），空数组即全通过。
 *
 * 抽成函数是为了让测试能指向一个临时目录：直接跑 CLI 会检查整个仓库，
 * 那样测试只能验证「当前仓库是干净的」，永远造不出失败情形。
 */
export async function checkRoots(roots, baseDir = ROOT) {
  const files = [];
  for (const root of roots) files.push(...(await collect(root)));
  files.sort();

  const failures = [];
  for (const file of files) {
    // eslint-disable-next-line no-await-in-loop -- 顺序执行，报错按路径排序输出
    const failure = await checkFile(file);
    if (failure !== undefined) failures.push({ file: path.relative(baseDir, file), failure });
  }
  return { files, failures };
}

const invokedDirectly =
  process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) await main();
