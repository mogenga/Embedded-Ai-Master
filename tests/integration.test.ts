import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMessages } from "../src/context/build.js";
import { SUMMARY_PROMPT } from "../src/context/compact.js";
import { ConfigLoadError, ModelReferenceError } from "../src/config/providers.js";
import { runSession } from "../src/index.js";
import type { LoopEvent } from "../src/loop/events.js";
import { McpManager } from "../src/mcp/manager.js";
import { SessionResumeError } from "../src/session/errors.js";
import { createSession, readSessionFile } from "../src/session/session.js";
import { ToolRegistry } from "../src/tools/registry.js";

const resumeCloseFailure = vi.hoisted(() => ({ enabled: false }));
const resumeCallCounter = vi.hoisted(() => ({ count: 0 }));
const statusAppendFailure = vi.hoisted(() => ({ enabled: false }));
const mcpStatusAppendFailure = vi.hoisted(() => ({ enabled: false }));

vi.mock("../src/session/session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/session/session.js")>();
  return {
    ...actual,
    createSession: async (
      dir: string,
      opts?: Parameters<typeof actual.createSession>[1],
    ) => {
      const handle = await actual.createSession(dir, opts);
      if (!statusAppendFailure.enabled && !mcpStatusAppendFailure.enabled) return handle;
      const originalAppend = handle.append.bind(handle);
      let failed = false;
      if (statusAppendFailure.enabled) {
        statusAppendFailure.enabled = false;
        handle.append = (event) => {
          if (failed) return originalAppend(event);
          failed = true;
          return Promise.reject(new Error("status append boom"));
        };
        return handle;
      }
      mcpStatusAppendFailure.enabled = false;
      handle.append = (event) => {
        if (failed || event.type !== "mcp_status") return originalAppend(event);
        failed = true;
        return Promise.reject(new Error("mcp status append boom"));
      };
      return handle;
    },
    resumeSession: async (dir: string, opts?: { generationThresholdBytes?: number }) => {
      resumeCallCounter.count += 1;
      const handle = await actual.resumeSession(dir, opts);
      if (!resumeCloseFailure.enabled) return handle;
      return {
        ...handle,
        close: async () => {
          await handle.close();
          throw new Error("close boom");
        },
      };
    },
  };
});

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "integration-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  resumeCloseFailure.enabled = false;
  resumeCallCounter.count = 0;
  statusAppendFailure.enabled = false;
  mcpStatusAppendFailure.enabled = false;
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) await removeTempDir(dir);
});


