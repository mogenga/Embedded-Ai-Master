/**
 * `runtime-deps.mjs` 的类型声明。
 *
 * 与 `corpus-stage.d.mts` 同一理由：脚本是纯 JS（`.mjs`），测试是 TypeScript；
 * 没有声明文件时 `tsc --noEmit` 报 TS7016，给本来就红的 typecheck 再加一条。
 *
 * **必须与 `runtime-deps.mjs` 的实现保持同步**：改了那边的签名就改这里。
 */

export type StageRuntimeDepsOptions = {
  /** 仓库根（含 `package-lock.json`、`dist/`、`dist-mcp/`）。默认脚本所在目录的上一级。 */
  repoRoot?: string;
  /** 输出目录；`verifyOnly` 为 true 时忽略。已存在则拒绝。 */
  outDir?: string;
  /** 只校验（算闭包 + 确认每个包在盘上），不复制任何文件。 */
  verifyOnly?: boolean;
  /** 进度输出。 */
  log?: (message: string) => void;
};

export type StageRuntimeDepsResult = {
  /** 闭包里各包的 lockfile 落点路径（POSIX，含 `node_modules/` 前缀）。 */
  packages: string[];
  /** 复制了多少个顶层包目录；`verifyOnly` 时为 0。 */
  fileCount: number;
  /** 输出目录；`verifyOnly` 时为 null。 */
  outDir: string | null;
  verifyOnly: boolean;
};

export type ParsedRuntimeDepsArgs =
  | { help: true }
  | { verifyOnly: true; repoRoot?: string }
  | { verifyOnly: false; out: string; repoRoot?: string };

export type CopyPlanItem = {
  /** 源：仓库内的绝对路径。 */
  from: string;
  /** 目标：相对输出目录的路径（POSIX）。 */
  to: string;
};

export type ClosureResult = {
  /** 闭包中各包的 lockfile 落点路径。 */
  keys: string[];
  /** 从入口解析不出的包名（lockfile 与产物对不上时非空）。 */
  missing: string[];
};

export class RuntimeDepsError extends Error {
  constructor(message: string, options?: { exitCode?: number; cause?: unknown });
  /** 2 = 用法错误，1 = 执行失败。 */
  exitCode: number;
}

export const OUT_DIR_NAME: string;
export const USAGE: string;

export function stageRuntimeDeps(
  options?: StageRuntimeDepsOptions,
): Promise<StageRuntimeDepsResult>;
export function parseArgs(argv: string[]): ParsedRuntimeDepsArgs;
export function collectSpecifiers(files: string[]): Promise<string[]>;
export function resolveKey(
  packages: Record<string, unknown>,
  name: string,
  fromKey: string,
): string | null;
export function computeClosure(
  packages: Record<string, unknown>,
  roots: string[],
): ClosureResult;
export function planCopies(repoRoot: string, keys: string[]): CopyPlanItem[];
