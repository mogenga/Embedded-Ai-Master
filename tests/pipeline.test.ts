import { getEventListeners } from "node:events";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { SessionHandle } from "../src/session/session.js";
import { echoTool } from "../src/tools/echo.js";
import { executeBatch, sanitizeIssues } from "../src/tools/pipeline.js";
import type { BatchCall } from "../src/tools/pipeline.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { ToolCtx, ToolDef, ToolResult } from "../src/tools/types.js";

interface Span {
  name: string;
  start: number;
  end: number;
}

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "pipeline-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function makeSession(dir: string): { session: SessionHandle; append: ReturnType<typeof vi.fn> } {
  const append = vi.fn<SessionHandle["append"]>(async () => ({
    seq: 0,
    ts: "2026-10-18T00:00:00.000Z",
    type: "status",
    payload: {},
  }));
  const session: SessionHandle = {
    id: "sess-1",
    dir,
    header: { id: "sess-1", createdAt: "2026-01-01T00:00:00.000Z", status: "open" },
    append,
    events: () => [],
    close: async () => {},
  };
  return { session, append };
}

function ok(text: string): ToolResult {
  return { isError: false, code: "ok", message: "", text };
}

function makeTool<I>(
  name: string,
  execute: ToolDef<I>["execute"],
  readOnly?: boolean,
): ToolDef<I> {
  const def: ToolDef<I> = {
    name,
    description: "测试工具",
    schema: z.object({}) as z.ZodType<I>,
    execute,
  };
  if (readOnly !== undefined) def.annotations = { readOnly };
  return def;
}

function delayedTool(name: string, delayMs: number, readOnly: boolean, spans: Span[]): ToolDef<{}> {
  return makeTool<{}>(
    name,
    async () => {
      const start = performance.now();
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      spans.push({ name, start, end: performance.now() });
      return ok(name);
    },
    readOnly,
  );
}

function outputTool(name: string, text: string, readOnly = true): ToolDef<{}> {
  return makeTool<{}>(name, async () => ok(text), readOnly);
}

function call(id: string, name: string, input: unknown = {}): BatchCall {
  return { id, name, input };
}

function spanOf(spans: Span[], name: string): Span {
  const span = spans.find((entry) => entry.name === name);
  if (!span) throw new Error(`missing span: ${name}`);
  return span;
}

function overlap(a: Span, b: Span): number {
  return Math.min(a.end, b.end) - Math.max(a.start, b.start);
}

function artifactDir(): string {
  return path.join(tmp, "artifacts");
}

function artifactPathOf(
  artifactPath: string | undefined,
  dir: string,
  safeId: string,
): string {
  expect(artifactPath).toBeDefined();
  if (artifactPath === undefined) throw new Error("missing artifactPath");
  expect(path.dirname(artifactPath)).toBe(dir);
  expect(path.basename(artifactPath)).toMatch(
    new RegExp(`^${safeId}-[0-9a-f]{16}(?:-\\d+)?\\.txt$`),
  );
  return artifactPath;
}

describe("executeBatch 管线阶段", () => {
  it("未知工具 → tool_not_found 结构化错", async () => {
    const { session } = makeSession(path.join(tmp, "session"));
    const reg = new ToolRegistry([]);

    const results = await executeBatch(session, reg, [call("t1", "ghost")], {
      signal: new AbortController().signal,
      artifactDir: artifactDir(),
    });

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("t1");
    expect(results[0].result).toMatchObject({ isError: true, code: "tool_not_found" });
    expect(results[0].result.text.length).toBeGreaterThan(0);
  });

  it("schema 校验失败 → schema_validation 且零执行", async () => {
    const { session } = makeSession(path.join(tmp, "session"));
    const execute = vi.fn(async (_input: { text: string }) => ok("never"));
    const reg = new ToolRegistry([
      {
        name: "echo",
        description: "回显",
        schema: z.object({ text: z.string() }),
        annotations: { readOnly: true },
        execute,
      },
    ]);

    const results = await executeBatch(session, reg, [call("t1", "echo", { wrong: true })], {
      signal: new AbortController().signal,
      artifactDir: artifactDir(),
    });

    expect(results[0].result.isError).toBe(true);
    expect(results[0].result.code).toBe("schema_validation");
    expect(results[0].result.text).toBe(results[0].result.message);
    expect(execute).not.toHaveBeenCalled();
  });

  it("空 calls → 空数组", async () => {
    const { session } = makeSession(path.join(tmp, "session"));
    const reg = new ToolRegistry([echoTool]);

    const results = await executeBatch(session, reg, [], {
      signal: new AbortController().signal,
      artifactDir: artifactDir(),
    });

    expect(results).toEqual([]);
  });
});

