/**
 * `check-ledger-status.mjs` 的类型声明。
 *
 * 理由与 `check-js-syntax.d.mts` 相同：脚本是纯 JS，而 `tests/check-ledger-status.test.ts`
 * 是 TypeScript；没有声明文件时 `tsc --noEmit` 报 TS7016，给 typecheck 添一条红。
 *
 * 只声明测试用到的出口。**改实现签名要同步改这里。**
 */

/** 一处状态自相矛盾。`rule` 是命中的规则名（`top-note` / `status-line`）。 */
export type LedgerProblem = {
  file: string;
  line: number;
  id: string;
  rule: string;
  detail: string;
};

/** 一份台账的扫描结果。 */
export type LedgerScan = {
  entries: number;
  statusLines: number;
  problems: LedgerProblem[];
};

/** 扫一组路径后的汇总。`files` 是实际读到的台账。 */
export type LedgerReport = {
  files: string[];
  entries: number;
  statusLines: number;
  problems: LedgerProblem[];
};

/** 只判状态块内部是否自相矛盾，不管顶部注记。 */
export function contradictionOf(
  statusText: string,
): { rule: string; detail: string } | undefined;

/** 解析一份台账文本。 */
export function checkText(text: string, file?: string): LedgerScan;

/** 扫一组文件或目录；目录不存在返回空结果，不抛错。 */
export function checkPaths(paths: string[]): LedgerReport;

/** 输出行：全绿时一行摘要，有命中时摘要 + 逐条问题。 */
export function formatResult(report: LedgerReport): string[];
