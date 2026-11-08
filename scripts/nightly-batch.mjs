#!/usr/bin/env node
/**
 * BR-7 夜批管线（**离线部分**）：读一个夹具目录，对每条用例跑一次 `runSession`，
 * 按固定表给退出码，把结果写到不会被重复覆盖的地方。
 *
 * 本轮**不接 Renode、不接真实模型**：夹具的 `script` 描述期望的工具调用序列，
 * `fetchImpl` 由 mock 按序列合成。所以整条管线在没有硬件、没有网络的机器上能跑完。
 *
 * 契约（夹具格式、幂等规则、两层超时、exit code 表、判分规则）的唯一出处是
 * `docs/operations/nightly-batch.md`。改这里的行为要同步改那份文档。
 *
 * **与 `scripts/diagnosis-e2e.mjs` 是两件东西**：那个是硬编码单场景、硬依赖 Renode
 * 的端到端验证；这个是按夹具目录跑的批处理。mock 模型的响应形状是照它抄的。
 *
 * **exit code 表是本脚本自己的**，不复用 `src/demo/run.ts` 的 `resolveExitCode`：
 * 那张表是「单次 demo」的（2 = 任何异常、130 = 用户取消），与本表的
 * 「2 = 环境错误、3 = 夹具错误、5 = 幂等冲突」直接矛盾，合并只会让两边都说不清。
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const DIST_INDEX = path.join(ROOT, "dist", "index.js");
const MODEL = "gw/flash";
const SESSION_LOG_PATTERN = /^session\.v(\d+)\.jsonl$/;
/** 用例 id 直接当路径片段用，必须挡掉分隔符与 `..`。 */
const SAFE_CASE_ID = /^[A-Za-z0-9._-]+$/;

export const DEFAULT_ROUND = 1;
/** 批次总墙钟缺省 30 分钟（单例上限由夹具的 `deadlineMs` 给，基准 25 分钟）。 */
export const DEFAULT_BATCH_TIMEOUT_MS = 30 * 60_000;

/**
 * 退出码表。**唯一契约源是 `docs/operations/nightly-batch.md`**，这里是它的实现。
 *
 * `124` 沿用 GNU `timeout` 的约定：单例超时且没有拿到任何判分结论。
 * 优先级（高 → 低）：2 环境错误 / 3 夹具错误 / 5 幂等冲突 / 4 批次墙钟 /
 * 124 单例超时无结论 / 1 有用例未通过 / 0 全通过。
 */
export const EXIT = Object.freeze({
  pass: 0,
  caseFailed: 1,
  environment: 2,
  fixture: 3,
  batchTimeout: 4,
  conflict: 5,
  timeoutNoVerdict: 124,
});

export const USAGE = [
  "用法: node scripts/nightly-batch.mjs --batch <夹具目录> [选项]",
  "",
  "选项:",
  "  --batch <dir>      批次目录（含 batch.json / cases / answers），必填",
  `  --round <n>        轮次，缺省 ${DEFAULT_ROUND}`,
  "  --force            覆盖本轮已有产物（旧文件改名为 <round>.json.bak）",
  "  --dry-run          只做预检并打印将要跑什么，不调用模型、不写产物",
  `  --timeout-ms <n>   批次总墙钟，缺省 ${DEFAULT_BATCH_TIMEOUT_MS}`,
].join("\n");

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// 夹具 schema（zod 校验：**形状错就是夹具错误，不是运行错误**，见 exit 3）
// ---------------------------------------------------------------------------

/**
 * `script[i]`：要么指定一次工具调用，要么给最终文本并收工。
 *
 * `strictObject` 是关键：拼错的键（`arguments` 写成 `args` 反了、`done:` 拼成
 * `final:`）若是被静默忽略，一条夹具会「跑完且通过」，而它实际什么都没验证。
 */
const ScriptStepSchema = z.union([
  z.strictObject({
    tool: z.string().min(1, "tool 不能为空"),
    args: z.record(z.string(), z.unknown()),
  }),
  z.strictObject({ done: z.string() }),
]);

/**
 * `cases/<id>.json`：给 agent 看的那一半。
 *
 * `maxTurns` 与 `deadlineMs` **必填、无默认值**：隐式上限会静默截断长诊断
 * （D-183 的教训），而一个漏写的 `deadlineMs` 会让这条用例在夜批里无限期占位。
 * 缺任何一个都不是「用默认值兜住」，是夹具写错了。
 */
