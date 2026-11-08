import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSession } from "../src/index.js";
import type { RunOptions } from "../src/index.js";
import { createScriptedFetch, main } from "../scripts/nightly-batch.mjs";
import type { CaseFixture } from "../scripts/nightly-batch.mjs";

/**
 * `scripts/nightly-batch.mjs` 的测试（BR-7 夜批管线的离线部分）。
 *
 * **全部离线、不 spawn 子进程、不需要构建产物**：`runSession` 直接从 `src/` 注入，
 * `fetchImpl` 由脚本按夹具的 `script` 合成（本文件可在外面再包一层计数或延时）。
 *
 * 批次墙钟用 `--timeout-ms 1` 触发，**不等真实计时器**；单例超时用夹具的
 * `deadlineMs` + 注入的 10ms 延时，也不等真实的长预算。
 *
 * 契约（夹具格式 / exit code 表 / 判分规则）的唯一出处是
 * `docs/operations/nightly-batch.md`；本文件是它的可执行副本。
 */

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

interface CaseEntry {
  id: string;
  /** 原样写进 `cases/<id>.json`，便于故意漏字段。 */
  fixture: Record<string, unknown>;
  /** 原样写进 `answers/<id>.json`。 */
  answers: Record<string, unknown>;
}

interface BatchSpec {
  name?: string;
  listed: CaseEntry[];
  /** 只写文件、不列进 batch.json（用于验证「没排进批次」不是静默跳过）。 */
  unlisted?: CaseEntry[];
}

async function writeBatch(spec: BatchSpec): Promise<string> {
  const root = await tempDir("nightly-batch-");
  const batchDir = path.join(root, "batch");
  await mkdir(path.join(batchDir, "cases"), { recursive: true });
  await mkdir(path.join(batchDir, "answers"), { recursive: true });
  await writeFile(
    path.join(batchDir, "batch.json"),
    JSON.stringify(
      {
        name: spec.name ?? "test-batch",
        description: "测试批次",
        cases: spec.listed.map((entry) => entry.id),
      },
      null,
      2,
    ),
    "utf8",
  );
  for (const entry of [...spec.listed, ...(spec.unlisted ?? [])]) {
    await writeFile(
      path.join(batchDir, "cases", `${entry.id}.json`),
      JSON.stringify(entry.fixture, null, 2),
      "utf8",
    );
    await writeFile(
      path.join(batchDir, "answers", `${entry.id}.json`),
      JSON.stringify(entry.answers, null, 2),
      "utf8",
    );
  }
  return batchDir;
}

function defaultFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "case-a",
    symptom: "板子串口完全没输出",
    maxTurns: 4,
    deadlineMs: 60_000,
    script: [
      { tool: "echo", args: { text: "probe" } },
      { tool: "ls", args: { path: "." } },
      { done: "根因：USART2 未初始化（RCC 时钟未使能）。" },
    ],
    ...overrides,
  };
}

function defaultAnswers(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    rootCause: "未初始化",
    requiredTools: ["echo", "ls"],
    forbiddenClaims: ["一定是硬件坏了"],
    ...overrides,
  };
}

function caseEntry(
  id: string,
  fixtureOverrides: Record<string, unknown> = {},
  answersOverrides: Record<string, unknown> = {},
): CaseEntry {
  return {
    id,
    fixture: defaultFixture({ id, ...fixtureOverrides }),
    answers: defaultAnswers(answersOverrides),
  };
}

interface RunResult {
  code: number;
  lines: string[];
  errors: string[];
}

interface RunOverrides {
  runSessionImpl?: typeof runSession;
  fetchFactory?: (fixture: CaseFixture, caseId: string) => {
    fetchImpl: typeof fetch;
    stats: { calls: number };
  };
}

/** 默认依赖：真实 `runSession`（从 src 注入）+ 默认脚本化 fetch。 */
async function run(
  batchDir: string,
  extraArgs: string[] = [],
  overrides: RunOverrides = {},
): Promise<RunResult> {
  const lines: string[] = [];
  const errors: string[] = [];
  const code = await main(
    ["--batch", batchDir, ...extraArgs],
    {
      runSession: overrides.runSessionImpl ?? runSession,
      ...(overrides.fetchFactory === undefined
        ? {}
        : { fetchFactory: overrides.fetchFactory }),
      log: (line: string) => lines.push(line),
      errorLog: (line: string) => errors.push(line),
    },
  );
  return { code, lines, errors };
}