async function removeTempDir(dir: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOTEMPTY" || attempt >= 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

interface FetchCall {
  url: string;
  body: Record<string, unknown>;
  headers: Headers;
}

function mockFetch(bodies: unknown[]): { impl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  let index = 0;
  const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      headers: new Headers(init?.headers),
    });
    const payload = bodies[Math.min(index, bodies.length - 1)];
    index += 1;
    return {
      ok: true,
      status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    };
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const TOOL_RESPONSE = {
  choices: [
    {
      message: {
        content: "",
        tool_calls: [
          { id: "call-1", type: "function", function: { name: "echo", arguments: '{"text":"hello"}' } },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
};

const EMPTY_RESPONSE = {
  choices: [{ message: { content: "done" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 20, completion_tokens: 3 },
};

const LONG_TOOL_TEXT = "E".repeat(400);

const LONG_TOOL_RESPONSE = {
  choices: [
    {
      message: {
        content: "",
        tool_calls: [
          {
            id: "call-long",
            type: "function",
            function: { name: "echo", arguments: JSON.stringify({ text: LONG_TOOL_TEXT }) },
          },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: { prompt_tokens: 5, completion_tokens: 2 },
};

const SUMMARY_RESPONSE = {
  choices: [{ message: { content: "summary-of-old-context" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 100, completion_tokens: 10 },
};

const HIGH_USAGE_TOOL_RESPONSE = {
  choices: [
    {
      message: {
        content: "",
        tool_calls: [
          {
            id: "call-meter",
            type: "function",
            function: { name: "echo", arguments: JSON.stringify({ text: "hi" }) },
          },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: { prompt_tokens: 1000, completion_tokens: 2 },
};

const SOFT_RATIO_TOOL_RESPONSE = toolCallResponseNoUsage("call-soft", "echo", {
  text: "S".repeat(100),
});
const TAIL_RATIO_TOOL_RESPONSE_A = toolCallResponseNoUsage("c1", "echo", {
  text: "A".repeat(80),
});
const TAIL_RATIO_TOOL_RESPONSE_B = toolCallResponseNoUsage("c2", "echo", {
  text: "B".repeat(80),
});

const PROVIDERS = {
  gw: {
    protocol: "openai-chat-completions",
    baseUrl: "http://127.0.0.1:9/v1",
    models: { flash: { contextWindow: 8192, maxOutput: 512 } },
    pricePerMillion: { input: 1, output: 1 },
  },
};

function providersText(): string {
  return JSON.stringify(PROVIDERS);
}

async function collect(generator: AsyncGenerator<LoopEvent>): Promise<LoopEvent[]> {
  const events: LoopEvent[] = [];
  for await (const event of generator) events.push(event);
  return events;
}

describe("runSession 端到端装配", () => {
  it("注入 providersText 与 mock fetch 后闭环终止、请求体正确并落日志", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const sessionDir = path.join(home, "case");
    const { impl, calls } = mockFetch([TOOL_RESPONSE, EMPTY_RESPONSE]);

    const events = await collect(
      runSession({
        input: "hi",
        model: "gw/flash",
        providersText: providersText(),
        sessionDir,
        fetchImpl: impl,
      }),
    );

    expect(events.map((event) => event.kind)).toEqual([
      "model_message",
      "tool_use",
      "tool_result",
      "model_message",
      "done",
    ]);
    expect(events.at(-1)).toEqual({ kind: "done", finishReason: "no_tool_calls" });
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe("http://127.0.0.1:9/v1/chat/completions");
    expect(calls[0].body.model).toBe("flash");
    expect(calls[0].body.max_tokens).toBe(512);
    expect(calls[0].body.stream).toBe(true);
    expect(calls[0].body.tools).toHaveLength(5);
    expect(
      (calls[0].body.tools as Array<{ type: string; function: { name: string } }>).map(
        (tool) => tool.function.name,
      ),
    ).toEqual(["echo", "fs", "shell", "glob", "grep"]);
    expect(calls[0].body.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "function",
          function: expect.objectContaining({ name: "echo" }),
        }),
      ]),
    );
    expect(calls[0].body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(calls[1].body.messages).toEqual([
      { role: "user", content: "hi" },
      expect.objectContaining({ role: "assistant" }),
      { role: "tool", content: "hello", tool_call_id: "call-1" },
    ]);

    const logPath = path.join(sessionDir, "session.v1.jsonl");
    expect(existsSync(logPath)).toBe(true);
    const log = readSessionFile(logPath);
    expect(log[0]).toMatchObject({ type: "user", payload: { content: "hi" } });
    expect(log.some((event) => event.type === "assistant")).toBe(true);
    expect(log.filter((event) => event.type === "tool_result")).toHaveLength(1);
    expect(buildMessages(log).map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
  });

  it("providersText 缺省且文件不存在时首个 next 抛 providers_not_found", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);

    const generator = runSession({ input: "hi", model: "gw/flash" });

    await expect(generator.next()).rejects.toBeInstanceOf(ConfigLoadError);
    await expect(
      runSession({ input: "hi", model: "gw/flash" }).next(),
    ).rejects.toMatchObject({ code: "providers_not_found" });
  });

  it("无效模型引用抛 ModelReferenceError", async () => {
    // 即使这条用例不会写文件，也要显式隔离：resolveHarnessHome 在测试进程里
    // 没有 HARNESS_HOME 时会硬失败，忘了隔离就应该在这里报出来（D-170）。
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);

    await expect(
      collect(runSession({ input: "hi", model: "gw/missing", providersText: providersText() })),
    ).rejects.toBeInstanceOf(ModelReferenceError);
  });

  it("apiKeyEnv 非空时发送 Bearer，空值与缺失都不发送 Authorization", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const withKey = JSON.stringify({
      gw: { ...PROVIDERS.gw, apiKeyEnv: "INTEGRATION_API_KEY" },
    });

    vi.stubEnv("INTEGRATION_API_KEY", "secret");
    const authorized = mockFetch([EMPTY_RESPONSE]);
    await collect(
      runSession({
        input: "hi",
        model: "gw/flash",
        providersText: withKey,
        fetchImpl: authorized.impl,
      }),
    );
    expect(authorized.calls[0].headers.get("authorization")).toBe("Bearer secret");

    vi.stubEnv("INTEGRATION_API_KEY", "");
    const emptyKey = mockFetch([EMPTY_RESPONSE]);
    await collect(
      runSession({
        input: "hi",
        model: "gw/flash",
        providersText: withKey,
        fetchImpl: emptyKey.impl,
      }),
    );
    expect(emptyKey.calls[0].headers.has("authorization")).toBe(false);

    vi.stubEnv("INTEGRATION_API_KEY", "   ");
    const blankKey = mockFetch([EMPTY_RESPONSE]);
    await collect(
      runSession({
        input: "hi",
        model: "gw/flash",
        providersText: withKey,
        fetchImpl: blankKey.impl,
      }),
    );
    expect(blankKey.calls[0].headers.has("authorization")).toBe(false);

    const missingKey = mockFetch([EMPTY_RESPONSE]);
    await collect(
      runSession({
        input: "hi",
        model: "gw/flash",
        providersText: JSON.stringify({
          gw: { ...PROVIDERS.gw, apiKeyEnv: "INTEGRATION_MISSING_KEY" },
        }),
        fetchImpl: missingKey.impl,
      }),
    );
    expect(missingKey.calls[0].headers.has("authorization")).toBe(false);
  });

  it("systemPrompt 成为会话首条事件且只落一次", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const sessionDir = path.join(home, "with-system");
    const { impl, calls } = mockFetch([EMPTY_RESPONSE]);

    await collect(
      runSession({
        input: "hi",
        model: "gw/flash",
        providersText: providersText(),
        sessionDir,
        systemPrompt: "be brief",
        fetchImpl: impl,
      }),
    );

    const log = readSessionFile(path.join(sessionDir, "session.v1.jsonl"));
    expect(log[0]).toMatchObject({ type: "system", payload: { content: "be brief" } });
    expect(log[1]).toMatchObject({ type: "user", payload: { content: "hi" } });
    expect(log.filter((event) => event.type === "system")).toHaveLength(1);
    expect(calls[0].body.messages).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ]);
  });

  it("sessionDir 缺省时落在 HARNESS_HOME/sessions/<id>", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const { impl } = mockFetch([EMPTY_RESPONSE]);

    await collect(
      runSession({ input: "hi", model: "gw/flash", providersText: providersText(), fetchImpl: impl }),
    );

    const entries = await readdir(path.join(home, "sessions"));
    expect(entries).toHaveLength(1);
    const dir = path.join(home, "sessions", entries[0]);
    const header = JSON.parse(await readFile(path.join(dir, "header.json"), "utf8")) as { id: string };
    expect(header.id).toBe(entries[0]);
    expect(existsSync(path.join(dir, "session.v1.jsonl"))).toBe(true);
    expect(existsSync(path.join(dir, "artifacts"))).toBe(false);
  });

  it("home 显式注入时会话写入该目录", async () => {
    const defaultHome = await tempDir();
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", defaultHome);
    const { impl, calls } = mockFetch([EMPTY_RESPONSE]);

    await collect(
      runSession({
        input: "hi",
        model: "gw/flash",
        providersText: providersText(),
        fetchImpl: impl,
        sessionId: "explicit-home",
        home,
      }),
    );

    expect(calls).toHaveLength(1);
    expect(existsSync(path.join(home, "sessions", "explicit-home", "session.v1.jsonl"))).toBe(
      true,
    );
    expect(existsSync(path.join(defaultHome, "sessions"))).toBe(false);
  });

  it("onSession 在会话创建后、首个业务事件前调用", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const { impl } = mockFetch([EMPTY_RESPONSE]);
    let seenId: string | undefined;
    let seenDir: string | undefined;
    let sawBusinessEvent: boolean | undefined;

    await collect(
      runSession({
        input: "hi",
        model: "gw/flash",
        providersText: providersText(),
        fetchImpl: impl,
        sessionId: "on-session",
        systemPrompt: "be brief",
        onSession: (session) => {
          seenId = session.id;
          seenDir = session.dir;
          sawBusinessEvent = session
            .events()
            .some((event) => event.type === "user" || event.type === "assistant");
        },
      }),
    );

    expect(seenId).toBe("on-session");
    expect(seenDir).toBe(path.join(home, "sessions", "on-session"));
    expect(sawBusinessEvent).toBe(false);
  });

  it("onSession 抛错按启动失败处理并释放会话锁", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const { impl } = mockFetch([EMPTY_RESPONSE]);

    await expect(
      collect(
        runSession({
          input: "hi",
          model: "gw/flash",
          providersText: providersText(),
          fetchImpl: impl,
          sessionId: "on-session-boom",
          onSession: () => {
            throw new Error("onSession boom");
          },
        }),
      ),
    ).rejects.toThrow("onSession boom");

    expect(existsSync(path.join(home, "sessions", "on-session-boom", "session.lock"))).toBe(
      false,
    );
  });

  it("maxTurns=1 且模型持续调用工具时以 interrupted 与 done(max_turns) 结束", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const { impl, calls } = mockFetch([TOOL_RESPONSE]);

    const events = await collect(
      runSession({
        input: "hi",
        model: "gw/flash",
        providersText: providersText(),
        sessionDir: path.join(home, "max-turns"),
        fetchImpl: impl,
        maxTurns: 1,
      }),
    );

    expect(events.map((event) => event.kind)).toEqual([
      "model_message",
      "tool_use",
      "tool_result",
      "interrupted",
      "done",
    ]);
    expect(events[3]).toEqual({ kind: "interrupted", reason: "max_turns" });
    expect(events[4]).toEqual({ kind: "done", finishReason: "max_turns" });
    expect(calls).toHaveLength(1);
  });

  it("maxCostUsd 极小时以 interrupted 与 done(max_cost_usd) 结束", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const { impl, calls } = mockFetch([TOOL_RESPONSE]);

    const events = await collect(
      runSession({
        input: "hi",
        model: "gw/flash",
        providersText: providersText(),
        sessionDir: path.join(home, "max-cost"),
        fetchImpl: impl,
        maxCostUsd: 0.000000001,
      }),
    );

    expect(events.map((event) => event.kind)).toEqual([
      "model_message",
      "tool_use",
      "tool_result",
      "interrupted",
      "done",
    ]);
    expect(events[3]).toEqual({ kind: "interrupted", reason: "max_cost_usd" });
    expect(events[4]).toEqual({ kind: "done", finishReason: "max_cost_usd" });
    expect(calls).toHaveLength(1);
  });

  it("不传 maxTurns 时默认 10 轮后熔断", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const { impl, calls } = mockFetch([TOOL_RESPONSE]);

    const events = await collect(
      runSession({
        input: "hi",
        model: "gw/flash",
        providersText: providersText(),
        sessionDir: path.join(home, "default-max-turns"),
        fetchImpl: impl,
      }),
    );

    expect(calls).toHaveLength(10);
    expect(events.slice(-2)).toEqual([
      { kind: "interrupted", reason: "max_turns" },
      { kind: "done", finishReason: "max_turns" },
    ]);
  });

  it("compaction 默认开启:小 contextWindow 下历史工具结果触发摘要并落日志", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const sessionDir = path.join(home, "auto-compaction");
    const { impl, calls } = mockFetch([LONG_TOOL_RESPONSE, SUMMARY_RESPONSE, EMPTY_RESPONSE]);

    const events = await collect(
      runSession({
        input: "hi",
        model: "gw/tiny",
        providersText: providersWith({ tiny: { contextWindow: 30, maxOutput: 512 } }),
        sessionDir,
        fetchImpl: impl,
        compaction: { keepRecentTurns: 0 },
      }),
    );

    expect(calls).toHaveLength(3);
    expect(calls[1].body.tools).toEqual([]);
    const summaryMessages = calls[1].body.messages as Array<{ role: string; content: string }>;
    expect(summaryMessages[0]).toEqual({ role: "system", content: SUMMARY_PROMPT });

    const finalMessages = calls[2].body.messages as Array<{ role: string; content: string }>;
    const finalSystem = finalMessages.find(
      (message) => message.role === "system" && message.content.includes("[Conversation summary]"),
    );
    expect(finalSystem).toBeDefined();
    expect(finalSystem?.content).toContain("summary-of-old-context");
    const toolMessages = finalMessages.filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0].content).toContain("[tool result elided");

    const log = readSessionFile(path.join(sessionDir, "session.v1.jsonl"));
    expect(
      log.some((event) => event.type === "compaction" && event.payload.kind === "microcompact"),
    ).toBe(true);
    expect(
      log.some((event) => event.type === "compaction" && event.payload.kind === "summary"),
    ).toBe(true);
    expect(log.filter((event) => event.type === "usage").length).toBeGreaterThanOrEqual(2);
    expect(events.some((event) => event.kind === "compacted")).toBe(true);
  });

  it("compaction.enabled:false 时不压缩并保留完整工具结果", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const sessionDir = path.join(home, "no-compaction");
    const { impl, calls } = mockFetch([LONG_TOOL_RESPONSE, EMPTY_RESPONSE]);

    const events = await collect(
      runSession({
        input: "hi",
        model: "gw/tiny",
        providersText: providersWith({ tiny: { contextWindow: 30, maxOutput: 512 } }),
        sessionDir,
        fetchImpl: impl,
        compaction: { enabled: false },
      }),
    );

    expect(calls).toHaveLength(2);
    const finalMessages = calls[1].body.messages as Array<{ role: string; content: string }>;
    const toolMessages = finalMessages.filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0].content).toBe(LONG_TOOL_TEXT);

    const log = readSessionFile(path.join(sessionDir, "session.v1.jsonl"));
    expect(log.some((event) => event.type === "compaction")).toBe(false);
    expect(events.some((event) => event.kind === "compacted")).toBe(false);
  });

  it("compaction.enabled:false 时不校验压缩比例", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const { impl } = mockFetch([EMPTY_RESPONSE]);

    const events = await collect(
      runSession({
        input: "hi",
        model: "gw/flash",
        providersText: providersText(),
        sessionDir: path.join(home, "disabled-invalid-ratios"),
        fetchImpl: impl,
        compaction: { enabled: false, keepTailRatio: 0, softRatio: 1 },
      }),
    );

    expect(events.at(-1)).toEqual({ kind: "done", finishReason: "no_tool_calls" });
  });

  it("meter 注入:大 prompt_tokens 锚定后使下一轮预算超限并触发压缩", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const sessionDir = path.join(home, "meter-anchor");
    const { impl, calls } = mockFetch([
      HIGH_USAGE_TOOL_RESPONSE,
      SUMMARY_RESPONSE,
      EMPTY_RESPONSE,
    ]);

    const events = await collect(
      runSession({
        input: "hi",
        model: "gw/tiny",
        providersText: providersWith({ tiny: { contextWindow: 90, maxOutput: 512 } }),
        sessionDir,
        fetchImpl: impl,
        compaction: { softRatio: 0.4 },
      }),
    );

    expect(calls).toHaveLength(3);
    expect(calls[1].body.tools).toEqual([]);
    const log = readSessionFile(path.join(sessionDir, "session.v1.jsonl"));
    expect(
      log.some(
        (event) => event.type === "compaction" && event.payload.kind === "summary",
      ),
    ).toBe(true);
    expect(events.some((event) => event.kind === "compacted")).toBe(true);
  });

  it("softRatio 透传:自定义阈值触发压缩而默认 0.8 不会", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const sessionDir = path.join(home, "soft-ratio");
    const { impl, calls } = mockFetch([
      SOFT_RATIO_TOOL_RESPONSE,
      SUMMARY_RESPONSE,
      EMPTY_RESPONSE,
    ]);

    const events = await collect(
      runSession({
        input: "hi",
        model: "gw/tiny",
        providersText: providersWith({ tiny: { contextWindow: 100, maxOutput: 512 } }),
        sessionDir,
        fetchImpl: impl,
        compaction: { softRatio: 0.5 },
      }),
    );

    expect(calls).toHaveLength(3);
    expect(calls[1].body.tools).toEqual([]);
    expect(events.some((event) => event.kind === "compacted")).toBe(true);
    const log = readSessionFile(path.join(sessionDir, "session.v1.jsonl"));
    expect(
      log.some(
        (event) => event.type === "compaction" && event.payload.kind === "summary",
      ),
    ).toBe(true);
  });

  it("keepTailRatio 透传:自定义 0.9 使摘要不再覆盖较早批次", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const sessionDir = path.join(home, "tail-ratio");
    const { impl, calls } = mockFetch([
      TAIL_RATIO_TOOL_RESPONSE_A,
      TAIL_RATIO_TOOL_RESPONSE_B,
      SUMMARY_RESPONSE,
      EMPTY_RESPONSE,
    ]);

    await collect(
      runSession({
        input: "hi",
        model: "gw/tiny",
        providersText: providersWith({ tiny: { contextWindow: 100, maxOutput: 512 } }),
        sessionDir,
        fetchImpl: impl,
        compaction: { softRatio: 0.95, keepTailRatio: 0.9 },
      }),
    );

    expect(calls).toHaveLength(4);
    expect(calls[2].body.tools).toEqual([]);
    const summaryMessages = calls[2].body.messages as Array<{ role: string; content: string }>;
    expect(summaryMessages[1].role).toBe("user");
    expect(summaryMessages[1].content).toContain("user: hi");
    expect(summaryMessages[1].content).not.toContain("tool(c1):");
  });

  it("compaction.enabled 非布尔值在入口抛 TypeError", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);

    await expect(
      collect(
        runSession({
          input: "hi",
          model: "gw/flash",
          providersText: providersText(),
          sessionDir: path.join(home, "invalid-enabled"),
          fetchImpl: mockFetch([EMPTY_RESPONSE]).impl,
          compaction: { enabled: 0 as unknown as boolean },
        }),
      ),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("结束后会话日志可读且工具结果完整", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const sessionDir = path.join(home, "closed-session");
    const { impl } = mockFetch([TOOL_RESPONSE, EMPTY_RESPONSE]);

    await collect(
      runSession({
        input: "hi",
        model: "gw/flash",
        providersText: providersText(),
        sessionDir,
        fetchImpl: impl,
      }),
    );

    const log = readSessionFile(path.join(sessionDir, "session.v1.jsonl"));
    expect(log.length).toBeGreaterThan(0);
    for (const event of log) {
      if (event.type !== "assistant") continue;
      const toolCalls = event.payload.toolCalls;
      if (!Array.isArray(toolCalls)) continue;
      for (const call of toolCalls) {
        const id = (call as { id: string }).id;
        expect(
          log.some(
            (candidate) =>
              candidate.type === "tool_result" &&
              candidate.parent === event.seq &&
              (candidate.payload as { id?: unknown }).id === id,
          ),
        ).toBe(true);
      }
    }
    expect(() => buildMessages(log)).not.toThrow();
  });

  it("自定义 sessionId 与 header.id 一致", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const sessionDir = path.join(home, "custom-dir");
    const { impl } = mockFetch([EMPTY_RESPONSE]);

    await collect(
      runSession({
        input: "hi",
        model: "gw/flash",
        providersText: providersText(),
        sessionDir,
        sessionId: "fixed-session-id",
        fetchImpl: impl,
      }),
    );

    const header = JSON.parse(await readFile(path.join(sessionDir, "header.json"), "utf8")) as {
      id: string;
    };
    expect(header.id).toBe("fixed-session-id");
  });

  it.each([
    ["路径穿越", "../evil"],
    ["空串", ""],
    ["路径分隔符", "a/b"],
    ["反斜杠", "a\\b"],
    ["超长", "a".repeat(129)],
    ["Windows 保留名 CON", "CON"],
    ["Windows 保留名 com1", "com1"],
    ["Windows 保留名 NUL", "NUL"],
  ])("非法 sessionId（%s）抛 TypeError", async (_label, sessionId) => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const { impl } = mockFetch([EMPTY_RESPONSE]);

    const error = await collect(
      runSession({
        input: "hi",
        model: "gw/flash",
        providersText: providersText(),
        sessionDir: path.join(home, "invalid-session"),
        sessionId,
        fetchImpl: impl,
      }),
    ).then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toContain("sessionId");
  });
});
function providersWith(models: Record<string, { contextWindow: number; maxOutput: number }>): string {
  return JSON.stringify({
    gw: { ...PROVIDERS.gw, models: { ...PROVIDERS.gw.models, ...models } },
  });
}

