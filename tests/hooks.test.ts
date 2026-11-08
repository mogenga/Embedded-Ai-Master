import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { HookConfigError, loadHookConfig, parseHookConfig } from "../src/hooks/config.js";
import { createHookRunner } from "../src/hooks/run.js";
import type { HookDef, HookOutcome } from "../src/hooks/types.js";
import { runSession } from "../src/index.js";
import type { RunOptions } from "../src/index.js";
import type { LoopEvent } from "../src/loop/events.js";
import type {
  PermissionCheckInput,
  PermissionGate,
  PermissionRequest,
} from "../src/permissions/types.js";
import { readSessionFile } from "../src/session/session.js";
import type { SessionHandle } from "../src/session/session.js";
import { echoTool } from "../src/tools/echo.js";
import { executeBatch } from "../src/tools/pipeline.js";
import type { BatchCall, BatchOptions, PermissionOptions } from "../src/tools/pipeline.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { ToolAnnotations, ToolDef, ToolResult } from "../src/tools/types.js";

/**
 * 钩子测试。
 *
 * 每个用例都把脚本**写成文件**再 `node <path>` 执行——不用 `node -e` 拼多行文本
 * （那在 Windows 的引号/换行规则下极易翻车，而且事故记录里 `node -e` 已经出过
 * 一次问题）。脚本一律无害、限定在临时目录内：写文件、写 stdout、按指定码退出。
 */

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "hooks-test-"));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await removeTempDir(tmp);
});

/**
 * 删临时目录，对 Windows 上的瞬时占用重试。
 *
 * 超时/中止用例里 `signalProcessTree` 是**异步**发出的（D-229：`taskkill /T /F`
 * 的启动成本固定在 1 s 左右，同步等它就是让事件循环停摆）。于是「用例已经拿到
 * hook_failed」与「钩子进程真的消失」之间有一段窗口，其间它以这个目录为 cwd，
 * `rm` 撞上 EBUSY/EPERM。重试是在等那 1 s，不是在放宽任何断言。
 *
 * **重试用尽也不抛**：`afterEach` 抛错会把**下一条**用例一并判红（D-229 里
 * `background-terminal` 踩过同一个坑：一条真实失败被放大成一片）。清不掉临时
 * 目录不属于被测行为，留给系统临时目录就是。上限 8 次 × 150 ms 略高于 1 s 的
 * 回收窗口；并行全量下 `taskkill` 会排队（实测最慢十几秒），所以这个上限本来
 * 就不可能覆盖最坏情况——那正是它不该判红的原因。
 */
async function removeTempDir(dir: string): Promise<void> {
  const retriable = new Set(["ENOTEMPTY", "EBUSY", "EPERM"]);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === undefined || !retriable.has(code)) return;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
}

function makeSession(dir: string): SessionHandle {
  return {
    id: "sess-hooks",
    dir,
    header: { id: "sess-hooks", createdAt: "2026-01-01T00:00:00.000Z", status: "open" },
    append: async (event) => ({
      seq: 0,
      ts: "2026-11-08T00:00:00.000Z",
      type: event.type,
      payload: event.payload,
    }),
    events: () => [],
    usageTotals: () => ({ promptTokens: 0, completionTokens: 0, cachedTokens: 0 }),
    close: async () => {},
  };
}

function ok(text: string): ToolResult {
  return { isError: false, code: "ok", message: "", text };
}

function makeTool<I>(
  name: string,
  schema: z.ZodType<I>,
  execute: ToolDef<I>["execute"],
  annotations: ToolAnnotations = {},
): ToolDef<I> {
  return { name, description: "", schema, annotations, execute };
}

function call(id: string, name: string, input: unknown = {}): BatchCall {
  return { id, name, input };
}

function decisionFor(
  input: PermissionCheckInput,
  overrides: Partial<PermissionRequest> = {},
): PermissionRequest {
  return {
    requestId: `req-${input.callId}`,
    callId: input.callId,
    tool: input.tool.name,
    args: input.args,
    access: "write",
    action: "allow",
    effective: "allow",
    reason: "test:allow",
    preset: "diagnose",
    source: "builtin",
    paramsDigest: "digest",
    paramsKeys: [],
    ...overrides,
  };
}

function fakeGate(
  decide: (input: PermissionCheckInput) => PermissionRequest = (input) => decisionFor(input),
): PermissionGate {
  return { check: async (input) => decide(input) };
}

interface OptsOverrides {
  signal?: AbortSignal;
  timeoutMs?: number;
  settleGraceMs?: number;
  hooks?: ReturnType<typeof createHookRunner>;
}

/** 默认显式声明"这批调用不经权限层"（D-116）；要通过 gate 时用 `withPermission`。 */
function optsOf(overrides: OptsOverrides = {}): BatchOptions {
  return {
    signal: overrides.signal ?? new AbortController().signal,
    artifactDir: path.join(tmp, "artifacts"),
    unsafeSkipPermission: true,
    ...(overrides.timeoutMs === undefined ? {} : { timeoutMs: overrides.timeoutMs }),
    ...(overrides.settleGraceMs === undefined ? {} : { settleGraceMs: overrides.settleGraceMs }),
    ...(overrides.hooks === undefined ? {} : { hooks: overrides.hooks }),
  };
}

function withPermission(
  permission: PermissionOptions,
  overrides: OptsOverrides = {},
): BatchOptions {
  const base = optsOf(overrides);
  const { unsafeSkipPermission: _skip, ...rest } = base as BatchOptions & {
    unsafeSkipPermission?: true;
  };
  return { ...rest, permission };
}