async function readJson(file: string): Promise<any> {
  return JSON.parse(await readFile(file, "utf8")) as unknown;
}

describe("nightly-batch · 通过用例", () => {
  it("一条通过的用例：退出码 0，产物写有 passed 与工具序列", async () => {
    const batchDir = await writeBatch({ listed: [caseEntry("case-a")] });

    const result = await run(batchDir);

    expect(result.code).toBe(0);
    const artifact = await readJson(path.join(batchDir, "runs", "case-a", "1.json"));
    expect(artifact.passed).toBe(true);
    expect(artifact.toolSequence).toEqual(["echo", "ls"]);
    expect(artifact.finalText).toContain("USART2 未初始化");
    expect(artifact.modelCalls).toBe(3);
    expect(artifact.finishReason).toBe("no_tool_calls");
  });
});

describe("nightly-batch · 判分失败必须点名原因", () => {
  it("缺工具：退出码 1，原因文本点名缺的工具", async () => {
    const batchDir = await writeBatch({
      listed: [
        caseEntry("case-a", {}, { requiredTools: ["echo", "mcp__probe__mem_read"] }),
      ],
    });

    const result = await run(batchDir);

    expect(result.code).toBe(1);
    const artifact = await readJson(path.join(batchDir, "runs", "case-a", "1.json"));
    expect(artifact.passed).toBe(false);
    const reasons = (artifact.reasons as string[]).join("\n");
    expect(reasons).toContain("mcp__probe__mem_read");
    expect(reasons).toContain("缺工具");
  });

  it("出现 forbiddenClaims：退出码 1，原因文本引用那句话", async () => {
    const batchDir = await writeBatch({
      listed: [
        caseEntry("case-a", {
          script: [
            { tool: "echo", args: { text: "probe" } },
            { tool: "ls", args: { path: "." } },
            { done: "根因：USART2 未初始化。结论：一定是硬件坏了。" },
          ],
        }),
      ],
    });

    const result = await run(batchDir);

    expect(result.code).toBe(1);
    const artifact = await readJson(path.join(batchDir, "runs", "case-a", "1.json"));
    const reasons = (artifact.reasons as string[]).join("\n");
    expect(reasons).toContain("一定是硬件坏了");
    expect(reasons).toContain("禁止说法");
  });

  it("finishReason 是 max_turns：退出码 1（不是通过）", async () => {
    const batchDir = await writeBatch({
      listed: [
        caseEntry("case-a", {
          maxTurns: 1,
          script: [
            { tool: "echo", args: { text: "probe" } },
            { done: "根因：USART2 未初始化。" },
          ],
        }),
      ],
    });

    const result = await run(batchDir);

    expect(result.code).toBe(1);
    const artifact = await readJson(path.join(batchDir, "runs", "case-a", "1.json"));
    expect(artifact.passed).toBe(false);
    expect(artifact.finishReason).toBe("max_turns");
    expect((artifact.reasons as string[]).join("\n")).toContain("max_turns");
  });
});

