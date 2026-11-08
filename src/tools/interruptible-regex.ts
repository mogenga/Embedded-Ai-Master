import { Script, createContext } from "node:vm";

/**
 * 可中断的正则求值（D-085）。
 *
 * 原生 `RegExp.test` 是同步且不可中断的：`(a+)+$` 对 30 个 `a` + `!` 实测
 * n=29 时 41 s、n=28 时 19 s 不返回，期间 `AbortSignal` 完全无效——管线超时
 * 只能让上层提前返回，正则仍在跑，整个宿主进程卡死。
 *
 * 这里把求值放进 `node:vm` 的独立 context，用 `runInContext(ctx, { timeout })`
 * 给出墙钟上界。实测（2026-11-08）：
 * - 灾难性回溯在 2000 ms 预算下 **2015.6 ms** 被打断（`ERR_SCRIPT_EXECUTION_TIMEOUT`）；
 * - 打断后同一个 context 与同一个 `RegExp` 实例仍可继续使用（连打断两次后仍正常）；
 * - 每次 `runInContext` 固定开销约 **105 µs**，`createContext` 约 0.28 ms（每次 grep 调用一次）；
 * - 一批 4.7 MiB / 41000 行：原生 2.81 ms、vm 4.07 ms；改成「按文件分组」后 4.48 → 4.74 ms。
 *
 * 因此批要成批跑（不然每个文件 100 µs 的固定开销会把 2000 文件拖成 3×），
 * 批的大小由下面两个常量封顶，使超时预算是常数而不是随仓库大小漂移。
 */

/**
 * 一批正则求值的墙钟预算。正常正则处理 4 MiB 约 2–40 ms，余量 50–1000×；
 * 灾难性正则会在这里被打断，而不是跑到几十秒。
 */
export const MATCH_TIMEOUT_MS = 2000;

/** 一批最多多少个文件。逐文件调用是 100 µs 固定开销（2000 文件 +550 ms），成批后只慢 +35%。 */
export const BATCH_MAX_FILES = 50;

/** 一批最多多少字节文本。让超时预算是常数，不随仓库大小漂移。 */
export const BATCH_MAX_BYTES = 4 * 1024 * 1024;

/**
 * `hits` 是**扁平**行下标：把这一批各文件的行按顺序首尾相接后的位置。
 * 调用方用各文件的行数前缀和把它还原成 (文件下标, 文件内行号)。
 *
 * `timedOut` 时给出被打断所在的文件下标——一个批最多 50 个文件，只报「这一批」
 * 对排障没有用处；槽位在文件边界上更新，因此是个准确定位而不是猜测。
 */
export type BatchMatchResult =
  | { hits: number[] }
  | { timedOut: true; fileIndex: number };

/**
 * 一批里的一行：字符串参与匹配，`null` 表示「这一行不参与匹配但仍占下标」。
 *
 * `grep` 用它承载超过 1 MiB 而被跳过的行：那些行必须保持行号对齐，又绝不能
 * 被正则看到（哪怕空串也会被 `^$` 命中）。
 */
export type BatchLine = string | null;

export interface InterruptibleMatcher {
  /**
   * 对一批文件求值。整批要么全部求完，要么 `timedOut`——**没有部分结果**，
   * 调用方不得把超时当成截断或空匹配。
   */
  testBatch(files: readonly (readonly BatchLine[])[]): BatchMatchResult;
}

const SETUP_SOURCE = "globalThis.regexp = new RegExp(pattern, flags);";

// 行数与命中都只在 vm 内部循环；跨 realm 只回传一个下标数组与一个文件槽位。
const RUN_SOURCE = `
  (() => {
    const regexp = globalThis.regexp;
    const files = globalThis.files;
    const hits = [];
    let base = 0;
    for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
      globalThis.fileIndex = fileIndex;
      const lines = files[fileIndex];
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        // null 是 grep 的超长行占位：占下标，但不交给正则。
        if (line !== null && regexp.test(line)) hits.push(base + index);
      }
      base += lines.length;
    }
    return hits;
  })()
`;

/**
 * pattern 的合法性由调用方在主线程校验（`grep` 用 `invalid_pattern` 拒绝），
 * 因此这里的 `new RegExp` 不会再抛语法错误。
 *
 * 返回的 matcher 长期存活：一个 context、一个预编译脚本，每次 `testBatch`
 * 只赋一次 `files` 再 `runInContext`。超时后 context 仍可继续使用。
 */
export function createInterruptibleMatcher(
  pattern: string,
  ignoreCase: boolean,
): InterruptibleMatcher {
  const context = createContext({
    pattern,
    flags: ignoreCase ? "i" : "",
    files: [] as readonly (readonly BatchLine[])[],
    fileIndex: -1,
  });
  new Script(SETUP_SOURCE).runInContext(context);
  const script = new Script(RUN_SOURCE);

  return {
    testBatch(files) {
      context.files = files;
      try {
        return { hits: script.runInContext(context, { timeout: MATCH_TIMEOUT_MS }) as number[] };
      } catch (error) {
        if ((error as { code?: string } | null)?.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
          return { timedOut: true, fileIndex: context.fileIndex as number };
        }
        throw error;
      }
    },
  };
}
