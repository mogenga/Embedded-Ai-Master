import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createContext,
  sessionEventToHostEvents,
  sessionEventsToMessages,
  summarizeHookDetail,
} from "../../desktop/renderer/protocol.js";

/**
 * 宿主接线与协议绘制（批次 9 · 9.4 hooks 的 Task 2）。
 *
 * Two halves, each with the tool that can honestly observe it:
 *
 *   - the protocol half is a pure function, so the two status branches and the
 *     tool-row note are asserted directly against real payloads;
 *   - the host half has no importable function (`desktop/host/host.js` starts
 *     the NDJSON loop at module scope), so it is asserted against the source,
 *     the way `subagent-result.test.js` and `replay-scrubber.test.js` assert
 *     wiring. That is honest about what it proves: a static check can show the
 *     option rides the same path as `permissions` and names the kernel's field;
 *     it cannot show a hooks file being read end to end.
 *
 * **Why item 1 of the brief reads differently against the real code (see the
 * report).** The brief asks the host to pass a `hooks` option "the way
 * `permissions` is passed". It cannot, and it does not need to:
 *
 *   - the desktop host never calls `runSession`; it calls
 *     `kernel.createSessionRunner(...)` and then `runner.start(...)`;
 *   - `SessionRunnerOptions` (`src/server/runner.ts`) has no `hooks` field and
 *     `runOptions` is built property by property, so a `hooks` key on the
 *     host's object would be accepted and dropped. Measured, not assumed: on
 *     the built kernel this probe (a temp `$HARNESS_HOME/hooks.json` plus a
 *     local gateway) ran the hook and got its stdout appended **without** any
 *     host change at all;
 *   - the user-level path already works because `runSession` defaults it to
 *     `<home>/hooks.json` and the runner already passes `home:
 *     opts.harnessHome`.
 *
 * So the tests below assert the wiring **as it exists**: the host passes the
 * one thing the kernel cannot derive (`harnessHome`, which is what makes the
 * default path correct) and adds no second judge of the file. The first case
 * says so explicitly, so a future reviewer cannot read "no `hooks` key here"
 * as an oversight.
 *
 * Hooks themselves do not run in this file: no process is spawned, no gateway
 * is contacted, and every payload below is a literal copied from the shape
 * `src/hooks/types.ts` / `src/tools/pipeline.ts` produce.
 */
const ROOT = path.join(import.meta.dirname, "..", "..");
const readHost = () => readFileSync(path.join(ROOT, "desktop", "host", "host.js"), "utf8");
const readProtocol = () =>
  readFileSync(path.join(ROOT, "desktop", "renderer", "protocol.js"), "utf8");
const readSource = (relative) => readFileSync(path.join(ROOT, relative), "utf8");

/** The block that starts at `header` and ends at the first `}` at its indent. */
function bodyOf(text, header) {
  const start = text.indexOf(header);
  expect(start, `${header} not found`).toBeGreaterThan(-1);
  const lineStart = text.lastIndexOf("\n", start) + 1;
  const indent = text.slice(lineStart, start);
  expect(indent.trim(), `${header} must start its line`).toBe("");
  let cursor = text.indexOf("\n", start);
  while (cursor !== -1) {
    const next = text.indexOf("\n", cursor + 1);
    const line = text.slice(cursor + 1, next === -1 ? text.length : next);
    if (line.startsWith(`${indent}}`)) return text.slice(start, next === -1 ? text.length : next);
    cursor = next;
  }
  throw new Error(`unterminated ${header}`);
}

function ev(seq, type, payload) {
  return { seq, ts: "2026-11-09T00:00:00.000Z", type, payload };
}

function translate(payload, type = "status") {
  const ctx = createContext({ sessionId: "s1" });
  return sessionEventToHostEvents(ev(0, type, payload), ctx);
}

/**
 * A `HookOutcome` as `src/hooks/run.ts` builds it.
 *
 * Written out field by field rather than abbreviated: the protocol layer reads
 * `event`, `command`, `blocked` and `failure` off these entries, and a fixture
 * carrying only the field a given case happens to use would let the others rot
 * unnoticed.
 */
function outcome(overrides = {}) {
  return {
    event: "preToolUse",
    command: "node",
    source: "user",
    index: 0,
    exitCode: 0,
    blocked: false,
    stdout: "",
    stderr: "",
    durationMs: 12,
    ...overrides,
  };
}

