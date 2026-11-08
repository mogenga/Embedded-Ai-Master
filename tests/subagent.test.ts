import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildMessages } from "../src/context/build.js";
import { runSession } from "../src/index.js";
import type { LoopCtx } from "../src/loop/query.js";
import { query } from "../src/loop/query.js";
import type { LoopEvent } from "../src/loop/events.js";
import type {
  CompletionResult,
  ModelChatMessage,
  ModelProtocol,
  ModelToolSchema,
} from "../src/model/protocol.js";
import { createPermissionGate } from "../src/permissions/gate.js";
import { readSessionDir } from "../src/session/persistence.js";
import { createSession } from "../src/session/session.js";
import type { SessionHandle } from "../src/session/session.js";
import type { SessionEvent } from "../src/session/types.js";
import {
  DEFAULT_MAX_TURNS,
  DEFAULT_TIMEOUT_MS,
  MAX_RUNNING_SUBAGENTS,
  getSubagent,
  killAllSubagents,
  killSubagent,
  listSubagents,
  startSubagent,
  subagentSpendUsd,
  takeSubagentCompletions,
} from "../src/subagent/runner.js";
import type { SubagentDeps } from "../src/subagent/runner.js";
import { createSubagentTools } from "../src/subagent/tools.js";
import { createBuiltinTools } from "../src/tools/builtin.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { ToolDef } from "../src/tools/types.js";

const tempDirs: string[] = [];
const sessions: SessionHandle[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "subagent-test-"));
  tempDirs.push(dir);
  return dir;
}

async function removeTempDir(dir: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const retriable = code === "ENOTEMPTY" || code === "EBUSY" || code === "EPERM";
      if (!retriable || attempt >= 8) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

afterEach(async () => {
  killAllSubagents();
  for (const session of sessions.splice(0)) await session.close().catch(() => undefined);
  for (const dir of tempDirs.splice(0)) await removeTempDir(dir);
});

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`等待条件超时（${timeoutMs}ms）`);
}

function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

type ScriptStep = CompletionResult | "hang";

/**
 * 离线模型桩。
 *
 * `"hang"` 表示「不返回」：等一个手动 resolve 的 Promise，并在 signal abort 时
 * 以 AbortError 退出——`query` 的收尾路径靠的正是这个错误。它与
 * `tests/integration.test.ts` 的 `mockFetch` 是同一条约束的两端：沙箱里没有
 * 网关，所有模型交互都必须是注入的桩。
 */
function scriptedModel(steps: ScriptStep[]): ModelProtocol & {
  calls: Array<{ messages: ModelChatMessage[]; tools: ModelToolSchema[] }>;
} {
  const calls: Array<{ messages: ModelChatMessage[]; tools: ModelToolSchema[] }> = [];
  let index = 0;
  return {
    calls,
    async complete(messages, tools, opts) {
      calls.push({ messages, tools });
      const step = steps[Math.min(index, steps.length - 1)];
      index += 1;
      if (step === "hang") {
        return new Promise<CompletionResult>((_resolve, reject) => {
          if (opts.signal.aborted) {
            reject(abortError());
            return;
          }
          opts.signal.addEventListener("abort", () => reject(abortError()), { once: true });
        });
      }
      if (step === undefined) throw new Error("script exhausted");
      return step;
    },
    countTokens() {
      return 0;
    },
  };
}

function reply(
  content: string,
  toolCalls: CompletionResult["toolCalls"] = [],
  usage?: CompletionResult["usage"],
): CompletionResult {
  const result: CompletionResult = {
    content,
    toolCalls,
    truncatedByMaxTokens: false,
    stopReason: null,
  };
  if (usage !== undefined) result.usage = usage;
  return result;
}

function toolReply(
  content: string,
  calls: Array<{ id: string; name: string; args: Record<string, unknown> }>,
  usage?: CompletionResult["usage"],
): CompletionResult {
  return reply(
    content,
    calls.map((call) => ({ id: call.id, name: call.name, arguments: call.args })),
    usage,
  );
}

interface Harness {
  parentSessionId: string;
  parentDir: string;
  workdir: string;
  deps: SubagentDeps;
  spend: number[];
  model: ReturnType<typeof scriptedModel>;
}

/**
 * 一套完整的父子环境。
 *
 * 父会话是**真会话**（`createSession`），子代理目录因此落在
 * `<parentDir>/subagents/<id>`——这也是「它不会被 `sessions.list()` 当成独立
 * 会话」的机制本身：列表只看 `sessions/` 的直接子目录。
 */