async function writeScript(name: string, lines: string[]): Promise<string> {
  const file = path.join(tmp, name);
  await writeFile(file, `${lines.join("\n")}\n`, "utf8");
  return file;
}

const NODE = process.execPath;

/** 一条 `preToolUse` / `postToolUse` 定义；`index` 默认 0。 */
function hookDef(overrides: Partial<HookDef> = {}): HookDef {
  return {
    event: "preToolUse",
    command: NODE,
    source: "user",
    index: 0,
    ...overrides,
  };
}

function hooksOf(...defs: HookDef[]): ReturnType<typeof createHookRunner> {
  return createHookRunner(defs);
}

function hookDetails(result: ToolResult): HookOutcome[] {
  const detail = result.detail as { hooks?: HookOutcome[] } | undefined;
  return detail?.hooks ?? [];
}

/** 追加一行到 `process.argv[2]`，用来观察「哪个钩子跑了」。 */
function appendLineScript(): string[] {
  return [
    'import { appendFileSync } from "node:fs";',
    'appendFileSync(process.argv[2], "line\\n");',
  ];
}

describe("executeBatch 的钩子：preToolUse", () => {
  it("没有钩子时零变化：结果与不传 hooks 逐字段相同", async () => {
    const session = makeSession(tmp);
    const tools = new ToolRegistry([echoTool]);
    const calls = [call("c1", "echo", { text: "hi" })];

    const without = await executeBatch(session, tools, calls, optsOf());
    const withUndefined = await executeBatch(session, tools, calls, optsOf({ hooks: undefined }));

    expect(withUndefined).toStrictEqual(without);
  });

  it("放行（exit 0）→ 工具真的执行了", async () => {
    const session = makeSession(tmp);
    const target = path.join(tmp, "tool-wrote.txt");
    const tool = makeTool("writer", z.object({}), async () => {
      await writeFile(target, "ran", "utf8");
      return ok("done");
    });
    const hooks = hooksOf(
      hookDef({ event: "preToolUse", command: NODE, args: [await writeScript("ok.mjs", ["process.exit(0);"])] }),
    );

    const results = await executeBatch(
      session,
      new ToolRegistry([tool]),
      [call("c1", "writer")],
      optsOf({ hooks }),
    );

    expect(results[0]!.result).toMatchObject({ isError: false, code: "ok", text: "done" });
    expect(existsSync(target)).toBe(true);
    expect(hookDetails(results[0]!.result)).toHaveLength(1);
    expect(hookDetails(results[0]!.result)[0]).toMatchObject({
      event: "preToolUse",
      blocked: false,
      exitCode: 0,
    });
  });

  it("放行时 preToolUse 的 stdout 被忽略（不进正文）", async () => {
    const session = makeSession(tmp);
    const script = await writeScript("chatty.mjs", [
      'process.stdout.write("chatter", () => process.exit(0));',
    ]);
    const hooks = hooksOf(hookDef({ event: "preToolUse", command: NODE, args: [script] }));

    const results = await executeBatch(
      session,
      new ToolRegistry([makeTool("reader", z.object({}), async () => ok("tool body"))]),
      [call("c1", "reader")],
      optsOf({ hooks }),
    );

    expect(results[0]!.result.text).toBe("tool body");
    expect(results[0]!.result.text).not.toContain("chatter");
    // 但它确实跑过、也确实说了话——记录在 detail 里（不进模型上下文的那条通道）。
    expect(hookDetails(results[0]!.result)[0]?.stdout).toBe("chatter");
  });

  it("阻断但 stderr 为空 → 给一句固定说明，而不是空正文", async () => {
    const session = makeSession(tmp);
    const script = await writeScript("silent-deny.mjs", ["process.exit(2);"]);
    const hooks = hooksOf(hookDef({ event: "preToolUse", command: NODE, args: [script] }));

    const results = await executeBatch(
      session,
      new ToolRegistry([makeTool("reader", z.object({}), async () => ok("never"))]),
      [call("c1", "reader")],
      optsOf({ hooks }),
    );

    const result = results[0]!.result;
    expect(result.code).toBe("hook_blocked");
    expect(result.text).toContain("hook blocked this tool call");
    expect(result.text.length).toBeGreaterThan(0);
  });

  it("外层 signal 中止 → 钩子被收掉，工具不执行，结果是 tool_aborted 而非 hook_blocked", async () => {
    const session = makeSession(tmp);
    const marker = path.join(tmp, "hook-finished-late.txt");
    const script = await writeScript("late.mjs", [
      'import { writeFileSync } from "node:fs";',
      "setTimeout(() => {",
      "  writeFileSync(process.argv[2], 'late');",
      "  process.exit(0);",
      "}, 5000);",
    ]);
    const hooks = hooksOf(
      hookDef({ event: "preToolUse", command: NODE, args: [script, marker], timeoutMs: 55_000 }),
    );
    const controller = new AbortController();
    const target = path.join(tmp, "never-abort.txt");
    setTimeout(() => controller.abort(), 250);

    const results = await executeBatch(
      session,
      new ToolRegistry([
        makeTool("writer", z.object({}), async () => {
          await writeFile(target, "ran", "utf8");
          return ok("done");
        }),
      ]),
      [call("c1", "writer")],
      optsOf({ hooks, signal: controller.signal }),
    );

    // 中止优先于钩子的判词：用户取消不是「钩子拦截」。
    expect(results[0]!.result.code).toBe("tool_aborted");
    expect(existsSync(target)).toBe(false);
    // 钩子进程被收掉：它那段「5 s 后写文件」不会再发生。
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(existsSync(marker)).toBe(false);
  });

  it("阻断（exit 2）→ hook_blocked，text 是 stderr，工具不执行", async () => {
    const session = makeSession(tmp);
    const target = path.join(tmp, "never.txt");
    const tool = makeTool("writer", z.object({}), async () => {
      await writeFile(target, "ran", "utf8");
      return ok("done");
    });
    const script = await writeScript("deny.mjs", [
      'process.stderr.write("blocked by policy", () => process.exit(2));',
    ]);
    const hooks = hooksOf(hookDef({ event: "preToolUse", command: NODE, args: [script] }));

    const results = await executeBatch(
      session,
      new ToolRegistry([tool]),
      [call("c1", "writer")],
      optsOf({ hooks }),
    );

    const result = results[0]!.result;
    expect(result.isError).toBe(true);
    expect(result.code).toBe("hook_blocked");
    expect(result.text).toContain("blocked by policy");
    expect(existsSync(target)).toBe(false);
    expect(hookDetails(result)[0]).toMatchObject({ blocked: true, exitCode: 2 });
  });

  it("第一条阻断后其余钩子仍跑完（不短路），且全部结果都进 detail.hooks", async () => {
    const session = makeSession(tmp);
    const log = path.join(tmp, "hooks-ran.log");
    const deny = await writeScript("deny2.mjs", [
      'process.stderr.write("no", () => process.exit(2));',
    ]);
    const observer = await writeScript("observe.mjs", appendLineScript());
    const hooks = hooksOf(
      hookDef({ event: "preToolUse", index: 0, command: NODE, args: [deny] }),
      hookDef({ event: "preToolUse", index: 1, command: NODE, args: [observer, log] }),
    );

    const results = await executeBatch(
      session,
      new ToolRegistry([makeTool("writer", z.object({}), async () => ok("done"))]),
      [call("c1", "writer")],
      optsOf({ hooks }),
    );

    expect(results[0]!.result.code).toBe("hook_blocked");
    expect(await readFile(log, "utf8")).toBe("line\n");
    expect(hookDetails(results[0]!.result)).toHaveLength(2);
    expect(hookDetails(results[0]!.result).map((entry) => entry.blocked)).toEqual([true, false]);
  });

  it("多条钩子都跑：各自追加一行，两行都在", async () => {
    const session = makeSession(tmp);
    const log = path.join(tmp, "both.log");
    const first = await writeScript("first.mjs", appendLineScript());
    const second = await writeScript("second.mjs", appendLineScript());
    const hooks = hooksOf(
      hookDef({ event: "preToolUse", index: 0, command: NODE, args: [first, log] }),
      hookDef({ event: "preToolUse", index: 1, command: NODE, args: [second, log] }),
    );

    const results = await executeBatch(
      session,
      new ToolRegistry([makeTool("reader", z.object({}), async () => ok("done"), { readOnly: true })]),
      [call("c1", "reader")],
      optsOf({ hooks }),
    );

    expect(results[0]!.result.code).toBe("ok");
    expect((await readFile(log, "utf8")).split("\n").filter(Boolean)).toHaveLength(2);
    expect(hookDetails(results[0]!.result)).toHaveLength(2);
  });

  it("钩子失败（exit 1）是 fail-closed → hook_failed，工具不执行", async () => {
    const session = makeSession(tmp);
    const target = path.join(tmp, "never-1.txt");
    const tool = makeTool("writer", z.object({}), async () => {
      await writeFile(target, "ran", "utf8");
      return ok("done");
    });
    const script = await writeScript("fail.mjs", ["process.exit(1);"]);
    const hooks = hooksOf(hookDef({ event: "preToolUse", command: NODE, args: [script] }));

    const results = await executeBatch(
      session,
      new ToolRegistry([tool]),
      [call("c1", "writer")],
      optsOf({ hooks }),
    );

    const result = results[0]!.result;
    expect(result.isError).toBe(true);
    expect(result.code).toBe("hook_failed");
    expect(result.text).toContain("exited with code 1");
    expect(existsSync(target)).toBe(false);
  });

  it("钩子起不来（可执行文件不存在）→ hook_failed，工具不执行", async () => {
    const session = makeSession(tmp);
    const target = path.join(tmp, "never-spawn.txt");
    const tool = makeTool("writer", z.object({}), async () => {
      await writeFile(target, "ran", "utf8");
      return ok("done");
    });
    const hooks = hooksOf(
      hookDef({
        event: "preToolUse",
        command: path.join(tmp, "no-such-binary-xyz"),
      }),
    );

    const results = await executeBatch(
      session,
      new ToolRegistry([tool]),
      [call("c1", "writer")],
      optsOf({ hooks }),
    );

    expect(results[0]!.result).toMatchObject({ isError: true, code: "hook_failed" });
    expect(existsSync(target)).toBe(false);
  });

  it("钩子超时（timeoutMs 200）→ hook_failed，且 2 s 内返回", async () => {
    const session = makeSession(tmp);
    const script = await writeScript("hang.mjs", ["setTimeout(() => {}, 60000);"]);
    const hooks = hooksOf(
      hookDef({ event: "preToolUse", command: NODE, args: [script], timeoutMs: 200 }),
    );
    const target = path.join(tmp, "never-timeout.txt");

    const startedAt = Date.now();
    const results = await executeBatch(
      session,
      new ToolRegistry([
        makeTool("writer", z.object({}), async () => {
          await writeFile(target, "ran", "utf8");
          return ok("done");
        }),
      ]),
      [call("c1", "writer")],
      optsOf({ hooks }),
    );
    const elapsed = Date.now() - startedAt;

    expect(results[0]!.result).toMatchObject({ isError: true, code: "hook_failed" });
    expect(results[0]!.result.text).toContain("timed out");
    expect(elapsed).toBeLessThan(2_000);
    expect(existsSync(target)).toBe(false);
  });

  it("权限拒绝时钩子一次都不跑（脚本的副作用文件不存在）", async () => {
    const session = makeSession(tmp);
    const log = path.join(tmp, "deny-should-not-run.log");
    const script = await writeScript("side-effect.mjs", appendLineScript());
    const hooks = hooksOf(hookDef({ event: "preToolUse", command: NODE, args: [script, log] }));
    const gate = fakeGate((input) =>
      decisionFor(input, { action: "deny", effective: "deny", reason: "rule:deny", source: "user" }),
    );

    const results = await executeBatch(
      session,
      new ToolRegistry([makeTool("writer", z.object({}), async () => ok("never"))]),
      [call("c1", "writer")],
      withPermission({ gate, onDecision: async () => {} }, { hooks }),
    );

    expect(results[0]!.result.code).toBe("permission_denied");
    expect(existsSync(log)).toBe(false);
    expect(results[0]!.result.detail).not.toHaveProperty("hooks");
  });

  it("并发只读分支同样跑钩子（加钩子不等于有并发时失效）", async () => {
    const session = makeSession(tmp);
    const log = path.join(tmp, "concurrent.log");
    const script = await writeScript("concurrent.mjs", appendLineScript());
    const hooks = hooksOf(hookDef({ event: "preToolUse", command: NODE, args: [script, log] }));
    const reader = (name: string): ToolDef<{}> =>
      makeTool(name, z.object({}), async () => ok(name), { readOnly: true });

    const results = await executeBatch(
      session,
      new ToolRegistry([reader("a"), reader("b")]),
      [call("1", "a"), call("2", "b")],
      optsOf({ hooks }),
    );

    expect(results.map((entry) => entry.result.code)).toEqual(["ok", "ok"]);
    expect((await readFile(log, "utf8")).split("\n").filter(Boolean)).toHaveLength(2);
  });

  it("并发只读分支里钩子也能阻断", async () => {
    const session = makeSession(tmp);
    const script = await writeScript("deny-concurrent.mjs", [
      'process.stderr.write("no concurrent", () => process.exit(2));',
    ]);
    const hooks = hooksOf(hookDef({ event: "preToolUse", command: NODE, args: [script] }));

    const results = await executeBatch(
      session,
      new ToolRegistry([
        makeTool("a", z.object({}), async () => ok("never"), { readOnly: true }),
        makeTool("b", z.object({}), async () => ok("never"), { readOnly: true }),
      ]),
      [call("1", "a"), call("2", "b")],
      optsOf({ hooks }),
    );

    expect(results.map((entry) => entry.result.code)).toEqual(["hook_blocked", "hook_blocked"]);
  });
});

