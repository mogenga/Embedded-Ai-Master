import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileGlobMatcher, matchesGlob } from "../src/tools/glob.js";
import { grepTool } from "../src/tools/grep.js";
import type { ToolCtx } from "../src/tools/types.js";

// 批次 7 Task 3：`glob` 非回溯匹配（D-086）。
//
// 旧实现把每个段边界的 globstar 前缀编译成一个可选的「任意前缀 + 斜杠」正则组，
// 多个这样的可选组在失败匹配时组合爆炸：globstar-a 重复 12 次 + 32 段路径实测
// **7.7–9.0 s**（单条路径），重复 12 次 @48 段 **303 s**。
// 这里把耗时钉成断言，并用「同形状但应当匹配」的路径做正对照——证明速度不是靠
// 「一律返回 false」换来的。
//
// `tests/glob.test.ts` 是语义守门人（641 行，一个字都不改）；本文件只补性能与
// 旧实现的行为边沿。阈值取 50 ms：新实现实测亚毫秒（子进程独立测量 0.3–0.6 ms），
// 留了两个数量级的余量，而旧实现在同一条用例上要几秒。
//
// 另外几条「怪行为」是旧正则的副产物，**有意保留**（语义不变是本任务的要求）：
//   - 跟在 `/` 后的末尾 globstar 编译成 `.*`，前面的 `/` 是字面量 → `a/**` 不匹配 `a`；
//   - `.*` 不跨行终止符 → 跨段 globstar 不吃含 `\n` / `\r` / U+2028 / U+2029 的段。

const tempDirs: string[] = [];

function makeWorkdir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "eam-glob-nonbacktracking-"));
  tempDirs.push(dir);
  return dir;
}

function writeAt(workdir: string, relative: string, content = "needle\n"): void {
  const absolute = path.join(workdir, relative);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, "utf8");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function elapsed<T>(fn: () => T): { result: T; ms: number } {
  const started = performance.now();
  const result = fn();
  return { result, ms: performance.now() - started };
}

/** 同一条路径多跑几次取最小值，避免偶发调度噪声把断言判红。 */
function minElapsed<T>(runs: number, fn: () => T): { result: T; ms: number } {
  let best = Infinity;
  let result!: T;
  for (let index = 0; index < runs; index += 1) {
    const one = elapsed(fn);
    result = one.result;
    if (one.ms < best) best = one.ms;
  }
  return { result, ms: best };
}

const PATHOLOGICAL_BUDGET_MS = 50;