async function readHeader(sessionDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(sessionDir, "header.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("runSession resume", () => {
  it("resume:true 继续同一会话并续写事件", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const sessionDir = path.join(home, "resume-continue");

    const firstFetch = mockFetch([EMPTY_RESPONSE]);
    await collect(
      runSession({
        input: "hi",
        model: "gw/flash",
        providersText: providersText(),
        sessionDir,
        fetchImpl: firstFetch.impl,
      }),
    );

    const secondFetch = mockFetch([EMPTY_RESPONSE]);
    const generator = runSession({
      input: "again",
      model: "gw/flash",
      providersText: providersText(),
      sessionDir,
      resume: true,
      fetchImpl: secondFetch.impl,
    });

    const firstEvent = await generator.next();
    expect(firstEvent.done).toBe(false);
    expect((await readHeader(sessionDir)).status).toBe("open");

    for await (const _event of generator) {
      void _event;
    }

    const log = readSessionFile(path.join(sessionDir, "session.v1.jsonl"));
    expect(log.filter((event) => event.type === "user").map((event) => event.payload.content)).toEqual([
      "hi",
      "again",
    ]);
    expect(secondFetch.calls).toHaveLength(1);
    expect(secondFetch.calls[0].body.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "done", tool_calls: [] },
      { role: "user", content: "again" },
    ]);
  });

  it("runSession 拒绝空 sessionDir（create 与 resume）", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);

    await expect(
      collect(
        runSession({
          input: "x",
          model: "gw/flash",
          providersText: providersText(),
          sessionDir: "",
        }),
      ),
    ).rejects.toMatchObject({ name: "SessionResumeError", code: "invalid_target" });
    await expect(
      collect(
        runSession({
          input: "x",
          model: "gw/flash",
          providersText: providersText(),
          sessionDir: "",
          resume: true,
        }),
      ),
    ).rejects.toMatchObject({ name: "SessionResumeError", code: "invalid_target" });
  });

  it("runSession resume 的 sessionDir 为文件 → invalid_target", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const sessionFile = path.join(home, "session-file");
    await writeFile(sessionFile, "keep", "utf8");

    await expect(
      collect(
        runSession({
          input: "x",
          model: "gw/flash",
          providersText: providersText(),
          sessionDir: sessionFile,
          resume: true,
        }),
      ),
    ).rejects.toMatchObject({
      name: "SessionResumeError",
      code: "invalid_target",
      detail: { dir: sessionFile },
    });
  });

  it("resume:true 缺 sessionDir 时首个 next 抛 missing_session_dir", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);

    await expect(
      runSession({
        input: "hi",
        model: "gw/flash",
        providersText: providersText(),
        resume: true,
      }).next(),
    ).rejects.toMatchObject({
      name: "SessionResumeError",
      code: "missing_session_dir",
    });
  });

  it("resume:true 且 model 与 header 不一致时抛 model_mismatch", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const sessionDir = path.join(home, "resume-model");
    const firstFetch = mockFetch([EMPTY_RESPONSE]);
    await collect(
      runSession({
        input: "hi",
        model: "gw/flash",
        providersText: providersText(),
        sessionDir,
        fetchImpl: firstFetch.impl,
      }),
    );

    const secondFetch = mockFetch([EMPTY_RESPONSE]);
    const error = await runSession({
      input: "again",
      model: "gw/other",
      providersText: providersWith({ other: { contextWindow: 8192, maxOutput: 512 } }),
      sessionDir,
      resume: true,
      fetchImpl: secondFetch.impl,
    })
      .next()
      .then(
        () => undefined,
        (reason: unknown) => reason,
      );

    expect(error).toBeInstanceOf(SessionResumeError);
    expect((error as SessionResumeError).code).toBe("model_mismatch");
    expect(secondFetch.calls).toHaveLength(0);
  });

  it("header 无 model 时允许 resume", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const sessionDir = path.join(home, "resume-no-model");
    await createSession(sessionDir, { id: "no-model" });

    const { impl, calls } = mockFetch([EMPTY_RESPONSE]);
    const events = await collect(
      runSession({
        input: "hi",
        model: "gw/flash",
        providersText: providersText(),
        sessionDir,
        resume: true,
        fetchImpl: impl,
      }),
    );

    expect(events.at(-1)).toEqual({ kind: "done", finishReason: "no_tool_calls" });
    expect(calls).toHaveLength(1);
    expect((await readHeader(sessionDir)).model).toBeUndefined();
    expect(
      readSessionFile(path.join(sessionDir, "session.v1.jsonl")).some(
        (event) => event.type === "user" && event.payload.content === "hi",
      ),
    ).toBe(true);
  });

  it("resume:true 且 systemPrompt 内容不一致时抛 system_prompt_mismatch", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const sessionDir = path.join(home, "resume-system-diff");
    const firstFetch = mockFetch([EMPTY_RESPONSE]);
    await collect(
      runSession({
        input: "hi",
        model: "gw/flash",
        providersText: providersText(),
        sessionDir,
        systemPrompt: "be brief",
        fetchImpl: firstFetch.impl,
      }),
    );

    const secondFetch = mockFetch([EMPTY_RESPONSE]);
    const error = await runSession({
      input: "again",
      model: "gw/flash",
      providersText: providersText(),
      sessionDir,
      resume: true,
      systemPrompt: "be verbose",
      fetchImpl: secondFetch.impl,
    })
      .next()
      .then(
        () => undefined,
        (reason: unknown) => reason,
      );

    expect(error).toBeInstanceOf(SessionResumeError);
    expect((error as SessionResumeError).code).toBe("system_prompt_mismatch");
    expect(secondFetch.calls).toHaveLength(0);
  });

  it("会话无 system 且非空时提供 systemPrompt 抛 system_prompt_mismatch", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const sessionDir = path.join(home, "resume-system-late");
    const firstFetch = mockFetch([EMPTY_RESPONSE]);
    await collect(
      runSession({
        input: "hi",
        model: "gw/flash",
        providersText: providersText(),
        sessionDir,
        fetchImpl: firstFetch.impl,
      }),
    );

    const secondFetch = mockFetch([EMPTY_RESPONSE]);
    const error = await runSession({
      input: "again",
      model: "gw/flash",
      providersText: providersText(),
      sessionDir,
      resume: true,
      systemPrompt: "late",
      fetchImpl: secondFetch.impl,
    })
      .next()
      .then(
        () => undefined,
        (reason: unknown) => reason,
      );

    expect(error).toBeInstanceOf(SessionResumeError);
    expect((error as SessionResumeError).code).toBe("system_prompt_mismatch");
    expect(secondFetch.calls).toHaveLength(0);
  });

  it("resume 遇到多条 system 且其中一条不一致时抛 system_prompt_mismatch（D-044）", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const sessionDir = path.join(home, "resume-multi-system");
    const session = await createSession(sessionDir, { id: "multi-system", systemPrompt: "same" });
    await session.append({ type: "system", payload: { content: "different" } });
    await session.append({ type: "user", payload: { content: "hi" } });
    await session.close();

    const { impl, calls } = mockFetch([EMPTY_RESPONSE]);
    const error = await runSession({
      input: "again",
      model: "gw/flash",
      providersText: providersText(),
      sessionDir,
      resume: true,
      systemPrompt: "same",
      fetchImpl: impl,
    })
      .next()
      .then(
        () => undefined,
        (reason: unknown) => reason,
      );

    expect(error).toBeInstanceOf(SessionResumeError);
    expect((error as SessionResumeError).code).toBe("system_prompt_mismatch");
    expect(calls).toHaveLength(0);
  });

  it("空会话 resume 提供 systemPrompt 时补写 system", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const sessionDir = path.join(home, "resume-system-empty");
    await createSession(sessionDir, { id: "empty-session" });

    const { impl, calls } = mockFetch([EMPTY_RESPONSE]);
    await collect(
      runSession({
        input: "hi",
        model: "gw/flash",
        providersText: providersText(),
        sessionDir,
        resume: true,
        systemPrompt: "be brief",
        fetchImpl: impl,
      }),
    );

    const log = readSessionFile(path.join(sessionDir, "session.v1.jsonl"));
    expect(log[0]).toMatchObject({ type: "system", payload: { content: "be brief" } });
    expect(log[1]).toMatchObject({ type: "user", payload: { content: "hi" } });
    expect(calls[0].body.messages).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ]);
  });

  it("create 路径 header 写入 provider/model/workdir", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const cwd = path.join(home, "workdir");
    const sessionDir = path.join(home, "header-create");
    const { impl } = mockFetch([EMPTY_RESPONSE]);

    await collect(
      runSession({
        input: "hi",
        model: "gw/flash",
        providersText: providersText(),
        sessionDir,
        cwd,
        fetchImpl: impl,
      }),
    );

    expect(await readHeader(sessionDir)).toMatchObject({
      provider: "gw",
      model: "gw/flash",
      workdir: cwd,
    });

    const defaultDir = path.join(home, "header-default-workdir");
    const second = mockFetch([EMPTY_RESPONSE]);
    await collect(
      runSession({
        input: "hi",
        model: "gw/flash",
        providersText: providersText(),
        sessionDir: defaultDir,
        fetchImpl: second.impl,
      }),
    );
    expect((await readHeader(defaultDir)).workdir).toBe(process.cwd());
  });

  it("resume 时 provider 与 apiKey 按当前 providers 解析而非 header", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const sessionDir = path.join(home, "resume-current-provider");
    const firstFetch = mockFetch([EMPTY_RESPONSE]);
    await collect(
      runSession({
        input: "hi",
        model: "gw/flash",
        providersText: providersText(),
        sessionDir,
        fetchImpl: firstFetch.impl,
      }),
    );

    vi.stubEnv("RESUME_API_KEY", "fresh-secret");
    const resumeProviders = JSON.stringify({
      gw: {
        ...PROVIDERS.gw,
        baseUrl: "http://127.0.0.1:7777/v1",
        apiKeyEnv: "RESUME_API_KEY",
      },
    });
    const secondFetch = mockFetch([EMPTY_RESPONSE]);
    await collect(
      runSession({
        input: "again",
        model: "gw/flash",
        providersText: resumeProviders,
        sessionDir,
        resume: true,
        fetchImpl: secondFetch.impl,
      }),
    );

    expect(secondFetch.calls[0].url).toBe("http://127.0.0.1:7777/v1/chat/completions");
    expect(secondFetch.calls[0].headers.get("authorization")).toBe("Bearer fresh-secret");
    expect(Object.keys(await readHeader(sessionDir))).not.toContain("apiKey");
  });

  it("强制压缩后 close→resume 仍含 summary/占位且日志只增不改", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const sessionDir = path.join(home, "resume-after-compaction");
    const tiny = providersWith({ tiny: { contextWindow: 30, maxOutput: 512 } });
    const firstFetch = mockFetch([LONG_TOOL_RESPONSE, SUMMARY_RESPONSE, EMPTY_RESPONSE]);
    await collect(
      runSession({
        input: "hi",
        model: "gw/tiny",
        providersText: tiny,
        sessionDir,
        fetchImpl: firstFetch.impl,
        compaction: { keepRecentTurns: 0 },
      }),
    );

    const logPath = path.join(sessionDir, "session.v1.jsonl");
    const before = readSessionFile(logPath);
    expect(
      before.some(
        (event) => event.type === "compaction" && event.payload.kind === "summary",
      ),
    ).toBe(true);
    expect(
      before.some(
        (event) => event.type === "compaction" && event.payload.kind === "microcompact",
      ),
    ).toBe(true);

    const secondFetch = mockFetch([EMPTY_RESPONSE]);
    await collect(
      runSession({
        input: "again",
        model: "gw/tiny",
        providersText: tiny,
        sessionDir,
        resume: true,
        fetchImpl: secondFetch.impl,
        compaction: { keepRecentTurns: 0 },
      }),
    );

    expect(secondFetch.calls).toHaveLength(1);
    const messages = secondFetch.calls[0].body.messages as Array<{
      role: string;
      content: string;
    }>;
    expect(
      messages.some(
        (message) =>
          message.role === "system"
          && message.content.includes("[Conversation summary]")
          && message.content.includes("summary-of-old-context"),
      ),
    ).toBe(true);
    expect(
      messages.some(
        (message) => message.role === "tool" && message.content.includes("[tool result elided"),
      ),
    ).toBe(true);

    const after = readSessionFile(logPath);
    expect(after.length).toBeGreaterThan(before.length);
    expect(after.slice(0, before.length)).toEqual(before);
  });

  it("已有 summary 时 resume 修复不完整尾部批次并保持摘要可投影", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const sessionDir = path.join(home, "resume-crash-summary");
    const session = await createSession(sessionDir, { id: "crash-summary" });
    await session.append({ type: "user", payload: { content: "old goal" } });
    const oldAssistant = await session.append({
      type: "assistant",
      payload: {
        content: "",
        toolCalls: [{ id: "old", name: "echo", arguments: { text: "old" } }],
      },
    });
    const oldResult = await session.append({
      type: "tool_result",
      payload: { id: "old", ok: true, text: "OLD-TOOL-MARKER", toolName: "echo" },
      parent: oldAssistant.seq,
    });
    await session.append({
      type: "compaction",
      payload: { kind: "summary", summary: "OLD-SUMMARY", coversUpToSeq: oldResult.seq },
    });
    const pending = await session.append({
      type: "assistant",
      payload: {
        content: "",
        toolCalls: [{ id: "pending", name: "echo", arguments: {} }],
      },
    });
    await session.close();

    const { impl, calls } = mockFetch([EMPTY_RESPONSE]);
    await collect(
      runSession({
        input: "continue",
        model: "gw/flash",
        providersText: providersText(),
        sessionDir,
        resume: true,
        fetchImpl: impl,
      }),
    );

    expect(calls).toHaveLength(1);
    const messages = calls[0].body.messages as Array<{ role: string; content: string }>;
    expect(
      messages.some(
        (message) =>
          message.role === "system"
          && message.content.includes("[Conversation summary]")
          && message.content.includes("OLD-SUMMARY"),
      ),
    ).toBe(true);
    expect(messages.some((message) => message.content.includes("result lost due to crash"))).toBe(
      true,
    );
    expect(messages.some((message) => message.content.includes("OLD-TOOL-MARKER"))).toBe(false);

    const log = readSessionFile(path.join(sessionDir, "session.v1.jsonl"));
    expect(
      log.some(
        (event) =>
          event.type === "tool_result"
          && event.parent === pending.seq
          && event.payload.code === "tool_result_lost",
      ),
    ).toBe(true);
    expect(
      log.some(
        (event) =>
          event.type === "interrupted" && event.payload.reason === "crash_recovery",
      ),
    ).toBe(true);
  });

  it.each([
    ["相等", { keepTailRatio: 0.8, softRatio: 0.8 }],
    ["tail=0", { keepTailRatio: 0, softRatio: 0.8 }],
    ["soft=1", { keepTailRatio: 0.16, softRatio: 1 }],
    ["keepRecentTurns=-1", { keepRecentTurns: -1 }],
    ["keepRecentTurns=1.5", { keepRecentTurns: 1.5 }],
  ])("非法压缩配置（%s）在 runSession 入口抛 TypeError", async (_label, compaction) => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);

    await expect(
      collect(
        runSession({
          input: "hi",
          model: "gw/flash",
          providersText: providersText(),
          sessionDir: path.join(home, "invalid-ratios"),
          fetchImpl: mockFetch([EMPTY_RESPONSE]).impl,
          compaction,
        }),
      ),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

function toolCallResponseNoUsage(id: string, name: string, args: unknown): unknown {
  return {
    choices: [
      {
        message: {
          content: "",
          tool_calls: [
            {
              id,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  };
}

function toolCallResponse(id: string, name: string, args: unknown): unknown {
  return {
    choices: [
      {
        message: {
          content: "",
          tool_calls: [
            {
              id,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

describe("runSession 内置工具装配", () => {
  it("模型返回 fs read 调用时在临时 workdir 内闭环执行", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const workdir = await tempDir();
    const sessionDir = path.join(home, "fs-closed-loop");
    await writeFile(path.join(workdir, "note.txt"), "hello fs\n", "utf8");
    const { impl, calls } = mockFetch([
      toolCallResponse("call-fs", "fs", { op: "read", path: "note.txt" }),
      EMPTY_RESPONSE,
    ]);

    const events = await collect(
      runSession({
        input: "read",
        model: "gw/flash",
        providersText: providersText(),
        sessionDir,
        cwd: workdir,
        fetchImpl: impl,
      }),
    );

    const result = events.find((event) => event.kind === "tool_result");
    expect(result).toMatchObject({ kind: "tool_result", id: "call-fs", ok: true, code: "ok" });
    expect((result as { text: string }).text).toContain("hello fs");
    expect((await readHeader(sessionDir)).workdir).toBe(workdir);
    expect(calls[1].body.messages).toEqual([
      { role: "user", content: "read" },
      expect.objectContaining({ role: "assistant" }),
      { role: "tool", tool_call_id: "call-fs", content: expect.stringContaining("hello fs") },
    ]);
  });

  it("缺省 cwd 时 header.workdir 用 process.cwd()", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const sessionDir = path.join(home, "default-cwd-tools");
    const { impl } = mockFetch([EMPTY_RESPONSE]);

    await collect(
      runSession({
        input: "hi",
        model: "gw/flash",
        providersText: providersText(),
        sessionDir,
        fetchImpl: impl,
      }),
    );

    expect((await readHeader(sessionDir)).workdir).toBe(process.cwd());
  });

  it("相对 cwd 以 path.resolve 后的绝对路径写入 header", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const sessionDir = path.join(home, "relative-cwd");
    const { impl } = mockFetch([EMPTY_RESPONSE]);

    await collect(
      runSession({
        input: "hi",
        model: "gw/flash",
        providersText: providersText(),
        sessionDir,
        cwd: ".",
        fetchImpl: impl,
      }),
    );

    expect((await readHeader(sessionDir)).workdir).toBe(path.resolve("."));
  });

  it("resume 旧会话无 workdir 时运行 workdir 回退 process.cwd()", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const sessionDir = path.join(home, "legacy-no-workdir");
    await createSession(sessionDir, { id: "legacy-no-workdir", model: "gw/flash" });
    const { impl } = mockFetch([
      toolCallResponse("call-cwd", "shell", { command: 'node -e "console.log(process.cwd())"' }),
      EMPTY_RESPONSE,
    ]);

    const events = await collect(
      runSession({
        input: "where",
        model: "gw/flash",
        providersText: providersText(),
        sessionDir,
        resume: true,
        fetchImpl: impl,
        permissions: { preset: "danger-full-access" },
      }),
    );

    const result = events.find((event) => event.kind === "tool_result");
    expect(result).toMatchObject({ kind: "tool_result", id: "call-cwd", ok: true, code: "ok" });
    expect((result as { text: string }).text.toLowerCase()).toContain(process.cwd().toLowerCase());
  });

  it.skipIf(process.platform !== "win32")("win32 下 cwd 大小写差异不触发 workdir_mismatch", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const sessionDir = path.join(home, "workdir-case");
    const workdir = await tempDir();
    const firstFetch = mockFetch([EMPTY_RESPONSE]);
    await collect(
      runSession({
        input: "hi",
        model: "gw/flash",
        providersText: providersText(),
        sessionDir,
        cwd: workdir,
        fetchImpl: firstFetch.impl,
      }),
    );

    const secondFetch = mockFetch([EMPTY_RESPONSE]);
    const events = await collect(
      runSession({
        input: "again",
        model: "gw/flash",
        providersText: providersText(),
        sessionDir,
        resume: true,
        cwd: workdir.toUpperCase(),
        fetchImpl: secondFetch.impl,
      }),
    );

    expect(events.at(-1)).toEqual({ kind: "done", finishReason: "no_tool_calls" });
    expect((await readHeader(sessionDir)).workdir).toBe(workdir);
  });

  it("resume 时 opts.cwd 与 header.workdir 冲突 → workdir_mismatch 且不改变会话", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const sessionDir = path.join(home, "workdir-mismatch");
    const workdirA = await tempDir();
    const workdirB = await tempDir();
    const firstFetch = mockFetch([EMPTY_RESPONSE]);
    await collect(
      runSession({
        input: "hi",
        model: "gw/flash",
        providersText: providersText(),
        sessionDir,
        cwd: workdirA,
        fetchImpl: firstFetch.impl,
      }),
    );
    const beforeHeader = await readHeaderText(sessionDir);
    const beforeLines = await logLineCount(sessionDir);

    const error = await runSession({
      input: "again",
      model: "gw/flash",
      providersText: providersText(),
      sessionDir,
      resume: true,
      cwd: workdirB,
      fetchImpl: mockFetch([EMPTY_RESPONSE]).impl,
    })
      .next()
      .then(
        () => undefined,
        (reason: unknown) => reason,
      );

    expect(error).toBeInstanceOf(SessionResumeError);
    expect((error as SessionResumeError).code).toBe("workdir_mismatch");
    expect(resumeCallCounter.count).toBe(0);
    expect(await readHeaderText(sessionDir)).toBe(beforeHeader);
    expect(await logLineCount(sessionDir)).toBe(beforeLines);
  });

  it("resume 不传 cwd 时使用 header.workdir 作为工具根", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const workdir = await tempDir();
    const sessionDir = path.join(home, "resume-workdir");
    await writeFile(path.join(workdir, "resume-note.txt"), "resumed ok\n", "utf8");
    const firstFetch = mockFetch([EMPTY_RESPONSE]);
    await collect(
      runSession({
        input: "hi",
        model: "gw/flash",
        providersText: providersText(),
        sessionDir,
        cwd: workdir,
        fetchImpl: firstFetch.impl,
      }),
    );

    const secondFetch = mockFetch([
      toolCallResponse("call-resume", "fs", { op: "read", path: "resume-note.txt" }),
      EMPTY_RESPONSE,
    ]);
    const events = await collect(
      runSession({
        input: "again",
        model: "gw/flash",
        providersText: providersText(),
        sessionDir,
        resume: true,
        fetchImpl: secondFetch.impl,
      }),
    );

    const result = events.find((event) => event.kind === "tool_result");
    expect(result).toMatchObject({ kind: "tool_result", id: "call-resume", ok: true, code: "ok" });
    expect((result as { text: string }).text).toContain("resumed ok");
  });
});

async function readHeaderText(sessionDir: string): Promise<string> {
  return readFile(path.join(sessionDir, "header.json"), "utf8");
}

async function logLineCount(sessionDir: string): Promise<number> {
  return readSessionFile(path.join(sessionDir, "session.v1.jsonl")).length;
}

async function resumeError(
  sessionDir: string,
  extra: { model?: string; systemPrompt?: string; sessionId?: string },
): Promise<unknown> {
  return runSession({
    input: "again",
    model: "gw/flash",
    providersText: providersWith({ other: { contextWindow: 8192, maxOutput: 512 } }),
    sessionDir,
    resume: true,
    fetchImpl: mockFetch([EMPTY_RESPONSE]).impl,
    ...extra,
  })
    .next()
    .then(
      () => undefined,
      (reason: unknown) => reason,
    );
}

describe("runSession resume 失败原子性", () => {
  it("model mismatch 时不改变 header 状态与日志", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const sessionDir = path.join(home, "atomic-model");
    await createSession(sessionDir, { id: "atomic-model", model: "gw/flash" });
    const beforeHeader = await readHeaderText(sessionDir);
    const beforeLines = await logLineCount(sessionDir);

    const error = await resumeError(sessionDir, { model: "gw/other" });

    expect(error).toBeInstanceOf(SessionResumeError);
    expect((error as SessionResumeError).code).toBe("model_mismatch");
    expect(resumeCallCounter.count).toBe(0);
    expect(await readHeaderText(sessionDir)).toBe(beforeHeader);
    expect(await logLineCount(sessionDir)).toBe(beforeLines);
  });

  it("systemPrompt mismatch 时不改变 header 状态与日志", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const sessionDir = path.join(home, "atomic-system");
    await createSession(sessionDir, {
      id: "atomic-system",
      model: "gw/flash",
      systemPrompt: "be brief",
    });
    const beforeHeader = await readHeaderText(sessionDir);
    const beforeLines = await logLineCount(sessionDir);

    const error = await resumeError(sessionDir, { systemPrompt: "be verbose" });

    expect(error).toBeInstanceOf(SessionResumeError);
    expect((error as SessionResumeError).code).toBe("system_prompt_mismatch");
    expect(resumeCallCounter.count).toBe(0);
    expect(await readHeaderText(sessionDir)).toBe(beforeHeader);
    expect(await logLineCount(sessionDir)).toBe(beforeLines);
  });

  it("sessionId mismatch 抛 session_id_mismatch 且不改变 header 状态与日志", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const sessionDir = path.join(home, "atomic-session-id");
    await createSession(sessionDir, { id: "real-session-id", model: "gw/flash" });
    const beforeHeader = await readHeaderText(sessionDir);
    const beforeLines = await logLineCount(sessionDir);

    const error = await resumeError(sessionDir, { sessionId: "other-session-id" });

    expect(error).toBeInstanceOf(SessionResumeError);
    expect((error as SessionResumeError).code).toBe("session_id_mismatch");
    expect(resumeCallCounter.count).toBe(0);
    expect(await readHeaderText(sessionDir)).toBe(beforeHeader);
    expect(await logLineCount(sessionDir)).toBe(beforeLines);
  });

  it("运行期主错误时 close 异常不覆盖原错误", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const sessionDir = path.join(home, "atomic-close-runtime");
    const firstFetch = mockFetch([EMPTY_RESPONSE]);
    await collect(
      runSession({
        input: "hi",
        model: "gw/flash",
        providersText: providersText(),
        sessionDir,
        fetchImpl: firstFetch.impl,
      }),
    );

    resumeCloseFailure.enabled = true;
    const failingFetch = vi.fn(async () => ({
      ok: false,
      status: 400,
      text: async () => "primary boom",
    })) as unknown as typeof fetch;

    const error = await collect(
      runSession({
        input: "again",
        model: "gw/flash",
        providersText: providersText(),
        sessionDir,
        resume: true,
        fetchImpl: failingFetch,
      }),
    ).then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("status 400");
    expect((error as Error).message).not.toContain("close boom");
    expect(resumeCallCounter.count).toBe(1);
  });

  it("无主错误时 close 异常上抛给调用方（D-046）", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const sessionDir = path.join(home, "atomic-close-success");
    const firstFetch = mockFetch([EMPTY_RESPONSE]);
    await collect(
      runSession({
        input: "hi",
        model: "gw/flash",
        providersText: providersText(),
        sessionDir,
        fetchImpl: firstFetch.impl,
      }),
    );

    resumeCloseFailure.enabled = true;
    const secondFetch = mockFetch([EMPTY_RESPONSE]);
    const error = await collect(
      runSession({
        input: "again",
        model: "gw/flash",
        providersText: providersText(),
        sessionDir,
        resume: true,
        fetchImpl: secondFetch.impl,
      }),
    ).then(
      () => undefined,
      (reason: unknown) => reason,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("close boom");
  });
});

describe("runSession resume systemPrompt 幂等", () => {
  it("已有 system 且 opts.systemPrompt 相同时不重复写 system", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const sessionDir = path.join(home, "system-same");
    const firstFetch = mockFetch([EMPTY_RESPONSE]);
    await collect(
      runSession({
        input: "hi",
        model: "gw/flash",
        providersText: providersText(),
        sessionDir,
        systemPrompt: "be brief",
        fetchImpl: firstFetch.impl,
      }),
    );

    const secondFetch = mockFetch([EMPTY_RESPONSE]);
    await collect(
      runSession({
        input: "again",
        model: "gw/flash",
        providersText: providersText(),
        sessionDir,
        resume: true,
        systemPrompt: "be brief",
        fetchImpl: secondFetch.impl,
      }),
    );

    const log = readSessionFile(path.join(sessionDir, "session.v1.jsonl"));
    expect(log.filter((event) => event.type === "system")).toHaveLength(1);
    expect(secondFetch.calls[0].body.messages).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "done", tool_calls: [] },
      { role: "user", content: "again" },
    ]);
  });
});