describe("nightly-batch · 夹具预检", () => {
  it("缺 deadlineMs：退出码 3，且没有发起任何模型调用", async () => {
    const broken = defaultFixture({ id: "case-a" });
    delete broken.deadlineMs;
    const batchDir = await writeBatch({
      listed: [{ id: "case-a", fixture: broken, answers: defaultAnswers() }],
    });

    let runSessionCalls = 0;
    let fetchFactoryCalls = 0;
    const result = await run(
      batchDir,
      [],
      {
        runSessionImpl: ((options: RunOptions) => {
          runSessionCalls += 1;
          return runSession(options);
        }) as typeof runSession,
        fetchFactory: (fixture, caseId) => {
          fetchFactoryCalls += 1;
          return createScriptedFetch(fixture, caseId);
        },
      },
    );

    expect(result.code).toBe(3);
    expect(runSessionCalls).toBe(0);
    expect(fetchFactoryCalls).toBe(0);
    expect(result.errors.join("\n")).toContain("deadlineMs");
    // 预检失败时不写任何产物。
    await expect(readFile(path.join(batchDir, "runs", "case-a", "1.json"), "utf8"))
      .rejects.toThrow();
  });

  it("多条坏夹具：一次列出全部，不是只报第一条", async () => {
    const missingDeadline = defaultFixture({ id: "case-a" });
    delete missingDeadline.deadlineMs;
    const wrongId = defaultFixture({ id: "other-id" });
    const batchDir = await writeBatch({
      listed: [
        { id: "case-a", fixture: missingDeadline, answers: defaultAnswers() },
        { id: "case-b", fixture: wrongId, answers: defaultAnswers() },
        caseEntry("case-c"),
      ],
    });

    let runSessionCalls = 0;
    const result = await run(batchDir, [], {
      runSessionImpl: ((options: RunOptions) => {
        runSessionCalls += 1;
        return runSession(options);
      }) as typeof runSession,
    });

    expect(result.code).toBe(3);
    expect(runSessionCalls).toBe(0);
    const text = result.errors.join("\n");
    expect(text).toContain("case-a");
    expect(text).toContain("case-b");
    expect(text).toContain("id 与文件名不一致");
  });

  it("--dry-run：预检通过后打印计划，不调用模型、不写产物", async () => {
    const batchDir = await writeBatch({ listed: [caseEntry("case-a")] });
    let runSessionCalls = 0;
    let fetchFactoryCalls = 0;

    const result = await run(batchDir, ["--dry-run"], {
      runSessionImpl: ((options: RunOptions) => {
        runSessionCalls += 1;
        return runSession(options);
      }) as typeof runSession,
      fetchFactory: () => {
        fetchFactoryCalls += 1;
        throw new Error("dry-run 不应创建 fetch");
      },
    });

    expect(result.code).toBe(0);
    expect(runSessionCalls).toBe(0);
    expect(fetchFactoryCalls).toBe(0);
    expect(result.lines.join("\n")).toContain("case-a");
    expect(result.lines.join("\n")).toContain("未调用模型、未写产物");
    await expect(readFile(path.join(batchDir, "runs", "case-a", "1.json"), "utf8"))
      .rejects.toThrow();
  });

  it("--dry-run 遇到坏夹具仍然 exit 3", async () => {
    const broken = defaultFixture({ id: "case-a" });
    broken.maxTurns = 0;
    const batchDir = await writeBatch({
      listed: [{ id: "case-a", fixture: broken, answers: defaultAnswers() }],
    });
    const result = await run(batchDir, ["--dry-run"]);
    expect(result.code).toBe(3);
    expect(result.errors.join("\n")).toContain("maxTurns");
  });

  it("--batch 指向不存在的目录：exit 3，不是 2", async () => {
    const root = await tempDir("nightly-missing-");
    const result = await run(path.join(root, "no-such-batch"), ["--dry-run"]);
    expect(result.code).toBe(3);
    expect(result.errors.join("\n")).toContain("夹具目录不存在");
  });

  it("未知参数：exit 2（不静默忽略，否则拼错的 flag 会真跑整批）", async () => {
    const batchDir = await writeBatch({ listed: [caseEntry("case-a")] });
    const result = await run(batchDir, ["--dryrun"]);
    expect(result.code).toBe(2);
    expect(result.errors.join("\n")).toContain("未知参数");
    await expect(readFile(path.join(batchDir, "runs", "case-a", "1.json"), "utf8"))
      .rejects.toThrow();
  });
});