describe("executeBatch 并发策略", () => {
  it("全部 readOnly → 并发执行,时间区间重叠", async () => {
    const { session } = makeSession(path.join(tmp, "session"));
    const spans: Span[] = [];
    const reg = new ToolRegistry([
      delayedTool("a", 50, true, spans),
      delayedTool("b", 50, true, spans),
    ]);

    const results = await executeBatch(
      session,
      reg,
      [call("1", "a"), call("2", "b")],
      { signal: new AbortController().signal, artifactDir: artifactDir() },
    );

    expect(results.map((entry) => entry.result.isError)).toEqual([false, false]);
    expect(overlap(spanOf(spans, "a"), spanOf(spans, "b"))).toBeGreaterThan(0);
  });

  it("含非 readOnly → 串行执行,时间区间不重叠", async () => {
    const { session } = makeSession(path.join(tmp, "session"));
    const spans: Span[] = [];
    const reg = new ToolRegistry([
      delayedTool("reader", 50, true, spans),
      delayedTool("writer", 50, false, spans),
    ]);

    const started = performance.now();
    const results = await executeBatch(
      session,
      reg,
      [call("1", "reader"), call("2", "writer")],
      { signal: new AbortController().signal, artifactDir: artifactDir() },
    );
    const elapsed = performance.now() - started;

    expect(results.map((entry) => entry.result.isError)).toEqual([false, false]);
    expect(elapsed).toBeGreaterThanOrEqual(95);
    expect(overlap(spanOf(spans, "reader"), spanOf(spans, "writer"))).toBeLessThanOrEqual(0);
  });

  it("未知工具按串行处理,其余 readOnly 工具不重叠", async () => {
    const { session } = makeSession(path.join(tmp, "session"));
    const spans: Span[] = [];
    const reg = new ToolRegistry([
      delayedTool("a", 30, true, spans),
      delayedTool("b", 30, true, spans),
    ]);

    const started = performance.now();
    const results = await executeBatch(
      session,
      reg,
      [call("1", "a"), call("2", "ghost"), call("3", "b")],
      { signal: new AbortController().signal, artifactDir: artifactDir() },
    );
    const elapsed = performance.now() - started;

    expect(results.map((entry) => entry.result.code)).toEqual([
      "ok",
      "tool_not_found",
      "ok",
    ]);
    expect(elapsed).toBeGreaterThanOrEqual(55);
    expect(overlap(spanOf(spans, "a"), spanOf(spans, "b"))).toBeLessThanOrEqual(0);
  });

  it("并发执行时返回顺序与输入 calls 一致", async () => {
    const { session } = makeSession(path.join(tmp, "session"));
    const spans: Span[] = [];
    const reg = new ToolRegistry([
      delayedTool("slow", 40, true, spans),
      delayedTool("fast", 5, true, spans),
    ]);

    const results = await executeBatch(
      session,
      reg,
      [call("s", "slow"), call("f", "fast")],
      { signal: new AbortController().signal, artifactDir: artifactDir() },
    );

    expect(results.map((entry) => entry.id)).toEqual(["s", "f"]);
    expect(results.map((entry) => entry.result.text)).toEqual(["slow", "fast"]);
  });
});

