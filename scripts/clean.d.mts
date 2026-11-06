/**
 * `clean.mjs` 的类型声明。
 *
 * 与 `release.d.mts` / `corpus-stage.d.mts` 同一理由：脚本是纯 JS（`.mjs`），
 * 测试是 TypeScript；没有声明文件时 `tsc --noEmit` 报 TS7016（隐式 any）。
 *
 * **必须与 `clean.mjs` 的实现保持同步**：改了那边的签名就改这里。
 */

export const USAGE: string;
export const CLEANABLE_DIRS: string[];

export class CleanError extends Error {
  constructor(message: string, options?: { exitCode?: number; cause?: unknown });
  exitCode: number;
}

export function resolveTarget(name: string, repoRoot?: string): { name: string; target: string };

export function inspectTarget(target: string): Promise<{ exists: boolean; symlink: boolean }>;

export function cleanTarget(resolved: { name: string; target: string }): Promise<{
  removed: boolean;
  target: string;
}>;

export function main(
  argv: string[],
  options?: {
    repoRoot?: string;
    log?: (line: string) => void;
    errorLog?: (line: string) => void;
  },
): Promise<0 | 1>;
