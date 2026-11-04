/**
 * `check-js-syntax.mjs` 的类型声明。
 *
 * 理由与 `corpus-stage.d.mts` 相同：脚本是纯 JS，而 `tests/check-js-syntax.test.ts`
 * 是 TypeScript；没有声明文件时 `tsc --noEmit` 报 TS7016，给 typecheck 添一条红。
 *
 * 只声明测试用到的三个出口。**改实现签名要同步改这里。**
 */

/** 一条不通过记录：相对路径 + Node 自己报的位置与原因。 */
export type SyntaxFailure = {
  file: string;
  failure: string;
};

/** 递归收集一个目录下的 `.js` / `.cjs` / `.mjs`；目录不存在时返回空数组。 */
export function collect(dir: string): Promise<string[]>;

/** 对一个文件跑 `node --check`；通过返回 `undefined`，否则返回 Node 的输出。 */
export function checkFile(file: string): Promise<string | undefined>;

/** 扫一组根目录，返回收集到的文件与不通过项。 */
export function checkRoots(
  roots: string[],
  baseDir?: string,
): Promise<{ files: string[]; failures: SyntaxFailure[] }>;
