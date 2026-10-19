import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMessages } from "../src/context/build.js";
import { ConfigLoadError, ModelReferenceError } from "../src/config/providers.js";
import { runSession } from "../src/index.js";
import type { LoopEvent } from "../src/loop/events.js";
import { SessionResumeError } from "../src/session/errors.js";
import { createSession, readSessionFile } from "../src/session/session.js";

const resumeCloseFailure = vi.hoisted(() => ({ enabled: false }));
const resumeCallCounter = vi.hoisted(() => ({ count: 0 }));

vi.mock("../src/session/session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/session/session.js")>();
  return {
    ...actual,
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
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

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
    expect(calls[0].body.stream).toBe(false);
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
    expect(summaryMessages[0]).toMatchObject({ role: "system" });

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