async function harness(opts: {
  steps?: ScriptStep[];
  pricePerMillion?: { input: number; output: number; cachedInput?: number };
  registry?: () => ToolRegistry;
  inheritableRules?: SubagentDeps["inheritableRules"];
} = {}): Promise<Harness> {
  const parentDir = await tempDir();
  const workdir = await tempDir();
  const parent = await createSession(parentDir);
  sessions.push(parent);
  const model = scriptedModel(opts.steps ?? [reply("结论：没有发现问题。")]);
  const spend: number[] = [];
  const deps: SubagentDeps = {
    model,
    modelCfg: { contextWindow: 8192, maxOutput: 512 },
    registry: opts.registry ?? (() => new ToolRegistry(createBuiltinTools())),
    budget: () => ({ over: false, tokens: 0, softLimit: 1 }),
    inheritableRules: opts.inheritableRules ?? [],
    cwd: workdir,
    onSpend: (usd) => {
      spend.push(usd);
    },
    ...(opts.pricePerMillion === undefined ? {} : { pricePerMillion: opts.pricePerMillion }),
  };
  return {
    parentSessionId: parent.id,
    parentDir,
    workdir,
    deps,
    spend,
    model,
  };
}

function eventsOf(dir: string): SessionEvent[] {
  return readSessionDir(dir).events;
}

function toolResultsOf(dir: string): Array<Record<string, unknown>> {
  return eventsOf(dir)
    .filter((event) => event.type === "tool_result")
    .map((event) => event.payload);
}

async function killAndWait(parentSessionId: string, id: string): Promise<void> {
  killSubagent(parentSessionId, id);
  await waitFor(() => getSubagent(parentSessionId, id)?.status !== "running");
}