function toolResult(detail, overrides = {}) {
  return {
    id: "c1",
    ok: true,
    text: "file body",
    toolName: "read",
    code: "ok",
    ...(detail === undefined ? {} : { detail }),
    ...overrides,
  };
}

describe("宿主透传：用户级 hooks 不需要宿主再传一份", () => {
  it("宿主把 harnessHome 交给 runner，内核据此默认读 $HARNESS_HOME/hooks.json", () => {
    // This is the whole wiring on the host side, and it is one line because
    // the kernel already owns the path default. `runSession` resolves
    // `home ?? resolveHarnessHome()` and `loadHookConfig` defaults
    // `userConfigPath` to `<home>/hooks.json`; the runner hands `home:
    // opts.harnessHome` down. Nothing else has to travel.
    const host = readHost();
    const body = bodyOf(host, "function createRunner()");
    const call = body.slice(body.indexOf("kernel.createSessionRunner({"));
    expect(call, "createRunner must build through kernel.createSessionRunner").toContain(
      "createSessionRunner({",
    );
    expect(call).toContain("harnessHome,");
  });

  it("宿主不自己读、也不自己判 hooks 配置（判定归 src/hooks/config.ts）", () => {
    // A host-side parse would be a second judge of one file, and the two would
    // eventually disagree — the visible symptom being "the file looks fine and
    // nothing runs". The host has no hook file reader and no hook schema name.
    const host = readHost();
    expect(host).not.toContain("parseHookConfig");
    expect(host).not.toContain("loadHookConfig");
    expect(host).not.toContain("hooks.json");
    // Verified by mutation (2026-11-09): the three lines above are what catch a
    // host that starts reading the file — `hooks.json` is the first to fire.
    //
    // The second half of this check used to be `not.toContain("hooks:")` inside
    // `createRunner()`, guarding against a runner option that would be accepted
    // and silently dropped (`SessionRunnerOptions` is closed, and the runner
    // assembles `runOptions` property by property). That assertion pinned a
    // *word*, not a behaviour: the day someone adds real pass-through for
    // project-level hooks in the desktop host, the correct change would turn it
    // red. The dead-wire risk it described is still covered, and covered
    // better, because a `hooks` key genuinely cannot reach `runSession` today —
    // `grep -c hooks src/server/runner.ts` is 0, and the kernel reads the file
    // from `harnessHome` on its own.
    expect(bodyOf(host, "function createRunner()")).toContain("harnessHome,");
  });

  it("内核侧的默认路径与 status 生产者确实存在（宿主依赖它们）", () => {
    // The host's one-line wiring is only correct because these three facts
    // hold. Pinning them here means a future change to the kernel's default
    // path breaks a test instead of quietly disabling every hook.
    const config = readSource("src/hooks/config.ts");
    expect(config).toContain('path.join(opts.home, "hooks.json")');
    const index = readSource("src/index.ts");
    expect(index).toContain("hooks_project_config_skipped");
    expect(index).toContain("hooks_config_failed");
    // The runner must pass `home` down, or `resolveHarnessHome()` inside
    // `runSession` would be a different directory than the host's.
    expect(readSource("src/server/runner.ts")).toContain("home: opts.harnessHome,");
  });
});

