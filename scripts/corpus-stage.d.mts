/**
 * `corpus-stage.mjs` 的类型声明。
 *
 * 为什么需要它：脚本是纯 JS（`.mjs`），而 `tests/corpus-stage.test.ts` 是 TypeScript。
 * 没有声明文件时 `tsc --noEmit` 报 TS7016（隐式 any），等于给本来就红的 typecheck
 * 再加一条。（另一条路是把测试写成 `.js`，如 `tests/corpus-publish.test.js`；
 * 这里保留 `.ts` 测试以复用 vitest 的类型推导，代价是这份声明。）
 *
 * **必须与 `corpus-stage.mjs` 的实现保持同步**：改了那边的签名就改这里。
 * 声明只覆盖测试实际用到的三个出口，不复制实现细节（校验规则、错误文案都不在这里）。
 */

export type StageOptions = {
  /** 语料源目录（绝对路径）。 */
  corpusDir: string;
  /** 已签名 `latest.json` 的绝对路径。 */
  manifestPath: string;
  /** 输出目录（绝对路径）；`verifyOnly` 为 true 时忽略。 */
  outDir?: string;
  /** 只校验不写盘。 */
  verifyOnly?: boolean;
  /** 进度输出。 */
  log?: (message: string) => void;
};

export type StageResult = {
  corpusVersion: number;
  /** 清单点名的文件（POSIX 相对路径）。 */
  files: string[];
  /** 输出目录；`verifyOnly` 时为 null。 */
  outDir: string | null;
  verifyOnly: boolean;
  /** 写出的清单路径；`verifyOnly` 时为 null。 */
  latestPath: string | null;
};

export type ParsedStageArgs =
  | { help: true }
  | { corpus: string; manifest: string; out: string; verifyOnly: false }
  | { corpus: string; manifest: string; verifyOnly: true; out?: undefined };

export class CorpusStageError extends Error {
  constructor(message: string, options?: { exitCode?: number });
  /** 2 = 用法错误，1 = 执行失败。 */
  exitCode: number;
}

export const MANIFEST_FILE_NAME: string;
export const USAGE: string;

export function stageCorpus(options: StageOptions): Promise<StageResult>;
export function parseArgs(argv: string[]): ParsedStageArgs;