describe("nightly-batch · 幂等", () => {
  it("同一 round 跑两次：第二次退出码 5，第一次的产物字节未变", async () => {
    const batchDir = await writeBatch({ listed: [caseEntry("case-a")] });
    const artifactFile = path.join(batchDir, "runs", "case-a", "1.json");

    const first = await run(batchDir);
    expect(first.code).toBe(0);
    const before = await readFile(artifactFile, "utf8");

    const second = await run(batchDir);
    expect(second.code).toBe(5);
    expect(second.errors.join("\n")).toContain("--round 2");
    expect(second.errors.join("\n")).toContain(artifactFile);
    expect(await readFile(artifactFile, "utf8")).toBe(before);
    // 没有静默跳过：第二次一条用例都没跑（没有「通过」的输出行）。
    expect(second.lines.join("\n")).not.toContain("通过 case-a");
  });

  it("--force：退出码 0，旧产物改名成 .bak 仍在", async () => {
    const batchDir = await writeBatch({ listed: [caseEntry("case-a")] });
    const artifactFile = path.join(batchDir, "runs", "case-a", "1.json");

    expect((await run(batchDir)).code).toBe(0);
    const before = await readFile(artifactFile, "utf8");

    const forced = await run(batchDir, ["--force"]);
    expect(forced.code).toBe(0);
    const backup = await readFile(`${artifactFile}.bak`, "utf8");
    expect(backup).toBe(before);
    expect(JSON.parse(await readFile(artifactFile, "utf8")).passed).toBe(true);
  });

  it("新 round 不受上一轮影响：--round 2 正常跑", async () => {
    const batchDir = await writeBatch({ listed: [caseEntry("case-a")] });
    expect((await run(batchDir)).code).toBe(0);
    expect((await run(batchDir, ["--round", "2"])).code).toBe(0);
    const artifact = await readJson(path.join(batchDir, "runs", "case-a", "2.json"));
    expect(artifact.round).toBe(2);
  });
});

describe("nightly-batch · 批次墙钟", () => {
  it("墙钟很小（1 ms）+ 3 条用例：退出码 4，产物写明未跑几条，未跑的不算通过", async () => {
    const batchDir = await writeBatch({
      listed: [caseEntry("case-a"), caseEntry("case-b"), caseEntry("case-c")],
    });

    // 批次墙钟是**可注入的选项**，不是硬编码的 30 分钟：测试传 1 ms，
    // 第一条还没跑完就到点，后面的全部未跑。
    const result = await run(batchDir, ["--timeout-ms", "1"]);

    expect(result.code).toBe(4);
    expect(result.lines.join("\n")).toMatch(/\d+ 条未跑/);
    const summary = await readJson(path.join(batchDir, "runs", "1.summary.json"));
    expect(summary.total).toBe(3);
    expect(summary.notRun.length).toBeGreaterThan(0);
    expect(summary.notRun.length + summary.passed + summary.failed.length).toBe(3);
    // 被墙钟打断的那条 + 后面的都没跑：一条都不写产物，绝不写「通过」冒充跑过。
    for (const caseId of summary.notRun) {
      await expect(readFile(path.join(batchDir, "runs", caseId, "1.json"), "utf8"))
        .rejects.toThrow();
    }
  });

  it("墙钟到点后不再启动新用例：3 条里只可能跑 1 条", async () => {
    const batchDir = await writeBatch({
      listed: [caseEntry("case-a"), caseEntry("case-b"), caseEntry("case-c")],
    });
    const result = await run(batchDir, ["--timeout-ms", "1"]);
    expect(result.code).toBe(4);
    await expect(readFile(path.join(batchDir, "runs", "case-c", "1.json"), "utf8"))
      .rejects.toThrow();
  });
});

describe("nightly-batch · 单例超时", () => {
  it("finishReason 是 deadline 且无 assistant 文本：退出码 124", async () => {
    const batchDir = await writeBatch({
      listed: [
        caseEntry("case-a", {
          deadlineMs: 1,
          script: [
            { tool: "echo", args: { text: "probe" } },
            { done: "根因：USART2 未初始化。" },
          ],
        }),
      ],
    });

    const result = await run(batchDir, [], {
      fetchFactory: (fixture) => {
        const scripted = createScriptedFetch(fixture, "case-a");
        // 第一次模型调用耗时 20ms，让 1ms 的整跑墙钟在拿到工具调用后跑穿：
        // 内核在「模型调用返回且还有工具要执行」时按 deadline 收尾，此时还没有
        // 任何 assistant 正文，因此没有判分结论。
        const slowFetch = (async (...args: Parameters<typeof fetch>) => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return scripted.fetchImpl(...args);
        }) as typeof fetch;
        return { fetchImpl: slowFetch, stats: scripted.stats };
      },
    });

    expect(result.code).toBe(124);
    const artifact = await readJson(path.join(batchDir, "runs", "case-a", "1.json"));
    expect(artifact.finishReason).toBe("deadline");
    expect(artifact.passed).toBe(false);
    expect((artifact.reasons as string[]).join("\n")).toContain("无判分结论");
  });
});