const MCP_FIXTURE = path.join(import.meta.dirname, "fixtures", "mcp-echo-server.mjs");

function mcpEchoServer(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { command: process.execPath, args: [MCP_FIXTURE], ...extra };
}

async function writeMcpConfig(
  dir: string,
  servers: Record<string, unknown>,
  name = "mcp.json",
): Promise<string> {
  const file = path.join(dir, name);
  await mkdir(dir, { recursive: true });
  await writeFile(file, JSON.stringify({ mcpServers: servers }), "utf8");
  return file;
}

function mcpStatusPayloads(sessionDir: string): Record<string, unknown>[] {
  return readSessionFile(path.join(sessionDir, "session.v1.jsonl"))
    .filter((event) => event.type === "mcp_status")
    .map((event) => event.payload);
}

function legacyMcpStatusPayloads(sessionDir: string): Record<string, unknown>[] {
  return readSessionFile(path.join(sessionDir, "session.v1.jsonl"))
    .filter((event) => event.type === "status")
    .map((event) => event.payload)
    .filter((payload) => typeof payload.status === "string" && payload.status.startsWith("mcp_"));
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`等待条件超时（${timeoutMs}ms）`);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("runSession MCP 装配", () => {
  it("MCP echo server 工具出现在请求 tools 中，调用闭环", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const configDir = await tempDir();
    const userConfigPath = await writeMcpConfig(configDir, { echo: mcpEchoServer() });
    const sessionDir = path.join(home, "mcp-echo-session");
    const { impl, calls } = mockFetch([
      toolCallResponseNoUsage("mcp-call", "mcp__echo__echo", { text: "hello-mcp" }),
      EMPTY_RESPONSE,
    ]);

    const events = await collect(
      runSession({
        input: "hi",
        model: "gw/flash",
        providersText: providersText(),
        sessionDir,
        fetchImpl: impl,
        cwd: configDir,
        mcp: { userConfigPath },
      }),
    );

    const firstTools = calls[0].body.tools as Array<{ function: { name: string } }>;
    expect(firstTools.map((tool) => tool.function.name)).toContain("mcp__echo__echo");
    const result = events.find(
      (event) => event.kind === "tool_result" && event.id === "mcp-call",
    );
    expect(result).toMatchObject({ ok: true, text: "hello-mcp" });
    expect(mcpStatusPayloads(sessionDir)).toContainEqual(
      expect.objectContaining({ kind: "connected", server: "echo" }),
    );
    expect(legacyMcpStatusPayloads(sessionDir)).toEqual([]);
  });

  it("项目级 mcp.json 默认不加载并记录 skipped", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const workdir = await tempDir();
    const pidFile = path.join(workdir, "mcp.pid");
    await writeMcpConfig(path.join(workdir, ".harness"), {
      echo: mcpEchoServer({ env: { PID_FILE: pidFile } }),
    });
    const sessionDir = path.join(home, "mcp-project-skipped");
    const { impl, calls } = mockFetch([EMPTY_RESPONSE]);

    await collect(
      runSession({
        input: "hi",
        model: "gw/flash",
        providersText: providersText(),
        sessionDir,
        fetchImpl: impl,
        cwd: workdir,
      }),
    );

    const tools = calls[0].body.tools as Array<{ function: { name: string } }>;
    expect(tools.map((tool) => tool.function.name).some((name) => name.startsWith("mcp__"))).toBe(
      false,
    );
    expect(existsSync(pidFile)).toBe(false);
    expect(mcpStatusPayloads(sessionDir)).toContainEqual(
      expect.objectContaining({ kind: "project_config_skipped" }),
    );
  });

  it("trustProjectConfig:true 时加载项目级 mcp.json", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const workdir = await tempDir();
    const pidFile = path.join(workdir, "mcp.pid");
    await writeMcpConfig(path.join(workdir, ".harness"), {
      echo: mcpEchoServer({ env: { PID_FILE: pidFile } }),
    });
    const sessionDir = path.join(home, "mcp-project-trusted");
    const { impl, calls } = mockFetch([EMPTY_RESPONSE]);

    await collect(
      runSession({
        input: "hi",
        model: "gw/flash",
        providersText: providersText(),
        sessionDir,
        fetchImpl: impl,
        cwd: workdir,
        mcp: { trustProjectConfig: true },
      }),
    );

    const tools = calls[0].body.tools as Array<{ function: { name: string } }>;
    expect(tools.map((tool) => tool.function.name)).toContain("mcp__echo__echo");
    expect(existsSync(pidFile)).toBe(true);
    expect(mcpStatusPayloads(sessionDir)).toContainEqual(
      expect.objectContaining({ kind: "connected", server: "echo" }),
    );
  });

  it("mcp.enabled:false 时不加载也不连接", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const configDir = await tempDir();
    const pidFile = path.join(configDir, "mcp.pid");
    const userConfigPath = await writeMcpConfig(configDir, {
      echo: mcpEchoServer({ env: { PID_FILE: pidFile } }),
    });
    const sessionDir = path.join(home, "mcp-disabled-session");
    const { impl, calls } = mockFetch([EMPTY_RESPONSE]);

    await collect(
      runSession({
        input: "hi",
        model: "gw/flash",
        providersText: providersText(),
        sessionDir,
        fetchImpl: impl,
        cwd: configDir,
        mcp: { enabled: false, userConfigPath },
      }),
    );

    const tools = calls[0].body.tools as Array<{ function: { name: string } }>;
    expect(tools.map((tool) => tool.function.name).some((name) => name.startsWith("mcp__"))).toBe(
      false,
    );
    expect(existsSync(pidFile)).toBe(false);
    expect(mcpStatusPayloads(sessionDir)).toEqual([]);
  });

  it("无配置或全部 disabled 时不连接、不写 status", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const configDir = await tempDir();
    const configPath = await writeMcpConfig(configDir, {
      echo: mcpEchoServer({ disabled: true }),
    });
    const cases: Array<{ name: string; mcp?: { projectConfigPath?: string } }> = [
      { name: "no-config" },
      { name: "all-disabled", mcp: { projectConfigPath: configPath } },
    ];

    for (const entry of cases) {
      const sessionDir = path.join(home, entry.name);
      const { impl, calls } = mockFetch([EMPTY_RESPONSE]);
      await collect(
        runSession({
          input: "hi",
          model: "gw/flash",
          providersText: providersText(),
          sessionDir,
          fetchImpl: impl,
          cwd: configDir,
          ...(entry.mcp !== undefined ? { mcp: entry.mcp } : {}),
        }),
      );
      const tools = calls[0].body.tools as Array<{ function: { name: string } }>;
      expect(tools.map((tool) => tool.function.name).some((name) => name.startsWith("mcp__"))).toBe(
        false,
      );
      expect(mcpStatusPayloads(sessionDir)).toEqual([]);
    }
  });

  it("单 server 连接失败记 status 且会话继续", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const configDir = await tempDir();
    const userConfigPath = await writeMcpConfig(configDir, {
      echo: mcpEchoServer(),
      broken: { command: "definitely-not-a-real-command-embedded-ai" },
    });
    const sessionDir = path.join(home, "mcp-partial-session");
    const { impl, calls } = mockFetch([EMPTY_RESPONSE]);

    const events = await collect(
      runSession({
        input: "hi",
        model: "gw/flash",
        providersText: providersText(),
        sessionDir,
        fetchImpl: impl,
        cwd: configDir,
        mcp: { userConfigPath },
      }),
    );

    const tools = calls[0].body.tools as Array<{ function: { name: string } }>;
    expect(tools.map((tool) => tool.function.name)).toContain("mcp__echo__echo");
    expect(events).toContainEqual({ kind: "done", finishReason: "no_tool_calls" });
    expect(mcpStatusPayloads(sessionDir)).toContainEqual(
      expect.objectContaining({ kind: "connect_failed", server: "broken" }),
    );
  });

  it("status 写入失败时输出错误且会话继续", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const configDir = await tempDir();
    const userConfigPath = await writeMcpConfig(configDir, {
      broken: { command: "definitely-not-a-real-command-embedded-ai" },
    });
    const sessionDir = path.join(home, "mcp-status-append-failure");
    const { impl } = mockFetch([EMPTY_RESPONSE]);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    statusAppendFailure.enabled = true;
    try {
      const events = await collect(
        runSession({
          input: "hi",
          model: "gw/flash",
          providersText: providersText(),
          sessionDir,
          fetchImpl: impl,
          cwd: configDir,
          mcp: { userConfigPath },
        }),
      );

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("[mcp] status event append failed: status append boom"),
      );
      expect(events).toContainEqual({ kind: "done", finishReason: "no_tool_calls" });
    } finally {
      errorSpy.mockRestore();
      statusAppendFailure.enabled = false;
    }
  });

  it("mcp_status 写入失败时降级且工具仍执行", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const configDir = await tempDir();
    const userConfigPath = await writeMcpConfig(configDir, { echo: mcpEchoServer() });
    const sessionDir = path.join(home, "mcp-status-event-failure");
    const { impl } = mockFetch([
      toolCallResponseNoUsage("mcp-call", "mcp__echo__echo", { text: "hello-mcp" }),
      EMPTY_RESPONSE,
    ]);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mcpStatusAppendFailure.enabled = true;
    try {
      const events = await collect(
        runSession({
          input: "hi",
          model: "gw/flash",
          providersText: providersText(),
          sessionDir,
          fetchImpl: impl,
          cwd: configDir,
          mcp: { userConfigPath },
        }),
      );

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("[mcp] status event append failed: mcp status append boom"),
      );
      expect(events).toContainEqual(
        expect.objectContaining({ kind: "tool_result", id: "mcp-call", ok: true }),
      );
      expect(events).toContainEqual({ kind: "done", finishReason: "no_tool_calls" });
      expect(
        readSessionFile(path.join(sessionDir, "session.v1.jsonl")).some(
          (event) =>
            event.type === "tool_result"
            && event.payload.id === "mcp-call"
            && event.payload.ok === true,
        ),
      ).toBe(true);
    } finally {
      errorSpy.mockRestore();
      mcpStatusAppendFailure.enabled = false;
    }
  });

  it("配置坏 JSON 记 mcp_config_failed 且会话继续", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const configDir = await tempDir();
    const userConfigPath = path.join(configDir, "broken.json");
    await writeFile(userConfigPath, "{ not json", "utf8");
    const sessionDir = path.join(home, "mcp-config-failed-session");
    const { impl, calls } = mockFetch([EMPTY_RESPONSE]);

    const events = await collect(
      runSession({
        input: "hi",
        model: "gw/flash",
        providersText: providersText(),
        sessionDir,
        fetchImpl: impl,
        cwd: configDir,
        mcp: { userConfigPath },
      }),
    );

    const tools = calls[0].body.tools as Array<{ function: { name: string } }>;
    expect(tools.map((tool) => tool.function.name).some((name) => name.startsWith("mcp__"))).toBe(
      false,
    );
    expect(events).toContainEqual({ kind: "done", finishReason: "no_tool_calls" });
    expect(mcpStatusPayloads(sessionDir)).toContainEqual(
      expect.objectContaining({ kind: "config_failed" }),
    );
  });

  it("list_changed 后新工具出现在后续请求", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const configDir = await tempDir();
    const userConfigPath = await writeMcpConfig(configDir, { echo: mcpEchoServer() });
    const sessionDir = path.join(home, "mcp-list-changed-session");
    const grownCall = {
      id: "grow-call",
      type: "function",
      function: { name: "mcp__echo__grow", arguments: "{}" },
    };
    const grownToolCall = {
      id: "grown-call",
      type: "function",
      function: { name: "mcp__echo__grown-1", arguments: "{}" },
    };
    const { impl, calls } = mockFetch([
      { choices: [{ message: { content: "", tool_calls: [grownCall] }, finish_reason: "tool_calls" }] },
      { choices: [{ message: { content: "", tool_calls: [grownToolCall] }, finish_reason: "tool_calls" }] },
      { choices: [{ message: { content: "", tool_calls: [grownToolCall] }, finish_reason: "tool_calls" }] },
      EMPTY_RESPONSE,
    ]);
    let fetchCount = 0;
    const wrapped: typeof fetch = async (input, init) => {
      if (fetchCount === 1) {
        await waitFor(() =>
          mcpStatusPayloads(sessionDir).some(
            (payload) => payload.kind === "tools_changed",
          ),
        );
      }
      fetchCount += 1;
      return impl(input, init);
    };

    const events = await collect(
      runSession({
        input: "hi",
        model: "gw/flash",
        providersText: providersText(),
        sessionDir,
        fetchImpl: wrapped,
        cwd: configDir,
        mcp: { userConfigPath },
        permissions: { preset: "danger-full-access" },
      }),
    );

    const laterTools = calls.slice(1).map((call) =>
      (call.body.tools as Array<{ function: { name: string } }>).map((tool) => tool.function.name),
    );
    expect(
      laterTools.some(
        (names) => names.includes("mcp__echo__grown-1") && names.includes("echo"),
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) => event.kind === "tool_result" && event.id === "grown-call" && event.ok,
      ),
    ).toBe(true);
    const logged = readSessionFile(path.join(sessionDir, "session.v1.jsonl"));
    expect(logged).toContainEqual(
      expect.objectContaining({
        type: "tool_result",
        payload: expect.objectContaining({
          toolName: "mcp__echo__grown-1",
          ok: true,
        }),
      }),
    );
    expect(mcpStatusPayloads(sessionDir)).toContainEqual(
      expect.objectContaining({ kind: "tools_changed", server: "echo" }),
    );
  });

  it("onStatus renamed 落到会话 status 事件", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const configDir = await tempDir();
    const userConfigPath = await writeMcpConfig(configDir, { echo: mcpEchoServer() });
    const sessionDir = path.join(home, "mcp-renamed-session");
    const { impl } = mockFetch([
      toolCallResponseNoUsage("grow-call", "mcp__echo__grow", {}),
      EMPTY_RESPONSE,
    ]);
    let fetchCount = 0;
    const wrapped: typeof fetch = async (input, init) => {
      if (fetchCount === 1) {
        await waitFor(() =>
          mcpStatusPayloads(sessionDir).some(
            (payload) => payload.kind === "tools_changed",
          ),
        );
      }
      fetchCount += 1;
      return impl(input, init);
    };

    await collect(
      runSession({
        input: "hi",
        model: "gw/flash",
        providersText: providersText(),
        sessionDir,
        fetchImpl: wrapped,
        cwd: configDir,
        mcp: { userConfigPath },
        permissions: { preset: "danger-full-access" },
      }),
    );

    const renamed = mcpStatusPayloads(sessionDir).filter(
      (payload) => payload.kind === "tool_name_renamed",
    );
    expect(renamed).toHaveLength(1);
    expect(renamed[0]).toMatchObject({
      server: "echo",
      tool: "dup_a",
      originalName: "mcp__echo__dup_a",
    });
    expect(renamed[0].name).toMatch(/^mcp__echo__dup_a_[0-9a-f]{6}$/);
  });

  it("刷新失败记 mcp_tools_refresh_failed 且旧工具仍可用", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const configDir = await tempDir();
    const userConfigPath = await writeMcpConfig(configDir, { echo: mcpEchoServer() });
    const sessionDir = path.join(home, "mcp-refresh-failed-session");
    const { impl, calls } = mockFetch([
      toolCallResponseNoUsage("broken-call", "mcp__echo__grow-broken", {}),
      toolCallResponseNoUsage("echo-call", "mcp__echo__echo", { text: "still-alive" }),
      EMPTY_RESPONSE,
    ]);
    let fetchCount = 0;
    const wrapped: typeof fetch = async (input, init) => {
      if (fetchCount === 1) {
        await waitFor(() =>
          mcpStatusPayloads(sessionDir).some(
            (payload) => payload.kind === "tools_refresh_failed",
          ),
        );
      }
      fetchCount += 1;
      return impl(input, init);
    };

    const events = await collect(
      runSession({
        input: "hi",
        model: "gw/flash",
        providersText: providersText(),
        sessionDir,
        fetchImpl: wrapped,
        cwd: configDir,
        mcp: { userConfigPath },
        permissions: { preset: "danger-full-access" },
      }),
    );

    expect(mcpStatusPayloads(sessionDir)).toContainEqual(
      expect.objectContaining({ kind: "tools_refresh_failed", server: "echo" }),
    );
    expect(
      events.some(
        (event) => event.kind === "tool_result" && event.id === "echo-call" && event.ok,
      ),
    ).toBe(true);
    const secondTools = (calls[1].body.tools as Array<{ function: { name: string } }>).map(
      (tool) => tool.function.name,
    );
    expect(secondTools).toContain("mcp__echo__echo");
  });

  it("坏 schema 触发刷新失败时保留旧集合", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const configDir = await tempDir();
    const userConfigPath = await writeMcpConfig(configDir, { echo: mcpEchoServer() });
    const sessionDir = path.join(home, "mcp-bad-schema-session");
    const { impl, calls } = mockFetch([
      toolCallResponseNoUsage("bad-call", "mcp__echo__bad-schema", {}),
      toolCallResponseNoUsage("echo-call", "mcp__echo__echo", { text: "still-alive" }),
      EMPTY_RESPONSE,
    ]);
    let fetchCount = 0;
    const wrapped: typeof fetch = async (input, init) => {
      if (fetchCount === 1) {
        await waitFor(() =>
          mcpStatusPayloads(sessionDir).some(
            (payload) => payload.kind === "tools_refresh_failed",
          ),
        );
      }
      fetchCount += 1;
      return impl(input, init);
    };

    const events = await collect(
      runSession({
        input: "hi",
        model: "gw/flash",
        providersText: providersText(),
        sessionDir,
        fetchImpl: wrapped,
        cwd: configDir,
        mcp: { userConfigPath },
        permissions: { preset: "danger-full-access" },
      }),
    );

    expect(mcpStatusPayloads(sessionDir)).toContainEqual(
      expect.objectContaining({ kind: "tools_refresh_failed", server: "echo" }),
    );
    expect(
      events.some(
        (event) => event.kind === "tool_result" && event.id === "echo-call" && event.ok,
      ),
    ).toBe(true);
    const secondTools = (calls[1].body.tools as Array<{ function: { name: string } }>).map(
      (tool) => tool.function.name,
    );
    expect(secondTools).toContain("mcp__echo__echo");

  });

  it("registry 全局重建失败记 scope:global 且会话继续", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const configDir = await tempDir();
    const userConfigPath = await writeMcpConfig(configDir, { echo: mcpEchoServer() });
    const sessionDir = path.join(home, "mcp-global-refresh-session");
    const { impl, calls } = mockFetch([EMPTY_RESPONSE]);
    const replaceSpy = vi
      .spyOn(ToolRegistry.prototype, "replace")
      .mockImplementationOnce(() => {
        throw new Error("registry replace boom");
      });
    try {
      const events = await collect(
        runSession({
          input: "hi",
          model: "gw/flash",
          providersText: providersText(),
          sessionDir,
          fetchImpl: impl,
          cwd: configDir,
          mcp: { userConfigPath },
        }),
      );

      expect(mcpStatusPayloads(sessionDir)).toContainEqual(
        expect.objectContaining({
          kind: "tools_refresh_failed",
          scope: "global",
          message: expect.stringContaining("registry replace boom"),
        }),
      );
      expect(
        mcpStatusPayloads(sessionDir).some(
          (payload) =>
            payload.kind === "tool_name_renamed"
            || payload.kind === "tool_invalid_schema",
        ),
      ).toBe(false);
      expect(events).toContainEqual({ kind: "done", finishReason: "no_tool_calls" });
      const tools = calls[0].body.tools as Array<{ function: { name: string } }>;
      expect(tools.map((tool) => tool.function.name).some((name) => name.startsWith("mcp__"))).toBe(
        false,
      );
    } finally {
      replaceSpy.mockRestore();
    }
  });

  it("adapter 过滤坏 schema 工具并落 mcp_tool_invalid_schema status", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const configDir = await tempDir();
    const userConfigPath = await writeMcpConfig(configDir, { echo: mcpEchoServer() });
    const sessionDir = path.join(home, "mcp-invalid-schema-session");
    const { impl, calls } = mockFetch([EMPTY_RESPONSE]);
    const originalTools = McpManager.prototype.tools;
    const toolsSpy = vi
      .spyOn(McpManager.prototype, "tools")
      .mockImplementation(function (this: McpManager) {
        return [
          ...originalTools.call(this),
          {
            server: "echo",
            tool: "invalid",
            description: "Invalid inputSchema root",
            inputSchema: { type: "string" },
          },
        ];
      });
    try {
      await collect(
        runSession({
          input: "hi",
          model: "gw/flash",
          providersText: providersText(),
          sessionDir,
          fetchImpl: impl,
          cwd: configDir,
          mcp: { userConfigPath },
        }),
      );

      expect(mcpStatusPayloads(sessionDir)).toContainEqual(
        expect.objectContaining({
          kind: "tool_invalid_schema",
          server: "echo",
          tool: "invalid",
        }),
      );
      const tools = (calls[0].body.tools as Array<{ function: { name: string } }>).map(
        (tool) => tool.function.name,
      );
      expect(tools).toContain("mcp__echo__echo");
      expect(tools).not.toContain("mcp__echo__invalid");
    } finally {
      toolsSpy.mockRestore();
    }
  });

  it("list_changed 移除工具后不再出现在后续请求", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const configDir = await tempDir();
    const userConfigPath = await writeMcpConfig(configDir, { echo: mcpEchoServer() });
    const sessionDir = path.join(home, "mcp-shrink-session");
    const { impl, calls } = mockFetch([
      toolCallResponseNoUsage("shrink-call", "mcp__echo__shrink", {}),
      toolCallResponseNoUsage("echo-call", "mcp__echo__echo", { text: "still-alive" }),
      EMPTY_RESPONSE,
    ]);
    let fetchCount = 0;
    const wrapped: typeof fetch = async (input, init) => {
      if (fetchCount === 1) {
        await waitFor(() =>
          mcpStatusPayloads(sessionDir).some(
            (payload) => payload.kind === "tools_changed",
          ),
        );
      }
      fetchCount += 1;
      return impl(input, init);
    };

    const events = await collect(
      runSession({
        input: "hi",
        model: "gw/flash",
        providersText: providersText(),
        sessionDir,
        fetchImpl: wrapped,
        cwd: configDir,
        mcp: { userConfigPath },
        permissions: { preset: "danger-full-access" },
      }),
    );

    const firstTools = (calls[0].body.tools as Array<{ function: { name: string } }>).map(
      (tool) => tool.function.name,
    );
    const secondTools = (calls[1].body.tools as Array<{ function: { name: string } }>).map(
      (tool) => tool.function.name,
    );
    expect(firstTools).toContain("mcp__echo__multi");
    expect(firstTools).toContain("mcp__echo__shrink");
    expect(secondTools).toContain("mcp__echo__echo");
    expect(secondTools).not.toContain("mcp__echo__multi");
    expect(secondTools).not.toContain("mcp__echo__shrink");
    expect(
      events.some(
        (event) => event.kind === "tool_result" && event.id === "echo-call" && event.ok,
      ),
    ).toBe(true);
    expect(mcpStatusPayloads(sessionDir)).toContainEqual(
      expect.objectContaining({ kind: "tools_changed", server: "echo" }),
    );
  });

  it("mcp.enabled 非布尔时抛 TypeError", async () => {
    await expect(
      collect(
        runSession({
          input: "hi",
          model: "gw/flash",
          providersText: providersText(),
          mcp: { enabled: "yes" as unknown as boolean },
        }),
      ),
    ).rejects.toThrow(/mcp\.enabled must be a boolean/);
  });

  it.each(["yes", 42, null, [], new Date()])("mcp 非对象时抛 TypeError: %j", async (value) => {
    await expect(
      collect(
        runSession({
          input: "hi",
          model: "gw/flash",
          providersText: providersText(),
          mcp: value as unknown as { enabled?: boolean },
        }),
      ),
    ).rejects.toThrow(/mcp must be an object/);
  });

  it("MCP close 异常不覆盖运行期主错误", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const configDir = await tempDir();
    const userConfigPath = await writeMcpConfig(configDir, { echo: mcpEchoServer() });
    const sessionDir = path.join(home, "mcp-close-error-session");
    const first = mockFetch([EMPTY_RESPONSE]);
    await collect(
      runSession({
        input: "hi",
        model: "gw/flash",
        providersText: providersText(),
        sessionDir,
        fetchImpl: first.impl,
        cwd: configDir,
        mcp: { userConfigPath },
      }),
    );

    const originalClose = McpManager.prototype.close;
    const closeSpy = vi
      .spyOn(McpManager.prototype, "close")
      .mockImplementationOnce(async function (this: McpManager): Promise<void> {
        await originalClose.call(this);
        throw new Error("mcp close boom");
      });
    try {
      const failingFetch = vi.fn(async () => ({
        ok: false,
        status: 400,
        text: async () => "primary boom",
      })) as unknown as typeof fetch;
      const error = await collect(
        runSession({
          input: "again",
          model: "gw/flash",
          providersText: providersText(),
          sessionDir,
          resume: true,
          fetchImpl: failingFetch,
          cwd: configDir,
          mcp: { userConfigPath },
        }),
      ).then(
        () => undefined,
        (reason: unknown) => reason,
      );

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("status 400");
      expect((error as Error).message).not.toContain("mcp close boom");
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      closeSpy.mockRestore();
    }
  });

  it("无主错误时 MCP close 异常冒泡", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const configDir = await tempDir();
    const userConfigPath = await writeMcpConfig(configDir, { echo: mcpEchoServer() });
    const sessionDir = path.join(home, "mcp-close-bubble-session");
    const first = mockFetch([EMPTY_RESPONSE]);
    await collect(
      runSession({
        input: "hi",
        model: "gw/flash",
        providersText: providersText(),
        sessionDir,
        fetchImpl: first.impl,
        cwd: configDir,
        mcp: { userConfigPath },
      }),
    );

    const originalClose = McpManager.prototype.close;
    const closeSpy = vi
      .spyOn(McpManager.prototype, "close")
      .mockImplementationOnce(async function (this: McpManager): Promise<void> {
        await originalClose.call(this);
        throw new Error("mcp close boom");
      });
    try {
      const { impl } = mockFetch([EMPTY_RESPONSE]);
      const error = await collect(
        runSession({
          input: "again",
          model: "gw/flash",
          providersText: providersText(),
          sessionDir,
          resume: true,
          fetchImpl: impl,
          cwd: configDir,
          mcp: { userConfigPath },
        }),
      ).then(
        () => undefined,
        (reason: unknown) => reason,
      );

      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("mcp close boom");
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      closeSpy.mockRestore();
    }
  });

  it("关闭后 MCP 子进程退出", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const configDir = await tempDir();
    const pidFile = path.join(configDir, "close.pid");
    const userConfigPath = await writeMcpConfig(configDir, {
      echo: mcpEchoServer({ env: { PID_FILE: pidFile } }),
    });
    const sessionDir = path.join(home, "mcp-close-session");
    const { impl } = mockFetch([EMPTY_RESPONSE]);

    await collect(
      runSession({
        input: "hi",
        model: "gw/flash",
        providersText: providersText(),
        sessionDir,
        fetchImpl: impl,
        cwd: configDir,
        mcp: { userConfigPath },
      }),
    );

    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(await readFile(pidFile, "utf8"));
    expect(Number.isInteger(pid)).toBe(true);
    await waitFor(() => !isAlive(pid));
  });
});
