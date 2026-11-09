import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunOptions, runSession } from "../../src/index.js";
import type { LoopEvent } from "../../src/loop/events.js";
import { createSessionRunner, RunnerError } from "../../src/server/runner.js";
import type { ActionInput, SessionRunner } from "../../src/server/runner.js";
import { createLogTailEventSource } from "../../src/events/log-tail.js";
import { createSession } from "../../src/session/session.js";
import type { SessionHandle } from "../../src/session/session.js";
import type { EventType } from "../../src/session/types.js";

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

function fakeHandle(dir = "test-session-dir"): SessionHandle {
  let seq = 0;
  const append = vi.fn(async (ev: { type: EventType }) => {
    const event = { seq: seq++, ts: "", type: ev.type, payload: {} };
    return event;
  });
  // `dir` 是 runner 记录 MCP 连接 key 的唯一来源，每个会话给一个可区分的值。
  return { append, dir } as unknown as SessionHandle;
}

interface FakeOptions {
  delayMs?: number;
  neverReady?: boolean;
  hang?: boolean;
  fail?: Error;
  /** 假会话目录；给每条 run 一个不同值即可区分连接 key。 */
  dir?: string;
  /** 在 run 内真的向 registry 取一个连接，用来观察 closeSession 的效果。 */
  acquireMcp?: boolean;
  /** 就绪后按顺序写入这些事件类型（走句柄的 append，即进程内回调的来源）。 */
  emit?: EventType[];
}

