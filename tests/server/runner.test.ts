import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunOptions, runSession } from "../../src/index.js";
import type { LoopEvent } from "../../src/loop/events.js";
import { createSessionRunner, RunnerError } from "../../src/server/runner.js";
import type { ActionInput, SessionRunner } from "../../src/server/runner.js";
import { createSession } from "../../src/session/session.js";
import type { SessionHandle } from "../../src/session/session.js";

const headerOverride = vi.hoisted(() => ({
  impl: undefined as undefined | ((dir: string) => unknown),
}));

vi.mock("../../src/session/persistence.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/session/persistence.js")>();
  return {
    ...actual,
    readSessionHeader: (dir: string) => {
      if (headerOverride.impl !== undefined) return headerOverride.impl(dir);
      return actual.readSessionHeader(dir);
    },
  };
});

const PROVIDERS_TEXT = JSON.stringify({
  alpha: {
    protocol: "openai-chat-completions",
    baseUrl: "http://127.0.0.1:9/v1",
    models: {
      m1: { contextWindow: 1000, maxOutput: 100 },
      m2: { contextWindow: 2000, maxOutput: 200 },
    },
  },
});

const homes: string[] = [];
const runners: SessionRunner[] = [];

function makeHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "runner-test-"));
  homes.push(home);
  return home;
}

function fakeHandle(): SessionHandle {
  const append = vi.fn(async () => ({ seq: 0, ts: "", type: "status" as const, payload: {} }));
  return { append } as unknown as SessionHandle;
}

interface FakeOptions {
  delayMs?: number;
  neverReady?: boolean;
  hang?: boolean;
  fail?: Error;
}