describe("executeBatch 错误与取消", () => {
  it("execute 抛 Error → tool_execution_error,不向上抛", async () => {
    const { session } = makeSession(path.join(tmp, "session"));
    const reg = new ToolRegistry([
      makeTool<{}>("boom", async () => {
        throw new Error("kaboom");
      }, true),
    ]);

    const results = await executeBatch(session, reg, [call("1", "boom")], {
      signal: new AbortController().signal,
      artifactDir: artifactDir(),
    });

    expect(results[0].result.isError).toBe(true);
    expect(results[0].result.code).toBe("tool_execution_error");
    expect(results[0].result.message).toContain("kaboom");
    expect(results[0].result.text).toContain("kaboom");
  });

  it("execute 抛超长 Error → message 与 text 同源截断至 2000", async () => {
    const { session } = makeSession(path.join(tmp, "session"));
    const message = "e".repeat(200000);
    const reg = new ToolRegistry([
      makeTool<{}>("boom", async () => {
        throw new Error(message);
      }, true),
    ]);


    const results = await executeBatch(session, reg, [call("boom-long", "boom")], {
      signal: new AbortController().signal,
      artifactDir: artifactDir(),
    });

    const result = results[0].result;
    expect(result.code).toBe("tool_execution_error");
    expect(result.message).toBe("e".repeat(2000));
    expect(result.text).toBe(result.message);
    expect(result.artifactPath).toBeUndefined();
  });

  it("timeoutMs 到期 → tool_timeout,且工具收到的 signal 已 abort", async () => {
    const { session } = makeSession(path.join(tmp, "session"));
    let received: AbortSignal | undefined;
    const reg = new ToolRegistry([
      makeTool<{}>("slow", async (_input, _ctx, signal) => {
        received = signal;
        await new Promise((resolve) => setTimeout(resolve, 50));
        return ok("slow");
      }, true),
    ]);

    const results = await executeBatch(session, reg, [call("1", "slow")], {
      signal: new AbortController().signal,
      artifactDir: artifactDir(),
      timeoutMs: 10,
    });

    expect(results[0].result.isError).toBe(true);
    expect(results[0].result.code).toBe("tool_timeout");
    expect(received).toBeDefined();
    expect(received?.aborted).toBe(true);
  });

  it("超时 abort 后工具抛 AbortError → tool_timeout", async () => {
    const { session } = makeSession(path.join(tmp, "session"));
    const reg = new ToolRegistry([
      makeTool<{}>("signal-aware", async (_input, _ctx, signal) => {
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("timeout", "AbortError")),
            { once: true },
          );
        });
        return ok("unreachable");
      }, true),
    ]);

    const results = await executeBatch(session, reg, [call("1", "signal-aware")], {
      signal: new AbortController().signal,
      artifactDir: artifactDir(),
      timeoutMs: 10,
    });

    expect(results[0].result.isError).toBe(true);
    expect(results[0].result.code).toBe("tool_timeout");
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "timeoutMs=%s 回退默认值且不抛错",
    async (timeoutMs) => {
      const { session } = makeSession(path.join(tmp, "session"));
      const spans: Span[] = [];
      const reg = new ToolRegistry([delayedTool("slow", 50, true, spans)]);

      const results = await executeBatch(session, reg, [call("1", "slow")], {
        signal: new AbortController().signal,
        artifactDir: artifactDir(),
        timeoutMs,
      });

      expect(results[0].result).toMatchObject({ isError: false, code: "ok", text: "slow" });
    },
  );

  it.each([1.5, 5_000_000_000])("timeoutMs=%s 整数化/上限化且不抛错", async (timeoutMs) => {
    const { session } = makeSession(path.join(tmp, "session"));
    const reg = new ToolRegistry([
      makeTool<{}>("instant", async () => ok("instant"), true),
    ]);

    const results = await executeBatch(session, reg, [call("1", "instant")], {
      signal: new AbortController().signal,
      artifactDir: artifactDir(),
      timeoutMs,
    });

    expect(results[0].result).toMatchObject({ isError: false, code: "ok", text: "instant" });
  });

  it("批次 signal 已取消 → tool_aborted 且不执行工具", async () => {
    const { session } = makeSession(path.join(tmp, "session"));
    const execute = vi.fn(async () => ok("never"));
    const reg = new ToolRegistry([makeTool<{}>("guarded", execute, true)]);
    const controller = new AbortController();
    controller.abort();

    const results = await executeBatch(session, reg, [call("1", "guarded")], {
      signal: controller.signal,
      artifactDir: artifactDir(),
    });

    expect(results[0].result.code).toBe("tool_aborted");
    expect(results[0].result.isError).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it("执行中批次 signal 取消 → tool_aborted", async () => {
    const { session } = makeSession(path.join(tmp, "session"));
    const spans: Span[] = [];
    const reg = new ToolRegistry([delayedTool("slow", 200, true, spans)]);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10);
    const started = performance.now();

    try {
      const results = await executeBatch(session, reg, [call("1", "slow")], {
        signal: controller.signal,
        artifactDir: artifactDir(),
      });
      const elapsed = performance.now() - started;

      expect(results[0].result.code).toBe("tool_aborted");
      expect(elapsed).toBeLessThan(100);
    } finally {
      clearTimeout(timer);
    }
  });

  it("工具抛 AbortError → tool_aborted", async () => {
    const { session } = makeSession(path.join(tmp, "session"));
    const reg = new ToolRegistry([
      makeTool<{}>("aborting", async () => {
        const error = new Error("cancelled");
        error.name = "AbortError";
        throw error;
      }, true),
    ]);

    const results = await executeBatch(session, reg, [call("1", "aborting")], {
      signal: new AbortController().signal,
      artifactDir: artifactDir(),
    });

    expect(results[0].result.isError).toBe(true);
    expect(results[0].result.code).toBe("tool_aborted");
  });

  it("executeBatch 结束后移除 opts.signal 的 abort 监听", async () => {
    const { session } = makeSession(path.join(tmp, "session"));
    const controller = new AbortController();
    const reg = new ToolRegistry([makeTool<{}>("ok", async () => ok("done"), true)]);

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);

    await executeBatch(session, reg, [call("1", "ok")], {
      signal: controller.signal,
      artifactDir: artifactDir(),
    });

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
});