const CaseFixtureSchema = z.strictObject({
  id: z.string().min(1, "id 不能为空"),
  symptom: z.string().refine((value) => value.trim().length > 0, "symptom 不能为空白"),
  maxTurns: z.int().positive(),
  deadlineMs: z.int().positive(),
  script: z.array(ScriptStepSchema).min(1, "script 至少要有一步"),
  expectToolFailure: z.boolean().optional(),
});

/**
 * `answers/<id>.json`：判分用的另一半，与 `cases/` 分开是为了防泄题。
 *
 * 三个字段都**必填**（与 `docs/operations/nightly-batch.md` 的字段表一致）：漏写
 * `forbiddenClaims` 若被当成「没有禁止说法」，一条本该判失败的用例会静默通过，
 * 而夹具看起来是完整的。
 */
const AnswerSchema = z.strictObject({
  rootCause: z.string().min(1, "rootCause 不能为空"),
  requiredTools: z.array(z.string().min(1)),
  forbiddenClaims: z.array(z.string().min(1)),
});

const BatchFileSchema = z.strictObject({
  name: z.string().min(1, "name 不能为空"),
  description: z.string().optional(),
  cases: z.array(z.string().min(1)),
});

function formatIssues(error) {
  return error.issues
    .map((issue) => {
      const where = issue.path.length === 0 ? "<root>" : issue.path.join(".");
      return `${where}: ${issue.message}`;
    })
    .join("; ");
}

function readJsonFile(file, problems, label) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    problems.push(`${label}: 读取失败（${errorMessage(error)}）`);
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    problems.push(`${label}: JSON 无效（${errorMessage(error)}）`);
    return undefined;
  }
}

/**
 * 读整个批次并校验**全部**用例，不做任何模型调用。
 *
 * 一条坏夹具 → 整批不跑（exit 3），并且**列出全部坏夹具**而不是第一条：
 * 跑到第 7 条才发现第 3 条写错时，前 6 条的产物就得作废，而 `runs/` 里那些
 * 文件看起来和真跑出来的一样。
 *
 * 返回 `{ problems }` 或 `{ batch }`，不抛异常：调用方据此决定 exit code。
 */
export function loadBatch(batchDir) {
  const problems = [];
  if (typeof batchDir !== "string" || batchDir.trim() === "") {
    return { problems: ["--batch 需要一个夹具目录"] };
  }
  if (!existsSync(batchDir)) {
    return { problems: [`夹具目录不存在: ${batchDir}`] };
  }
  const batchFile = path.join(batchDir, "batch.json");
  const rawBatch = readJsonFile(batchFile, problems, "batch.json");
  if (rawBatch === undefined && problems.length > 0) return { problems };

  const parsedBatch = BatchFileSchema.safeParse(rawBatch);
  if (!parsedBatch.success) {
    return { problems: [`batch.json: ${formatIssues(parsedBatch.error)}`] };
  }
  const batch = parsedBatch.data;

  const duplicate = batch.cases.find(
    (id, index) => batch.cases.indexOf(id) !== index,
  );
  if (duplicate !== undefined) {
    return { problems: [`batch.json: 用例 ${duplicate} 重复列出`] };
  }

  const casesDir = path.join(batchDir, "cases");
  const answersDir = path.join(batchDir, "answers");
  const cases = [];
  for (const id of batch.cases) {
    const label = `cases/${id}.json`;
    if (!SAFE_CASE_ID.test(id) || id === "." || id === "..") {
      problems.push(`batch.json: 用例 id ${JSON.stringify(id)} 不是合法的文件名词`);
      continue;
    }
    const rawCase = readJsonFile(path.join(casesDir, `${id}.json`), problems, label);
    if (rawCase === undefined) continue;
    const parsedCase = CaseFixtureSchema.safeParse(rawCase);
    if (!parsedCase.success) {
      problems.push(`${label}: ${formatIssues(parsedCase.error)}`);
      continue;
    }
    if (parsedCase.data.id !== id) {
      problems.push(
        `${label}: id 与文件名不一致（文件 ${id}，内容 ${JSON.stringify(parsedCase.data.id)}）`,
      );
      continue;
    }

    const answerLabel = `answers/${id}.json`;
    const rawAnswer = readJsonFile(path.join(answersDir, `${id}.json`), problems, answerLabel);
    if (rawAnswer === undefined) continue;
    const parsedAnswer = AnswerSchema.safeParse(rawAnswer);
    if (!parsedAnswer.success) {
      problems.push(`${answerLabel}: ${formatIssues(parsedAnswer.error)}`);
      continue;
    }

    cases.push({
      fixture: parsedCase.data,
      answers: parsedAnswer.data,
      caseFile: path.join(casesDir, `${id}.json`),
      answerFile: path.join(answersDir, `${id}.json`),
    });
  }

  if (problems.length > 0) return { problems };
  if (cases.length === 0) {
    return { problems: ["batch.json: cases 为空，没有可跑的用例"] };
  }
  return { batch: { ...batch, cases: cases.map((entry) => entry.fixture.id) }, cases };
}