describe("两种 hooks 状态各有分支", () => {
  const protocol = readProtocol();

  it("protocol.js 的 case \"status\" 里有两个字符串常量", () => {
    // Both names come from `src/index.ts` (`session.append({ type: "status" })`).
    // A typo here is not a crash — it is a silent fall-through to no branch,
    // i.e. the operator never learns their hooks file is broken.
    const start = protocol.indexOf('case "status": {');
    expect(start).toBeGreaterThan(-1);
    const end = protocol.indexOf('case "interrupted"', start);
    expect(end).toBeGreaterThan(start);
    const block = protocol.slice(start, end);
    expect(block).toContain('status === "hooks_config_failed"');
    expect(block).toContain('status === "hooks_project_config_skipped"');
  });

  it("hooks_config_failed 画一条 warn，并带上内核说的文件名与条目", () => {
    const message =
      "钩子配置无效: E:/home/hooks.json（hooks[0]: 未知字段 \"macher\"）";
    const out = translate({ status: "hooks_config_failed", message });

    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("notice");
    expect(out[0].level).toBe("warn");
    // The whole point of the message is which file and which entry: a notice
    // that says only "配置坏了" sends the reader hunting between the user and
    // the project file.
    expect(String(out[0].text)).toContain("E:/home/hooks.json");
    expect(String(out[0].text)).toContain("hooks[0]");
    // It must not read as "the turn failed" — hooks are hardening, the run
    // continues (Task 1's decision, asserted there against `done`).
    expect(out.some((item) => item.type === "run_end")).toBe(false);
  });

  it("hooks_project_config_skipped 画一条 warn，说的是未信任而不是坏了", () => {
    const out = translate({
      status: "hooks_project_config_skipped",
      message: "E:/work/.harness/hooks.json",
    });

    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("notice");
    expect(out[0].level).toBe("warn");
    expect(String(out[0].text)).toContain("E:/work/.harness/hooks.json");
    // The two statuses need different next steps, so they must not share a
    // sentence: "读取失败" would send someone to look for a syntax error in a
    // file that is valid and merely untrusted.
    expect(String(out[0].text)).toContain("未信任");
  });

  it("两条 status 都不是「未识别的事件类型」", () => {
    for (const status of ["hooks_config_failed", "hooks_project_config_skipped"]) {
      const out = translate({ status, message: "x" });
      expect(out).toHaveLength(1);
      expect(String(out[0].text)).not.toContain("未识别的事件类型");
    }
  });

  it("不认识的 hooks_* status 不画东西，也不冒充成功", () => {
    // A future status the renderer does not know must stay silent rather than
    // produce a reassuring notice. `status` is a known event type, so this
    // produces nothing at all — no warning, no run_end.
    expect(translate({ status: "hooks_something_else", message: "x" })).toStrictEqual([]);
  });
});

describe("钩子拦截可见", () => {
  it("blocked 的钩子让工具行带一行附加说明", () => {
    const out = translate(toolResult({ hooks: [outcome({ blocked: true, exitCode: 2 })] }), "tool_result");

    const end = out.find((item) => item.type === "tool_end");
    expect(end).toBeDefined();
    expect(typeof end.hookNote).toBe("string");
    expect(end.hookNote).toContain("被钩子拦截");
    // The command is what the reader needs to find the entry that refused.
    expect(end.hookNote).toContain("node");
  });

  it("preToolUse 失败（fail-closed）说明这次调用根本没执行", () => {
    const note = summarizeHookDetail({
      hooks: [outcome({ failure: "hook #0 (user) node: exited with code 1", exitCode: 1 })],
    });
    expect(note).toContain("钩子未跑成");
    expect(note).toContain("调用未执行");
    // The kernel's own sentence travels: it names the entry and the reason.
    expect(note).toContain("hook #0 (user)");
    expect(note).toContain("exited with code 1");
  });

  it("postToolUse 失败只说钩子没跑成，不说调用没执行", () => {
    // A post hook failing leaves the tool's own result intact (`isError` /
    // `code` keep the tool's values, asserted in tests/hooks.test.ts). Saying
    // "调用未执行" here would contradict the row's own success mark.
    const note = summarizeHookDetail({
      hooks: [outcome({ event: "postToolUse", failure: "hook #1 (project) node: timed out after 5000ms" })],
    });
    expect(note).toContain("钩子未跑成");
    expect(note).not.toContain("调用未执行");
  });

  it("多条钩子同时说话时只详述第一条，并说明还有几条", () => {
    const note = summarizeHookDetail({
      hooks: [
        outcome({ blocked: true, exitCode: 2, command: "first-hook" }),
        outcome({ blocked: true, exitCode: 2, command: "second-hook" }),
      ],
    });
    expect(note).toContain("first-hook");
    expect(note).toContain("另有 1 条");
    // One line, not a list: this is a row annotation, and dumping every
    // objection into it would bury the row it annotates.
    expect(note).not.toContain("second-hook");
  });

  it("钩子跑过但没说话时不加说明（不是每条配了钩子的行都长一行）", () => {
    expect(summarizeHookDetail({ hooks: [outcome()] })).toBeUndefined();
    expect(summarizeHookDetail({ hooks: [] })).toBeUndefined();
  });

  it("说明在重开会话后仍在（回放路径读同一个字段）", () => {
    // A blocked call that loses its reason when the conversation is reopened
    // reads as an ordinary failure; the two views of one log must agree.
    const messages = sessionEventsToMessages([
      ev(0, "assistant", {
        content: "",
        toolCalls: [{ id: "c1", name: "shell", arguments: { command: "rm -rf build" } }],
      }),
      ev(1, "tool_result", toolResult({ hooks: [outcome({ blocked: true, exitCode: 2 })] }, {
        ok: false,
        toolName: "shell",
      })),
    ]);
    const row = messages.find((message) => message.role === "tool");
    expect(row.hookNote).toContain("被钩子拦截");
    expect(row.ok).toBe(false);
  });

  it("说明被截断到一行能放下的长度", () => {
    const note = summarizeHookDetail({
      hooks: [outcome({ failure: `hook #0 (user) node: ${"x".repeat(500)}` })],
    });
    expect(note.length).toBeLessThanOrEqual(201);
    expect(note).toContain("…");
  });
});