describe("executeBatch 证据落盘", () => {
  it("小输出（<=8000 token）不落盘且 artifactPath 为 undefined", async () => {
    const { session } = makeSession(path.join(tmp, "session"));
    const reg = new ToolRegistry([echoTool]);
    const dir = artifactDir();

    const results = await executeBatch(
      session,
      reg,
      [call("small", "echo", { text: "hi" })],
      { signal: new AbortController().signal, artifactDir: dir },
    );

    expect(results[0].result.isError).toBe(false);
    expect(results[0].result.text).toBe("hi");
    expect(results[0].result.artifactPath).toBeUndefined();
    await expect(stat(dir)).rejects.toThrow();
  });

  it("10000 token 输出 → 落盘全文、artifactPath 存在、text 不截断", async () => {
    const { session, append } = makeSession(path.join(tmp, "session"));
    const text = "x".repeat(40000);
    const reg = new ToolRegistry([outputTool("big", text)]);
    const dir = artifactDir();

    const results = await executeBatch(session, reg, [call("big-1", "big")], {
      signal: new AbortController().signal,
      artifactDir: dir,
    });

    const result = results[0].result;
    expect(result.isError).toBe(false);
    const artifactPath = artifactPathOf(result.artifactPath, dir, "big-1");
    const marker = `\n[full output at ${artifactPath}]`;
    expect(result.text).toBe(text + marker);
    expect(await readFile(artifactPath, "utf8")).toBe(text);
    expect(append).not.toHaveBeenCalled();
  });

  it("30000 token 输出 → 截断并追加 truncated 标记,落盘保留全文", async () => {
    const { session } = makeSession(path.join(tmp, "session"));
    const text = "y".repeat(120000);
    const reg = new ToolRegistry([outputTool("huge", text)]);
    const dir = artifactDir();

    const results = await executeBatch(session, reg, [call("huge-1", "huge")], {
      signal: new AbortController().signal,
      artifactDir: dir,
    });

    const result = results[0].result;
    const artifactPath = artifactPathOf(result.artifactPath, dir, "huge-1");
    const marker = `\n[truncated; full output at ${artifactPath}]`;
    expect(result.text.startsWith(text.slice(0, 100000))).toBe(true);
    expect(result.text).toBe(text.slice(0, 100000) + marker);
    expect(result.text.length).toBeLessThanOrEqual(100000 + marker.length);
    expect(await readFile(artifactPath, "utf8")).toBe(text);
  });

  it("恰好 8000 token（32000 字符）不落盘", async () => {
    const { session } = makeSession(path.join(tmp, "session"));
    const text = "e".repeat(32000);
    const reg = new ToolRegistry([outputTool("edge", text)]);
    const dir = artifactDir();

    const results = await executeBatch(session, reg, [call("edge-8000", "edge")], {
      signal: new AbortController().signal,
      artifactDir: dir,
    });

    expect(results[0].result.text).toBe(text);
    expect(results[0].result.artifactPath).toBeUndefined();
    await expect(stat(dir)).rejects.toThrow();
  });

  it("8001 token（32004 字符）落盘", async () => {
    const { session } = makeSession(path.join(tmp, "session"));
    const text = "f".repeat(32004);
    const reg = new ToolRegistry([outputTool("edge", text)]);
    const dir = artifactDir();

    const results = await executeBatch(session, reg, [call("edge-8001", "edge")], {
      signal: new AbortController().signal,
      artifactDir: dir,
    });

    const result = results[0].result;
    const artifactPath = artifactPathOf(result.artifactPath, dir, "edge-8001");
    const marker = `\n[full output at ${artifactPath}]`;
    expect(result.text).toBe(text + marker);
    expect(await readFile(artifactPath, "utf8")).toBe(text);
  });

  it("isError=true 的大文本同样落盘并加标记", async () => {
    const { session } = makeSession(path.join(tmp, "session"));
    const text = "v".repeat(40000);
    const reg = new ToolRegistry([
      makeTool<{}>(
        "fails",
        async () => ({ isError: true, code: "tool_failed", message: "failed", text }),
        true,
      ),
    ]);
    const dir = artifactDir();

    const results = await executeBatch(session, reg, [call("fail-big", "fails")], {
      signal: new AbortController().signal,
      artifactDir: dir,
    });

    const result = results[0].result;
    expect(result.isError).toBe(true);
    expect(result.code).toBe("tool_failed");
    const artifactPath = artifactPathOf(result.artifactPath, dir, "fail-big");
    expect(result.text).toBe(text + `\n[full output at ${artifactPath}]`);
    expect(await readFile(artifactPath, "utf8")).toBe(text);
  });

  it("恰好 100000 字符落盘但不截断", async () => {
    const { session } = makeSession(path.join(tmp, "session"));
    const text = "g".repeat(100000);
    const reg = new ToolRegistry([outputTool("edge", text)]);
    const dir = artifactDir();

    const results = await executeBatch(session, reg, [call("edge-100000", "edge")], {
      signal: new AbortController().signal,
      artifactDir: dir,
    });

    const result = results[0].result;
    const artifactPath = artifactPathOf(result.artifactPath, dir, "edge-100000");
    const marker = `\n[full output at ${artifactPath}]`;
    expect(result.text).toBe(text + marker);
    expect(result.text).not.toContain("[truncated");
    expect(await readFile(artifactPath, "utf8")).toBe(text);
  });

  it("100001 字符截断为前 100000 并追加 truncated 标记", async () => {
    const { session } = makeSession(path.join(tmp, "session"));
    const text = "h".repeat(100001);
    const reg = new ToolRegistry([outputTool("edge", text)]);
    const dir = artifactDir();

    const results = await executeBatch(session, reg, [call("edge-100001", "edge")], {
      signal: new AbortController().signal,
      artifactDir: dir,
    });

    const result = results[0].result;
    const artifactPath = artifactPathOf(result.artifactPath, dir, "edge-100001");
    const marker = `\n[truncated; full output at ${artifactPath}]`;
    expect(result.text.startsWith(text.slice(0, 100000))).toBe(true);
    expect(result.text).toBe(text.slice(0, 100000) + marker);
    expect(result.text.length).toBeLessThanOrEqual(100000 + marker.length);
    expect(await readFile(artifactPath, "utf8")).toBe(text);
  });

  it.each(["CON", "COM1", "NUL", "con"])("Windows 保留名 %s 加前缀 _", async (reserved) => {
    const { session } = makeSession(path.join(tmp, "session"));
    const text = "i".repeat(40000);
    const reg = new ToolRegistry([outputTool("big", text)]);
    const dir = artifactDir();

    const results = await executeBatch(session, reg, [call(reserved, "big")], {
      signal: new AbortController().signal,
      artifactDir: dir,
    });

    const result = results[0].result;
    expect(result.isError).toBe(false);
    const artifactPath = artifactPathOf(result.artifactPath, dir, `_${reserved}`);
    expect(await readFile(artifactPath, "utf8")).toBe(text);
  });

  it("超长 call.id 截断为 100 字符", async () => {
    const { session } = makeSession(path.join(tmp, "session"));
    const text = "j".repeat(40000);
    const reg = new ToolRegistry([outputTool("big", text)]);
    const dir = artifactDir();

    const results = await executeBatch(session, reg, [call("a".repeat(200), "big")], {
      signal: new AbortController().signal,
      artifactDir: dir,
    });

    const result = results[0].result;
    const artifactPath = artifactPathOf(result.artifactPath, dir, "a".repeat(100));
    expect(await readFile(artifactPath, "utf8")).toBe(text);
  });

  it("清洗后同名但原始 id 不同 → 两个证据文件均存在", async () => {
    const { session } = makeSession(path.join(tmp, "session"));
    const textA = "k".repeat(40000);
    const textB = "m".repeat(40000);
    const reg = new ToolRegistry([
      outputTool("big-a", textA),
      outputTool("big-b", textB),
    ]);
    const dir = artifactDir();

    const results = await executeBatch(
      session,
      reg,
      [call("a/b", "big-a"), call("a?b", "big-b")],
      { signal: new AbortController().signal, artifactDir: dir },
    );

    const first = artifactPathOf(results[0].result.artifactPath, dir, "a_b");
    const second = artifactPathOf(results[1].result.artifactPath, dir, "a_b");
    expect(first).not.toBe(second);
    expect(await readFile(first, "utf8")).toBe(textA);
    expect(await readFile(second, "utf8")).toBe(textB);
  });

  it.each([
    ["parent-traversal", "../evil", "___evil"],
    ["windows-traversal", "..\\evil", "___evil"],
    ["absolute", "C:\\Windows\\x", "C__Windows_x"],
    ["nul", "\u0000ctrl", "_ctrl"],
    ["chinese", "中文", "__"],
    ["long", "a".repeat(300), "a".repeat(100)],
  ])("路径 id（%s）被限制在 artifactDir 内", async (_label, id, safeId) => {
    const { session } = makeSession(path.join(tmp, "session"));
    const text = "z".repeat(40000);
    const reg = new ToolRegistry([outputTool("big", text)]);
    const dir = artifactDir();

    const results = await executeBatch(session, reg, [call(id, "big")], {
      signal: new AbortController().signal,
      artifactDir: dir,
    });

    const result = results[0].result;
    expect(result.isError).toBe(false);
    const artifactPath = artifactPathOf(result.artifactPath, dir, safeId);
    const fileName = path.basename(artifactPath);
    expect(fileName).not.toContain("..");
    expect(fileName).not.toContain("/");
    expect(fileName).not.toContain("\\");
    expect(await readFile(artifactPath, "utf8")).toBe(text);
  });
});