// ---------------------------------------------------------------------------
// mock 模型：按夹具的 script 顺序返回工具调用 / 最终文本
// ---------------------------------------------------------------------------

function providersText() {
  return JSON.stringify({
    gw: {
      protocol: "openai-chat-completions",
      // 一个不会有人监听的地址：真实的 fetch 不会带到这里（本脚本永远注入 fetchImpl），
      // 但即便注入漏了，请求也落在本地而非某个真实网关。
      baseUrl: "http://127.0.0.1:9/v1",
      models: { flash: { contextWindow: 16384, maxOutput: 1024 } },
      pricePerMillion: { input: 1, output: 1 },
    },
  });
}

function toolCallBody(id, name, args) {
  return {
    choices: [
      {
        message: {
          content: "",
          tool_calls: [
            { id, type: "function", function: { name, arguments: JSON.stringify(args) } },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 2 },
  };
}

function doneBody(text) {
  return {
    choices: [{ message: { content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 20, completion_tokens: 8 },
  };
}

/**
 * 按 `script` 逐条返回的 `fetchImpl`（形状照 `scripts/diagnosis-e2e.mjs` 的 mockFetch）。
 *
 * 请求次数用完后**继续返回最后一条**：`script` 若以 `done` 结尾就一直是那段文本，
 * 若以工具调用结尾就一直重复最后一个工具——后者会让 `maxTurns` 先熔断，
 * 用例判失败，而不是让整条管线挂住。
 *
 * 返回值里的 `stats.calls` 是「模型调用次数」，测试用它证明预检失败时没有发起任何调用。
 *
 * 导出是为了让测试能替换/包一层（例如加延时），并断言计数。
 */
export function createScriptedFetch(fixture, caseId) {
  const steps = fixture.script;
  const stats = { calls: 0 };
  const fetchImpl = async () => {
    const step = steps[Math.min(stats.calls, steps.length - 1)];
    stats.calls += 1;
    const callId = `${caseId}-call-${stats.calls}`;
    const body = step.done !== undefined
      ? doneBody(step.done)
      : toolCallBody(callId, step.tool, step.args);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { fetchImpl, stats };
}

// ---------------------------------------------------------------------------
// 会话日志（评分与「是否拿到结论」的唯一事实源）
// ---------------------------------------------------------------------------

/** 会话目录里全部代次的日志，按代次升序（读不到目录时返回空数组）。 */
function sessionLogsInOrder(sessionDir) {
  if (!existsSync(sessionDir)) return [];
  const found = [];
  for (const name of readdirSync(sessionDir)) {
    const match = SESSION_LOG_PATTERN.exec(name);
    if (match === null) continue;
    const generation = Number(match[1]);
    if (!Number.isSafeInteger(generation) || generation < 1) continue;
    found.push({ generation, name });
  }
  found.sort((left, right) => left.generation - right.generation);
  return found.map((entry) => path.join(sessionDir, entry.name));
}

/**
 * 从会话目录读出工具序列、最终文本、finishReason。
 *
 * 多代日志按代次**升序**拼接：`session.append` 会在日志超过阈值时滚动到下一
 * 代，只看 `session.v1.jsonl` 会让长会话的后半段（往往正是结论）读不到。
 *
 * 日志不存在时返回空结果而不是抛错：那条用例因此拿不到结论，判失败并点名原因
 * （R3：读不到就说读不到，不能当成「没有工具调用」）。
 */
function readSessionOutcome(sessionDir) {
  const toolSequence = [];
  const failedToolSequence = [];
  const assistantTexts = [];
  let finishReason;
  const logPaths = sessionLogsInOrder(sessionDir);
  for (const logPath of logPaths) {
    const text = readFileSync(logPath, "utf8");
    for (const line of text.split(/\r?\n/)) {
      if (line.trim() === "") continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        // 尾部半行（进程被杀/落盘被打断）不改变已写入的事实：跳过，别整体作废。
        continue;
      }
      if (event.type === "tool_result" && typeof event.payload?.toolName === "string") {
        toolSequence.push(event.payload.toolName);
        if (event.payload.ok === false) failedToolSequence.push(event.payload.toolName);
      }
      if (event.type === "assistant" && typeof event.payload?.content === "string") {
        assistantTexts.push(event.payload.content);
      }
      // 收尾事实按日志顺序取**最后一条**：正常收尾写 `status{done, finishReason}`，
      // 熔断/超时/取消写 `interrupted{reason}`。两者都在时以后写的为准。
      if (event.type === "status" && typeof event.payload?.finishReason === "string") {
        finishReason = event.payload.finishReason;
      }
      if (event.type === "interrupted" && typeof event.payload?.reason === "string") {
        finishReason = event.payload.reason;
      }
    }
  }
  return {
    toolSequence,
    failedToolSequence,
    finalText: assistantTexts.length === 0 ? "" : assistantTexts[assistantTexts.length - 1],
    hasAssistantText: assistantTexts.some((value) => value.trim() !== ""),
    finishReason,
    logPaths,
  };
}

// ---------------------------------------------------------------------------
// 判分
// ---------------------------------------------------------------------------

function includesIgnoreCase(haystack, needle) {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/**
 * 对一条用例判分，返回**可判的原因**（不是光一个 false）。
 *
 * 三个判据（`docs/operations/nightly-batch.md` §判分）：
 * 1. `requiredTools` 全部出现在 `tool_result` 的 `toolName` 序列里（顺序不敏感）；
 * 2. 最后的 assistant 文本包含 `rootCause`（子串、大小写不敏感）；
 * 3. 最后的 assistant 文本不含任何 `forbiddenClaims`。
 *
 * 另外两条独立于夹具答案的判据：`finishReason` 必须是 `no_tool_calls`（`max_turns`
 * / `deadline` / `aborted` 都不是「跑完了」），以及工具失败（除非夹具显式
 * `expectToolFailure: true`）。
 */
export function scoreCase(entry, outcome) {
  const reasons = [];
  const { fixture, answers } = entry;

  const missingTools = answers.requiredTools.filter(
    (tool) => !outcome.toolSequence.includes(tool),
  );
  if (missingTools.length > 0) {
    reasons.push(
      `缺工具: ${missingTools.join(", ")}（实际调用 ${outcome.toolSequence.join(", ") || "无"}）`,
    );
  }

  if (fixture.expectToolFailure !== true) {
    const failedTools = outcome.failedToolSequence ?? [];
    if (failedTools.length > 0) {
      reasons.push(`工具失败: ${failedTools.join(", ")}`);
    }
  }

  if (outcome.finalText.trim() === "") {
    reasons.push("没有 assistant 文本可供判分（模型没有收尾）");
  } else {
    if (!includesIgnoreCase(outcome.finalText, answers.rootCause)) {
      reasons.push(`缺根因关键词: ${answers.rootCause}`);
    }
    for (const claim of answers.forbiddenClaims) {
      if (includesIgnoreCase(outcome.finalText, claim)) {
        reasons.push(`出现禁止说法: ${claim}`);
      }
    }
  }

  if (outcome.finishReason !== "no_tool_calls") {
    reasons.push(`finishReason 是 ${outcome.finishReason ?? "缺失"}，不是 no_tool_calls`);
  }

  return { passed: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

function parsePositiveInt(raw, flag) {
  if (!/^\d+$/.test(raw) || Number(raw) <= 0 || !Number.isSafeInteger(Number(raw))) {
    return { error: `${flag} 需要一个正整数，收到 ${JSON.stringify(raw)}` };
  }
  return { value: Number(raw) };
}

/** 只认列出的 flag；未知 flag 直接报错，不静默忽略（拼错的 `--dryrun` 会真跑整批）。 */
export function parseArgs(argv) {
  const parsed = {
    batchDir: undefined,
    round: DEFAULT_ROUND,
    force: false,
    dryRun: false,
    timeoutMs: DEFAULT_BATCH_TIMEOUT_MS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return { kind: "help" };
    if (arg === "--force") {
      parsed.force = true;
      continue;
    }
    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }
    if (arg === "--batch" || arg === "--round" || arg === "--timeout-ms") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        return { kind: "error", message: `${arg} 缺少取值` };
      }
      index += 1;
      if (arg === "--batch") {
        parsed.batchDir = value;
        continue;
      }
      const parsedValue = parsePositiveInt(value, arg);
      if (parsedValue.error !== undefined) return { kind: "error", message: parsedValue.error };
      if (arg === "--round") parsed.round = parsedValue.value;
      else parsed.timeoutMs = parsedValue.value;
      continue;
    }
    return { kind: "error", message: `未知参数: ${arg}` };
  }
  if (parsed.batchDir === undefined) {
    return { kind: "error", message: "缺少 --batch <夹具目录>" };
  }
  return { kind: "run", options: parsed };
}

// ---------------------------------------------------------------------------
// 产物
// ---------------------------------------------------------------------------

function artifactPath(batchDir, caseId, round) {
  return path.join(batchDir, "runs", caseId, `${round}.json`);
}

function summaryPath(batchDir, round) {
  return path.join(batchDir, "runs", `${round}.summary.json`);
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * 写一个用例的产物。`--force` 时旧文件先改名成 `<round>.json.bak`。
 *
 * 只保留最近一次前值（`.bak` 再冲突时覆盖旧的 `.bak`）：夜批要的是「这一轮
 * 是什么、上一轮是什么」，不是无限历史；真正的历史在版本库与日志里。
 */
function writeCaseArtifact(batchDir, caseId, round, artifact, force) {
  const target = artifactPath(batchDir, caseId, round);
  mkdirSync(path.dirname(target), { recursive: true });
  if (existsSync(target)) {
    if (!force) {
      // 正常路径不会到这里：调用前已经做过冲突预检。留着是为了防止两个进程
      // 并发时静默覆盖（宁可报错，不覆盖）。
      throw new Error(`产物已存在: ${target}`);
    }
    const backup = `${target}.bak`;
    rmSync(backup, { force: true });
    renameSync(target, backup);
  }
  writeJson(target, artifact);
}

// ---------------------------------------------------------------------------
// 单例运行
// ---------------------------------------------------------------------------

/**
 * 跑一条用例。**每次都用新的临时 caseDir**（会话目录就在里面）。
 *
 * 复用同一个 caseDir 会让上一次的会话日志渗进这一次的判分：`runSession` 会
 * 在已有日志后接写，读回来时 `toolSequence` 里混着上一轮的工具调用。
 *
 * 单例超时由夹具的 `deadlineMs` 交给内核（`finishReason: "deadline"`），
 * 不在这里另起计时器：内核的墙钟在每次模型调用与每批工具执行前都会检查，
 * 与取消（`aborted`）走不同的收尾路径，界面文案也不同。
 */
async function runOneCase(entry, opts) {
  const fixture = entry.fixture;
  const caseDir = mkdtempSync(path.join(opts.tempRoot, `${fixture.id}-`));
  const { fetchImpl, stats } = opts.fetchFactory(fixture, fixture.id);
  const runOptions = {
    input: fixture.symptom,
    model: MODEL,
    providersText: providersText(),
    sessionId: "nightly",
    sessionDir: caseDir,
    home: caseDir,
    cwd: caseDir,
    fetchImpl,
    mcp: {},
    permissions: { preset: "read-only" },
    maxTurns: fixture.maxTurns,
    deadlineMs: fixture.deadlineMs,
    signal: opts.signal,
  };
  let runError;
  try {
    for await (const _event of opts.runSession(runOptions)) {
      // 事件同时落进会话日志；判分读日志，不读这个循环。
    }
  } catch (error) {
    // 单条用例抛错不终止整批：它只是「这条没跑成」，如实记进这一条的产物。
    // 脚本自身的异常（参数、IO）在 main 的 catch 里才是 exit 2。
    runError = errorMessage(error);
  }
  const outcome = readSessionOutcome(caseDir);
  rmSync(caseDir, { recursive: true, force: true });
  return { outcome, modelCalls: stats.calls, runError };
}

/**
 * 批次墙钟（`--timeout-ms`，缺省 30 分钟）。
 *
 * **两件事都要做到**：到点后不再启动新用例，并把**已经启动**的那条打断
 * （`AbortController`）——只做前者的话，一条卡住的用例会让「整跑超时」形同虚设。
 *
 * 计时器走真实时间，这个时限是**可注入的选项**：测试用 `--timeout-ms 1`
 * 就能在毫秒内看到 exit 4，不需要等 30 分钟，也不需要伪造时钟。
 * 已启动的用例被 `AbortController` 打断，`runOneCase` 因此会正常收尾，
 * 随后由 `expired()` 判断「这条的结果不作数」。
 */
function createBatchClock(timeoutMs) {
  let expired = false;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, timeoutMs);
  // 不阻止进程退出：计时器只是兜底，正常路径结束时会被 stop() 清掉。
  timer.unref?.();
  return {
    expired: () => expired,
    signal: controller.signal,
    stop: () => clearTimeout(timer),
  };
}

// ---------------------------------------------------------------------------
// 批次运行
// ---------------------------------------------------------------------------

/**
 * 幂等冲突预检：目标 `(batch, case, round)` 里**任何一条**产物已存在就停。
 *
 * 提前一次性查完再开跑，而不是跑到某条才发现：跑到一半才发现冲突时，
 * 前面几条的产物已经写出去了，这一轮又还没跑完——`runs/` 里会留下一半新
 * 一半旧的状态，看起来像个完整轮次。
 *
 * 不覆盖、也不静默跳过：静默跳过会让「这一轮没跑」看起来像「这一轮通过」。
 */
function findConflicts(batchDir, caseIds, round) {
  return caseIds
    .map((caseId) => artifactPath(batchDir, caseId, round))
    .filter((file) => existsSync(file));
}

/**
 * 一条用例的产物。`passed` **由 `reasons` 推导**，不由调用方各传一次：
 * 两处各写一个 `passed` 时，改了一处忘了另一处就会出现「passed: true 且带原因」
 * 这种自相矛盾的文件。
 */
function buildArtifact(entry, outcome, extra) {
  const reasons = [...extra.reasons];
  if (extra.runError !== undefined) reasons.push(`运行异常: ${extra.runError}`);
  return {
    id: entry.fixture.id,
    round: extra.round,
    startedAt: extra.startedAt,
    finishedAt: extra.finishedAt,
    passed: reasons.length === 0,
    reasons,
    finishReason: outcome.finishReason ?? null,
    modelCalls: extra.modelCalls,
    toolSequence: outcome.toolSequence,
    finalText: outcome.finalText,
    ...(extra.runError === undefined ? {} : { runError: extra.runError }),
  };
}

function printDryRun(loaded, options, log) {
  log(`dry-run: ${options.batchDir}`);
  log(`  轮次 ${options.round}，${loaded.cases.length} 条用例`);
  for (const entry of loaded.cases) {
    const steps = entry.fixture.script.map((step) =>
      step.done !== undefined ? `done(${JSON.stringify(step.done.slice(0, 40))})` : step.tool,
    );
    log(`  - ${entry.fixture.id}: ${steps.join(" → ")}`);
    log(
      `      maxTurns=${entry.fixture.maxTurns} deadlineMs=${entry.fixture.deadlineMs}`
      + ` 产物=${artifactPath(options.batchDir, entry.fixture.id, options.round)}`,
    );
    log(`      rootCause=${JSON.stringify(entry.answers.rootCause)}`);
  }
  log("dry-run: 预检通过；未调用模型、未写产物");
}

function printConflict(conflicts, round, errorLog) {
  errorLog(`幂等冲突：轮次 ${round} 已有产物，未覆盖`);
  for (const file of conflicts) errorLog(`  已有: ${file}`);
  errorLog(`  换一个轮次：--round ${round + 1}；或确认要覆盖：--force`);
}

/**
 * 跑一整批。返回 exit code，不直接 `process.exitCode`（测试要拿到它）。
 *
 * `loaded` 是 `loadBatch` 的成功结果：预检、`--dry-run`、幂等冲突检查都在
 * `main` 里做完了（那些路径不该因为 `dist/` 缺件而报成环境错误）。
 *
 * 顺序（与 exit 表一一对应）：
 * 1. 依赖检查 → 2（在 `main` 里）
 * 2. 预检全部夹具（**任何模型调用之前**）→ 3（在 `main` 里）
 * 3. `--dry-run`：打印计划、返回 0，不写产物（在 `main` 里）
 * 4. 幂等冲突预检 → 5（在 `main` 里，也在写每一条产物时兜住并发）
 * 5. 逐条运行；到点不再启动新用例、并打断已启动的那条 → 4
 * 6. 汇总判分：有未通过 → 1；单例超时且无文本 → 124；否则 0
 */
export async function runBatch(loaded, options, deps) {
  const { batchDir, round, force } = options;
  const log = deps.log;
  const { cases } = loaded;

  const startedAt = new Date().toISOString();
  const tempRoot = mkdtempSync(path.join(tmpdir(), "nightly-batch-"));
  const clock = createBatchClock(options.timeoutMs);
  const results = [];
  let notRun = [];
  let timedOutWithoutVerdict = false;

  try {
    for (let index = 0; index < cases.length; index += 1) {
      const entry = cases[index];
      const caseId = entry.fixture.id;
      if (clock.expired()) {
        notRun = cases.slice(index).map((rest) => rest.fixture.id);
        log(`批次墙钟到点：${notRun.length} 条未跑（${notRun.join(", ")}）`);
        break;
      }
      const caseStartedAt = new Date().toISOString();
      log(`跑 ${caseId} …`);
      // 逐条再查一次：`main` 里的冲突预检挡的是「开跑前就存在」，这一次挡的是
      // 同一轮里两个进程并发（或上一轮跑到一半被杀、留下了半批产物）。
      // 覆盖永远要 `--force`，不覆盖。
      if (!force && existsSync(artifactPath(batchDir, caseId, round))) {
        printConflict([artifactPath(batchDir, caseId, round)], round, deps.errorLog);
        return EXIT.conflict;
      }
      const run = await runOneCase(entry, {
        tempRoot,
        runSession: deps.runSession,
        fetchFactory: deps.fetchFactory,
        signal: clock.signal,
      });
      const outcome = run.outcome;
      // 批次墙钟在跑这条时到点：这条被 `AbortController` 打断了，它的结果
      // **不是判分结论**。不写产物、不算通过，并把自己和后面的都记为「未跑」。
      //
      // 判据用「signal 已 abort」而不是只看 `expired`：`expired` 是计时器回调设置
      // 的，而 `runOneCase` 可能在回调真正跑起来之前就返回了——那时这条其实
      // 已经跑完了。只有 signal 已经打断过它，这条的结果才不可信。
      if (clock.signal.aborted) {
        notRun = cases.slice(index).map((rest) => rest.fixture.id);
        log(`批次墙钟到点（${caseId} 被中断）：${notRun.length} 条未跑（${notRun.join(", ")}）`);
        break;
      }
      // 单例超时且**没有任何 assistant 文本**时没有判分结论可言：`124`（GNU timeout）。
      // 有文本就照常按三条判据判（可能是 0 也可能是 1），因为那时「跑没跑完」
      // 已经有一个可判的事实了。
      const timedOutNoVerdict =
        outcome.finishReason === "deadline" && !outcome.hasAssistantText;
      if (timedOutNoVerdict) timedOutWithoutVerdict = true;
      const scored = timedOutNoVerdict
        ? {
            passed: false,
            reasons: [
              "单例超时（finishReason=deadline）且没有产出任何 assistant 文本：无判分结论",
            ],
          }
        : scoreCase(entry, outcome);

      const artifact = buildArtifact(entry, outcome, {
        round,
        startedAt: caseStartedAt,
        finishedAt: new Date().toISOString(),
        reasons: scored.reasons,
        modelCalls: run.modelCalls,
        runError: run.runError,
      });
      writeCaseArtifact(batchDir, caseId, round, artifact, force);
      results.push({ id: caseId, passed: artifact.passed, reasons: artifact.reasons });
      log(
        `  ${artifact.passed ? "通过" : "未通过"} ${caseId}`
        + (artifact.passed ? "" : `：${artifact.reasons.join("；")}`),
      );
    }
  } finally {
    clock.stop();
    rmSync(tempRoot, { recursive: true, force: true });
  }

  const passedCount = results.filter((result) => result.passed).length;
  const summary = {
    batch: loaded.batch.name,
    round,
    startedAt,
    finishedAt: new Date().toISOString(),
    total: cases.length,
    passed: passedCount,
    failed: results.filter((result) => !result.passed).map((result) => result.id),
    notRun,
    exitCode: 0,
  };
  let exitCode = EXIT.pass;
  if (notRun.length > 0) exitCode = EXIT.batchTimeout;
  else if (summary.failed.length > 0) exitCode = timedOutWithoutVerdict ? EXIT.timeoutNoVerdict : EXIT.caseFailed;
  summary.exitCode = exitCode;
  writeJson(summaryPath(batchDir, round), summary);

  log(
    `汇总：${passedCount}/${cases.length} 通过`
    + (notRun.length === 0 ? "" : `，${notRun.length} 条未跑`)
    + `；exit ${exitCode}`,
  );
  return exitCode;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

async function loadDefaultRunSession() {
  // 默认走构建产物（与 `scripts/diagnosis-e2e.mjs` 同一口径）：脚本本身不在 tsc
  // 的 include 里，不能直接 import `src/` 的 TS。
  if (!existsSync(DIST_INDEX)) {
    throw new Error(
      `未找到 ${DIST_INDEX}；请先运行 npm run build（测试通过 deps.runSession 注入，不需要构建）`,
    );
  }
  const module = await import(pathToFileURL(DIST_INDEX).href);
  return module.runSession;
}

/**
 * CLI 入口。`deps` 让测试注入 `runSession` / `fetchFactory` / 假时钟与日志。
 *
 * 返回 exit code（不设置 `process.exitCode`）：直接调用处会用它退出，测试拿它断言。
 */
export async function main(argv, deps = {}) {
  const parsed = parseArgs(argv);
  const log = deps.log ?? ((line) => console.log(line));
  const errorLog = deps.errorLog ?? ((line) => console.error(line));
  if (parsed.kind === "help") {
    log(USAGE);
    return EXIT.pass;
  }
  if (parsed.kind === "error") {
    errorLog(parsed.message);
    errorLog(USAGE);
    return EXIT.environment;
  }

  const fetchFactory = deps.fetchFactory ?? ((fixture, caseId) => createScriptedFetch(fixture, caseId));

  // 预检（含 `--dry-run`）在加载构建产物**之前**完成：夹具写错时给出的应该是
  // exit 3（夹具错误），不是 exit 2（环境错误）。先查 `dist/` 会把一个夹具问题
  // 报成「环境没装好」，操作者会去重装依赖而夹具仍然错。
  const preflight = loadBatch(parsed.options.batchDir);
  if (preflight.problems !== undefined) {
    errorLog(`夹具错误：${preflight.problems.length} 处，整批不跑`);
    for (const problem of preflight.problems) errorLog(`  - ${problem}`);
    return EXIT.fixture;
  }
  if (parsed.options.dryRun) {
    printDryRun(preflight, parsed.options, log);
    return EXIT.pass;
  }
  // 冲突检查也放在加载构建产物之前：不跑的一轮不该因为环境缺件而报成环境错误。
  const conflicts = findConflicts(
    parsed.options.batchDir,
    preflight.cases.map((entry) => entry.fixture.id),
    parsed.options.round,
  );
  if (conflicts.length > 0 && !parsed.options.force) {
    printConflict(conflicts, parsed.options.round, errorLog);
    return EXIT.conflict;
  }

  let runSessionImpl = deps.runSession;
  if (runSessionImpl === undefined) {
    try {
      runSessionImpl = await loadDefaultRunSession();
    } catch (error) {
      errorLog(`环境错误：${errorMessage(error)}`);
      return EXIT.environment;
    }
  }

  try {
    return await runBatch(preflight, parsed.options, {
      runSession: runSessionImpl,
      fetchFactory,
      log,
      errorLog,
    });
  } catch (error) {
    // 脚本自身抛异常（IO、schema 之外的意外）→ 2。单条用例的异常在 runOneCase
    // 里已经收进那条的产物，不会走到这里。
    errorLog(`内部错误：${errorMessage(error)}`);
    return EXIT.environment;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
