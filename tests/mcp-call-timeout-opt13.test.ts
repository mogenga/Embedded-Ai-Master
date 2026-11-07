import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * BACKLOG 6.3 / OPT-13 — a long tool call must not be cut at 120 s by a cap the
 * operator cannot raise.
 *
 * Two independent 120 s caps sit on the path, and the outer one fires first:
 *
 *   1. `src/tools/pipeline.ts` — `DEFAULT_TIMEOUT_MS`, used when the run has no
 *      `timeoutMs`. It applies to *every* tool, so a Keil build (10 min inside
 *      `buildInIde`) is aborted at 120 s before the MCP layer is ever asked.
 *   2. `src/mcp/manager.ts` — `MAX_CALL_TIMEOUT_MS`, a hard ceiling on whatever
 *      `mcp.json` asks for.
 *
 * Both must move together. Raising only the MCP ceiling changes nothing while
 * the pipeline default still aborts first; raising only the pipeline default
 * hands every builtin tool a 10-minute leash. The decision recorded in
 * BACKLOG 6.3 was: keep the defaults where they are, let a tool that knows it
 * is slow declare its own budget, and raise the MCP ceiling to match.
 *
 * No jsdom and no real MCP server here — these read the sources the way
 * `renderer-reachability.test.js` does. What is pinned is the wiring that a
 * future edit could silently drop, plus the numbers the design rests on.
 */
const ROOT = path.join(import.meta.dirname, "..");
const read = (...parts: string[]): string => readFileSync(path.join(ROOT, ...parts), "utf8");

describe("MCP 单次调用上限（OPT-13 / BACKLOG 6.3）", () => {
  it("MCP 层的硬顶不再是 120s，而是 10 分钟", () => {
    const source = read("src", "mcp", "manager.ts");
    const match = /const MAX_CALL_TIMEOUT_MS = ([\d_]+);/.exec(source);
    expect(match).not.toBeNull();
    if (match === null) return;
    // `10 * 60_000`: the number Keil's own build path already uses. A lower
    // ceiling silently makes `mcp.json`'s `timeoutMs` a lie.
    expect(Number(match[1].replaceAll("_", ""))).toBe(600_000);
  });

  it("默认调用超时仍是 15s：不配置的人不该因为抬高上限而等更久", () => {
    const source = read("src", "mcp", "manager.ts");
    const match = /const DEFAULT_CALL_TIMEOUT_MS = ([\d_]+);/.exec(source);
    expect(match).not.toBeNull();
    if (match === null) return;
    expect(Number(match[1].replaceAll("_", ""))).toBe(15_000);
  });

  it("工具可以声明自己的单次上限，管线不再一律套用 120s 缺省", () => {
    const types = read("src", "tools", "types.ts");
    // The field is what lets `mcp__keil__keil_debug` outlive the builtin
    // default without giving `shell`/`grep` the same leash.
    expect(types).toContain("callTimeoutMs");

    const pipeline = read("src", "tools", "pipeline.ts");
    // The resolution must consult the tool's own budget, not only `opts`.
    expect(pipeline).toMatch(/callTimeoutMs/);
  });

  it("MCP 适配器把 server 配的 timeoutMs 传成工具自己的上限", () => {
    const adapter = read("src", "mcp", "tools.ts");
    expect(adapter).toMatch(/callTimeoutMs/);
    // The value has to come from the server's config, not a constant: a user
    // who writes `timeoutMs: 600000` in `mcp.json` must actually get it.
    expect(adapter).toMatch(/timeoutMs/);
  });

  it("种子的 keil 条目拿到 10 分钟，其余三台仍是 120s", async () => {
    // Imported rather than grepped: the entry is built in a loop over
    // `EMBEDDED_SERVER_FILES`, so the literal `name: "keil"` never appears next
    // to a `timeoutMs` literal in the source. Reading the exported table is
    // the only honest check of what a fresh install actually gets.
    const seed = await import("../src/corpus/seed.js");
    const budgets = seed.EMBEDDED_SERVER_TIMEOUT_MS as Record<string, number>;

    // A fresh install must get a build-able budget. Writing 120_000 for keil
    // made `buildInIde`'s own 10-minute allowance unreachable — the config
    // said one thing and the implementation did another (OPT-13).
    expect(budgets.keil).toBe(600_000);

    // serial / datasheet have no 10-minute operations; giving them the same
    // leash would only make a hung call sit there four times as long.
    expect(budgets.serial).toBe(120_000);
    expect(budgets.datasheet).toBe(120_000);
  });
});

describe("内置工具不受影响", () => {
  it("管线的缺省超时仍是 120s", () => {
    const pipeline = read("src", "tools", "pipeline.ts");
    const match = /const DEFAULT_TIMEOUT_MS = ([\d_]+);/.exec(pipeline);
    expect(match).not.toBeNull();
    if (match === null) return;
    // Changing this would give shell/grep/glob a 10-minute default, which is
    // the opposite of what 6.3 asked for.
    expect(Number(match[1].replaceAll("_", ""))).toBe(120_000);
  });

  it("没有声明 callTimeoutMs 的内置工具照旧拿 120s", () => {
    const builtin = read("src", "tools", "builtin.ts");
    expect(builtin).not.toContain("callTimeoutMs");
  });
});
