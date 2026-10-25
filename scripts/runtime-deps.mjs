/**
 * 打包前置脚本：把内核运行时真正需要的 `node_modules` 闭包装进一个可打包的目录。
 *
 * **为什么必须有这一步**：`dist/` 与 `dist-mcp/` 的编译产物保留了裸说明符
 * （`import { z } from "zod"`、`from "@modelcontextprotocol/client"`）。宿主用**绝对
 * file URL** 动态 import 内核，Node 于是从那个文件所在目录向上找 `node_modules`。
 * 安装包里内核住在 `resources/dist/`，而 `resources/` 下没有任何 `node_modules`
 * —— 打出来的包会以 `Cannot find package 'zod'` 退出，窗口根本起不来。
 *
 * **为什么是闭包而不是整份依赖**：整份 `node_modules` 里绝大多数是构建期工具
 * （electron-builder、typescript、vitest……），它们不该出现在用户机器上。这里只
 * 装「从 `dist/` 与 `dist-mcp/` 的 import 出发，沿 `package-lock.json` 的依赖边
 * 走到头」的那一小撮。
 *
 * **闭包从 lockfile 算，不从 `node_modules` 里猜**：`package-lock.json` 是 npm 落盘
 * 的那份解析结果，含传递依赖与版本落点；`node_modules` 里可能有 lockfile 不认的
 * 残留（手动装过、提升规则变过）。按 lockfile 算，结果可复现。
 *
 * **失败语义（R3）**：任何一项算不出来、找不到、装不下，都非零退出并点名。绝不
 * 产出一个「少了几个包」的目录 —— 那种目录要到运行时才炸，且炸在用户机器上。
 *
 * 不联网、不装依赖、不读私钥。只复制已有的文件。
 */

import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** `node_modules` 里被装进 `resources/` 的那份的名字。 */
export const OUT_DIR_NAME = "node_modules";

/**
 * 一份 `package-lock.json` 里，`packages` 键就是落点路径，`""` 是根包。
 * 这条常量只为可读性：`resolveKey` 到处用它拼前缀。
 */
const NODE_MODULES = "node_modules";

/**
 * 一段源码里出现的裸说明符。
 *
 * 只有三种写法算 import：`import ... from "x"`、`export ... from "x"`、
 * `import("x")` 与 `import "x"`。用「行首 + 语句关键字」锚定，而不是在整份文件里
 * 搜引号 —— 后者会把注释、错误文案、模板串里的引号也算进来（实测过：一条
 * `throw new Error("...")` 里的括注会被当成包名）。
 */