describe("executeBatch 证据唯一性", () => {
  it("同批重复 id → 第二次 duplicate_call_id 且不执行", async () => {
    const { session } = makeSession(path.join(tmp, "session"));
    const execute = vi.fn(async () => ok("first"));
    const reg = new ToolRegistry([makeTool<{}>("tool", execute, true)]);

    const results = await executeBatch(
      session,
      reg,
      [call("dup", "tool"), call("dup", "tool")],
      { signal: new AbortController().signal, artifactDir: artifactDir() },
    );

    expect(results[0].result.code).toBe("ok");
    expect(results[1].result).toMatchObject({ isError: true, code: "duplicate_call_id" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("空字符串 id 第二次 → duplicate_call_id 且只执行一次", async () => {
    const { session } = makeSession(path.join(tmp, "session"));
    const execute = vi.fn(async () => ok("first"));
    const reg = new ToolRegistry([makeTool<{}>("tool", execute, true)]);

    const results = await executeBatch(session, reg, [call("", "tool"), call("", "tool")], {
      signal: new AbortController().signal,
      artifactDir: artifactDir(),
    });

    expect(results[0].result.code).toBe("ok");
    expect(results[1].result).toMatchObject({ isError: true, code: "duplicate_call_id" });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("同批两个 readOnly 工具同 id 不覆盖", async () => {
    const { session } = makeSession(path.join(tmp, "session"));
    const textA = "p".repeat(40000);
    const textB = "q".repeat(40000);
    const reg = new ToolRegistry([
      outputTool("first-tool", textA),
      outputTool("second-tool", textB),
    ]);
    const dir = artifactDir();

    const results = await executeBatch(
      session,
      reg,
      [call("same", "first-tool"), call("same", "second-tool")],
      { signal: new AbortController().signal, artifactDir: dir },
    );

    expect(results[0].result.code).toBe("ok");
    expect(results[1].result.code).toBe("duplicate_call_id");
    const artifactPath = artifactPathOf(results[0].result.artifactPath, dir, "same");
    expect(await readFile(artifactPath, "utf8")).toBe(textA);
    expect(await readdir(dir)).toHaveLength(1);
  });

  it("跨批同 id 两次落盘两个文件且内容各自正确", async () => {
    const { session } = makeSession(path.join(tmp, "session"));
    const textA = "r".repeat(40000);
    const textB = "s".repeat(40000);
    const reg = new ToolRegistry([
      outputTool("big-a", textA),
      outputTool("big-b", textB),
    ]);
    const dir = artifactDir();

    const first = await executeBatch(session, reg, [call("shared", "big-a")], {
      signal: new AbortController().signal,
      artifactDir: dir,
    });
    const second = await executeBatch(session, reg, [call("shared", "big-b")], {
      signal: new AbortController().signal,
      artifactDir: dir,
    });

    const firstPath = artifactPathOf(first[0].result.artifactPath, dir, "shared");
    const secondPath = artifactPathOf(second[0].result.artifactPath, dir, "shared");
    expect(firstPath).not.toBe(secondPath);
    expect(path.basename(secondPath)).toMatch(/-1\.txt$/);
    expect(await readFile(firstPath, "utf8")).toBe(textA);
    expect(await readFile(secondPath, "utf8")).toBe(textB);
  });
});

describe("executeBatch ToolResult 形状校验", () => {
  it.each([
    ["null", null],
    ["缺少 text", { isError: false, code: "ok", message: "" }],
    ["text 为 null", { isError: false, code: "ok", message: "", text: null }],
    ["text 为 number", { isError: false, code: "ok", message: "", text: 1 }],
    ["isError 为 string", { isError: "false", code: "ok", message: "", text: "x" }],
  ])("%s → tool_protocol_error", async (_label, bad) => {
    const { session } = makeSession(path.join(tmp, "session"));
    const reg = new ToolRegistry([
      makeTool<{}>("bad", async () => bad as unknown as ToolResult, true),
    ]);

    const results = await executeBatch(session, reg, [call("1", "bad")], {
      signal: new AbortController().signal,
      artifactDir: artifactDir(),
    });

    const result = results[0].result;
    expect(result).toMatchObject({ isError: true, code: "tool_protocol_error" });
    expect(result.message).toContain("invalid ToolResult");
    expect(result.text).toBe(result.message);
  });

  it("协议错误摘要不拼接原始大对象", async () => {
    const { session } = makeSession(path.join(tmp, "session"));
    const bad = {
      isError: false,
      code: "ok",
      message: "",
      text: 1,
      blob: "z".repeat(100000),
    };
    const reg = new ToolRegistry([
      makeTool<{}>("bad", async () => bad as unknown as ToolResult, true),
    ]);

    const results = await executeBatch(session, reg, [call("1", "bad")], {
      signal: new AbortController().signal,
      artifactDir: artifactDir(),
    });

    const result = results[0].result;
    expect(result.code).toBe("tool_protocol_error");
    expect(result.message.length).toBeLessThan(500);
    expect(result.message).not.toContain("zzzz");
  });
});

describe("executeBatch 落盘失败", () => {
  async function blockedArtifactDir(): Promise<string> {
    const blocked = path.join(tmp, "blocked");
    await writeFile(blocked, "x");
    return blocked;
  }

  it("成功结果落盘失败且未超限时保留全文并追加 retained 标记", async () => {
    const { session } = makeSession(path.join(tmp, "session"));
    const text = "t".repeat(40000);
    const reg = new ToolRegistry([outputTool("big", text)]);
    const dir = await blockedArtifactDir();

    const results = await executeBatch(session, reg, [call("1", "big")], {
      signal: new AbortController().signal,
      artifactDir: dir,
    });

    const result = results[0].result;
    const marker = "\n[artifact write failed; full output retained]";
    expect(result.isError).toBe(false);
    expect(result.code).toBe("ok");
    expect(result.text).toBe(text + marker);
    expect(result.artifactPath).toBeUndefined();
    expect(result.detail).toMatchObject({ artifactError: expect.any(String) });
  });

  it("错误结果落盘失败且未超限时保留全文并追加 retained 标记", async () => {
    const { session } = makeSession(path.join(tmp, "session"));
    const text = "u".repeat(40000);
    const reg = new ToolRegistry([
      makeTool<{}>(
        "fails",
        async () => ({ isError: true, code: "tool_failed", message: "failed", text }),
        true,
      ),
    ]);
    const dir = await blockedArtifactDir();

    const results = await executeBatch(session, reg, [call("1", "fails")], {
      signal: new AbortController().signal,
      artifactDir: dir,
    });

    const result = results[0].result;
    const marker = "\n[artifact write failed; full output retained]";
    expect(result.isError).toBe(true);
    expect(result.code).toBe("tool_failed");
    expect(result.text).toBe(text + marker);
    expect(result.detail).toMatchObject({ artifactError: expect.any(String) });
  });

  it("落盘失败且文本超限时追加 truncated 标记", async () => {
    const { session } = makeSession(path.join(tmp, "session"));
    const text = "w".repeat(120000);
    const reg = new ToolRegistry([outputTool("huge", text)]);
    const dir = await blockedArtifactDir();

    const results = await executeBatch(session, reg, [call("1", "huge")], {
      signal: new AbortController().signal,
      artifactDir: dir,
    });

    const result = results[0].result;
    const marker = "\n[truncated; artifact write failed]";
    expect(result.isError).toBe(false);
    expect(result.text.startsWith(text.slice(0, 100000))).toBe(true);
    expect(result.text.endsWith(marker)).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(100000 + marker.length);
    expect(result.artifactPath).toBeUndefined();
    expect(result.detail).toMatchObject({ artifactError: expect.any(String) });
  });
});

describe("executeBatch 出口限长", () => {
  it("300000 字符 call.name → message 与 text 同源截断至 200", async () => {
    const { session } = makeSession(path.join(tmp, "session"));
    const reg = new ToolRegistry([]);


    const results = await executeBatch(session, reg, [call("long-name", "n".repeat(300000))], {
      signal: new AbortController().signal,
      artifactDir: artifactDir(),
    });

    const result = results[0].result;
    expect(result.code).toBe("tool_not_found");
    expect(result.message).toBe(`tool not found: ${"n".repeat(200)}`);
    expect(result.text).toBe(result.message);
    expect(result.artifactPath).toBeUndefined();
  });

  it("200000 字符 schema 键 → detail 白名单且 JSON ≤10000", async () => {
    const { session } = makeSession(path.join(tmp, "session"));
    const key = "k".repeat(200000);
    const reg = new ToolRegistry([
      {
        name: "big-schema",
        description: "大键 schema",
        schema: z.object({ [key]: z.string() }),
        annotations: { readOnly: true },
        execute: async () => ok("never"),
      },
    ]);

    const results = await executeBatch(session, reg, [call("1", "big-schema", {})], {
      signal: new AbortController().signal,
      artifactDir: artifactDir(),
    });

    const result = results[0].result;
    expect(result.code).toBe("schema_validation");
    expect(result.message.length).toBeLessThanOrEqual(2000);
    const issues = result.detail as Array<{ code?: string; path: string[]; message: string }>;
    expect(issues.length).toBeLessThanOrEqual(20);
    expect(JSON.stringify(issues).length).toBeLessThanOrEqual(10000);
    for (const issue of issues) {
      expect(Object.keys(issue).sort()).toEqual(["code", "message", "path"]);
      expect(Array.isArray(issue.path)).toBe(true);
      for (const segment of issue.path) expect(segment.length).toBeLessThanOrEqual(100);
      expect(issue.message.length).toBeLessThanOrEqual(500);
    }
  });

  it("unrecognized_keys 不保留原始 keys 数组", async () => {
    const { session } = makeSession(path.join(tmp, "session"));
    const extraKey = "x".repeat(200000);
    const reg = new ToolRegistry([
      {
        name: "strict-schema",
        description: "严格 schema",
        schema: z.object({ known: z.string() }).strict(),
        annotations: { readOnly: true },
        execute: async () => ok("never"),
      },
    ]);

    const results = await executeBatch(
      session,
      reg,
      [call("1", "strict-schema", { known: "k", [extraKey]: "v" })],
      { signal: new AbortController().signal, artifactDir: artifactDir() },
    );

    const result = results[0].result;
    expect(result.code).toBe("schema_validation");
    expect(JSON.stringify(result.detail).length).toBeLessThanOrEqual(10000);
    const issues = result.detail as Array<Record<string, unknown>>;
    expect(issues[0]).not.toHaveProperty("keys");
    expect(Object.keys(issues[0]).sort()).toEqual(["code", "message", "path"]);
  });

  it("超过 20 条 schema issue 只保留 20 条", async () => {
    const { session } = makeSession(path.join(tmp, "session"));
    const shape: Record<string, z.ZodString> = {};
    for (let index = 0; index < 25; index += 1) {
      shape[`field_${index}`] = z.string();
    }
    const reg = new ToolRegistry([
      {
        name: "many-issues",
        description: "多问题 schema",
        schema: z.object(shape),
        annotations: { readOnly: true },
        execute: async () => ok("never"),
      },
    ]);

    const results = await executeBatch(session, reg, [call("1", "many-issues", {})], {
      signal: new AbortController().signal,
      artifactDir: artifactDir(),
    });

    const issues = results[0].result.detail as Array<{ message: string }>;
    expect(issues).toHaveLength(20);
    for (const issue of issues) expect(issue.message.length).toBeLessThanOrEqual(500);
  });

  it("20 条 issue × 20 段 × 100 字符 path → JSON ≤10000", () => {
    const raw = Array.from({ length: 20 }, () => ({
      code: "c".repeat(100),
      path: Array.from({ length: 20 }, () => "p".repeat(100)),
      message: "m".repeat(500),
    }));

    const sanitized = sanitizeIssues(raw);

    expect(JSON.stringify(sanitized).length).toBeLessThanOrEqual(10000);
    expect(Array.isArray(sanitized)).toBe(true);
  });

  it("invalid_union 保留子错误摘要", async () => {
    const { session } = makeSession(path.join(tmp, "session"));
    const reg = new ToolRegistry([
      {
        name: "union-schema",
        description: "union schema",
        schema: z.object({
          value: z.union([z.object({ a: z.string() }), z.object({ b: z.number() })]),
        }),
        annotations: { readOnly: true },
        execute: async () => ok("never"),
      },
    ]);

    const results = await executeBatch(
      session,
      reg,
      [call("1", "union-schema", { value: {} })],
      { signal: new AbortController().signal, artifactDir: artifactDir() },
    );

    const issues = results[0].result.detail as Array<{
      errors?: Array<{ code?: string; message?: string }>;
    }>;
    expect(issues[0].errors).toBeDefined();
    expect(issues[0].errors?.length).toBeGreaterThan(0);
    expect(typeof issues[0].errors?.[0].code).toBe("string");
    expect(typeof issues[0].errors?.[0].message).toBe("string");
  });

  it("畸形 code 不产生 undefined 键", () => {
    const sanitized = sanitizeIssues([
      { code: 123, path: ["x"], message: "m" },
      { path: [], message: "missing-code" },
    ]) as Array<Record<string, unknown>>;

    for (const issue of sanitized) {
      expect(Object.prototype.hasOwnProperty.call(issue, "code")).toBe(false);
      expect(Object.keys(issue)).not.toContain("undefined");
    }
  });

  it("超出预算且压缩无效时返回 truncated 兜底", () => {
    const sanitized = sanitizeIssues(
      [{ code: "custom", path: ["a".repeat(100)], message: "m".repeat(500) }],
      10,
    );

    expect(sanitized).toStrictEqual({ issues: [], truncated: true });
  });
});

describe("executeBatch 工具上下文", () => {
  it("默认 cwd 为 session.dir,并传入 sessionId", async () => {
    const sessionDir = path.join(tmp, "session");
    const { session } = makeSession(sessionDir);
    let received: ToolCtx | undefined;
    const reg = new ToolRegistry([
      makeTool<{}>("ctx", async (_input, ctx) => {
        received = ctx;
        return ok("done");
      }, true),
    ]);

    await executeBatch(session, reg, [call("1", "ctx")], {
      signal: new AbortController().signal,
      artifactDir: artifactDir(),
    });

    expect(received).toStrictEqual({ sessionId: "sess-1", cwd: sessionDir });
  });

  it("显式 cwd 覆盖 session.dir", async () => {
    const { session } = makeSession(path.join(tmp, "session"));
    const cwd = path.join(tmp, "work");
    let received: ToolCtx | undefined;
    const reg = new ToolRegistry([
      makeTool<{}>("ctx", async (_input, ctx) => {
        received = ctx;
        return ok("done");
      }, true),
    ]);

    await executeBatch(session, reg, [call("1", "ctx")], {
      signal: new AbortController().signal,
      artifactDir: artifactDir(),
      cwd,
    });

    expect(received).toStrictEqual({ sessionId: "sess-1", cwd });
  });
});
