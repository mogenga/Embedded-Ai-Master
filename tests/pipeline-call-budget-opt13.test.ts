import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { SessionHandle } from "../src/session/session.js";
import { executeBatch } from "../src/tools/pipeline.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { ToolDef, ToolResult } from "../src/tools/types.js";

/**
 * BACKLOG 6.3 / OPT-13 — the tool's own budget has to reach the pipeline.
 *
 * The source-level checks live in `mcp-call-timeout-opt13.test.ts`; this file
 * answers the behavioural half: given a tool that declares `callTimeoutMs`,
 * does `executeAuthorized` actually let it run longer than the 120 s default?
 *
 * No real waiting: the tool resolves on its own schedule and the pipeline's
 * own timer is the thing under test, so a short declared budget stands in for
 * the 10-minute one without sleeping for ten minutes.
 */
let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "pipeline-budget-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function makeSession(dir: string): SessionHandle {
  return {
    id: "sess-budget",
    dir,
    header: { id: "sess-budget", createdAt: "2026-01-01T00:00:00.000Z", status: "open" },
    append: vi.fn<SessionHandle["append"]>(async () => ({
      seq: 0,
      ts: "2026-10-18T00:00:00.000Z",
      type: "status",
      payload: {},
    })),
    events: () => [],
    usageTotals: () => ({ promptTokens: 0, completionTokens: 0, cachedTokens: 0 }),
    close: async () => {},
  };
}

function ok(text: string): ToolResult {
  return { isError: false, code: "ok", message: "", text };
}

/** A tool that finishes after `finishAfterMs` of real time. */
function slowTool(name: string, finishAfterMs: number, callTimeoutMs?: number): ToolDef<{}> {
  return {
    name,
    description: name,
    schema: z.object({}),
    ...(callTimeoutMs === undefined ? {} : { callTimeoutMs }),
    execute: async () => {
      await new Promise((resolve) => setTimeout(resolve, finishAfterMs));
      return ok(name);
    },
  };
}

// 这些用例只测单次预算，不经权限层；显式声明（D-116）。
const opts = () => ({
  signal: new AbortController().signal,
  artifactDir: path.join(tmp, "artifacts"),
  unsafeSkipPermission: true as const,
});

describe("工具自带的单次预算（OPT-13 / BACKLOG 6.3）", () => {
  it("没有声明的工具照旧受 120s 缺省约束（这里是它的短版本）", async () => {
    // The default is 120 s, which no test can wait for. What is pinned here is
    // the shape: without a declaration the tool gets `opts.timeoutMs`, and a
    // tool that overruns it is cut.
    const registry = new ToolRegistry([slowTool("plain", 80)]);
    const results = await executeBatch(
      makeSession(tmp),
      registry,
      [{ id: "1", name: "plain", input: {} }],
      { ...opts(), timeoutMs: 20 },
    );

    expect(results[0]!.result.code).toBe("tool_timeout");
  });

  it("声明了 callTimeoutMs 的工具可以跑得比 opts.timeoutMs 更久", async () => {
    // This is the whole point of the field: `keil_debug`'s build needs 10 min
    // while the run-level budget (if any) may be far shorter, and the tool is
    // the one that knows. The pipeline must take the larger of the two.
    const registry = new ToolRegistry([slowTool("builder", 80, 5_000)]);
    const results = await executeBatch(
      makeSession(tmp),
      registry,
      [{ id: "1", name: "builder", input: {} }],
      { ...opts(), timeoutMs: 20 },
    );

    expect(results[0]!.result.code).toBe("ok");
    expect(results[0]!.result.text).toBe("builder");
  });

  it("用户显式配的更长的预算优先于工具声明", async () => {
    // A run-level budget longer than the tool's declaration must not be
    // shortened to it — the operator's decision wins, the declaration only
    // ever raises the floor.
    const registry = new ToolRegistry([slowTool("builder", 80, 1)]);
    const results = await executeBatch(
      makeSession(tmp),
      registry,
      [{ id: "1", name: "builder", input: {} }],
      { ...opts(), timeoutMs: 5_000 },
    );

    expect(results[0]!.result.code).toBe("ok");
  });

  it("两者都没给时仍是 120s 缺省，不会被误判成立即超时", async () => {
    const registry = new ToolRegistry([slowTool("plain", 5)]);
    const results = await executeBatch(
      makeSession(tmp),
      registry,
      [{ id: "1", name: "plain", input: {} }],
      opts(),
    );

    expect(results[0]!.result.code).toBe("ok");
  });
});
