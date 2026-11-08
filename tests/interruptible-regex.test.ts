import { describe, expect, it } from "vitest";
import {
  MATCH_TIMEOUT_MS,
  createInterruptibleMatcher,
} from "../src/tools/interruptible-regex.js";

/**
 * 灾难性回溯的输入：30 个 `a` 后跟一个 `!`，配 `(a+)+$`。
 *
 * 实测原生 `RegExp.test` 在这条输入上 >40 s 不返回（n=29 时 41 s，n=28 时 19 s）；
 * 正确实现必须在 MATCH_TIMEOUT_MS 附近被打断。用例自身把墙钟上界写死为 10 s，
 * 远高于 2 s 预算，又远低于「没生效时」的量级。
 */
const CATASTROPHIC_PATTERN = "(a+)+$";
const CATASTROPHIC_LINE = `${"a".repeat(30)}!`;

/** 逐行原生匹配，返回**扁平**下标（各文件的行首尾相接）。与 matcher 的返回形状一致。 */
function nativeHits(pattern: string, ignoreCase: boolean, files: string[][]): number[] {
  const regex = new RegExp(pattern, ignoreCase ? "i" : "");
  const hits: number[] = [];
  let base = 0;
  for (const lines of files) {
    for (let index = 0; index < lines.length; index += 1) {
      if (regex.test(lines[index]!)) hits.push(base + index);
    }
    base += lines.length;
  }
  return hits;
}

describe("createInterruptibleMatcher", () => {
  it("命中下标与原生 RegExp.test 逐条相等（跨文件）", () => {
    const files = [
      ["const value = compute(x, y);", "needle here"],
      ["NEEDLE there", "nothing at all", ""],
      ["needle needle"],
    ];
    const matcher = createInterruptibleMatcher("needle", false);

    const result = matcher.testBatch(files);

    expect(result).toEqual({ hits: nativeHits("needle", false, files) });
  });

  it("ignoreCase 交给 matcher 处理", () => {
    const files = [["NEEDLE", "needle", "Needle", "haystack"]];

    const sensitive = createInterruptibleMatcher("needle", false).testBatch(files);
    const insensitive = createInterruptibleMatcher("needle", true).testBatch(files);

    expect(sensitive).toEqual({ hits: [1] });
    expect(insensitive).toEqual({ hits: [0, 1, 2] });
  });

  it("空批与空文件返回空命中", () => {
    expect(createInterruptibleMatcher("needle", false).testBatch([])).toEqual({ hits: [] });
    expect(createInterruptibleMatcher("needle", false).testBatch([[], []])).toEqual({ hits: [] });
  });

  it(`灾难性回溯在 ${MATCH_TIMEOUT_MS}ms 预算内被中断并返回 timedOut`, () => {
    const matcher = createInterruptibleMatcher(CATASTROPHIC_PATTERN, false);

    const started = performance.now();
    const result = matcher.testBatch([[CATASTROPHIC_LINE]]);
    const elapsed = performance.now() - started;

    expect(result).toEqual({ timedOut: true, fileIndex: 0 });
    expect(elapsed).toBeLessThan(10_000);
  });

  it("timedOut 时给出被打断所在的文件下标，不是只报整批", () => {
    const matcher = createInterruptibleMatcher(CATASTROPHIC_PATTERN, false);

    const result = matcher.testBatch([["aaaa"], ["aaaa"], ["aaaa", CATASTROPHIC_LINE], ["aaaa"]]);

    expect(result).toEqual({ timedOut: true, fileIndex: 2 });
  });

  it("中断之后同一个 matcher 仍可继续使用", () => {
    const matcher = createInterruptibleMatcher(CATASTROPHIC_PATTERN, false);

    expect(matcher.testBatch([[CATASTROPHIC_LINE]])).toMatchObject({ timedOut: true });
    // 同一 pattern：(a+)+$ 只匹配「全是 a 直到结尾」的行。
    expect(matcher.testBatch([["aaaa", "aab", "zzz"]])).toEqual({ hits: [0] });
    // 再中断一次，仍然可复用。
    expect(matcher.testBatch([[CATASTROPHIC_LINE]])).toMatchObject({ timedOut: true });
    expect(matcher.testBatch([["aaaa"]])).toEqual({ hits: [0] });
  });
});