describe("executeBatch 的钩子：postToolUse", () => {
  it("stdout 追加在正文之后，不替换原正文", async () => {
    const session = makeSession(tmp);
    const script = await writeScript("note.mjs", [
      'process.stdout.write("hello", () => process.exit(0));',
    ]);
    const hooks = hooksOf(hookDef({ event: "postToolUse", command: NODE, args: [script] }));

    const results = await executeBatch(
      session,
      new ToolRegistry([makeTool("reader", z.object({}), async () => ok("original body"))]),
      [call("c1", "reader")],
      optsOf({ hooks }),
    );

    const text = results[0]!.result.text;
    expect(results[0]!.result.isError).toBe(false);
    expect(text).toContain("original body");
    expect(text).toContain("--- hook: ");
    expect(text).toContain("hello");
    expect(text.indexOf("original body")).toBeLessThan(text.indexOf("--- hook: "));
    expect(text.indexOf("--- hook: ")).toBeLessThan(text.indexOf("hello"));
  });

  it("钩子非 0 退出不改判：工具结果仍是 isError=false，失败只进 detail.hooks", async () => {
    const session = makeSession(tmp);
    const script = await writeScript("post-fail.mjs", ["process.exit(1);"]);
    const hooks = hooksOf(hookDef({ event: "postToolUse", command: NODE, args: [script] }));

    const results = await executeBatch(
      session,
      new ToolRegistry([makeTool("reader", z.object({}), async () => ok("tool said ok"))]),
      [call("c1", "reader")],
      optsOf({ hooks }),
    );

    const result = results[0]!.result;
    expect(result.isError).toBe(false);
    expect(result.code).toBe("ok");
    expect(result.text).toBe("tool said ok");
    expect(hookDetails(result)[0]?.failure).toEqual(expect.stringContaining("exited with code 1"));
  });

  it("evidence 降级：追加了钩子输出后 evidence=false 且逐条标 evidenceDropped", async () => {
    const session = makeSession(tmp);
    const script = await writeScript("evidence-note.mjs", [
      'process.stdout.write("note from hook", () => process.exit(0));',
    ]);
    const hooks = hooksOf(hookDef({ event: "postToolUse", command: NODE, args: [script] }));
    const evidenceTool = makeTool(
      "probe_evidence",
      z.object({}),
      async () => ok("raw tool output"),
      { readOnly: true, evidence: true },
    );

    const results = await executeBatch(
      session,
      new ToolRegistry([evidenceTool]),
      [call("c1", "probe_evidence")],
      optsOf({ hooks }),
    );

    const result = results[0]!.result;
    expect(result.evidence).toBe(false);
    expect(hookDetails(result)[0]).toMatchObject({ evidenceDropped: true });
  });

  it("evidence 降级在串行分支同样生效（两个分支各有一处 evidence 赋值）", async () => {
    const session = makeSession(tmp);
    const script = await writeScript("evidence-serial.mjs", [
      'process.stdout.write("serial note", () => process.exit(0));',
    ]);
    const hooks = hooksOf(hookDef({ event: "postToolUse", command: NODE, args: [script] }));
    // `readOnly: false` 让这一批走串行分支：`executeBatch` 的 evidence 赋值有两处，
    // 只在并发分支验证过的话，串行那一处写错不会被发现。
    const evidenceTool = makeTool(
      "probe_evidence_serial",
      z.object({}),
      async () => ok("raw serial output"),
      { readOnly: false, evidence: true },
    );

    const results = await executeBatch(
      session,
      new ToolRegistry([evidenceTool]),
      [call("c1", "probe_evidence_serial")],
      optsOf({ hooks }),
    );

    const result = results[0]!.result;
    expect(result.evidence).toBe(false);
    expect(result.text).toContain("serial note");
    expect(hookDetails(result)[0]).toMatchObject({ evidenceDropped: true });
  });

  it("追加发生在新旧正文分叉之前：钩子输出计入 artifact 落盘（放在 finalizeResult 之后就会丢）", async () => {
    const session = makeSession(tmp);
    // 工具自己产出约 3.2 万字符，刚好在 8000 token（约 32000 字符）阈值之下；
    // 钩子再追加 8000 字符后越线。若追加发生在 `finalizeResult` 之后，正文里
    // 就不会有 artifact 标记，而落盘的 artifact 里会是**旧**正文——两种都不对。
    const toolBody = "x".repeat(32_000);
    const script = await writeScript("big-note.mjs", [
      'process.stdout.write("h".repeat(8000), () => process.exit(0));',
    ]);
    const hooks = hooksOf(hookDef({ event: "postToolUse", command: NODE, args: [script] }));
    const tools = new ToolRegistry([makeTool("big", z.object({}), async () => ok(toolBody))]);

    // 自证：同一份正文、不挂钩子时**不落盘**。这样下面的 artifactPath 才能归因到
    // 「钩子把正文推过了阈值」，而不是「这个体积本来就会落盘」。
    const noHook = await executeBatch(session, tools, [call("c-big-0", "big")], optsOf());
    expect(noHook[0]!.result.artifactPath).toBeUndefined();

    const results = await executeBatch(session, tools, [call("c-big", "big")], optsOf({ hooks }));

    const result = results[0]!.result;
    expect(result.artifactPath).toBeDefined();
    const artifact = await readFile(result.artifactPath!, "utf8");
    // artifact 里是**追加之后**的正文：包含钩子那一段。
    expect(artifact).toContain("--- hook: ");
    expect(artifact).toContain("hhhh");
    expect(artifact.startsWith(toolBody)).toBe(true);
    // 日志里的正文是 artifact 的截断版，两者同源。
    expect(result.text).toContain("--- hook: ");
    // 落盘路径（finalizeResult 的 artifact 分支）不能把 detail.hooks 吃掉：
    // 那是唯一记录「这条结果被哪个钩子改过」的通道。
    expect(hookDetails(result)).toHaveLength(1);
  }, 30_000);

  it("没有钩子输出时不降级 evidence（没跑与跑了没说话是两回事）", async () => {
    const session = makeSession(tmp);
    const hooks = hooksOf(
      hookDef({ event: "postToolUse", matcher: "someone_else", command: NODE }),
    );
    const evidenceTool = makeTool(
      "probe_evidence",
      z.object({}),
      async () => ok("raw tool output"),
      { readOnly: true, evidence: true },
    );

    const results = await executeBatch(
      session,
      new ToolRegistry([evidenceTool]),
      [call("c1", "probe_evidence")],
      optsOf({ hooks }),
    );

    expect(results[0]!.result.evidence).toBe(true);
    expect(results[0]!.result.detail).toBeUndefined();
  });
});