const STATIC_IMPORT = /^[ \t]*(?:import|export)\s+(?:[^'"]*?\bfrom\s+)?["']([^"']+)["']/gm;
const DYNAMIC_IMPORT = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

/**
 * npm 包名的合法形状。用来在抽出来之后挡掉上面两个正则仍可能命中的非包名
 * （例如 `import` 后面跟的是变量名时不会进来，但保守起见再校验一次）。
 */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

export class RuntimeDepsError extends Error {
  /**
   * @param {string} message
   * @param {{ exitCode?: number }} [options] 2 = 用法错误，1 = 执行失败
   */
  constructor(message, options = {}) {
    super(message);
    this.name = "RuntimeDepsError";
    this.exitCode = options.exitCode ?? 1;
  }
}

export const USAGE = `用法: node scripts/runtime-deps.mjs --out <输出目录> [--repo-root <仓库根>]
      node scripts/runtime-deps.mjs --verify-only [--repo-root <仓库根>]

  --out          输出目录；装好的 node_modules 就是这个目录本身
                 （打包配置里 extraResources 的 from 指向它，to 为 node_modules）
  --repo-root    仓库根（含 package-lock.json、dist/、dist-mcp/）。默认本脚本所在目录的上一级
  --verify-only  只算出闭包并确认每个包都在盘上，不复制

行为：
  · 扫描 dist/ 与 dist-mcp/ 里所有的 import / export / import()，取出裸说明符的包名。
  · 从 package-lock.json 出发，沿 dependencies / optionalDependencies 求传递闭包。
  · 按 lockfile 记的落点路径复制每一层（含嵌套 node_modules，如果有）。
  · 任一包缺失、lockfile 对不上、或输出目录已存在 → 非零退出并点名，不产出半成品。
  · 不联网、不装依赖、不跑 npm。`;

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/** 递归收集某目录下所有 `.js` 文件。 */
async function collectJsFiles(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    throw new RuntimeDepsError(`目录无法读取：${dir}（${messageOf(error)}）`, { cause: error });
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectJsFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 从若干 JS 文件里取出被 import 的**包名**（已剥掉子路径与 `node:` 前缀）。
 *
 * 相对路径、绝对路径、`file:` URL 一律跳过：它们不是包。内置模块（`node:*`）
 * 也跳过 —— 它们在运行时里，不在 `node_modules` 里。
 */
export async function collectSpecifiers(files) {
  const names = new Set();
  for (const file of files) {
    const text = await readFile(file, "utf8");
    for (const pattern of [STATIC_IMPORT, DYNAMIC_IMPORT]) {
      // `matchAll` 需要全局标志；两个正则都带 g，重复用同一 lastIndex 前先归零。
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        const specifier = match[1];
        if (
          specifier.startsWith(".") ||
          specifier.startsWith("/") ||
          specifier.startsWith("node:") ||
          specifier.startsWith("file:") ||
          specifier.startsWith("data:") ||
          specifier.includes("://")
        ) {
          continue;
        }
        const parts = specifier.split("/");
        const name = specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
        if (PACKAGE_NAME.test(name)) names.add(name);
      }
    }
  }
  return [...names].sort();
}

/**
 * 在 lockfile 的 `packages` 里按 Node 的解析规则找 `name` 从 `fromKey` 出发的落点。
 *
 * 从 `fromKey` 开始逐级剥掉末尾的 `/node_modules/<pkg>` 再拼，直到根。这正是
 * Node 向上查找 `node_modules` 的顺序，所以嵌套安装（版本冲突时 npm 会这么放）
 * 也会被找对。
 *
 * @param {Record<string, unknown>} packages
 * @param {string} name
 * @param {string} fromKey 落点路径（`""` 表示根）
 * @returns {string | null}
 */
export function resolveKey(packages, name, fromKey) {
  let base = fromKey;
  for (;;) {
    const candidate = base === "" ? `${NODE_MODULES}/${name}` : `${base}/${NODE_MODULES}/${name}`;
    if (packages[candidate] !== undefined) return candidate;
    if (base === "") return null;
    const cut = base.lastIndexOf(`/${NODE_MODULES}/`);
    if (cut === -1) {
      // 再上一级就是根。
      base = "";
    } else {
      base = base.slice(0, cut);
    }
  }
}

/**
 * 求运行时依赖闭包。
 *
 * @param {Record<string, unknown>} packages lockfile 的 `packages`
 * @param {string[]} roots 入口包名
 * @returns {{ keys: string[]; missing: string[] }} 闭包中各包的落点路径（已排序）与解析不出的包名
 */
export function computeClosure(packages, roots) {
  const keys = new Set();
  const missing = [];
  const queue = [];

  for (const name of roots) {
    const key = resolveKey(packages, name, "");
    if (key === null) missing.push(name);
    else queue.push(key);
  }

  while (queue.length > 0) {
    const key = queue.shift();
    if (key === undefined || keys.has(key)) continue;
    keys.add(key);

    const entry = packages[key];
    if (!isRecord(entry)) continue;
    const deps = {
      ...(isRecord(entry.dependencies) ? entry.dependencies : {}),
      // `optionalDependencies` 里的包可能没被安装（npm 允许缺）。找不到时不报错，
      // 但要把它列出 —— 静默当成「不需要」会让漏装的 optional 依赖无从发现。
      ...(isRecord(entry.optionalDependencies) ? entry.optionalDependencies : {}),
    };
    for (const name of Object.keys(deps)) {
      const depKey = resolveKey(packages, name, key);
      if (depKey !== null) queue.push(depKey);
    }
  }

  return { keys: [...keys].sort(), missing };
}

/**
 * 算出「从哪里、复制到哪」的清单。
 *
 * 落点路径相对 `node_modules` 那一层，所以 `node_modules/zod` 装成 `<out>/zod`，
 * 嵌套的 `node_modules/a/node_modules/b` 装成 `<out>/a/node_modules/b` —— 保持
 * 原样，否则同名不同版本的解析会错。
 *
 * @param {string} repoRoot
 * @param {string[]} keys
 */
export function planCopies(repoRoot, keys) {
  return keys.map((key) => {
    const absolute = path.join(repoRoot, ...key.split("/"));
    const relative = key.startsWith(`${NODE_MODULES}/`)
      ? key.slice(NODE_MODULES.length + 1)
      : key;
    return { from: absolute, to: relative };
  });
}

/**
 * 复制一个包目录。**递归包含它自己的 `node_modules`**，否则嵌套安装的包会丢。
 */
async function copyPackageTree(sourceDir, targetDir) {
  let entries;
  try {
    entries = await readdir(sourceDir, { withFileTypes: true });
  } catch (error) {
    throw new RuntimeDepsError(`包目录无法读取：${sourceDir}（${messageOf(error)}）`, {
      cause: error,
    });
  }
  await mkdir(targetDir, { recursive: true });
  for (const entry of entries) {
    const from = path.join(sourceDir, entry.name);
    const to = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await copyPackageTree(from, to);
      continue;
    }
    if (!entry.isFile()) {
      // 符号链接在 `node_modules` 里可能表示 workspace 链接，复制语义不明确；
      // 报错而不是悄悄跳过 —— 少一个包要到用户机器上才炸。
      throw new RuntimeDepsError(`包内含非普通文件，无法复制：${from}`);
    }
    try {
      await copyFile(from, to);
    } catch (error) {
      throw new RuntimeDepsError(`复制失败：${from} → ${to}（${messageOf(error)}）`, {
        cause: error,
      });
    }
  }
}

async function assertDirectory(target, what) {
  try {
    const info = await stat(target);
    if (!info.isDirectory()) {
      throw new RuntimeDepsError(`${what}不是目录：${target}`);
    }
  } catch (error) {
    if (error instanceof RuntimeDepsError) throw error;
    throw new RuntimeDepsError(`${what}不存在：${target}（${messageOf(error)}）`, {
      cause: error,
    });
  }
}

/**
 * 读 lockfile。只读 `packages` 段 —— `lockfileVersion` 不是 2/3 时直接拒绝，
 * 因为 v1 的 `dependencies` 树形结构与这里的落点路径算法不兼容，而按 v1 猜会
 * 得到一个看似成功、实则漏包的目录。
 */
async function readLockfile(lockPath) {
  let text;
  try {
    text = await readFile(lockPath, "utf8");
  } catch (error) {
    throw new RuntimeDepsError(`package-lock.json 无法读取：${lockPath}（${messageOf(error)}）`, {
      cause: error,
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (error) {
    throw new RuntimeDepsError(`package-lock.json 不是合法 JSON：${lockPath}（${messageOf(error)}）`, {
      cause: error,
    });
  }

  if (!isRecord(parsed) || !isRecord(parsed.packages)) {
    throw new RuntimeDepsError(
      `package-lock.json 没有 packages 段：${lockPath}（需要 lockfileVersion 2 或 3）`,
    );
  }
  if (parsed.lockfileVersion !== 2 && parsed.lockfileVersion !== 3) {
    throw new RuntimeDepsError(
      `package-lock.json 的 lockfileVersion 是 ${String(parsed.lockfileVersion)}，只支持 2 或 3`,
    );
  }
  return parsed.packages;
}

/**
 * 主流程。
 *
 * @param {{
 *   repoRoot?: string,
 *   outDir?: string,
 *   verifyOnly?: boolean,
 *   log?: (message: string) => void,
 * }} options
 * @returns {Promise<{
 *   packages: string[],
 *   fileCount: number,
 *   outDir: string | null,
 *   verifyOnly: boolean,
 * }>}
 */
export async function stageRuntimeDeps(options = {}) {
  const log = options.log ?? ((message) => process.stderr.write(`${message}\n`));
  const verifyOnly = options.verifyOnly === true;
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(options.repoRoot ?? path.join(scriptDir, ".."));

  if (!verifyOnly && (typeof options.outDir !== "string" || options.outDir.trim() === "")) {
    throw new RuntimeDepsError("缺少 --out；不给输出目录就无法知道装到哪里", { exitCode: 2 });
  }
  const outDir = verifyOnly ? null : path.resolve(options.outDir);

  const distDir = path.join(repoRoot, "dist");
  const distMcpDir = path.join(repoRoot, "dist-mcp");
  await assertDirectory(distDir, "内核产物目录");
  await assertDirectory(distMcpDir, "MCP server 产物目录");

  const files = [...(await collectJsFiles(distDir)), ...(await collectJsFiles(distMcpDir))];
  const specifiers = await collectSpecifiers(files);
  if (specifiers.length === 0) {
    throw new RuntimeDepsError(
      `在 ${distDir} 与 ${distMcpDir} 里没有找到任何裸说明符 import —— 产物可能不是预期的构建结果`,
    );
  }
  log(`从 ${files.length} 个产物文件中取出 ${specifiers.length} 个外部包：${specifiers.join(", ")}`);

  const packages = await readLockfile(path.join(repoRoot, "package-lock.json"));
  const { keys, missing } = computeClosure(packages, specifiers);
  if (missing.length > 0) {
    throw new RuntimeDepsError(
      `package-lock.json 里找不到这些包：${missing.join(", ")}。` +
        "产物与 lockfile 对不上 —— 先确认 dist/ 是用同一份 lockfile 构建的",
    );
  }

  const plan = planCopies(repoRoot, keys);
  for (const item of plan) {
    await assertDirectory(item.from, "依赖目录");
  }
  log(`闭包 ${plan.length} 个包：${keys.join(", ")}`);

  if (verifyOnly) {
    log("校验通过：全部依赖在盘上，未复制任何文件。");
    return { packages: keys, fileCount: 0, outDir: null, verifyOnly: true };
  }

  // 输出目录已存在就拒绝：覆盖会静默销毁上一次的产物，而「目录里出现的东西
  // 一定是这一次的」是打包脚本唯一能依赖的性质。
  try {
    await stat(outDir);
    throw new RuntimeDepsError(
      `输出目录已存在：${outDir}。请先删除它再运行` +
        "（不覆盖、也不改名备份：打包按固定路径取用，目录里留下一份旧副本会被当成当前依赖）。",
    );
  } catch (error) {
    if (error instanceof RuntimeDepsError) throw error;
    // ENOENT 是期望路径：目录不存在，可以建。
  }

  // 先写同父级的临时目录，全部成功后再 rename —— 与 `corpus-stage.mjs` 同一手法，
  // 保证 rename 在同一卷上（跨卷 rename 会退化成复制且可能中途失败）。
  const tempDir = `${outDir}.staging-${process.pid}`;
  await rm(tempDir, { recursive: true, force: true });
  let fileCount = 0;
  try {
    // `outDir` 的父目录也可能还不存在（`desktop/build/` 就是这种情况）。Windows
    // 上 rename 到一个父目录不存在的目标是 EPERM 而不是 ENOENT，症状像权限问题，
    // 所以父目录必须先建出来。
    await mkdir(path.dirname(outDir), { recursive: true });
    await mkdir(tempDir, { recursive: true });
    for (const item of plan) {
      const target = path.join(tempDir, ...item.to.split("/"));
      await copyPackageTree(item.from, target);
      fileCount += 1;
    }
    await rename(tempDir, outDir);
  } catch (error) {
    await rm(tempDir, { recursive: true, force: true });
    throw error instanceof RuntimeDepsError
      ? error
      : new RuntimeDepsError(`装配依赖失败：${messageOf(error)}`, { cause: error });
  }

  // 落一份清单，便于打包后核对「包里到底装了哪些包、什么版本」。
  const manifest = {
    generatedBy: "scripts/runtime-deps.mjs",
    packageCount: plan.length,
    packages: keys.map((key) => {
      const entry = packages[key];
      return {
        path: key,
        version: isRecord(entry) && typeof entry.version === "string" ? entry.version : null,
      };
    }),
  };
  await writeFile(
    path.join(outDir, "runtime-deps.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );

  log(`装配完成：${plan.length} 个包 → ${outDir}`);
  return { packages: keys, fileCount, outDir, verifyOnly: false };
}

/**
 * @param {string[]} argv
 * @returns {{ help: true } | { repoRoot?: string, out?: string, verifyOnly: boolean }}
 */
export function parseArgs(argv) {
  const result = { verifyOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--verify-only") {
      result.verifyOnly = true;
      continue;
    }
    if (arg === "--out" || arg === "--repo-root") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new RuntimeDepsError(`${arg} 缺少值`, { exitCode: 2 });
      }
      if (arg === "--out") result.out = value;
      else result.repoRoot = value;
      index += 1;
      continue;
    }
    throw new RuntimeDepsError(`不认识的参数：${arg}`, { exitCode: 2 });
  }

  if (result.verifyOnly && result.out !== undefined) {
    throw new RuntimeDepsError(
      "--verify-only 与 --out 不能同时给：前者不写盘，静默忽略 --out 会让人以为已经产出了",
      { exitCode: 2 },
    );
  }
  if (!result.verifyOnly && result.out === undefined) {
    throw new RuntimeDepsError("缺少 --out（或用 --verify-only 只做校验）", { exitCode: 2 });
  }
  return result;
}

// CLI 入口与导出分离：测试 import 这个模块时不能顺手跑一遍 argv 分支。
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}\n`);
    process.exitCode = error instanceof RuntimeDepsError ? error.exitCode : 2;
    parsed = null;
  }

  if (parsed !== null) {
    if ("help" in parsed && parsed.help === true) {
      process.stdout.write(`${USAGE}\n`);
    } else {
      try {
        // `parseArgs` 沿用 CLI 参数名（`out`），`stageRuntimeDeps` 用调用方语言
        // （`outDir`）；两者在入口这里对上，不在内部再猜一遍。
        await stageRuntimeDeps({
          ...("repoRoot" in parsed && parsed.repoRoot !== undefined
            ? { repoRoot: parsed.repoRoot }
            : {}),
          ...("out" in parsed && parsed.out !== undefined ? { outDir: parsed.out } : {}),
          verifyOnly: parsed.verifyOnly === true,
        });
      } catch (error) {
        process.stderr.write(`失败：${error instanceof Error ? error.message : String(error)}\n`);
        process.exitCode = error instanceof RuntimeDepsError ? error.exitCode : 1;
      }
    }
  }
}