describe("没钩子时输出逐字段不变", () => {
  it("没有 detail 的 tool_result 与现在完全相同", () => {
    // The regression this guards is "the new field is added unconditionally",
    // which would put a `hookNote` (or an empty one) on every row of every
    // session, including logs written before hooks existed.
    const out = translate(toolResult(undefined), "tool_result");
    expect(out).toStrictEqual([
      { type: "tool_start", name: "read", summary: "read", id: "c1" },
      { type: "tool_end", name: "read", ok: true, summary: "read", id: "c1" },
      { type: "tool_output", name: "read", content: "file body", id: "c1" },
    ]);
    expect(out.find((item) => item.type === "tool_end")).not.toHaveProperty("hookNote");
  });

  it("detail 是别的形状（已有 detail、没有 hooks 键）时也不变", () => {
    const out = translate(
      toolResult({ mayStillBeRunning: true, abortEscalated: true }),
      "tool_result",
    );
    const end = out.find((item) => item.type === "tool_end");
    expect(end).toStrictEqual({ type: "tool_end", name: "read", ok: true, summary: "read", id: "c1" });
    expect(end).not.toHaveProperty("hookNote");
  });

  it("detail.hooks 为空数组时不变", () => {
    expect(summarizeHookDetail({ hooks: [] })).toBeUndefined();
    const out = translate(toolResult({ hooks: [] }), "tool_result");
    expect(out.find((item) => item.type === "tool_end")).not.toHaveProperty("hookNote");
  });

  it("detail 不是普通对象（垃圾值）时不抛，也不加字段", () => {
    for (const detail of [null, "hooks", 42, [], { hooks: "nope" }, { hooks: [null, 1, "x"] }]) {
      expect(summarizeHookDetail(detail)).toBeUndefined();
    }
    const out = translate(toolResult(null), "tool_result");
    expect(out.find((item) => item.type === "tool_end")).not.toHaveProperty("hookNote");
  });

  it("回放里没有 detail 的行不带 hookNote", () => {
    const messages = sessionEventsToMessages([
      ev(0, "tool_result", toolResult(undefined)),
    ]);
    // `summary` is empty here because the replayed row derives it from the
    // assistant event that spawned the call, and this fixture has none — the
    // assertion is about the absence of `hookNote`, not about the summary.
    expect(messages[0]).not.toHaveProperty("hookNote");
    expect(messages[0]).toStrictEqual({
      role: "tool",
      name: "read",
      summary: "",
      ok: true,
      done: true,
    });
  });
});

describe("配置契约与宿主读的是同一份路径", () => {
  it("文档契约存在且指向实现文件", () => {
    const doc = readSource("docs/operations/hooks.md");
    expect(doc).toContain("src/hooks/config.ts");
    expect(doc).toContain("src/hooks/run.ts");
    expect(doc).toContain("src/tools/pipeline.ts");
    // Every exit code the implementation distinguishes is in the contract.
    for (const code of ["preToolUse", "postToolUse", "hook_blocked", "hook_failed"]) {
      expect(doc).toContain(code);
    }
  });
});

/**
 * End-to-end through the real host process, gated on a built kernel.
 *
 * The static checks above say the host hands the kernel a `harnessHome` and
 * that the kernel defaults the path; they cannot say a hook actually runs
 * between the two, because the host has no importable seam for that. This
 * group runs the host exactly as the Electron main process does — NDJSON over
 * stdio — against a temp `$HARNESS_HOME`, a local gateway, and hook scripts
 * written into the same temp dir. Nothing touches the network beyond
 * 127.0.0.1, and the only command executed is `node <temp script>`.
 *
 * Skipped when `dist/` predates the hooks module (a fresh clone): a green here
 * against a build with no `dist/hooks/` would be a green that never ran the
 * thing it names.
 */