describe("钩子的输入契约", () => {
  it("stdin 是这次调用的 JSON（pre：tool/callId/sessionId/cwd/input）", async () => {
    const session = makeSession(tmp);
    const capture = path.join(tmp, "stdin-pre.json");
    const script = await writeScript("capture.mjs", [
      'import { writeFileSync } from "node:fs";',
      "const chunks = [];",
      'process.stdin.on("data", (chunk) => chunks.push(chunk));',
      'process.stdin.on("end", () => {',
      "  writeFileSync(process.argv[2], Buffer.concat(chunks));",
      "});",
    ]);
    const hooks = hooksOf(hookDef({ event: "preToolUse", command: NODE, args: [script, capture] }));

    await executeBatch(
      session,
      new ToolRegistry([makeTool("reader", z.object({ q: z.string() }), async () => ok("done"))]),
      [call("call-7", "reader", { q: "find" })],
      optsOf({ hooks }),
    );

    const parsed = JSON.parse(await readFile(capture, "utf8")) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      tool: "reader",
      callId: "call-7",
      sessionId: "sess-hooks",
      cwd: tmp,
      input: { q: "find" },
    });
    expect(parsed).not.toHaveProperty("result");
  });

  it("stdin 的 post 版本还带 result", async () => {
    const session = makeSession(tmp);
    const capture = path.join(tmp, "stdin-post.json");
    const script = await writeScript("capture-post.mjs", [
      'import { writeFileSync } from "node:fs";',
      "const chunks = [];",
      'process.stdin.on("data", (chunk) => chunks.push(chunk));',
      'process.stdin.on("end", () => {',
      "  writeFileSync(process.argv[2], Buffer.concat(chunks));",
      "});",
    ]);
    const hooks = hooksOf(hookDef({ event: "postToolUse", command: NODE, args: [script, capture] }));

    await executeBatch(
      session,
      new ToolRegistry([makeTool("reader", z.object({}), async () => ok("tool text"))]),
      [call("call-9", "reader")],
      optsOf({ hooks }),
    );

    const parsed = JSON.parse(await readFile(capture, "utf8")) as Record<string, unknown>;
    expect(parsed.result).toEqual({
      isError: false,
      code: "ok",
      message: "",
      text: "tool text",
    });
  });

  it("payload 无法序列化（循环引用）→ 这条钩子记 failure，且脚本一次都没跑", async () => {
    const log = path.join(tmp, "never-serialized.log");
    const script = await writeScript("serialize.mjs", appendLineScript());
    const runner = hooksOf(hookDef({ event: "preToolUse", command: NODE, args: [script, log] }));
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    const outcomes = await runner.run(
      "preToolUse",
      "reader",
      { callId: "c1", sessionId: "s", cwd: tmp, input: circular },
      new AbortController().signal,
    );

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.failure).toContain("not serializable");
    expect(existsSync(log)).toBe(false);
  });

  it("env 是最小集：不继承测试进程里注入的哨兵变量", async () => {
    const session = makeSession(tmp);
    vi.stubEnv("HOOK_SENTINEL_SECRET", "s3cr3t-value");
    const capture = path.join(tmp, "env.json");
    const script = await writeScript("env.mjs", [
      'import { writeFileSync } from "node:fs";',
      'writeFileSync(process.argv[2], JSON.stringify(process.env));',
    ]);
    const hooks = hooksOf(hookDef({ event: "preToolUse", command: NODE, args: [script, capture] }));

    await executeBatch(
      session,
      new ToolRegistry([makeTool("reader", z.object({}), async () => ok("done"))]),
      [call("c1", "reader")],
      optsOf({ hooks }),
    );

    const env = JSON.parse(await readFile(capture, "utf8")) as Record<string, string>;
    expect(Object.hasOwn(env, "HOOK_SENTINEL_SECRET")).toBe(false);
    expect(env.HOOK_SENTINEL_SECRET).toBeUndefined();
    // 反向断言：env 不是空的（否则「不含哨兵」可以靠给空 env 蒙过去）。
    expect(typeof env.PATH).toBe("string");
  });
});