describe("subagent 运行语义", () => {
  it("立即返回：模型请求被挂住时 startSubagent 仍 < 200 ms 返回 id", async () => {
    const h = await harness({ steps: ["hang"] });
    const startedAt = Date.now();

    const outcome = await startSubagent(h.parentSessionId, h.parentDir, "查一下时钟配置", {
      deps: h.deps,
    });
    const elapsed = Date.now() - startedAt;

    expect("id" in outcome).toBe(true);
    expect(elapsed).toBeLessThan(200);
    if (!("id" in outcome)) return;
    // 模型确实还没回话——「立即返回」不是因为它已经跑完了。
    await waitFor(() => h.model.calls.length > 0);
    expect(getSubagent(h.parentSessionId, outcome.id)?.status).toBe("running");
    await killAndWait(h.parentSessionId, outcome.id);
  });

  it("只读由权限层保证：子代理调 write 得到 permission_denied，目标文件不存在", async () => {
    const h = await harness({
      steps: [
        toolReply("", [{ id: "w1", name: "write", args: { path: "blocked.txt", content: "x" } }]),
        reply("写不了，被权限层拒绝了。"),
      ],
    });
    const target = path.join(h.workdir, "blocked.txt");

    const outcome = await startSubagent(h.parentSessionId, h.parentDir, "写一个文件试试", {
      deps: h.deps,
    });
    if (!("id" in outcome)) throw new Error(outcome.error);
    await waitFor(() => getSubagent(h.parentSessionId, outcome.id)?.status !== "running");

    const results = toolResultsOf(path.join(h.parentDir, "subagents", outcome.id));
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: "w1", ok: false, code: "permission_denied" });
    // 权限层不是「事后报错」：文件根本没有被创建。
    expect(existsSync(target)).toBe(false);
  });

  it("只读的边界是权限层而不是另一张白名单：子代理也起不了子代理", async () => {
    // `subagent` 自己声明 access: () => "write"。如果「只读」是一张工具名清单，
    // 新工具会被漏掉；权限层按 access 判定，所以它自动被挡住。
    const nested = createSubagentTools(await freeDeps());
    const registry = () => new ToolRegistry([...createBuiltinTools(), ...nested]);
    const h = await harness({
      steps: [
        toolReply("", [
          { id: "s1", name: "subagent", args: { prompt: "再开一个" } },
        ]),
        reply("没有权限再开子代理。"),
      ],
      registry,
    });

    const outcome = await startSubagent(h.parentSessionId, h.parentDir, "递归试试", {
      deps: h.deps,
    });
    if (!("id" in outcome)) throw new Error(outcome.error);
    await waitFor(() => getSubagent(h.parentSessionId, outcome.id)?.status !== "running");

    const results = toolResultsOf(path.join(h.parentDir, "subagents", outcome.id));
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: "s1", ok: false, code: "permission_denied" });
    // 只有一个子代理：父会话没有冒出第二个。
    expect(listSubagents(h.parentSessionId)).toHaveLength(1);
  });

  it("子会话是真会话：父目录下 subagents/<id> 有 header.json 与 session.v1.jsonl", async () => {
    const h = await harness();
    const outcome = await startSubagent(h.parentSessionId, h.parentDir, "读一遍环境", {
      deps: h.deps,
    });
    if (!("id" in outcome)) throw new Error(outcome.error);
    await waitFor(() => getSubagent(h.parentSessionId, outcome.id)?.status !== "running");

    const childDir = path.join(h.parentDir, "subagents", outcome.id);
    // 目录在父会话目录**下面**：`sessions.list()` 只看 sessions/ 的直接子目录，
    // 所以它不会被列成一条独立会话。
    expect(path.dirname(childDir)).toBe(path.join(h.parentDir, "subagents"));
    expect(existsSync(path.join(childDir, "header.json"))).toBe(true);
    expect(existsSync(path.join(childDir, "session.v1.jsonl"))).toBe(true);

    const { header, events } = readSessionDir(childDir);
    expect(header.id).toBe(outcome.id);
    // 跑完 close()：header 落成 closed，锁也释放了。这一步不验证，「真会话」
    // 就只是「一个目录」——下次打开它要等陈旧锁超时。
    expect(header.status).toBe("closed");
    // 日志是唯一事实源：system 提示词、用户任务、assistant 结论都在里面。
    expect(events[0]).toMatchObject({ type: "system" });
    expect(String(events[0]?.payload.content)).toContain("只读子代理");
    expect(events.some((event) => event.type === "user")).toBe(true);
    expect(events.some((event) => event.type === "assistant")).toBe(true);
    // 子会话投影出来是完整的一问一答，父会话不必在场。
    expect(buildMessages(events).map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
    ]);
  });

  it("只读工具可用：子代理 read 一个临时文件 → ok 且正文含文件内容", async () => {
    const h = await harness({
      steps: [
        toolReply("", [{ id: "r1", name: "read", args: { path: "notes.txt" } }]),
        reply("文件里写的是 heartbeat-ok。"),
      ],
    });
    await writeFile(path.join(h.workdir, "notes.txt"), "heartbeat-ok\n", "utf8");

    const outcome = await startSubagent(h.parentSessionId, h.parentDir, "读 notes.txt", {
      deps: h.deps,
    });
    if (!("id" in outcome)) throw new Error(outcome.error);
    await waitFor(() => getSubagent(h.parentSessionId, outcome.id)?.status !== "running");

    const results = toolResultsOf(path.join(h.parentDir, "subagents", outcome.id));
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: "r1", ok: true });
    expect(String(results[0]?.text)).toContain("heartbeat-ok");
  });

  it("完成与取结果：状态 finished、text 非空，完成队列恰好一条且取出即清空", async () => {
    const h = await harness({
      steps: [reply("结论：时钟树是 72 MHz。证据：docs/clock.md:12。", [], {
        promptTokens: 30,
        completionTokens: 12,
      })],
    });
    const outcome = await startSubagent(h.parentSessionId, h.parentDir, "确认主频", {
      deps: h.deps,
    });
    if (!("id" in outcome)) throw new Error(outcome.error);
    await waitFor(() => getSubagent(h.parentSessionId, outcome.id)?.status === "finished");

    const summary = getSubagent(h.parentSessionId, outcome.id);
    expect(summary?.status).toBe("finished");
    expect(summary?.text).toContain("72 MHz");
    expect(summary?.turns).toBe(1);
    expect(summary?.toolCalls).toBe(0);
    expect(summary?.promptTokens).toBe(30);
    expect(summary?.completionTokens).toBe(12);

    const first = takeSubagentCompletions(h.parentSessionId);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ id: outcome.id, status: "finished" });
    expect(first[0]?.text).toContain("72 MHz");
    // 取出即清空：同一个终局不会写两遍。
    expect(takeSubagentCompletions(h.parentSessionId)).toEqual([]);
  });

  it("成本计入父会话：子代理花掉的钱让父轮次在发请求前熔断为 max_cost_usd", async () => {
    const h = await harness({
      steps: [reply("结论：查完了。", [], { promptTokens: 1_000, completionTokens: 1_000 })],
      pricePerMillion: { input: 1, output: 1 },
    });
    const outcome = await startSubagent(h.parentSessionId, h.parentDir, "花点钱", {
      deps: h.deps,
    });
    if (!("id" in outcome)) throw new Error(outcome.error);
    await waitFor(() => getSubagent(h.parentSessionId, outcome.id)?.status === "finished");

    // 1000 prompt + 1000 completion，$1/M → $0.002。
    expect(h.spend).toHaveLength(1);
    expect(h.spend[0]).toBeCloseTo(0.002, 9);

    const parentModel = scriptedModel([reply("不该被调用")]);
    const parent = sessions[0]!;
    const external = h.spend.reduce((total, usd) => total + usd, 0);
    const ctx: LoopCtx = {
      session: parent,
      model: parentModel,
      modelCfg: { contextWindow: 8192, maxOutput: 512 },
      tools: new ToolRegistry(createBuiltinTools()),
      budget: () => ({ over: false, tokens: 0, softLimit: 1 }),
      signal: new AbortController().signal,
      artifactDir: path.join(h.parentDir, "artifacts"),
      permissionGate: createPermissionGate({ preset: "diagnose", rules: [] }),
      pricePerMillion: { input: 1, output: 1 },
      externalCostUsd: () => external,
    };
    const events: LoopEvent[] = [];
    for await (const event of query(ctx, "继续", { maxCostUsd: 0.001 })) events.push(event);

    // 熔断发生在**发请求之前**：父会话一次模型调用都没有发出去。
    expect(parentModel.calls).toHaveLength(0);
    expect(events).toContainEqual({ kind: "interrupted", reason: "max_cost_usd" });
    expect(events.at(-1)).toEqual({ kind: "done", finishReason: "max_cost_usd" });
  });

  it("runSession 把账本接到 LoopCtx 上：子代理花掉的钱让父会话下一轮熔断", async () => {
    // 上面那条测的是 `query` 的钩子本身；这一条测的是**接线**。
    // 曾经写成「成本为零就不传闭包」——ctx 在任何子代理启动之前组装，那一刻
    // 账本恒为零，于是永远不传，钩子形同不存在。
    const home = await tempDir();
    const providersText = JSON.stringify({
      gw: {
        protocol: "openai-chat-completions",
        baseUrl: "http://127.0.0.1:9",
        models: { flash: { contextWindow: 8192, maxOutput: 512 } },
        pricePerMillion: { input: 1, output: 1 },
      },
    });

    // 第 1 次请求：父轮次分派一个子代理（子代理自己的模型调用由 `deps.model`
    // 桩接管，不碰这个 fetch）。
    const responses = [
      reply("", [{ id: "s1", name: "subagent", arguments: { prompt: "花钱调查" } }]),
      reply("不该被调用"),
    ];
    let index = 0;
    const fetchImpl = (async () => {
      const payload = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return {
        ok: true,
        status: 200,
        json: async () => payload,
        text: async () => JSON.stringify(payload),
      };
    }) as unknown as typeof fetch;

    // 子代理在**这一轮之前**就已经结算过：账本按父会话累计，与子代理是哪一轮
    // 起的无关（父会话的 costUsd 本来就是整段会话的累计值）。
    const h = await harness({
      steps: [reply("结论：查完了。", [], { promptTokens: 1_000, completionTokens: 1_000 })],
      pricePerMillion: { input: 1, output: 1 },
    });
    const outcome = await startSubagent("parent-session", h.parentDir, "花钱调查", {
      deps: h.deps,
    });
    if (!("id" in outcome)) throw new Error(outcome.error);
    await waitFor(() => getSubagent("parent-session", outcome.id)?.status === "finished");
    expect(subagentSpendUsd("parent-session")).toBeCloseTo(0.002, 9);

    const events: LoopEvent[] = [];
    for await (const event of runSession({
      input: "继续",
      model: "gw/flash",
      providersText,
      // 父会话目录与刚才那次子代理的父目录是同一个：账本按会话 id 累计，
      // 与「子代理是在哪一轮起的」无关。这里由 `runSession` 自己建会话。
      sessionDir: path.join(h.parentDir, "parent-session"),
      sessionId: "parent-session",
      fetchImpl,
      home,
      maxCostUsd: 0.001,
      permissions: { preset: "diagnose" },
    })) {
      events.push(event);
    }

    // 父会话一次模型调用都没发出去：熔断在发请求之前。
    expect(index).toBe(0);
    expect(events).toContainEqual({ kind: "interrupted", reason: "max_cost_usd" });
    expect(events.at(-1)).toEqual({ kind: "done", finishReason: "max_cost_usd" });
  });

  it("轮内花掉的钱在同一轮的下一次模型调用之前就熔断（不是等到下一次重算）", async () => {
    // 这一条测的是**轮内增量**，不是三处重算：子代理可能在父轮次的两条模型
    // 调用之间结算，而 `costUsd += …` 只累加父会话自己的用量。只在重算里折入
    // 的话，那笔钱要等到下一次压缩才被看见——而预算闸门最该生效的正是
    // 「它已经被花掉了」的那一刻。
    //
    // 构造方式：父轮次的第 1 次模型调用要求跑一个假工具，该工具执行时把
    // 外部账本推到 0.002；同一轮的**第 2 次**模型调用因此必须被拦下。
    let external = 0;
    const bumpTool: ToolDef<Record<string, never>> = {
      name: "bump",
      description: "把外部账本推高（测试用）",
      schema: z.object({}),
      annotations: { readOnly: true },
      execute: async () => {
        external = 0.002;
        return { isError: false, code: "ok", message: "", text: "bumped" };
      },
    };
    const model = scriptedModel([
      toolReply("", [{ id: "b1", name: "bump", args: {} }]),
      reply("不该被调用"),
    ]);
    const parentDir = await tempDir();
    const parent = await createSession(parentDir);
    sessions.push(parent);
    const ctx: LoopCtx = {
      session: parent,
      model,
      modelCfg: { contextWindow: 8192, maxOutput: 512 },
      tools: new ToolRegistry([bumpTool]),
      budget: () => ({ over: false, tokens: 0, softLimit: 1 }),
      signal: new AbortController().signal,
      artifactDir: path.join(parentDir, "artifacts"),
      permissionGate: createPermissionGate({ preset: "danger-full-access", rules: [] }),
      pricePerMillion: { input: 1, output: 1 },
      externalCostUsd: () => external,
    };

    const events: LoopEvent[] = [];
    for await (const event of query(ctx, "继续", { maxCostUsd: 0.001 })) events.push(event);

    // 第 2 次模型调用从未发生：轮内增量在 `assertBreakers` 之前就并进了成本。
    expect(model.calls).toHaveLength(1);
    expect(events).toContainEqual({ kind: "interrupted", reason: "max_cost_usd" });
    expect(events.at(-1)).toEqual({ kind: "done", finishReason: "max_cost_usd" });
  });

  it("没有价格就不加 0：pricePerMillion 缺省时 onSpend 不调用、costUsd 不出现", async () => {
    const h = await harness({
      steps: [reply("结论：查完了。", [], { promptTokens: 1_000, completionTokens: 1_000 })],
    });
    const outcome = await startSubagent(h.parentSessionId, h.parentDir, "查一下", {
      deps: h.deps,
    });
    if (!("id" in outcome)) throw new Error(outcome.error);
    await waitFor(() => getSubagent(h.parentSessionId, outcome.id)?.status === "finished");

    expect(h.spend).toEqual([]);
    const summary = getSubagent(h.parentSessionId, outcome.id);
    expect(summary?.costUsd).toBeUndefined();
    // 「零美元」和「不知道价格」是两件事，事件里也一样：字段整个不出现。
    const completion = takeSubagentCompletions(h.parentSessionId)[0];
    expect(completion === undefined ? {} : Object.hasOwn(completion, "costUsd")).toBe(false);
  });

  it("并发上限：4 个挂着之后第 5 个返回 subagent_limit", async () => {
    const h = await harness({ steps: ["hang"] });
    const started: string[] = [];
    for (let index = 0; index < MAX_RUNNING_SUBAGENTS; index += 1) {
      const outcome = await startSubagent(h.parentSessionId, h.parentDir, `调查 ${index}`, {
        deps: h.deps,
      });
      if (!("id" in outcome)) throw new Error(outcome.error);
      started.push(outcome.id);
    }

    const fifth = await startSubagent(h.parentSessionId, h.parentDir, "第五个", { deps: h.deps });

    expect(fifth).toEqual({
      error: `too many running subagents (max ${MAX_RUNNING_SUBAGENTS})`,
      code: "subagent_limit",
    });
    expect(listSubagents(h.parentSessionId)).toHaveLength(MAX_RUNNING_SUBAGENTS);
    for (const id of started) await killAndWait(h.parentSessionId, id);
  });

  it("终止：killSubagent → 状态 killed、killedBy 为 kill", async () => {
    const h = await harness({ steps: ["hang"] });
    const outcome = await startSubagent(h.parentSessionId, h.parentDir, "跑一个长调查", {
      deps: h.deps,
    });
    if (!("id" in outcome)) throw new Error(outcome.error);
    await waitFor(() => h.model.calls.length > 0);

    expect(killSubagent(h.parentSessionId, outcome.id)).toBe(true);
    await waitFor(() => getSubagent(h.parentSessionId, outcome.id)?.status !== "running");

    const summary = getSubagent(h.parentSessionId, outcome.id);
    expect(summary?.status).toBe("killed");
    expect(summary?.killedBy).toBe("kill");
    expect(summary?.error).toBeUndefined();
    // 已经结束的作业再 kill 一次：不再伪造一次新的终止。
    expect(killSubagent(h.parentSessionId, outcome.id)).toBe(false);
  });

  it("超时：子代理自己的定时器 abort，终局是 timed_out 且 killedBy 为 timeout", async () => {
    const h = await harness({ steps: ["hang"] });
    const outcome = await startSubagent(h.parentSessionId, h.parentDir, "跑一个长调查", {
      deps: h.deps,
      timeoutMs: 50,
    });
    if (!("id" in outcome)) throw new Error(outcome.error);
    await waitFor(() => getSubagent(h.parentSessionId, outcome.id)?.status !== "running");

    const summary = getSubagent(h.parentSessionId, outcome.id);
    expect(summary?.status).toBe("timed_out");
    expect(summary?.killedBy).toBe("timeout");
  });

  it("继承父的 deny 规则：只收紧、不放行（父的 allow 规则不会让写工具变得可写）", async () => {
    // 父会话这一轮的规则里有一条 deny `read`、一条 allow `write`。
    // 子代理必须继承那条 deny；同时那条 allow 不能漏进来——子代理的预设
    // 永远是 read-only，父说「写可以」不构成一个子代理可以写的理由。
    const h = await harness({
      steps: [
        toolReply("", [
          { id: "r1", name: "read", args: { path: "notes.txt" } },
          { id: "w1", name: "write", args: { path: "blocked.txt", content: "x" } },
        ]),
        reply("读被禁、写也被禁。"),
      ],
      inheritableRules: [
        { rule: { tool: "read", action: "deny", reason: "test:no-read" }, source: "inline" },
        { rule: { tool: "write", action: "allow", reason: "test:allow-write" }, source: "inline" },
      ],
    });
    await writeFile(path.join(h.workdir, "notes.txt"), "secret\n", "utf8");

    const outcome = await startSubagent(h.parentSessionId, h.parentDir, "试试读写", {
      deps: h.deps,
    });
    if (!("id" in outcome)) throw new Error(outcome.error);
    await waitFor(() => getSubagent(h.parentSessionId, outcome.id)?.status !== "running");

    const results = toolResultsOf(path.join(h.parentDir, "subagents", outcome.id));
    expect(results).toHaveLength(2);
    // 父的 deny 被继承（收紧生效）……
    expect(results[0]).toMatchObject({ id: "r1", ok: false, code: "permission_denied" });
    // ……父的 allow 没有被继承（read-only 预设仍然挡住写）。
    expect(results[1]).toMatchObject({ id: "w1", ok: false, code: "permission_denied" });
    expect(existsSync(path.join(h.workdir, "blocked.txt"))).toBe(false);
  });

  it("熔断的终局是 failed 而不是 finished：没查完的调查不能报成结论", async () => {
    // 第 1 轮就调工具：没有工具调用时 `query` 会以 `no_tool_calls` 正常收尾，
    // 根本走不到第 2 轮，这条用例也就测不到熔断那条路径。
    const h = await harness({
      steps: [
        toolReply("", [{ id: "e1", name: "echo", args: { text: "hi" } }], {
          promptTokens: 3,
          completionTokens: 3,
        }),
        reply("", [], { promptTokens: 3, completionTokens: 3 }),
      ],
    });
    const outcome = await startSubagent(h.parentSessionId, h.parentDir, "查一下", {
      deps: h.deps,
      maxTurns: 1,
    });
    if (!("id" in outcome)) throw new Error(outcome.error);
    await waitFor(() => getSubagent(h.parentSessionId, outcome.id)?.status !== "running");

    const summary = getSubagent(h.parentSessionId, outcome.id);
    expect(summary?.status).toBe("failed");
    expect(summary?.error).toContain("max_turns");
  });

  it("子代理的 system 提示词是只读告知，且写进子会话日志的第一条", async () => {
    const h = await harness();
    const outcome = await startSubagent(h.parentSessionId, h.parentDir, "查一下", {
      deps: h.deps,
    });
    if (!("id" in outcome)) throw new Error(outcome.error);
    await waitFor(() => getSubagent(h.parentSessionId, outcome.id)?.status !== "running");

    const { events } = readSessionDir(path.join(h.parentDir, "subagents", outcome.id));
    expect(events[0]?.type).toBe("system");
    const prompt = String(events[0]?.payload.content);
    // 三件事都必须说：它是只读的、怎么组织结论、不要提下一步计划等批准。
    expect(prompt).toContain("只读");
    expect(prompt).toContain("写操作会被权限层拒绝");
    expect(prompt).toContain("先说结论");
    expect(prompt).toContain("不要提出下一步计划等待批准");
  });

  it("killAllSubagents 只发 abort，不伪造「已结束」", async () => {
    const h = await harness({ steps: ["hang"] });
    const outcome = await startSubagent(h.parentSessionId, h.parentDir, "长调查", {
      deps: h.deps,
    });
    if (!("id" in outcome)) throw new Error(outcome.error);
    await waitFor(() => h.model.calls.length > 0);

    killAllSubagents();

    // 作业表被清空：查不到「已结束」，因为此刻它确实还没收尾。
    expect(getSubagent(h.parentSessionId, outcome.id)).toBeUndefined();
    expect(listSubagents(h.parentSessionId)).toEqual([]);
    // 也不推一条完成通知：一个被丢掉的作业不该再往队列里写。
    expect(takeSubagentCompletions(h.parentSessionId)).toEqual([]);
  });

  it("跨会话不可见：用另一个 parentSessionId 查同一个 id 得到 undefined", async () => {
    const h = await harness();
    const outcome = await startSubagent(h.parentSessionId, h.parentDir, "查一下", {
      deps: h.deps,
    });
    if (!("id" in outcome)) throw new Error(outcome.error);
    await waitFor(() => getSubagent(h.parentSessionId, outcome.id)?.status !== "running");

    expect(getSubagent("another-parent", outcome.id)).toBeUndefined();
    expect(listSubagents("another-parent")).toEqual([]);
    expect(takeSubagentCompletions("another-parent")).toEqual([]);
    expect(killSubagent("another-parent", outcome.id)).toBe(false);
  });

  it("子代理读不到父产物：父 artifacts 里的文件在子代理那里是明确错误码", async () => {
    const h = await harness({
      steps: [
        toolReply("", [{ id: "a1", name: "artifact", args: { path: "secret.txt" } }]),
        reply("读不到父会话的产物。"),
      ],
    });
    const parentArtifacts = path.join(h.parentDir, "artifacts");
    await mkdir(parentArtifacts, { recursive: true });
    await writeFile(path.join(parentArtifacts, "secret.txt"), "PARENT-ONLY\n", "utf8");

    const outcome = await startSubagent(h.parentSessionId, h.parentDir, "读 secret", {
      deps: h.deps,
    });
    if (!("id" in outcome)) throw new Error(outcome.error);
    await waitFor(() => getSubagent(h.parentSessionId, outcome.id)?.status !== "running");

    const results = toolResultsOf(path.join(h.parentDir, "subagents", outcome.id));
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: "a1", ok: false });
    // 子代理的 artifact 根是它自己的 `<childDir>/artifacts`，那里根本没有东西。
    // 明确错误码而不是「空文件」：读不到与读到空是两件事（R3）。
    expect(results[0]?.code).toBe("artifact_dir_missing");
    expect(String(results[0]?.text)).not.toContain("PARENT-ONLY");
  });
});