function createFakeRunSession(options: FakeOptions = {}): {
  impl: typeof runSession;
  calls: RunOptions[];
  release: () => void;
} {
  const calls: RunOptions[] = [];
  let releaseHang!: () => void;
  const hangGate = new Promise<void>((resolve) => {
    releaseHang = resolve;
  });
  const impl = async function* run(opts: RunOptions): AsyncGenerator<LoopEvent> {
    calls.push(opts);
    if (options.fail !== undefined) throw options.fail;
    if (options.neverReady !== true) {
      if (options.delayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      }
      opts.onSession?.(fakeHandle());
    }
    if (options.hang === true) {
      await Promise.race([
        hangGate,
        new Promise<void>((_, reject) => {
          opts.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
      ]);
    }
    yield { kind: "done", finishReason: "no_tool_calls" };
  };
  return { impl, calls, release: () => releaseHang() };
}

function newRunner(home: string, overrides: Parameters<typeof createSessionRunner>[0] | object = {}): SessionRunner {
  const runner = createSessionRunner({
    harnessHome: home,
    providersText: PROVIDERS_TEXT,
    ...overrides,
  });
  runners.push(runner);
  return runner;
}

async function startError(runner: SessionRunner, input: ActionInput): Promise<RunnerError> {
  const error = await runner.start(input).then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(RunnerError);
  return error as RunnerError;
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

afterEach(async () => {
  headerOverride.impl = undefined;
  await Promise.allSettled(runners.splice(0).map((runner) => runner.close()));
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("createSessionRunner", () => {
  it("构造时不加载 providers，无 providers 也可创建", () => {
    const home = makeHome();
    expect(() => createSessionRunner({ harnessHome: home })).not.toThrow();
  });

  it("新建会话：把 input/home/providers/permissions 传给 runSession", async () => {
    const home = makeHome();
    const fake = createFakeRunSession();
    const runner = newRunner(home, { runSessionImpl: fake.impl, cwd: "E:/work" });

    const outcome = await runner.start({ text: "hi" });

    expect(outcome.created).toBe(true);
    expect(outcome.sessionId).toMatch(/^[a-zA-Z0-9_-]{1,128}$/);
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0];
    expect(call?.sessionId).toBe(outcome.sessionId);
    expect(call?.input).toBe("hi");
    expect(call?.home).toBe(home);
    expect(call?.providersText).toBe(JSON.stringify(JSON.parse(PROVIDERS_TEXT)));
    expect(call?.permissions?.prompter).toBeDefined();
    expect(call?.cwd).toBe("E:/work");
    expect(call?.resume).toBeUndefined();
    expect(call?.signal).toBeDefined();
  });

  it("等待 onSession 后才 resolve", async () => {
    const home = makeHome();
    const fake = createFakeRunSession({ delayMs: 50 });
    const runner = newRunner(home, { runSessionImpl: fake.impl });

    const startedAt = Date.now();
    await runner.start({ text: "hi" });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(40);
  });

  it("onSession 超时：abort 并抛 session_start_timeout", async () => {
    const home = makeHome();
    const fake = createFakeRunSession({ neverReady: true, hang: true });
    const runner = newRunner(home, { runSessionImpl: fake.impl, readyTimeoutMs: 20 });

    const error = await startError(runner, { text: "hi" });
    expect(error.code).toBe("session_start_timeout");
    expect(error.message).toContain("会话未创建成功");
    expect(fake.calls[0]?.signal?.aborted).toBe(true);
  });

  it("追加会话：使用 header.model、resume 与 sessionDir，且省略 cwd", async () => {
    const home = makeHome();
    const sessionId = "existing-session";
    const sessionDir = path.join(home, "sessions", sessionId);
    const handle = await createSession(sessionDir, {
      id: sessionId,
      model: "alpha/m2",
      workdir: "E:/old-work",
    });
    await handle.close();
    const fake = createFakeRunSession();
    const runner = newRunner(home, { runSessionImpl: fake.impl, cwd: "E:/runner-work" });

    const outcome = await runner.start({ text: "again", sessionId });

    expect(outcome).toEqual({ sessionId, created: false });
    const call = fake.calls[0];
    expect(call?.resume).toBe(true);
    expect(call?.sessionDir).toBe(sessionDir);
    expect(call?.model).toBe("alpha/m2");
    expect(call === undefined ? true : "cwd" in call).toBe(false);
  });

  it("同一会话运行中再次 start 抛 session_busy，结束后可再启动", async () => {
    const home = makeHome();
    const fake = createFakeRunSession({ hang: true });
    const runner = newRunner(home, { runSessionImpl: fake.impl });

    const first = await runner.start({ text: "first" });
    await expect(
      runner.start({ text: "second", sessionId: first.sessionId }),
    ).rejects.toMatchObject({ code: "session_busy" });

    fake.release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(runner.start({ text: "third" })).resolves.toMatchObject({ created: true });
  });

  it("校验输入：空/空白/超长与非法会话 id", async () => {
    const home = makeHome();
    const fake = createFakeRunSession();
    const runner = newRunner(home, { runSessionImpl: fake.impl });

    await expect(runner.start({ text: "" })).rejects.toMatchObject({ code: "invalid_text" });
    await expect(runner.start({ text: "  \n " })).rejects.toMatchObject({ code: "invalid_text" });
    await expect(runner.start({ text: "a".repeat(8001) })).rejects.toMatchObject({
      code: "invalid_text",
    });
    await expect(
      runner.start({ text: "hi", sessionId: "../evil" }),
    ).rejects.toMatchObject({ code: "invalid_session_id" });
    await expect(
      runner.start({ text: "hi", sessionId: "no-such-session" }),
    ).rejects.toMatchObject({ code: "unknown_session" });
  });

  it("无 providers 时 start 抛 model_unavailable 并提示配置文件与环境变量", async () => {
    const home = makeHome();
    const fake = createFakeRunSession();
    const runner = newRunner(home, {
      runSessionImpl: fake.impl,
      providersText: "",
    });

    const error = await startError(runner, { text: "hi" });
    expect(error.code).toBe("model_unavailable");
    expect(error.message).toContain("HARNESS_HOME/providers.json");
    expect(error.message).not.toContain(home);
    expect(error.message).toContain("HARNESS_WEB_MODEL");
  });

  it("providers JSON 损坏时抛 model_unavailable 并提示配置文件与环境变量", async () => {
    const home = makeHome();
    const fake = createFakeRunSession();
    const runner = newRunner(home, { runSessionImpl: fake.impl, providersText: "{not json" });

    const error = await startError(runner, { text: "hi" });
    expect(error.code).toBe("model_unavailable");
    expect(error.message).toContain("HARNESS_HOME/providers.json");
    expect(error.message).not.toContain(home);
    expect(error.message).toContain("HARNESS_WEB_MODEL");
  });

  it("模型引用无效时抛 model_unavailable 并提示配置文件与环境变量", async () => {
    const home = makeHome();
    vi.stubEnv("HARNESS_WEB_MODEL", "alpha/no-such-model");
    const fake = createFakeRunSession();
    const runner = newRunner(home, { runSessionImpl: fake.impl });

    const error = await startError(runner, { text: "hi" });
    expect(error.code).toBe("model_unavailable");
    expect(error.message).toContain("HARNESS_HOME/providers.json");
    expect(error.message).not.toContain(home);
    expect(error.message).toContain("HARNESS_WEB_MODEL");
  });

  it("providers 无可用引用时抛 model_unavailable 并提示配置文件与环境变量", async () => {
    const home = makeHome();
    vi.stubEnv("HARNESS_WEB_MODEL", "");
    const fake = createFakeRunSession();
    const runner = newRunner(home, { runSessionImpl: fake.impl, providersText: "{}" });

    const error = await startError(runner, { text: "hi" });
    expect(error.code).toBe("model_unavailable");
    expect(error.message).toContain("HARNESS_HOME/providers.json");
    expect(error.message).not.toContain(home);
    expect(error.message).toContain("HARNESS_WEB_MODEL");
  });

  it("HARNESS_WEB_MODEL 覆盖默认模型引用", async () => {
    const home = makeHome();
    vi.stubEnv("HARNESS_WEB_MODEL", "alpha/m2");
    const fake = createFakeRunSession();
    const runner = newRunner(home, { runSessionImpl: fake.impl });

    await runner.start({ text: "hi" });

    expect(fake.calls[0]?.model).toBe("alpha/m2");
  });

  it("默认使用 providers 的第一个模型引用", async () => {
    const home = makeHome();
    vi.stubEnv("HARNESS_WEB_MODEL", "");
    const fake = createFakeRunSession();
    const runner = newRunner(home, { runSessionImpl: fake.impl });

    await runner.start({ text: "hi" });

    expect(fake.calls[0]?.model).toBe("alpha/m1");
  });

  it("providers 来自 harnessHome 的 providers.json", async () => {
    const home = makeHome();
    writeFileSync(path.join(home, "providers.json"), PROVIDERS_TEXT, "utf8");
    const fake = createFakeRunSession();
    const runner = newRunner(home, { runSessionImpl: fake.impl, providersText: undefined });

    await runner.start({ text: "hi" });

    expect(fake.calls[0]?.model).toBe("alpha/m1");
  });

  it("generator 在就绪前失败：保留 code 但文案说明会话启动失败", async () => {
    const home = makeHome();
    const fake = createFakeRunSession({ fail: new Error("boom") });
    const runner = newRunner(home, { runSessionImpl: fake.impl });

    const error = await startError(runner, { text: "hi" });
    expect(error.code).toBe("model_unavailable");
    expect(error.message).toContain("会话启动失败");
    expect(error.message).toContain("boom");
    expect(error.message).not.toContain("模型不可用");
    expect(error.message).not.toContain("providers");
  });

  it("未知会话在 providers 缺失前优先返回 unknown_session", async () => {
    const home = makeHome();
    const runner = newRunner(home, { providersText: "" });

    await expect(
      runner.start({ text: "hi", sessionId: "no-such-session" }),
    ).rejects.toMatchObject({ code: "unknown_session" });
  });

  it("header 损坏时抛 session_corrupt", async () => {
    const home = makeHome();
    const sessionId = "corrupt-session";
    mkdirSync(path.join(home, "sessions", sessionId), { recursive: true });
    writeFileSync(path.join(home, "sessions", sessionId, "header.json"), "{bad", "utf8");
    const fake = createFakeRunSession();
    const runner = newRunner(home, { runSessionImpl: fake.impl });

    const error = await startError(runner, { text: "hi", sessionId });
    expect(error.code).toBe("session_corrupt");
    expect(error.message).toContain("会话 header 损坏");
    expect(fake.calls).toHaveLength(0);
  });

  it("header 权限错误时抛 session_unreadable", async () => {
    const home = makeHome();
    headerOverride.impl = () => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    };
    const fake = createFakeRunSession();
    const runner = newRunner(home, { runSessionImpl: fake.impl });

    const error = await startError(runner, { text: "hi", sessionId: "existing-session" });
    expect(error.code).toBe("session_unreadable");
    expect(error.message).toBe("会话不可读");
    expect(fake.calls).toHaveLength(0);
  });

  it("close 后 start 抛 runner_unavailable", async () => {
    const home = makeHome();
    const fake = createFakeRunSession();
    const runner = newRunner(home, { runSessionImpl: fake.impl });
    await runner.close();

    await expect(runner.start({ text: "hi" })).rejects.toMatchObject({
      code: "runner_unavailable",
    });
  });

  it("decide 对未知会话返回 unknown_session", async () => {
    const home = makeHome();
    const fake = createFakeRunSession();
    const runner = newRunner(home, { runSessionImpl: fake.impl });

    await expect(runner.decide("no-such-session", "r1", "allow")).resolves.toEqual({
      kind: "unknown_session",
    });
  });

  it("close 中止运行中的会话", async () => {
    const home = makeHome();
    const fake = createFakeRunSession({ hang: true });
    const runner = newRunner(home, { runSessionImpl: fake.impl });

    await runner.start({ text: "hi" });
    await expect(runner.close()).resolves.toBeUndefined();
    expect(fake.calls[0]?.signal?.aborted).toBe(true);
  });

  it("close 中止运行中的会话时不写 stderr", async () => {
    const home = makeHome();
    const fake = createFakeRunSession({ hang: true });
    const runner = newRunner(home, { runSessionImpl: fake.impl });
    await runner.start({ text: "hi" });

    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await runner.close();
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });

  it("就绪前被 close 中止时 start 抛 session_start_timeout", async () => {
    const home = makeHome();
    const fake = createFakeRunSession({ neverReady: true, hang: true });
    const runner = newRunner(home, { runSessionImpl: fake.impl, readyTimeoutMs: 5000 });

    const pending = startError(runner, { text: "hi" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const closing = runner.close();
    const error = await pending;
    expect(error.code).toBe("session_start_timeout");
    expect(error.message).toContain("会话在就绪前被中止");
    await closing;
  });
});