describe("钩子 matcher", () => {
  it("`mcp__keil__*` 匹配 mcp__keil__x，不匹配 shell", async () => {
    const log = path.join(tmp, "matcher.log");
    const script = await writeScript("matcher.mjs", appendLineScript());
    const runner = hooksOf(
      hookDef({ event: "preToolUse", matcher: "mcp__keil__*", command: NODE, args: [script, log] }),
    );
    const signal = new AbortController().signal;
    const payload = { callId: "c1", sessionId: "s", cwd: tmp, input: {} };

    const matched = await runner.run("preToolUse", "mcp__keil__x", payload, signal);
    expect(matched).toHaveLength(1);
    expect((await readFile(log, "utf8")).split("\n").filter(Boolean)).toHaveLength(1);

    const unmatched = await runner.run("preToolUse", "shell", payload, signal);
    expect(unmatched).toHaveLength(0);
    // 不匹配 = 一次都没 spawn：日志行数不变。
    expect((await readFile(log, "utf8")).split("\n").filter(Boolean)).toHaveLength(1);
  });

  it("缺省 matcher 匹配全部工具", async () => {
    const script = await writeScript("all.mjs", ["process.exit(0);"]);
    const runner = hooksOf(hookDef({ event: "preToolUse", command: NODE, args: [script] }));
    const signal = new AbortController().signal;
    const payload = { callId: "c1", sessionId: "s", cwd: tmp, input: {} };

    expect(await runner.run("preToolUse", "shell", payload, signal)).toHaveLength(1);
    expect(await runner.run("preToolUse", "mcp__probe__mem_read", payload, signal)).toHaveLength(1);
  });
});