/** 给递归用例凑一份独立 deps（它只被用来构造工具对象，不会被真正调用）。 */
async function freeDeps(): Promise<SubagentDeps> {
  return {
    model: scriptedModel([reply("不会用到")]),
    modelCfg: { contextWindow: 8192, maxOutput: 512 },
    registry: () => new ToolRegistry([]),
    budget: () => ({ over: false, tokens: 0, softLimit: 1 }),
    inheritableRules: [],
    cwd: process.cwd(),
    onSpend: () => undefined,
  };
}

describe("subagent 工具的对外形态", () => {
  it("缺省值与常量对齐：30 轮、10 分钟（与 terminal_bg 同值）", () => {
    // 这两个数字是**产品决定**，不是随手写的：子代理是被分派的一件差事，
    // 与主循环「没有默认轮数上限」的有意偏离，注释在 runner.ts 里。
    expect(DEFAULT_MAX_TURNS).toBe(30);
    expect(DEFAULT_TIMEOUT_MS).toBe(10 * 60 * 1000);
    expect(MAX_RUNNING_SUBAGENTS).toBe(4);
  });

  it("subagent 的 access 是 write，但没有声明 destructive", async () => {
    const [subagentTool, checkTool] = createSubagentTools(await freeDeps());

    expect(subagentTool.name).toBe("subagent");
    expect(subagentTool.access?.({ prompt: "x" })).toBe("write");
    // 声明 destructive 会让它在 diagnose 预设下变成无条件审批——它不破坏任何东西。
    expect(subagentTool.annotations?.destructive).toBeUndefined();
    expect(subagentTool.annotations?.readOnly).toBe(false);

    expect(checkTool.name).toBe("subagent_check");
    // 与 terminal_bg_check 同形：只有 kill 才是写操作。
    expect(checkTool.access?.({ id: "sa_000000000000" })).toBe("read");
    expect(checkTool.access?.({ id: "sa_000000000000", kill: true })).toBe("write");
  });

  it("subagent_check：kill 不带 id 是 invalid_input，未知 id 是 subagent_unknown", async () => {
    const [, checkTool] = createSubagentTools(await freeDeps());
    const ctx = { sessionId: "s-parent", cwd: process.cwd() };

    const missingId = await checkTool.execute(
      { kill: true },
      ctx,
      new AbortController().signal,
    );
    expect(missingId).toMatchObject({ isError: true, code: "invalid_input" });

    const unknown = await checkTool.execute(
      { id: "sa_ffffffffffff" },
      ctx,
      new AbortController().signal,
    );
    expect(unknown).toMatchObject({ isError: true, code: "subagent_unknown" });
  });

  it("subagent_check 列本会话的子代理；别的会话看不到", async () => {
    const h = await harness({ steps: ["hang"] });
    const [, checkTool] = createSubagentTools(h.deps);
    const outcome = await startSubagent(h.parentSessionId, h.parentDir, "调查 X", {
      deps: h.deps,
      label: "x 调查",
    });
    if (!("id" in outcome)) throw new Error(outcome.error);
    await waitFor(() => h.model.calls.length > 0);

    const own = await checkTool.execute(
      {},
      { sessionId: h.parentSessionId, cwd: h.workdir },
      new AbortController().signal,
    );
    expect(own.isError).toBe(false);
    expect(own.text).toContain(outcome.id);
    expect(own.text).toContain("x 调查");

    const other = await checkTool.execute(
      {},
      { sessionId: "another-parent", cwd: h.workdir },
      new AbortController().signal,
    );
    expect(other.isError).toBe(false);
    expect(other.text).toBe("没有子代理");

    await killAndWait(h.parentSessionId, outcome.id);
  });

  it("subagent 工具的完整往返：启动 → detail 里带 id/sessionDir/running → check 取到结论", async () => {
    const h = await harness({
      steps: [reply("结论：主频 72 MHz。", [], { promptTokens: 10, completionTokens: 4 })],
    });
    const [subagentTool, checkTool] = createSubagentTools(h.deps);
    const ctx = {
      sessionId: h.parentSessionId,
      cwd: h.workdir,
      artifactDir: path.join(h.parentDir, "artifacts"),
    };

    const started = await subagentTool.execute(
      { prompt: "确认主频", label: "主频调查" },
      ctx,
      new AbortController().signal,
    );
    expect(started.isError).toBe(false);
    const detail = started.detail as { id: string; sessionDir: string; status: string };
    expect(detail.status).toBe("running");
    expect(detail.id).toMatch(/^sa_[0-9a-f]{12}$/);
    expect(detail.sessionDir).toBe(path.join(h.parentDir, "subagents", detail.id));
    // 正文要说清楚下一步怎么做，而不是只回一个 id。
    expect(started.text).toContain(detail.id);
    expect(started.text).toContain("subagent_check");

    await waitFor(() => getSubagent(h.parentSessionId, detail.id)?.status !== "running");

    const checked = await checkTool.execute(
      { id: detail.id },
      ctx,
      new AbortController().signal,
    );
    expect(checked.isError).toBe(false);
    expect(checked.text).toContain("finished");
    expect(checked.text).toContain("72 MHz");
    expect(checked.text).toContain("主频调查");
    expect(checked.detail).toMatchObject({
      id: detail.id,
      status: "finished",
      turns: 1,
      promptTokens: 10,
      completionTokens: 4,
    });
  });

  it("subagent 工具把并发上限转成 failure(subagent_limit)", async () => {
    const h = await harness({ steps: ["hang"] });
    const [subagentTool] = createSubagentTools(h.deps);
    const ctx = {
      sessionId: h.parentSessionId,
      cwd: h.workdir,
      artifactDir: path.join(h.parentDir, "artifacts"),
    };
    const signal = new AbortController().signal;
    const ids: string[] = [];
    for (let index = 0; index < MAX_RUNNING_SUBAGENTS; index += 1) {
      const started = await subagentTool.execute({ prompt: `调查 ${index}` }, ctx, signal);
      expect(started.isError).toBe(false);
      ids.push((started.detail as { id: string }).id);
    }

    const fifth = await subagentTool.execute({ prompt: "第五个" }, ctx, signal);

    expect(fifth).toMatchObject({ isError: true, code: "subagent_limit" });
    expect(fifth.text).toContain("max 4");
    for (const id of ids) await killAndWait(h.parentSessionId, id);
  });

  it("subagent_check 的 kill 路径：先说「已请求终止」，再说终局", async () => {
    const h = await harness({ steps: ["hang"] });
    const [, checkTool] = createSubagentTools(h.deps);
    const ctx = {
      sessionId: h.parentSessionId,
      cwd: h.workdir,
      artifactDir: path.join(h.parentDir, "artifacts"),
    };
    const signal = new AbortController().signal;
    const started = await startSubagent(h.parentSessionId, h.parentDir, "长调查", {
      deps: h.deps,
    });
    if (!("id" in started)) throw new Error(started.error);
    await waitFor(() => h.model.calls.length > 0);

    const requested = await checkTool.execute({ id: started.id, kill: true }, ctx, signal);
    expect(requested.isError).toBe(false);
    // 终止是异步的：此刻只能说「已请求终止」，不能说「已结束」。
    expect(requested.text).toContain("termination requested");
    expect(requested.detail).toMatchObject({ killRequested: true, status: "running" });

    await waitFor(() => getSubagent(h.parentSessionId, started.id)?.status !== "running");

    // 已经结束的再 kill 一次：如实报告终局，不伪造一次新的终止。
    const after = await checkTool.execute({ id: started.id, kill: true }, ctx, signal);
    expect(after.isError).toBe(false);
    expect(after.text).toContain("killed");
    expect(after.detail).toMatchObject({ killRequested: false, status: "killed" });
  });

  it("subagent 工具在拿不到会话目录时如实报错，而不是把子会话建到 cwd 里", async () => {
    const [subagentTool] = createSubagentTools(await freeDeps());

    const result = await subagentTool.execute(
      { prompt: "x" },
      { sessionId: "s-parent", cwd: process.cwd() },
      new AbortController().signal,
    );

    expect(result).toMatchObject({ isError: true, code: "subagent_unavailable" });
  });
});