describe("glob 非回溯匹配（D-086）", () => {
  it("`**/a/`×12 对 32 段路径：不匹配且 < 50 ms", () => {
    const pattern = `${"**/a/".repeat(12)}z`;
    const path = `${"a/".repeat(32)}y`;

    const { result, ms } = minElapsed(3, () => matchesGlob(path, pattern));

    expect(result).toBe(false);
    expect(ms).toBeLessThan(PATHOLOGICAL_BUDGET_MS);
  }, 60_000);

  it("`**/a/`×8 对 48 段路径：不匹配且 < 50 ms", () => {
    const pattern = `${"**/a/".repeat(8)}z`;
    const path = `${"a/".repeat(48)}y`;

    const { result, ms } = minElapsed(3, () => matchesGlob(path, pattern));

    expect(result).toBe(false);
    expect(ms).toBeLessThan(PATHOLOGICAL_BUDGET_MS);
  }, 60_000);

  it("`**/*a/` 连续 6 组：不匹配且 < 50 ms", () => {
    const pattern = `${"**/*a/".repeat(6)}z`;
    const path = `${"a/".repeat(40)}y`;

    const { result, ms } = minElapsed(3, () => matchesGlob(path, pattern));

    expect(result).toBe(false);
    expect(ms).toBeLessThan(PATHOLOGICAL_BUDGET_MS);
  }, 60_000);

  it("同形状但应当匹配的路径返回 true（正对照，不是靠一律不匹配换速度）", () => {
    // 与上面三条一一对应的成功路径：同样多的段、同样多的 `**`。
    expect(matchesGlob(`${"x/".repeat(32)}${"a/".repeat(12)}z`, `${"**/a/".repeat(12)}z`)).toBe(
      true,
    );
    expect(matchesGlob(`${"x/".repeat(40)}${"a/".repeat(8)}z`, `${"**/a/".repeat(8)}z`)).toBe(true);
    expect(matchesGlob(`${"a/".repeat(40)}z`, `${"**/*a/".repeat(6)}z`)).toBe(true);
  });

  it("同一病态 pattern 连续调用 20 次仍 < 100 ms（grep 的 glob 过滤按文件调用）", () => {
    const matcher = compileGlobMatcher(`${"**/*a/".repeat(6)}z`);
    expect(matcher).toBeDefined();
    const match = matcher!;
    const path = `${"a/".repeat(40)}y`;

    const { result, ms } = minElapsed(1, () => Array.from({ length: 20 }, () => match(path)));

    expect(result.every((hit) => hit === false)).toBe(true);
    expect(ms).toBeLessThan(100);
  }, 60_000);

  it("64 段合法 pattern（段数上限内）：结果正确且不超时", () => {
    const deep = Array.from({ length: 64 }, () => "a").join("/");
    // 段数按非空段计，64 是上限。
    const withGlobstar = `${"**/"}${Array.from({ length: 63 }, () => "a").join("/")}`;

    const exact = minElapsed(3, () => matchesGlob(deep, deep));
    expect(exact.result).toBe(true);
    expect(exact.ms).toBeLessThan(PATHOLOGICAL_BUDGET_MS);

    expect(matchesGlob(`${deep.slice(0, -1)}b`, deep)).toBe(false);

    const deepPath = `${"x/"}${Array.from({ length: 63 }, () => "a").join("/")}`;
    const globstar = minElapsed(3, () => matchesGlob(deepPath, withGlobstar));
    expect(globstar.result).toBe(true);
    expect(globstar.ms).toBeLessThan(PATHOLOGICAL_BUDGET_MS);
  }, 60_000);

  it("末尾 `**` 前的 `/` 是字面量：`a/**` 不匹配 `a`，匹配 `a/` 与 `a/b`", () => {
    expect(matchesGlob("a", "a/**")).toBe(false);
    expect(matchesGlob("a/", "a/**")).toBe(true);
    expect(matchesGlob("a/b/c", "a/**")).toBe(true);
  });

  it("尾随 `/` 是空段：`a/` 只匹配 `a/`，`**/` 只匹配空串或以 `/` 结尾的路径", () => {
    expect(matchesGlob("a/xyz", "a/")).toBe(false);
    expect(matchesGlob("a/", "a/")).toBe(true);
    expect(matchesGlob("", "**/")).toBe(true);
    expect(matchesGlob("a/b/", "**/")).toBe(true);
    expect(matchesGlob("a/b", "**/")).toBe(false);
  });

  it("跨段 `**` 不吃含行终止符的段（旧 `.*` 不跨行的副产物，保留）", () => {
    expect(matchesGlob("a\nb.ts", "*.ts")).toBe(true);
    expect(matchesGlob("a\nb/c", "**/c")).toBe(false);
    expect(matchesGlob("a\rb/c", "**/c")).toBe(false);
    expect(matchesGlob(`a\u2028b/c`, "**/c")).toBe(false);
    expect(matchesGlob(`a\u2029b/c`, "**/c")).toBe(false);
    // 普通空格不是行终止符，`.*` 照常跨过。
    expect(matchesGlob("a b/c", "**/c")).toBe(true);
    expect(matchesGlob("a\nb", "**")).toBe(false);
    // 换行落在非跨段位置时照常匹配（`?` 是 `[^/]`，不是 `.`）。
    expect(matchesGlob("a\nb.ts", "a?b.ts")).toBe(true);
  });

  it("`?` 按码点而不是码元匹配（旧正则带 `u` 标志）", () => {
    expect(matchesGlob("\u{1F600}", "?")).toBe(true);
    expect(matchesGlob("\u{1F600}", "??")).toBe(false);
    expect(matchesGlob("\u{1F600}.ts", "?.ts")).toBe(true);
  });
});

describe("grep 的 glob 过滤在深目录树上（D-086 的实际影响面）", () => {
  it("深树 + 病态 glob：过滤结果正确且在 < 5 s 内返回", async () => {
    const workdir = makeWorkdir();
    // 40 层目录，每层 2 个文件；glob 是会让旧实现爆炸的形状。
    let dir = "";
    for (let depth = 0; depth < 40; depth += 1) {
      dir = dir === "" ? `d${depth}` : `${dir}/d${depth}`;
      writeAt(workdir, `${dir}/a.ts`);
      writeAt(workdir, `${dir}/b.md`);
    }

    const ctx: ToolCtx = { sessionId: "test", cwd: workdir };
    const { result, ms } = await elapsedAsync(() =>
      grepTool.execute(
        { pattern: "needle", glob: `${"**/d*/".repeat(6)}*.ts` },
        ctx,
        new AbortController().signal,
      ),
    );

    expect(result.isError).toBe(false);
    // 6 组 `**/d*/` 且每个 `**` 可零次 → 目录深度 ≥6 的 `a.ts` 全部命中（深度 6..40 共 35 个），
    // 每个深度的 b.md 被 `*.ts` 过滤掉。
    expect(result.detail).toMatchObject({ matched: 35, returned: 35, truncated: false });
    expect(result.text).toContain("d0/d1/d2/d3/d4/d5/a.ts:1:needle");
    expect(result.text).not.toContain(".md:");
    expect(ms).toBeLessThan(5_000);
  }, 60_000);
});

async function elapsedAsync<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const started = performance.now();
  const result = await fn();
  return { result, ms: performance.now() - started };
}