function createFakeRunSession(options: FakeOptions = {}): {
  impl: typeof runSession;
  calls: RunOptions[];
  managers: Array<{ close: ReturnType<typeof vi.fn> }>;
  release: () => void;
} {
  const calls: RunOptions[] = [];
  const managers: Array<{ close: ReturnType<typeof vi.fn> }> = [];
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
      const handle = fakeHandle(options.dir);
      opts.onSession?.(handle);
      if (options.acquireMcp === true && opts.mcpRegistry !== undefined) {
        const manager = { close: vi.fn(async () => undefined) };
        managers.push(manager);
        await opts.mcpRegistry.acquire(options.dir ?? "test-session-dir", async () => {
          return manager as never;
        });
      }
      // 真实内核在这一步之后才写 user/assistant……；假 run 用同样的句柄
      // 写出几条事件，用来观察进程内回调。
      for (const type of options.emit ?? []) {
        await handle.append({ type, payload: {} });
      }
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
  return { impl, calls, managers, release: () => releaseHang() };
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

/**
 * `start` 在 `onSession` 就返回，假 runSession 里 `onSession` 之后的语句
 * （取 MCP 连接）要等 generator 继续跑一个 tick 才执行。
 */
function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
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

  it("单次 mode 覆盖预设，未知值在启动前拒绝", async () => {
    const home = makeHome();
    const fake = createFakeRunSession();
    const runner = newRunner(home, {
      runSessionImpl: fake.impl,
      permissions: { preset: "diagnose" },
    });

    await runner.start({ text: "hi", mode: "read-only" });
    expect(fake.calls[0]?.permissions?.preset).toBe("read-only");

    // Without a mode the runner's own preset stands.
    await runner.start({ text: "again" });
    expect(fake.calls[1]?.permissions?.preset).toBe("diagnose");

    const error = await startError(runner, { text: "x", mode: "bypassPermissions" as never });
    expect(error.code).toBe("invalid_mode");
    // The rejected call never reached runSession.
    expect(fake.calls).toHaveLength(2);
  });

  it("运行上限透传给 runSession，非法值在启动前拒绝", async () => {
    const home = makeHome();
    const fake = createFakeRunSession();
    const runner = newRunner(home, { runSessionImpl: fake.impl });

    await runner.start({
      text: "hi",
      maxTurns: 3,
      maxCostUsd: 0.5,
      timeoutMs: 1000,
      systemPrompt: "你是诊断助手",
    });
    const call = fake.calls[0];
    expect(call?.maxTurns).toBe(3);
    expect(call?.maxCostUsd).toBe(0.5);
    expect(call?.timeoutMs).toBe(1000);
    expect(call?.systemPrompt).toBe("你是诊断助手");

    // Absent means "use the kernel default"; an empty prompt is the same thing.
    await runner.start({ text: "again", systemPrompt: "   " });
    expect(fake.calls[1]?.maxTurns).toBeUndefined();
    expect(fake.calls[1]?.maxCostUsd).toBeUndefined();
    expect(fake.calls[1]?.systemPrompt).toBeUndefined();

    for (const bad of [
      { maxTurns: 0 },
      { maxTurns: "3" as never },
      { maxCostUsd: -1 },
      { timeoutMs: 1.5 },
    ]) {
      const error = await startError(runner, { text: "x", ...bad });
      expect(error.code).toBe("invalid_run_limits");
    }
    expect(fake.calls).toHaveLength(2);
  });

  it("单次 reasoningEffort 透传给 runSession，非法值在启动前拒绝", async () => {
    const home = makeHome();
    const fake = createFakeRunSession();
    const runner = newRunner(home, { runSessionImpl: fake.impl });

    await runner.start({ text: "hi", reasoningEffort: "high" });
    expect(fake.calls[0]?.reasoningEffort).toBe("high");

    // `auto` 是界面的哨兵值，到这一层必须变成「没有覆盖」——否则它会作为
    // 一个字面量等级被发上线，而协议里没有这一档。字段必须真的缺席。
    await runner.start({ text: "again", reasoningEffort: "auto" });
    expect(fake.calls[1]?.reasoningEffort).toBeUndefined();
    expect(Object.hasOwn(fake.calls[1] as object, "reasoningEffort")).toBe(false);

    // 界面档位与协议值都收；runner 不折算（它看不到模型配置），原样交给
    // 内核——`runSession` 按该模型的 `effortMap` 折算成协议值再上线。
    await runner.start({ text: "tier", reasoningEffort: "galaxy" });
    expect(fake.calls[2]?.reasoningEffort).toBe("galaxy");

    // 例子里原本是 `"max"`：Task 1 之后它是合法档位，不再是拒绝的样本。
    // 断言本身没变——仍必须有一个非协议值、非档位的字符串在启动前被拒。
    const error = await startError(runner, { text: "x", reasoningEffort: "xhigh" as never });
    expect(error.code).toBe("invalid_run_limits");
    expect(error.message).toContain("reasoningEffort");
    // 被拒绝的调用从未到达 runSession。
    expect(fake.calls).toHaveLength(3);
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

  it("新建会话时本次传入的 model 优先于构造时的模型与环境变量", async () => {
    const home = makeHome();
    vi.stubEnv("HARNESS_WEB_MODEL", "alpha/m1");
    const fake = createFakeRunSession();
    const runner = newRunner(home, { runSessionImpl: fake.impl, model: "alpha/m1" });

    await runner.start({ text: "hi", model: "alpha/m2" });

    // 选择模型的下拉框就在 composer 上：本次选择必须真的传到这一次运行。
    expect(fake.calls[0]?.model).toBe("alpha/m2");
  });

  it("本次传入的 model 不在 providers 中时抛 model_unavailable 且不启动会话", async () => {
    const home = makeHome();
    const fake = createFakeRunSession();
    const runner = newRunner(home, { runSessionImpl: fake.impl });

    const error = await startError(runner, { text: "hi", model: "alpha/nope" });
    expect(error.code).toBe("model_unavailable");
    // 引用无效必须在建会话之前失败，不能留下一场跑错模型的运行。
    expect(fake.calls).toHaveLength(0);
  });

  it("本次传入的 model 不是字符串时抛 invalid_model 且不启动会话", async () => {
    const home = makeHome();
    const fake = createFakeRunSession();
    const runner = newRunner(home, { runSessionImpl: fake.impl });

    for (const bad of [42 as never, null as never, { id: "alpha/m2" } as never]) {
      const error = await startError(runner, { text: "hi", model: bad });
      expect(error.code).toBe("invalid_model");
    }
    // 类型错误是调用方的 bug：不能靠内核的默认模型把它盖过去。
    expect(fake.calls).toHaveLength(0);
  });

  it("续聊时 header.model 优先于本次传入的 model", async () => {
    const home = makeHome();
    const sessionId = "model-pinned-session";
    const sessionDir = path.join(home, "sessions", sessionId);
    const handle = await createSession(sessionDir, { id: sessionId, model: "alpha/m1" });
    await handle.close();
    const fake = createFakeRunSession();
    const runner = newRunner(home, { runSessionImpl: fake.impl });

    await runner.start({ text: "again", sessionId, model: "alpha/m2" });

    // 会话模型固定在 header 里（内核自己会抛 model_mismatch）：续聊时
    // 本次传入的选择不能改写既有会话，否则这场对话会换一个模型继续。
    expect(fake.calls[0]?.model).toBe("alpha/m1");
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

  it("close 后 decide 返回 runner_unavailable 而不是 unknown_session", async () => {
    const home = makeHome();
    const fake = createFakeRunSession();
    const runner = newRunner(home, { runSessionImpl: fake.impl });
    await runner.close();

    // 与 start 的 closed 语义一致:关闭后不可再决,不能把「运行器已关闭」伪装成「会话不存在」(D-154)。
    await expect(runner.decide("s1", "r1", "allow")).resolves.toEqual({
      kind: "runner_unavailable",
    });
  });

  it("abort 中止运行中的会话并返回 true", async () => {
    const home = makeHome();
    const fake = createFakeRunSession({ hang: true });
    const runner = newRunner(home, { runSessionImpl: fake.impl });

    const { sessionId } = await runner.start({ text: "hi" });
    expect(runner.abort(sessionId)).toBe(true);
    expect(fake.calls[0]?.signal?.aborted).toBe(true);
    await runner.close();
  });

  it("abort 对已结束或不存在的会话返回 false", async () => {
    const home = makeHome();
    const fake = createFakeRunSession();
    const runner = newRunner(home, { runSessionImpl: fake.impl });

    const { sessionId } = await runner.start({ text: "hi" });
    // 让 generator 跑完并注销；未关闭的 runner 仍应如实说“没有可中止的”。
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(runner.abort("no-such-session")).toBe(false);
    expect(runner.abort(sessionId)).toBe(false);
  });

  it("close 后 abort 返回 false", async () => {
    const home = makeHome();
    const fake = createFakeRunSession({ hang: true });
    const runner = newRunner(home, { runSessionImpl: fake.impl });
    const { sessionId } = await runner.start({ text: "hi" });

    await runner.close();
    expect(runner.abort(sessionId)).toBe(false);
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

  it("start 把 registry 传给 runSession，同一 runner 的两次 run 共用同一张表", async () => {
    const home = makeHome();
    const fake = createFakeRunSession({ acquireMcp: true, dir: "dir-a" });
    const runner = newRunner(home, { runSessionImpl: fake.impl });

    await runner.start({ text: "hi" });
    await runner.start({ text: "again" });

    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]?.mcpRegistry).toBeDefined();
    // 同一张表是复用的前提：两次 run 拿到不同 registry 就等于又一条新连接。
    expect(fake.calls[1]?.mcpRegistry).toBe(fake.calls[0]?.mcpRegistry);
  });

  it("closeSession 释放该会话的连接，且重复调用无操作", async () => {
    const home = makeHome();
    const fake = createFakeRunSession({ acquireMcp: true, dir: "dir-a" });
    const runner = newRunner(home, { runSessionImpl: fake.impl });

    const outcome = await runner.start({ text: "hi" });
    await nextTick();
    expect(fake.managers).toHaveLength(1);

    await runner.closeSession(outcome.sessionId);
    expect(fake.managers[0]?.close).toHaveBeenCalledTimes(1);

    // 再关一次是无操作（该会话已从表里移除）。
    await runner.closeSession(outcome.sessionId);
    expect(fake.managers[0]?.close).toHaveBeenCalledTimes(1);
  });

  it("closeSession 对未知会话静默成功", async () => {
    const home = makeHome();
    const fake = createFakeRunSession();
    const runner = newRunner(home, { runSessionImpl: fake.impl });
    await runner.start({ text: "hi" });

    await expect(runner.closeSession("no-such-session")).resolves.toBeUndefined();
  });

  it("close 释放所有会话的 MCP 连接，单个失败作为错误返回", async () => {
    const home = makeHome();
    const fake = createFakeRunSession({ acquireMcp: true, dir: "dir-b" });
    const runner = newRunner(home, { runSessionImpl: fake.impl });
    await runner.start({ text: "hi" });
    await nextTick();
    const boom = new Error("close boom");
    fake.managers[0]?.close.mockRejectedValueOnce(boom);

    await expect(runner.close()).rejects.toBe(boom);
  });

  it("close 后 closeSession 是空操作", async () => {
    const home = makeHome();
    const fake = createFakeRunSession({ acquireMcp: true, dir: "dir-c" });
    const runner = newRunner(home, { runSessionImpl: fake.impl });
    const outcome = await runner.start({ text: "hi" });
    await nextTick();
    await runner.close();

    expect(fake.managers[0]?.close).toHaveBeenCalledTimes(1);
    await expect(runner.closeSession(outcome.sessionId)).resolves.toBeUndefined();
    expect(fake.managers[0]?.close).toHaveBeenCalledTimes(1);
  });

  describe("进程内事件通道（OPT-15 / D-134）", () => {
    it("每条落盘事件按顺序转给 onSessionEvent", async () => {
      const home = makeHome();
      const fake = createFakeRunSession({ emit: ["user", "assistant_delta", "assistant"] });
      const received: Array<{ session: string; seq: number; type: string }> = [];
      const runner = newRunner(home, {
        runSessionImpl: fake.impl,
        onSessionEvent: (session, event) => {
          received.push({ session, seq: event.seq, type: event.type });
        },
      });

      const outcome = await runner.start({ text: "hi" });
      await nextTick();

      expect(received.map((entry) => entry.type)).toEqual(["user", "assistant_delta", "assistant"]);
      expect(received.map((entry) => entry.seq)).toEqual([0, 1, 2]);
      // 会话 id 必须对得上：宿主用它判断这条事件是不是当前这一轮的。
      expect(received.every((entry) => entry.session === outcome.sessionId)).toBe(true);
    });

    it("回调抛错不影响运行结果，也不冒泡到 start", async () => {
      const home = makeHome();
      const fake = createFakeRunSession({ emit: ["user", "assistant"] });
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        const runner = newRunner(home, {
          runSessionImpl: fake.impl,
          onSessionEvent: () => {
            throw new Error("render boom");
          },
        });

        await expect(runner.start({ text: "hi" })).resolves.toMatchObject({ created: true });
        await nextTick();

        // 两次回调都真的被执行了：一次失败不能让后续事件也丢掉。
        expect(stderr.mock.calls.filter((call) => String(call[0]).includes("事件回调失败"))).toHaveLength(1);
        // 只记一次，不是每条事件一行。
        expect(stderr).toHaveBeenCalledTimes(1);
      } finally {
        stderr.mockRestore();
      }
    });

    it("没有回调时行为与从前一致", async () => {
      const home = makeHome();
      const fake = createFakeRunSession({ emit: ["user"] });
      const runner = newRunner(home, { runSessionImpl: fake.impl });

      await expect(runner.start({ text: "hi" })).resolves.toMatchObject({ created: true });
      await nextTick();
    });

    it("加速通道坏了，事件仍在日志里（文件跟随仍能送到）", async () => {
      // 真实 runSession + 400 网关：回调每次都抛错，但这一轮照常落盘。
      // 之后用日志跟随读同一个会话，事件必须一条不少——加速是加速，不是
      // 事实源（R3 / D-134：文件跟随承担崩溃恢复与重连补播）。
      const home = makeHome();
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        const runner = newRunner(home, {
          fetchImpl: (async () =>
            new Response(JSON.stringify({ error: { message: "bad request (test)" } }), {
              status: 400,
              headers: { "Content-Type": "application/json" },
            })) as typeof fetch,
          onSessionEvent: () => {
            throw new Error("live channel down");
          },
        });

        const outcome = await runner.start({ text: "串口没输出" });

        // 等真实信号，不等固定延时：全量并行跑时 50ms 可能不够，而这条用例
        // 断言的正是「日志里有完整事件流」——用固定延时会让它变成「机器多快
        // 能跑完一轮」的测试。轮询到出现 interrupted（本轮终局）再读。
        const source = createLogTailEventSource({ sessionsRoot: path.join(home, "sessions") });
        let events: { type: string; seq: number }[] = [];
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          const read = await source.read(outcome.sessionId, -1);
          events = read.events as { type: string; seq: number }[];
          if (events.some((event) => event.type === "interrupted")) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(events.length).toBeGreaterThan(0);
        expect(events.map((event) => event.type)).toContain("user");
        expect(events.at(-1)?.type).toBe("interrupted");
        // seq 从 0 连续，文件通道拿到的是一条完整事件流。
        expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index));
      } finally {
        stderr.mockRestore();
      }
    });
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