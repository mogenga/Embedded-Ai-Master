import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BoundedMatches, grepTool } from "../src/tools/grep.js";
import type { ToolCtx } from "../src/tools/types.js";

/**
 * 批量 7 Task 2：`grep` 的有界收集（D-078）与可中断正则求值（D-085）。
 *
 * 本文件只新增用例；`tests/grep.test.ts` 的既有断言一个字都没改，它是「语义逐字节
 * 不变」的守门人。这里补三类：
 *   1. 命中数远超 limit 时 `matched` 仍是真实总数、`returned` 只有 limit；
 *   2. 灾难性正则返回显式 `regex_timeout`，而不是 `(no matches)` / `aborted`；
 *   3. 普通正则大批量下，结果与「逐行原生 RegExp.test」逐条相等。
 */

const tempDirs: string[] = [];
const signal = new AbortController().signal;

function makeWorkdir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "eam-grep-bounded-"));
  tempDirs.push(dir);
  return dir;
}

function makeCtx(workdir: string): ToolCtx {
  return { sessionId: "test", cwd: workdir };
}

function writeAt(workdir: string, relative: string, content: string | Buffer = ""): void {
  const absolute = path.join(workdir, relative);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function run(
  workdir: string,
  input: Parameters<typeof grepTool.execute>[0],
  signalOverride: AbortSignal = signal,
) {
  return grepTool.execute(input, makeCtx(workdir), signalOverride);
}

/** 与 `grep` 的排序一致：先按文件路径字典序，同文件内按行号数值升序。 */
function byFileThenLine(a: { file: string; line: number }, b: { file: string; line: number }) {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  return a.line - b.line;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("grep 有界收集（D-078）", () => {
  it("5000 行全命中、limit 200：matched 精确 = 5000，returned = 200", async () => {
    const workdir = makeWorkdir();
    const lines = Array.from({ length: 5000 }, (_, index) => `hit ${index}`);
    writeAt(workdir, "a.txt", `${lines.join("\n")}\n`);

    const r = await run(workdir, { pattern: "hit" });

    expect(r.isError).toBe(false);
    expect(r.detail).toMatchObject({ matched: 5000, returned: 200, truncated: true });
    const output = r.text.split("\n");
    expect(output).toHaveLength(201);
    expect(output[0]).toBe("a.txt:1:hit 0");
    expect(output[199]).toBe("a.txt:200:hit 199");
    expect(output[200]).toBe("[truncated]");
  }, 60_000);

  it("跨文件保留全局最小的 limit 条，顺序与全量 sort 一致", async () => {
    const workdir = makeWorkdir();
    // 文件名故意不按字典序写入，让 readdir 顺序与目标顺序不同。
    const names = ["c.txt", "a.txt", "e.txt", "b.txt", "d.txt"];
    for (const name of names) writeAt(workdir, name, "hit\nhit\nhit\n");

    const r = await run(workdir, { pattern: "hit", maxResults: 5 });

    // 全量 sort 后前 5 条：a.txt:1,2,3 / b.txt:1,2
    expect(r.text).toBe(
      [
        "a.txt:1:hit",
        "a.txt:2:hit",
        "a.txt:3:hit",
        "b.txt:1:hit",
        "b.txt:2:hit",
        "[truncated]",
      ].join("\n"),
    );
    expect(r.detail).toMatchObject({ matched: 15, returned: 5, truncated: true });
  });

  it("limit 与命中数相等时 truncated 仍为 false（边沿不变）", async () => {
    const workdir = makeWorkdir();
    writeAt(workdir, "a.txt", "hit\nhit\n");

    const r = await run(workdir, { pattern: "hit", maxResults: 2 });

    expect(r.detail).toMatchObject({ matched: 2, returned: 2, truncated: false });
    expect(r.text).not.toContain("[truncated]");
  });

  it("命中数超过 limit 1 条时 truncated 为 true（边沿不变）", async () => {
    const workdir = makeWorkdir();
    writeAt(workdir, "a.txt", "hit\nhit\nhit\n");

    const r = await run(workdir, { pattern: "hit", maxResults: 2 });

    expect(r.detail).toMatchObject({ matched: 3, returned: 2, truncated: true });
    expect(r.text.endsWith("[truncated]")).toBe(true);
  });

  it("收集量恒被 limit + 1 封顶，不随命中总数增长（BoundedMatches 不变量）", () => {
    // 直接测收集器本身：堆峰值在本机由 GC 节奏主导（同一语料换成永不命中的
    // pattern，实测峰值仍会在 0–33 MiB 之间漂），拿它当断言测的是 GC 而不是算法。
    const collector = new BoundedMatches(200);

    for (let index = 0; index < 200_000; index += 1) {
      collector.add({ file: "a.txt", line: index + 1, text: `hit ${index}` });
    }

    expect(collector.matched).toBe(200_000);
    expect(collector.retained).toBe(201);
    const ordered = collector.ordered();
    expect(ordered).toHaveLength(201);
    expect(ordered[0]).toMatchObject({ line: 1 });
    expect(ordered[200]).toMatchObject({ line: 201 });
  });

  it("BoundedMatches 保留全局最小的 limit + 1 条，按 (file, line) 升序", () => {
    const collector = new BoundedMatches(3);
    // 乱序插入，跨文件，且末尾有很多更小的候选把先来的挤出去。
    const candidates = [
      { file: "m.txt", line: 9 },
      { file: "a.txt", line: 2 },
      { file: "z.txt", line: 1 },
      { file: "a.txt", line: 1 },
      { file: "b.txt", line: 1 },
      { file: "a.txt", line: 0 },
    ];
    for (const candidate of candidates) collector.add({ ...candidate, text: "" });

    expect(collector.matched).toBe(6);
    expect(collector.retained).toBe(4);
    expect(collector.ordered().map(({ file, line }) => `${file}:${line}`)).toEqual([
      // a.txt:0 被保留；m.txt:9 / z.txt:1 被挤掉。
      "a.txt:0",
      "a.txt:1",
      "a.txt:2",
      "b.txt:1",
    ]);
  });

  it("200 万命中的端到端调用：matched 精确、returned = 200、堆不随命中数线性增长", async () => {
    const workdir = makeWorkdir();
    // 1000 文件 × 2000 行 = 200 万命中。同一进程内 A/B 实测（2026-11-08）：
    // 旧实现峰值 190.8 MiB，新实现 32.0 MiB。
    // 这里只做一个**宽松**的端到端兜底：阈值 120 MiB 远离旧值 190 MiB，同时不会
    // 因为 GC 节奏（同一语料换成永不命中的 pattern 也会有 0–33 MiB 漂移）而误红。
    // 真正的有界性由上面两条 BoundedMatches 用例钉住。
    const line = "needle-x";
    for (let file = 0; file < 1000; file += 1) {
      writeAt(workdir, `f${String(file).padStart(4, "0")}.txt`, `${line}\n`.repeat(2000));
    }

    const heapBefore = process.memoryUsage().heapUsed;
    let heapPeak = heapBefore;
    const sampler = setInterval(() => {
      const used = process.memoryUsage().heapUsed;
      if (used > heapPeak) heapPeak = used;
    }, 2);

    let r;
    try {
      r = await run(workdir, { pattern: "needle" });
    } finally {
      clearInterval(sampler);
    }

    expect((heapPeak - heapBefore) / (1024 * 1024)).toBeLessThan(120);
    expect(r.detail).toMatchObject({ matched: 2_000_000, returned: 200, truncated: true });
  }, 120_000);
});

describe("grep 可中断正则（D-085）", () => {
  /**
   * `(a+)+$` 对 30 个 `a` + `!`：原生 test 实测 n=29 时 41 s、n=28 时 19 s 不返回。
   * 2 s 批预算下应在 10 s 内返回显式错误；vitest 超时给到 30 s 兜底。
   */
  it("灾难性回溯 → regex_timeout 显式错误，不是无匹配也不是 aborted", async () => {
    const workdir = makeWorkdir();
    writeAt(workdir, "boom.txt", `${"a".repeat(30)}!\n`);

    const started = performance.now();
    const r = await run(workdir, { pattern: "(a+)+$" });
    const elapsed = performance.now() - started;

    expect(r.isError).toBe(true);
    expect(r.code).toBe("regex_timeout");
    expect(elapsed).toBeLessThan(10_000);
    // 文本必须说清三件事：pattern、文件位置、原因是回溯过长。
    expect(r.text).toContain("(a+)+$");
    expect(r.text).toContain("boom.txt");
    expect(r.text).toMatch(/正则回溯过长|backtracking/);
    // 不得伪装成其它结果。
    expect(r.text).not.toBe("(no matches)");
    expect(r.text).not.toContain("(no matches)");
  }, 30_000);

  it("灾难性行之后的正常行不返回：超时是整批作废而非静默截断", async () => {
    const workdir = makeWorkdir();
    // 同一文件、同一批：第 1、3 行都能被 needle 正常命中，第 2 行触发灾难性回溯。
    writeAt(workdir, "mixed.txt", ["alpha needle", `${"a".repeat(30)}!`, "needle later"].join("\n"));

    const r = await run(workdir, { pattern: "(a+)+$|needle" });

    expect(r.isError).toBe(true);
    expect(r.code).toBe("regex_timeout");
    expect(r.text).not.toContain("alpha needle");
    expect(r.text).not.toContain("needle later");
  }, 30_000);

  it("任一文件超时 → 整体 regex_timeout，不返回其它文件已完成的命中", async () => {
    const workdir = makeWorkdir();
    // 字典序上 aaa.txt 先于 zzz.txt，两者同属一批（批最多 50 文件）。
    writeAt(workdir, "aaa.txt", "needle\n");
    writeAt(workdir, "zzz.txt", `${"a".repeat(30)}!\n`);

    const r = await run(workdir, { pattern: "(a+)+$|needle" });

    expect(r.isError).toBe(true);
    expect(r.code).toBe("regex_timeout");
    expect(r.text).not.toContain("aaa.txt:1:needle");
  }, 30_000);

  it("前几批已收集的命中在后续批超时时一并作废", async () => {
    const workdir = makeWorkdir();
    // 60 个先被扫到的小文件 + 1 个灾难性文件：灾难性文件落在第二批
    // （BATCH_MAX_FILES = 50），第一批的命中此时已经在收集器里了。
    for (let index = 0; index < 60; index += 1) {
      writeAt(workdir, `a${String(index).padStart(3, "0")}.txt`, "needle\n");
    }
    writeAt(workdir, "zzz.txt", `${"a".repeat(30)}!\n`);

    const r = await run(workdir, { pattern: "(a+)+$|needle" });

    expect(r.isError).toBe(true);
    expect(r.code).toBe("regex_timeout");
    // 错误文本里当然会回显 pattern（它自己含 "needle"），所以断言的是「没有任何
    // path:line:text 形式的结果行」，而不是「文本里没有 needle」。
    expect(r.text).not.toMatch(/^a\d{3}\.txt:1:/m);
    expect(r.detail).toBeUndefined();
  }, 30_000);

  it("普通正则大批量与逐行原生 RegExp.test 逐条相等", async () => {
    const workdir = makeWorkdir();
    // 64 文件（跨两个批次）× 400 行，混合大小写。
    const expected: { file: string; line: number; text: string }[] = [];
    const native = new RegExp("needle", "i");
    for (let file = 0; file < 64; file += 1) {
      const name = `dir${String(file % 4)}/f${String(file).padStart(3, "0")}.txt`;
      const lines: string[] = [];
      for (let line = 0; line < 400; line += 1) {
        const text = line % 7 === 0 ? `Needle ${file}-${line}` : `haystack ${file}-${line}`;
        lines.push(text);
        if (native.test(text)) expected.push({ file: name, line: line + 1, text });
      }
      writeAt(workdir, name, `${lines.join("\n")}\n`);
    }
    expected.sort(byFileThenLine);
    const expectedText = expected
      .slice(0, 1000)
      .map((match) => `${match.file}:${match.line}:${match.text}`);

    const r = await run(workdir, { pattern: "needle", ignoreCase: true, maxResults: 1000 });

    expect(r.isError).toBe(false);
    expect(r.text.split("\n")).toEqual([...expectedText, "[truncated]"]);
    expect(r.detail).toMatchObject({
      matched: expected.length,
      returned: 1000,
      truncated: true,
    });
  }, 60_000);

  it.each([
    { label: "大小写敏感 + 无 glob", pattern: "needle", ignoreCase: false, glob: undefined },
    { label: "ignoreCase + 无 glob", pattern: "NEEDLE", ignoreCase: true, glob: undefined },
    { label: "大小写敏感 + glob", pattern: "needle", ignoreCase: false, glob: "**/*.ts" },
    { label: "ignoreCase + glob", pattern: "NeEdLe", ignoreCase: true, glob: "**/*.ts" },
  ])("$label 时输出与原生逐行结果一致", async ({ pattern, ignoreCase, glob }) => {
    const workdir = makeWorkdir();
    writeAt(workdir, "a.ts", "needle\nNEEDLE\n");
    writeAt(workdir, "b.md", "needle\n");

    const r = await run(workdir, { pattern, ignoreCase, glob });

    const native = new RegExp(pattern, ignoreCase ? "i" : "");
    const expected: string[] = [];
    const candidates: { file: string; text: string }[] = [
      { file: "a.ts", text: "needle" },
      { file: "a.ts", text: "NEEDLE" },
      { file: "b.md", text: "needle" },
    ];
    for (const [index, candidate] of candidates.entries()) {
      if (glob === "**/*.ts" && !candidate.file.endsWith(".ts")) continue;
      if (!native.test(candidate.text)) continue;
      expected.push(`${candidate.file}:${index === 2 ? 1 : index + 1}:${candidate.text}`);
    }
    expect(r.text).toBe(expected.join("\n") || "(no matches)");
  });
});
