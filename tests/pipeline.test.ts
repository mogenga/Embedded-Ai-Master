import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { SessionHandle } from "../src/session/session.js";
import { echoTool } from "../src/tools/echo.js";
import { executeBatch } from "../src/tools/pipeline.js";
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
    header: {},
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

  it("schema 校验失败 → schema_validation", async () => {
    const { session } = makeSession(path.join(tmp, "session"));
    const reg = new ToolRegistry([echoTool]);

    const results = await executeBatch(session, reg, [call("t1", "echo", { wrong: true })], {
      signal: new AbortController().signal,
      artifactDir: artifactDir(),
    });

    expect(results[0].result.isError).toBe(true);
    expect(results[0].result.code).toBe("schema_validation");
    expect(results[0].result.text).toBe(results[0].result.message);
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

    const started = performance.now();
    const results = await executeBatch(
      session,
      reg,
      [call("1", "a"), call("2", "b")],
      { signal: new AbortController().signal, artifactDir: artifactDir() },
    );
    const elapsed = performance.now() - started;

    expect(results.map((entry) => entry.result.isError)).toEqual([false, false]);
    expect(elapsed).toBeLessThan(100);
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

  it("timeoutMs 到期 → tool_timeout,即使工具不监听 signal", async () => {
    const { session } = makeSession(path.join(tmp, "session"));
    const spans: Span[] = [];
    const reg = new ToolRegistry([delayedTool("slow", 50, true, spans)]);

    const results = await executeBatch(session, reg, [call("1", "slow")], {
      signal: new AbortController().signal,
      artifactDir: artifactDir(),
      timeoutMs: 10,
    });

    expect(results[0].result.isError).toBe(true);
    expect(results[0].result.code).toBe("tool_timeout");
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
    const reg = new ToolRegistry([delayedTool("slow", 50, true, spans)]);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10);

    try {
      const results = await executeBatch(session, reg, [call("1", "slow")], {
        signal: controller.signal,
        artifactDir: artifactDir(),
      });

      expect(results[0].result.code).toBe("tool_aborted");
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
});

describe("executeBatch 证据落盘", () => {
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
    expect(result.text).toBe(text);
    expect(result.artifactPath).toBe(path.join(dir, "big-1.txt"));
    if (result.artifactPath === undefined) throw new Error("missing artifactPath");
    expect(await readFile(result.artifactPath, "utf8")).toBe(text);
    expect(append).not.toHaveBeenCalled();
  });

  it("30000 token 输出 → text 截断为 100000 字符,落盘保留全文", async () => {
    const { session } = makeSession(path.join(tmp, "session"));
    const text = "y".repeat(120000);
    const reg = new ToolRegistry([outputTool("huge", text)]);

    const results = await executeBatch(session, reg, [call("huge-1", "huge")], {
      signal: new AbortController().signal,
      artifactDir: artifactDir(),
    });

    const result = results[0].result;
    expect(result.text.length).toBe(100000);
    expect(result.text).toBe(text.slice(0, 100000));
    if (result.artifactPath === undefined) throw new Error("missing artifactPath");
    expect(await readFile(result.artifactPath, "utf8")).toBe(text);
  });

  it("模型控制的 call.id 无法路径穿越", async () => {
    const { session } = makeSession(path.join(tmp, "session"));
    const text = "z".repeat(40000);
    const reg = new ToolRegistry([outputTool("big", text)]);
    const dir = artifactDir();

    const results = await executeBatch(session, reg, [call("../evil", "big")], {
      signal: new AbortController().signal,
      artifactDir: dir,
    });

    const artifactPath = results[0].result.artifactPath;
    expect(artifactPath).toBeDefined();
    if (artifactPath === undefined) throw new Error("missing artifactPath");
    const fileName = path.basename(artifactPath);
    expect(fileName).not.toContain("..");
    expect(fileName).not.toContain("/");
    expect(fileName).not.toContain("\\");
    expect(path.dirname(artifactPath)).toBe(dir);
    expect(await readFile(artifactPath, "utf8")).toBe(text);
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