const DIST_BUILT = existsSync(path.join(ROOT, "dist", "index.js"));
const HOOKS_BUILT = existsSync(path.join(ROOT, "dist", "hooks", "run.js"));
const HOST = path.join(ROOT, "desktop", "host", "host.js");
const HOST_TIMEOUT_MS = 30_000;

const tempDirs = [];
const servers = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise((resolve) => server.close(resolve)).catch(() => undefined);
  }
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

/**
 * A local gateway that answers one tool call, then a final answer.
 *
 * Two turns are the minimum that produces a `tool_result` at all: the kernel
 * has to see the tool result before it can finish. Both frames are SSE because
 * that is the shape the adapter asks for first.
 */
async function twoTurnGateway() {
  let turn = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url?.includes("/models")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "flash" }] }));
        return;
      }
      turn += 1;
      const frame = (payload) => `data: ${JSON.stringify(payload)}\n\n`;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (turn === 1) {
        res.write(
          frame({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "c1",
                      type: "function",
                      function: { name: "echo", arguments: JSON.stringify({ text: "hi" }) },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          }),
        );
        res.write(frame({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }));
      } else {
        res.write(frame({ choices: [{ delta: { content: "done" }, finish_reason: null }] }));
        res.write(frame({ choices: [{ delta: {}, finish_reason: "stop" }] }));
      }
      res.write(frame({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 3 } }));
      res.end("data: [DONE]\n\n");
    });
  });
  servers.push(server);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return `http://127.0.0.1:${port}/v1`;
}

/** A temp `$HARNESS_HOME` + workdir with a providers file pointing at a gateway. */
async function tempHome() {
  const root = await mkdtemp(path.join(tmpdir(), "eam-hooks-"));
  tempDirs.push(root);
  const home = path.join(root, "home");
  const work = path.join(root, "work");
  await mkdir(home, { recursive: true });
  await mkdir(work, { recursive: true });
  await writeFile(
    path.join(home, "providers.json"),
    JSON.stringify({
      gw: {
        protocol: "openai-chat-completions",
        baseUrl: await twoTurnGateway(),
        models: { flash: { contextWindow: 8192, maxOutput: 512 } },
      },
    }),
    "utf8",
  );
  return { root, home, work };
}

/** Write a hook script into the temp dir and return its path. */
async function writeHook(root, name, lines) {
  const file = path.join(root, name);
  await writeFile(file, lines.join("\n"), "utf8");
  return file;
}

/**
 * Run the host as a child process and feed it NDJSON.
 *
 * Same surface the Electron main process drives, so the assertion is about the
 * shipped path rather than a re-implementation of it.
 */
function runHost(home, work, commands, until = (events) =>
  events.some((event) => event.type === "run_end")) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOST], {
      cwd: work,
      env: {
        ...process.env,
        HARNESS_HOME: home,
        // A test process must never read the machine's real `~/.agents/skills`.
        AGENTS_HOME: path.join(home, ".agents-fixture"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const events = [];
    let buffer = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`host timed out; events: ${events.map((e) => e.type).join(",")}`));
    }, HOST_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim() === "") continue;
        try {
          events.push(JSON.parse(line));
        } catch {
          events.push({ type: "unparsed", line });
        }
      }
      if (until(events)) child.stdin.write(`${JSON.stringify({ cmd: "shutdown" })}\n`);
    });
    child.stderr.on("data", (chunk) => events.push({ type: "stderr", text: chunk.toString("utf8") }));
    child.on("error", reject);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve(events);
    });
    // The handshake has to settle before a prompt: `init` builds the runner.
    child.stdin.write(`${JSON.stringify(commands[0])}\n`);
    setTimeout(() => {
      for (const command of commands.slice(1)) {
        child.stdin.write(`${JSON.stringify(command)}\n`);
      }
    }, 900);
  });
}