describe("hooks.json 配置校验", () => {
  // describe 体在 beforeEach 之前执行，那时 `tmp` 还是 undefined——所以这里是
  // 函数而不是常量。
  function configFile(): string {
    return path.join(tmp, "hooks.json");
  }

  function hookDocument(hooks: unknown[]): string {
    return JSON.stringify({ version: 1, hooks });
  }

  function errorOf(text: string, filePath = configFile()): HookConfigError {
    try {
      parseHookConfig(text, filePath);
    } catch (error) {
      expect(error).toBeInstanceOf(HookConfigError);
      return error as HookConfigError;
    }
    throw new Error("expected parseHookConfig to throw");
  }

  it("接受一份合法配置，并按文件内序号编号", () => {
    const parsed = parseHookConfig(
      hookDocument([
        { event: "preToolUse", matcher: "shell", command: "node", args: ["a.mjs"], timeoutMs: 5000 },
        { event: "postToolUse", command: "node" },
      ]),
      configFile(),
    );

    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({
      event: "preToolUse",
      matcher: "shell",
      command: "node",
      args: ["a.mjs"],
      timeoutMs: 5000,
    });
    expect(parsed[1]).toEqual({ event: "postToolUse", command: "node" });
  });

  it("未知字段直接报错（拼错的 matcher 不能让安全钩子静默失效）", () => {
    const error = errorOf(
      hookDocument([{ event: "preToolUse", command: "node", macher: "shell" }]),
    );

    expect(error.code).toBe("invalid_schema");
    expect(error.message).toContain(configFile());
    expect(error.message).toContain("hooks[0]");
    expect(error.message).toContain("macher");
  });

  it("非法 event 报错，消息含文件与序号", () => {
    const error = errorOf(
      hookDocument([
        { event: "preToolUse", command: "node" },
        { event: "beforeToolUse", command: "node" },
      ]),
    );

    expect(error.code).toBe("invalid_schema");
    expect(error.message).toContain(configFile());
    expect(error.message).toContain("hooks[1]");
  });

  it("超范围 timeoutMs 报错（0 / 60001）", () => {
    for (const timeoutMs of [0, 60_001]) {
      const error = errorOf(
        hookDocument([{ event: "preToolUse", command: "node", timeoutMs }]),
      );
      expect(error.code).toBe("invalid_schema");
      expect(error.message).toContain("hooks[0]");
      expect(error.message).toContain("timeoutMs");
    }
  });

  it("version 不是 1 / JSON 坏掉 / 文件顶层不是对象 各自报错", () => {
    expect(errorOf(JSON.stringify({ version: 2, hooks: [] })).code).toBe("unsupported_version");
    expect(errorOf("{not json").code).toBe("invalid_json");
    expect(errorOf(JSON.stringify([1, 2, 3])).code).toBe("unsupported_version");
  });

  it("command 为空 / args 含非字符串 报错", () => {
    expect(errorOf(hookDocument([{ event: "preToolUse", command: "  " }])).code).toBe(
      "invalid_schema",
    );
    expect(
      errorOf(hookDocument([{ event: "preToolUse", command: "node", args: ["ok", 7] }])).code,
    ).toBe("invalid_schema");
  });
});

