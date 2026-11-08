/**
 * `nightly-batch.mjs` 的类型声明。
 *
 * 与 `clean.d.mts` / `release.d.mts` / `corpus-stage.d.mts` 同一理由：脚本是纯 JS
 * （`.mjs`），而 `tests/nightly-batch.test.ts` 是 TypeScript；没有声明文件时
 * `tsc --noEmit` 报 TS7016（隐式 any）。
 *
 * **必须与 `nightly-batch.mjs` 的实现保持同步**：改了那边的签名就改这里。
 * 契约本身（夹具格式 / exit code 表 / 判分规则）在
 * `docs/operations/nightly-batch.md`，这里只写形状。
 */

import type { runSession } from "../src/index.js";

export type ExitCode = 0 | 1 | 2 | 3 | 4 | 5 | 124;

export const DEFAULT_ROUND: number;
export const DEFAULT_BATCH_TIMEOUT_MS: number;

/** exit code 表。键名是含义，值是码。 */
export const EXIT: Readonly<{
  pass: 0;
  caseFailed: 1;
  environment: 2;
  fixture: 3;
  batchTimeout: 4;
  conflict: 5;
  timeoutNoVerdict: 124;
}>;

export const USAGE: string;

/** `script[i]`：一次工具调用，或最终文本。 */
export type ScriptStep =
  | { tool: string; args: Record<string, unknown> }
  | { done: string };

export type CaseFixture = {
  id: string;
  symptom: string;
  maxTurns: number;
  deadlineMs: number;
  script: ScriptStep[];
  expectToolFailure?: boolean;
};

export type Answers = {
  rootCause: string;
  requiredTools: string[];
  forbiddenClaims: string[];
};

export type LoadedCase = {
  fixture: CaseFixture;
  answers: Answers;
  caseFile: string;
  answerFile: string;
};

export type LoadedBatch = {
  batch: { name: string; description?: string; cases: string[] };
  cases: LoadedCase[];
};

/**
 * 读批次并校验全部夹具。**不抛异常**：`problems` 非空即夹具错误（exit 3），
 * 一次性列出全部坏夹具而不是第一条。
 */
export function loadBatch(
  batchDir: string,
): { problems: string[] } | { batch: LoadedBatch["batch"]; cases: LoadedCase[] };

/**
 * 按 `script` 逐条返回的 mock `fetchImpl`。`stats.calls` 是模型调用次数，
 * 测试用它证明「预检失败时没有发起任何调用」。
 */
export function createScriptedFetch(
  fixture: CaseFixture,
  caseId: string,
): { fetchImpl: typeof fetch; stats: { calls: number } };

export type CaseOutcome = {
  toolSequence: string[];
  failedToolSequence: string[];
  finalText: string;
  hasAssistantText: boolean;
  finishReason?: string;
  logPaths: string[];
};

/** 对一条用例判分。`reasons` 为空即通过；每条原因必须可判。 */
export function scoreCase(
  entry: LoadedCase,
  outcome: CaseOutcome,
): { passed: boolean; reasons: string[] };

export type RunOptions = {
  batchDir: string;
  round: number;
  force: boolean;
  dryRun: boolean;
  timeoutMs: number;
};

export function parseArgs(
  argv: string[],
):
  | { kind: "help" }
  | { kind: "error"; message: string }
  | { kind: "run"; options: RunOptions };

export type BatchDeps = {
  runSession: typeof runSession;
  fetchFactory: (
    fixture: CaseFixture,
    caseId: string,
  ) => { fetchImpl: typeof fetch; stats: { calls: number } };
  log: (line: string) => void;
  errorLog: (line: string) => void;
};

export function runBatch(
  loaded: LoadedBatch,
  options: RunOptions,
  deps: BatchDeps,
): Promise<ExitCode>;

export type MainDeps = {
  /** 缺省时从 `dist/index.js` 加载；测试注入以免要求先构建。 */
  runSession?: typeof runSession;
  fetchFactory?: BatchDeps["fetchFactory"];
  log?: (line: string) => void;
  errorLog?: (line: string) => void;
};

/** CLI 入口。返回 exit code（不设置 `process.exitCode`）。 */
export function main(argv: string[], deps?: MainDeps): Promise<ExitCode>;