describe.skipIf(!DIST_BUILT || !HOOKS_BUILT)("宿主端到端：用户级钩子真的会被执行", () => {
  it("postToolUse 的 stdout 进工具正文（不传任何 hooks 选项）", async () => {
    // This is the measurement the brief's item 1 assumed needed host wiring.
    // It does not: `runSession` defaults the user path to `<home>/hooks.json`
    // and the runner already passes `home`. If that ever stops being true this
    // case goes red, which is the point — the doc and the host both now depend
    // on it.
    const { root, home, work } = await tempHome();
    const script = await writeHook(root, "note.mjs", [
      'process.stdout.write("from hook", () => process.exit(0));',
    ]);
    await writeFile(
      path.join(home, "hooks.json"),
      JSON.stringify({
        version: 1,
        hooks: [{ event: "postToolUse", command: process.execPath, args: [script] }],
      }),
      "utf8",
    );

    const events = await runHost(home, work, [
      { cmd: "init", cwd: work, locale: "zh" },
      { cmd: "prompt", text: "say hi" },
    ]);

    const output = events.find((event) => event.type === "tool_output");
    expect(output, "the tool must have produced output").toBeDefined();
    expect(output.content).toContain("--- hook: ");
    expect(output.content).toContain("from hook");
    // And nothing about hooks should have been drawn on the row: this hook
    // ran fine, and the note is for the two outcomes a reader must not miss.
    expect(events.find((event) => event.type === "tool_end")?.hookNote).toBeUndefined();
  });

  it("preToolUse exit 2 让工具行带一行说明，且工具没有执行", async () => {
    const { root, home, work } = await tempHome();
    const script = await writeHook(root, "deny.mjs", [
      "let raw = '';",
      "process.stdin.setEncoding('utf8');",
      "for await (const chunk of process.stdin) raw += chunk;",
      "process.stderr.write('blocked by test policy');",
      "process.exit(2);",
    ]);
    await writeFile(
      path.join(home, "hooks.json"),
      JSON.stringify({
        version: 1,
        hooks: [
          { event: "preToolUse", matcher: "echo", command: process.execPath, args: [script] },
        ],
      }),
      "utf8",
    );

    const events = await runHost(home, work, [
      { cmd: "init", cwd: work, locale: "zh" },
      { cmd: "prompt", text: "say hi" },
    ]);

    const end = events.find((event) => event.type === "tool_end");
    expect(end).toBeDefined();
    expect(end.ok).toBe(false);
    expect(end.hookNote).toContain("被钩子拦截");
    // The tool never ran, so there is no output row to draw.
    expect(events.find((event) => event.type === "tool_output")).toBeUndefined();
  });

  it("坏掉的 hooks.json 只画一条 warn，这一轮照样跑完", async () => {
    const { home, work } = await tempHome();
    await writeFile(path.join(home, "hooks.json"), "{ not json", "utf8");

    const events = await runHost(home, work, [
      { cmd: "init", cwd: work, locale: "zh" },
      { cmd: "prompt", text: "say hi" },
    ]);

    const notices = events.filter((event) => event.type === "notice").map((event) => event.text);
    expect(notices.some((text) => text.includes("钩子配置读取失败"))).toBe(true);
    // The file name is the actionable half: two candidate files, one broken.
    expect(notices.some((text) => text.includes("hooks.json"))).toBe(true);
    // Hooks are hardening, not a precondition — the turn still finished.
    expect(events.some((event) => event.type === "run_end")).toBe(true);
  });

  it("项目级 hooks.json 不会被加载，并说清是未信任", async () => {
    const { root, home, work } = await tempHome();
    const script = await writeHook(root, "project.mjs", [
      'process.stdout.write("should not run", () => process.exit(0));',
    ]);
    await mkdir(path.join(work, ".harness"), { recursive: true });
    await writeFile(
      path.join(work, ".harness", "hooks.json"),
      JSON.stringify({
        version: 1,
        hooks: [{ event: "postToolUse", command: process.execPath, args: [script] }],
      }),
      "utf8",
    );

    const events = await runHost(home, work, [
      { cmd: "init", cwd: work, locale: "zh" },
      { cmd: "prompt", text: "say hi" },
    ]);

    expect(events.find((event) => event.type === "tool_output")?.content ?? "").not.toContain(
      "should not run",
    );
    const notices = events.filter((event) => event.type === "notice").map((event) => event.text);
    expect(notices.some((text) => text.includes("项目钩子配置未加载"))).toBe(true);
    expect(notices.some((text) => text.includes("未信任"))).toBe(true);
  });
});