describe("loadHookConfig 的信任门", () => {
  async function writeConfig(filePath: string, hooks: unknown[]): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify({ version: 1, hooks }), "utf8");
  }

  it("未信任时不读项目级配置，但报出被跳过的路径", async () => {
    const home = path.join(tmp, "home");
    const workdir = path.join(tmp, "work");
    await writeConfig(path.join(home, "hooks.json"), [
      { event: "preToolUse", command: "user-cmd" },
    ]);
    await writeConfig(path.join(workdir, ".harness", "hooks.json"), [
      { event: "preToolUse", command: "project-cmd" },
    ]);

    const loaded = loadHookConfig({ home, workdir, includeProject: false });

    expect(loaded.hooks.map((hook) => hook.command)).toEqual(["user-cmd"]);
    expect(loaded.hooks[0]).toMatchObject({ source: "user", index: 0 });
    expect(loaded.projectSkipped).toBe(path.join(workdir, ".harness", "hooks.json"));
  });

  it("信任时读两份，序号各自从 0 起、来源可区分", async () => {
    const home = path.join(tmp, "home");
    const workdir = path.join(tmp, "work");
    await writeConfig(path.join(home, "hooks.json"), [
      { event: "preToolUse", command: "user-a" },
      { event: "preToolUse", command: "user-b" },
    ]);
    await writeConfig(path.join(workdir, ".harness", "hooks.json"), [
      { event: "postToolUse", command: "project-a" },
    ]);

    const loaded = loadHookConfig({ home, workdir, includeProject: true });

    expect(loaded.hooks.map((hook) => [hook.command, hook.source, hook.index])).toEqual([
      ["user-a", "user", 0],
      ["user-b", "user", 1],
      ["project-a", "project", 0],
    ]);
    expect(loaded.projectSkipped).toBeUndefined();
  });

  it("两份文件都不存在 → 空清单，不是错误", () => {
    const loaded = loadHookConfig({
      home: path.join(tmp, "empty-home"),
      workdir: path.join(tmp, "empty-work"),
      includeProject: true,
    });

    expect(loaded.hooks).toEqual([]);
    expect(loaded.projectSkipped).toBeUndefined();
  });
});

