#!/usr/bin/env node
/**
 * 构建前清理：删掉仓库根下的一个构建产物目录。
 *
 * **为什么需要它**：`tsc` 只覆盖写、不删除已无源码对应的旧产物。`src/server/`
 * 下已经删掉的 `api.ts` / `body.ts` / `config-api.ts` / `event-stream.ts` /
 * `http.ts` / `serve.ts` 的编译结果仍留在 `dist/server/`；`dist-mcp/` 里同样躺着
 * 已删除的 `cubeide/` / `espidf/` / `arduino/` 三个 server 目录。它们会被
 * electron-builder 的 `extraResources` 原样打进安装包（`resources/dist/` /
 * `resources/dist-mcp/`），于是用户机器上多出一批仓库里并不存在的模块。
 *
 * **为什么参数化、一次只清一个**：`npm run build` 与 `npm run build:mcp` 是两条
 * 独立命令、写两个独立目录。若每次互删对方产物，CI 里
 * `npm run build && npm run build:mcp` 的第二步会把第一步的内核产物删掉——
 * 那是一个比孤儿文件严重得多的问题。
 *
 * **只允许删仓库根下的 `dist/` 与 `dist-mcp/`**，且拒绝对符号链接动手：
 * 参数经 `path.resolve` 后逐步校验，`..`、绝对路径、其它名字一律拒绝。这两个目录
 * 都是 gitignored 的构建产物（`.gitignore` 的「构建产物」一节），删了可重建。
 *
 * **不需要清 `*.tsbuildinfo`**：`tsconfig.json` / `tsconfig.build.json` /
 * `tsconfig.mcp.json` 都没有开 `incremental` / `composite`，也没有设
 * `tsBuildInfoFile`，`tsc` 每次都全量编译，不存在「删了输出却复用旧缓存」的问题。
 * 将来若开了增量编译，这里必须一并清理。
 *
 * 用法：
 *   node scripts/clean.mjs dist
 *   node scripts/clean.mjs dist-mcp
 *
 * 退出码：0 = 已删除或本来就不存在；1 = 参数不合法或删除失败（原因打到 stderr，
 * 不静默吞掉，R3）。
 *
 * 无依赖，只用 `node:*`。
 */

import { lstat, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "..");

export const USAGE = `用法: node scripts/clean.mjs <dist|dist-mcp>

  dist      删除仓库根的 dist/（npm run build 的产物）
  dist-mcp  删除仓库根的 dist-mcp/（npm run build:mcp 的产物）
  --help    显示本说明

只删这一个目录；不存在时静默成功。参数不合法或删除失败 → 退出码 1。
`;

/** 允许清理的目录名。刻意做成白名单而不是「任意相对路径」。 */
export const CLEANABLE_DIRS = ["dist", "dist-mcp"];

/** 清理失败。消息会原样打到 stderr，所以必须自带修复线索（R3）。 */
export class CleanError extends Error {
  /**
   * @param {string} message
   * @param {{ exitCode?: number, cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CleanError";
    this.exitCode = options.exitCode ?? 1;
  }
}

/**
 * 把参数解析成要删的绝对路径。纯函数：不碰文件系统。
 *
 * 拒绝的形态与理由：
 * - 非白名单名字（含 `..`、绝对路径、带分隔符的路径）：从名字上就出不了仓库根。
 * - 解析后父目录不是 `repoRoot`：兜住 `repoRoot` 本身不规整的边界。
 *
 * @param {string} name 命令行参数
 * @param {string} [repoRoot]
 * @returns {{ name: string, target: string }}
 */
export function resolveTarget(name, repoRoot = REPO_ROOT) {
  if (typeof name !== "string" || name === "") {
    throw new CleanError("缺少要清理的目录名（dist 或 dist-mcp）", { exitCode: 1 });
  }
  if (!CLEANABLE_DIRS.includes(name)) {
    throw new CleanError(
      `拒绝清理 ${JSON.stringify(name)}：只允许 ${CLEANABLE_DIRS.join(" / ")}`,
    );
  }
  const root = path.resolve(repoRoot);
  const target = path.resolve(root, name);
  if (path.dirname(target) !== root) {
    throw new CleanError(`拒绝清理 ${target}：解析后不在仓库根 ${root} 下的一级目录`);
  }
  return { name, target };
}

/**
 * 探明目标是否存在、是不是符号链接 / 目录联接。
 *
 * 用 `lstat` 而不是 `stat`：`stat` 会跟随链接，把「指向别处的链接」看成普通目录，
 * 那样 `rm -r` 会不会穿透取决于平台实现——**不赌这个**。链接一律拒绝。
 *
 * @param {string} target
 * @returns {Promise<{ exists: boolean, symlink: boolean }>}
 */
export async function inspectTarget(target) {
  try {
    const info = await lstat(target);
    return { exists: true, symlink: info.isSymbolicLink() };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { exists: false, symlink: false };
    }
    throw new CleanError(`无法检查 ${target}（${error.code ?? error.message}）`, { cause: error });
  }
}

/**
 * 删除一个构建目录。不存在时静默成功（`removed: false`）；是符号链接时拒绝。
 *
 * @param {{ name: string, target: string }} resolved
 * @returns {Promise<{ removed: boolean, target: string }>}
 */
export async function cleanTarget(resolved) {
  const { target } = resolved;
  const facts = await inspectTarget(target);
  if (!facts.exists) {
    return { removed: false, target };
  }
  if (facts.symlink) {
    throw new CleanError(
      `拒绝清理 ${target}：它是符号链接 / 目录联接，删除会作用到链接目标而不是构建产物`,
    );
  }
  try {
    await rm(target, { recursive: true, force: true });
  } catch (error) {
    throw new CleanError(`删除 ${target} 失败：${error.message}`, { cause: error });
  }
  return { removed: true, target };
}

/**
 * CLI 入口。
 *
 * @param {string[]} argv
 * @param {{ repoRoot?: string, log?: (line: string) => void, errorLog?: (line: string) => void }} [options]
 * @returns {Promise<0 | 1>}
 */
export async function main(argv, options = {}) {
  const log = options.log ?? ((line) => process.stdout.write(`${line}\n`));
  const errorLog = options.errorLog ?? ((line) => process.stderr.write(`${line}\n`));

  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    log(USAGE.trimEnd());
    return 0;
  }
  if (argv.length !== 1) {
    errorLog(`失败：需要且只需要一个目录名（dist 或 dist-mcp），收到 ${argv.length} 个`);
    errorLog(USAGE.trimEnd());
    return 1;
  }

  try {
    const resolved = resolveTarget(argv[0], options.repoRoot ?? REPO_ROOT);
    const result = await cleanTarget(resolved);
    log(result.removed ? `已清理 ${result.target}` : `${result.target} 不存在，无需清理`);
    return 0;
  } catch (error) {
    errorLog(`失败：${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

// 只有被当成脚本直接运行时才跑 CLI；测试 import 本模块拿纯函数，不应触发删除。
const invokedPath =
  process.argv[1] === undefined ? "" : pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath !== "" && import.meta.url === invokedPath) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`失败：${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