describe("runSession 的钩子装配", () => {
  const PROVIDERS = {
    gw: {
      protocol: "openai-chat-completions",
      baseUrl: "http://127.0.0.1:9/v1",
      models: { flash: { contextWindow: 8192, maxOutput: 512 } },
    },
  };

  const EMPTY_RESPONSE = {
    choices: [{ message: { content: "done" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 20, completion_tokens: 3 },
  };

  function echoCall(id: string, text: string): unknown {
    return {
      choices: [
        {
          message: {
            content: "",
            tool_calls: [
              {
                id,
                type: "function",
                function: { name: "echo", arguments: JSON.stringify({ text }) },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    };
  }

  function mockFetch(bodies: unknown[]): typeof fetch {
    let index = 0;
    return vi.fn(async () => {
      const payload = bodies[Math.min(index, bodies.length - 1)];
      index += 1;
      return {
        ok: true,
        status: 200,
        json: async () => payload,
        text: async () => JSON.stringify(payload),
      };
    }) as unknown as typeof fetch;
  }

  async function collect(generator: AsyncGenerator<LoopEvent>): Promise<LoopEvent[]> {
    const events: LoopEvent[] = [];
    for await (const event of generator) events.push(event);
    return events;
  }

  async function runIn(
    home: string,
    workdir: string,
    bodies: unknown[],
    extra: Partial<RunOptions> = {},
  ): Promise<LoopEvent[]> {
    return collect(
      runSession({
        input: "hi",
        model: "gw/flash",
        providersText: JSON.stringify(PROVIDERS),
        cwd: workdir,
        sessionDir: path.join(home, "session"),
        home,
        fetchImpl: mockFetch(bodies),
        ...extra,
      }),
    );
  }

  function toolResults(
    events: LoopEvent[],
  ): Array<Extract<LoopEvent, { kind: "tool_result" }>> {
    return events.filter(
      (event): event is Extract<LoopEvent, { kind: "tool_result" }> =>
        event.kind === "tool_result",
    );
  }

  function statusPayloads(home: string): Record<string, unknown>[] {
    return readSessionFile(path.join(home, "session", "session.v1.jsonl"))
      .filter((event) => event.type === "status")
      .map((event) => event.payload);
  }

  it("用户级 hooks.json 生效：hook 的 stdout 落进工具正文", async () => {
    const home = path.join(tmp, "home");
    await mkdir(home, { recursive: true });
    const script = await writeScript("run-session-note.mjs", [
      'process.stdout.write("from hook", () => process.exit(0));',
    ]);
    await writeFile(
      path.join(home, "hooks.json"),
      JSON.stringify({
        version: 1,
        hooks: [{ event: "postToolUse", command: NODE, args: [script] }],
      }),
      "utf8",
    );

    const events = await runIn(home, tmp, [echoCall("c1", "hi"), EMPTY_RESPONSE]);

    const result = toolResults(events)[0];
    expect(result?.ok).toBe(true);
    expect(result?.text).toContain("--- hook: ");
    expect(result?.text).toContain("from hook");
  });

  it("没有 hooks.json 时行为不变：正文里没有 hook 段，也没有新 status", async () => {
    const home = path.join(tmp, "home-empty");
    await mkdir(home, { recursive: true });

    const events = await runIn(home, tmp, [echoCall("c1", "hi"), EMPTY_RESPONSE]);

    expect(toolResults(events)[0]?.text).toBe("hi");
    expect(toolResults(events)[0]?.detail).toBeUndefined();
    const statuses = statusPayloads(home).map((payload) => payload.status);
    expect(statuses).not.toContain("hooks_config_failed");
    expect(statuses).not.toContain("hooks_project_config_skipped");
  });

  it("项目级 hooks.json 未信任 → 不生效，并写一条 hooks_project_config_skipped", async () => {
    const home = path.join(tmp, "home-skip");
    const workdir = path.join(tmp, "work-skip");
    await mkdir(home, { recursive: true });
    await mkdir(path.join(workdir, ".harness"), { recursive: true });
    const script = await writeScript("project-note.mjs", [
      'process.stdout.write("should not run", () => process.exit(0));',
    ]);
    await writeFile(
      path.join(workdir, ".harness", "hooks.json"),
      JSON.stringify({
        version: 1,
        hooks: [{ event: "postToolUse", command: NODE, args: [script] }],
      }),
      "utf8",
    );

    const events = await runIn(home, workdir, [echoCall("c1", "hi"), EMPTY_RESPONSE]);

    expect(toolResults(events)[0]?.text).toBe("hi");
    expect(toolResults(events)[0]?.text).not.toContain("should not run");
    expect(statusPayloads(home)).toContainEqual({
      status: "hooks_project_config_skipped",
      message: path.join(workdir, ".harness", "hooks.json"),
    });
  });

  it("信任（trustProjectConfig）后项目级 hooks.json 生效", async () => {
    const home = path.join(tmp, "home-trust");
    const workdir = path.join(tmp, "work-trust");
    await mkdir(home, { recursive: true });
    await mkdir(path.join(workdir, ".harness"), { recursive: true });
    const script = await writeScript("trusted-note.mjs", [
      'process.stdout.write("trusted hook ran", () => process.exit(0));',
    ]);
    await writeFile(
      path.join(workdir, ".harness", "hooks.json"),
      JSON.stringify({
        version: 1,
        hooks: [{ event: "postToolUse", command: NODE, args: [script] }],
      }),
      "utf8",
    );

    const events = await runIn(home, workdir, [echoCall("c1", "hi"), EMPTY_RESPONSE], {
      hooks: { trustProjectConfig: true },
    });

    expect(toolResults(events)[0]?.text).toContain("trusted hook ran");
    expect(
      statusPayloads(home).map((payload) => payload.status),
    ).not.toContain("hooks_project_config_skipped");
  });

  it("hooks.json 坏掉 → 发 hooks_config_failed，但这次运行照常完成", async () => {
    const home = path.join(tmp, "home-broken");
    await mkdir(home, { recursive: true });
    await writeFile(path.join(home, "hooks.json"), "{ not json", "utf8");

    const events = await runIn(home, tmp, [echoCall("c1", "hi"), EMPTY_RESPONSE]);

    // 钩子是加固，不是运行的前提：工具照跑，运行照常结束。
    expect(toolResults(events)[0]?.text).toBe("hi");
    expect(events.some((event) => event.kind === "done")).toBe(true);
    const failed = statusPayloads(home).find(
      (payload) => payload.status === "hooks_config_failed",
    );
    expect(failed).toBeDefined();
    expect(String(failed?.message)).toContain("hooks.json");
  });

  it("hooks 选项类型非法 → 在触碰文件系统前抛 TypeError", async () => {
    const home = path.join(tmp, "home-bad-option");
    await mkdir(home, { recursive: true });

    await expect(
      collect(
        runSession({
          input: "hi",
          model: "gw/flash",
          providersText: JSON.stringify(PROVIDERS),
          cwd: tmp,
          sessionDir: path.join(home, "session"),
          home,
          fetchImpl: mockFetch([EMPTY_RESPONSE]),
          hooks: { trustProjectConfig: "yes" } as unknown as RunOptions["hooks"],
        }),
      ),
    ).rejects.toThrow(/hooks\.trustProjectConfig must be a boolean/);
  });
});
