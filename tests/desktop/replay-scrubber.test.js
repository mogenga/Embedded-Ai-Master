import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sessionEventsToMessages, sessionLoadedEvent } from "../../desktop/renderer/protocol.js";

/**
 * BR-6 验收② 的延伸：按事件下标截断并回放（BACKLOG 9.2）。
 *
 * Three surfaces are covered, each with the tool that can actually observe it:
 *
 *   - `sessionLoadedEvent(events, {atSeq})` is a pure function, so it is tested
 *     directly — including the two shapes the brief calls out (the first event
 *     only, and a cut that lands between a `tool_call` and its `tool_result`);
 *   - the host's `loadSession` handler is not importable, so it is driven
 *     through a real host process against a hand-written log, the same way
 *     `fork-atseq.test.js` drives `forkSession`;
 *   - the scrubber itself has no DOM to run in (no jsdom in this repository),
 *     so its wiring is asserted against the sources: a control with a listener
 *     and a state with a producer, which is the class of bug a scrubber starts
 *     as.
 */
const RENDERER = path.join(import.meta.dirname, "..", "..", "desktop", "renderer");
const read = (name) => readFileSync(path.join(RENDERER, name), "utf8");

const REPO_ROOT = path.join(import.meta.dirname, "..", "..");
const HOST = path.join(REPO_ROOT, "desktop", "host", "host.js");
const DIST_BUILT = existsSync(path.join(REPO_ROOT, "dist", "index.js"));
const HOST_TIMEOUT_MS = 30_000;
const tempDirs = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

function ev(seq, type, payload) {
  return { seq, ts: "2026-11-08T00:00:00.000Z", type, payload };
}

/**
 * A log with a tool call in the middle of it.
 *
 * `seq 1` announces call `c1`, `seq 3` reports its result. Any `atSeq` in
 * `[1, 2]` therefore lands **inside** the call: `tool_use` present, its
 * `tool_result` absent. That is the shape the brief requires not to throw and
 * not to draw half a row.
 */
function sampleLog() {
  return [
    ev(0, "user", { content: "第一问" }),
    ev(1, "assistant", {
      content: "先查供电",
      toolCalls: [{ id: "c1", name: "read", arguments: { path: "a.c" } }],
    }),
    ev(2, "todos", { callId: "c1", items: [{ content: "读 datasheet", status: "pending" }] }),
    ev(3, "tool_result", { id: "c1", toolName: "read", ok: true, text: "寄存器 0x00" }),
    ev(4, "assistant", { content: "第二答", toolCalls: [] }),
  ];
}

describe("sessionLoadedEvent 按事件下标截断", () => {
  it("带 atSeq 时只投影 seq <= atSeq 的消息", () => {
    const full = sessionLoadedEvent(sampleLog());
    expect(full.messages.map((row) => row.role)).toStrictEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);

    const cut = sessionLoadedEvent(sampleLog(), { atSeq: 3 });
    // Up to and including seq 3: the tool result closes the call, so its row
    // is present. The trailing assistant (seq 4) is not.
    expect(cut.messages.map((row) => row.text ?? row.summary)).toStrictEqual([
      "第一问",
      "先查供电",
      "a.c",
    ]);
    expect(cut.messages.map((row) => row.role)).toStrictEqual(["user", "assistant", "tool"]);

    // The event also says how far the log goes, so the scrubber has a maximum
    // that comes from the log rather than from a second read of it.
    expect(cut.lastSeq).toBe(4);
  });

  it("atSeq = 0 只有第一条事件的内容", () => {
    const event = sessionLoadedEvent(sampleLog(), { atSeq: 0 });
    expect(event.messages).toStrictEqual([{ role: "user", text: "第一问", index: 0, images: 0 }]);
    expect(event.lastSeq).toBe(4);
  });

  it("atSeq 等于 lastSeq 时与不截断是同一份投影", () => {
    const log = sampleLog();
    const atEnd = sessionLoadedEvent(log, { atSeq: 4 });
    const whole = sessionLoadedEvent(log);
    expect(atEnd.messages).toStrictEqual(whole.messages);
    expect(atEnd.todos).toStrictEqual(whole.todos);
    expect(atEnd.usage).toStrictEqual(whole.usage);
    // The position is still echoed: "asked for N" is a fact, and dropping it
    // at the head would make the renderer's "replaying" test depend on two
    // fields happening to differ.
    expect(atEnd.atSeq).toBe(4);
    expect(atEnd.lastSeq).toBe(4);
  });

  it("界面状态跟着截断：todos 与 usage 都只看到 atSeq 之前", () => {
    // The plan arrives at seq 2; the priced call at seq 4. A scrubber that
    // truncated the bubbles but kept the whole log's plan would show work the
    // replay has not reached yet.
    const log = [
      ev(0, "user", { content: "第一问" }),
      ev(1, "todos", { callId: "c1", items: [{ content: "旧计划", status: "pending" }] }),
      ev(2, "usage", { promptTokens: 11, completionTokens: 3 }),
      ev(3, "todos", { callId: "c2", items: [{ content: "新计划", status: "in_progress" }] }),
      ev(4, "usage", { promptTokens: 5, completionTokens: 1 }),
    ];
    const early = sessionLoadedEvent(log, { atSeq: 1 });
    expect(early.todos).toStrictEqual([{ content: "旧计划", status: "pending" }]);
    expect(early.usage).toStrictEqual({ inputTokens: 0, outputTokens: 0, cachedTokens: 0 });

    const middle = sessionLoadedEvent(log, { atSeq: 2 });
    expect(middle.todos).toStrictEqual([{ content: "旧计划", status: "pending" }]);
    expect(middle.usage).toStrictEqual({ inputTokens: 11, outputTokens: 3, cachedTokens: 0 });

    // Before the first plan there is none — not the one the unreached future
    // holds.
    expect(sessionLoadedEvent(log, { atSeq: 0 }).todos).toBeNull();
  });

  it("atSeq 越界（负数 / 大于 lastSeq）抛错，错误信息含合法范围", () => {
    // Silent clamping is what the brief forbids: "replay to event 3" must not
    // quietly become "replay to the end".
    expect(() => sessionLoadedEvent(sampleLog(), { atSeq: -1 })).toThrow(/0\.\.4/);
    expect(() => sessionLoadedEvent(sampleLog(), { atSeq: 5 })).toThrow(/0\.\.4/);
    // Same for a non-integer and a non-number: a scrubber sending "3.5" is a
    // bug, not a position.
    expect(() => sessionLoadedEvent(sampleLog(), { atSeq: 1.5 })).toThrow(/0\.\.4/);
    expect(() => sessionLoadedEvent(sampleLog(), { atSeq: "3" })).toThrow(/0\.\.4/);
    expect(() => sessionLoadedEvent(sampleLog(), { atSeq: null })).toThrow(/0\.\.4/);
    // An empty log has no legal position at all.
    expect(() => sessionLoadedEvent([], { atSeq: 0 })).toThrow(/0\.\.-1/);
  });

  it("atSeq 落在工具调用中间：不抛错，那条 tool 行不出现", () => {
    const log = sampleLog();
    for (const atSeq of [1, 2]) {
      let event;
      expect(() => {
        event = sessionLoadedEvent(log, { atSeq });
      }, `atSeq ${atSeq} must not throw`).not.toThrow();
      // Half a call is not a row: no `tool` message, and nothing invented to
      // stand in for the missing result.
      expect(event.messages.some((row) => row.role === "tool")).toBe(false);
      expect(event.messages.map((row) => row.role)).toStrictEqual(["user", "assistant"]);
    }
  });

  it("缺省 atSeq 时行为不变（整份日志）", () => {
    const log = sampleLog();
    expect(sessionLoadedEvent(log).messages).toStrictEqual(sessionEventsToMessages(log));
    expect(sessionLoadedEvent(log)).not.toHaveProperty("atSeq");
  });
});

// ---------------------------------------------------------------------------
// 宿主：loadSession 透传 atSeq
// ---------------------------------------------------------------------------

async function tempHome() {
  const dir = await mkdtemp(path.join(tmpdir(), "eam-replay-"));
  tempDirs.push(dir);
  await writeFile(
    path.join(dir, "providers.json"),
    JSON.stringify({
      gw: {
        protocol: "openai-chat-completions",
        // Never contacted: load is a filesystem operation.
        baseUrl: "http://127.0.0.1:1/v1",
        models: { flash: { contextWindow: 8192, maxOutput: 512 } },
      },
    }),
    "utf8",
  );
  return dir;
}

/**
 * A closed session with five events, written by hand.
 *
 * The same shape `sampleLog()` uses: a tool call at seq 1 whose result lands
 * at seq 3, so `atSeq: 2` is a cut in the middle of a call and `atSeq: 0` is a
 * one-event prefix. Both are legal positions in this log; `atSeq: 9` is not.
 */
async function writeSourceSession(home, id = "replay-session") {
  const dir = path.join(home, "sessions", id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "header.json"),
    JSON.stringify({ id, createdAt: new Date().toISOString(), status: "closed", workdir: home }),
    "utf8",
  );
  const lines = sampleLog().map((event) => JSON.stringify(event));
  await writeFile(path.join(dir, "session.v1.jsonl"), `${lines.join("\n")}\n`, "utf8");
  return dir;
}

function runHost(home, commands, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOST], {
      cwd: path.dirname(HOST),
      env: {
        ...process.env,
        HARNESS_HOME: home,
        AGENTS_HOME: path.join(home, ".agents-fixture"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const events = [];
    let buffer = "";
    let lastCommand;
    const timer = setTimeout(() => {
      child.kill();
      const tail = events.slice(-3).map((event) => JSON.stringify(event).slice(0, 300));
      reject(new Error([
        "host timed out",
        `last command: ${JSON.stringify(lastCommand)}`,
        `last events (${events.length} total): ${tail.join(" | ") || "(none)"}`,
      ].join("\n")));
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
      if (options.until !== undefined && options.until(events)) {
        child.stdin.write(`${JSON.stringify({ cmd: "shutdown" })}\n`);
      }
    });
    child.stderr.on("data", (chunk) => events.push({ type: "stderr", text: chunk.toString("utf8") }));
    child.on("error", reject);
    child.on("exit", () => {
      clearTimeout(timer);
      resolve(events);
    });

    for (const command of commands) {
      lastCommand = command;
      child.stdin.write(`${JSON.stringify(command)}\n`);
    }
  });
}

describe.skipIf(!DIST_BUILT)("宿主 loadSession 透传 atSeq", () => {
  it("带 atSeq 打开会话时只回放该位置之前的转录", async () => {
    const home = await tempHome();
    await writeSourceSession(home);

    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "loadSession", id: "replay-session", atSeq: 3 },
      ],
      { until: (all) => all.some((event) => event.type === "session_loaded") },
    );
    const loaded = events.find((event) => event.type === "session_loaded");
    expect(loaded).toBeDefined();
    // seq 3 closes the call: user, assistant, tool. The trailing assistant
    // (seq 4) belongs to the future the replay has not reached.
    expect(loaded.messages.map((row) => row.role)).toStrictEqual(["user", "assistant", "tool"]);
    expect(loaded.lastSeq).toBe(4);
    // The event says where it was cut, so the renderer can draw "第 4 / 5 条"
    // without re-reading anything.
    expect(loaded.atSeq).toBe(3);
  }, HOST_TIMEOUT_MS);

  it("不带 atSeq 时打开整份日志，事件只说 lastSeq", async () => {
    const home = await tempHome();
    await writeSourceSession(home);

    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "loadSession", id: "replay-session" },
      ],
      { until: (all) => all.some((event) => event.type === "session_loaded") },
    );
    const loaded = events.find((event) => event.type === "session_loaded");
    expect(loaded.messages.map((row) => row.role)).toStrictEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(loaded.lastSeq).toBe(4);
    expect(loaded).not.toHaveProperty("atSeq");
  }, HOST_TIMEOUT_MS);

  it("atSeq 不是非负整数时回 warn notice，且不换会话", async () => {
    const home = await tempHome();
    await writeSourceSession(home);

    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "loadSession", id: "replay-session", atSeq: -1 },
        { cmd: "loadSession", id: "replay-session", atSeq: 1.5 },
      ],
      {
        until: (all) =>
          all.filter((event) => event.type === "notice" && String(event.text).includes("atSeq 必须是非负整数"))
            .length === 2,
      },
    );
    const warnings = events.filter(
      (event) => event.type === "notice" && String(event.text).includes("atSeq 必须是非负整数"),
    );
    expect(warnings).toHaveLength(2);
    expect(warnings.every((event) => event.level === "warn")).toBe(true);
    // "The session did not switch" is the observable half: no transcript was
    // sent for either bad request.
    expect(events.some((event) => event.type === "session_loaded")).toBe(false);
  }, HOST_TIMEOUT_MS);

  it("atSeq 超出日志范围时把协议层的原文带回给用户，且不换会话", async () => {
    const home = await tempHome();
    await writeSourceSession(home);

    const events = await runHost(
      home,
      [
        { cmd: "init", cwd: home },
        { cmd: "loadSession", id: "replay-session", atSeq: 99 },
      ],
      { until: (all) => all.some((event) => event.type === "notice" && String(event.text).includes("会话未打开")) },
    );
    const warning = events
      .filter((event) => event.type === "notice" && String(event.text).includes("会话未打开"))
      .at(-1);
    expect(warning).toBeDefined();
    expect(warning.level).toBe("warn");
    // The bound is the log's own fact (last seq 4), said by the one projector
    // that owns it — not a bound the host derived from a second read.
    expect(warning.text).toContain("0..4");
    expect(events.some((event) => event.type === "session_loaded")).toBe(false);
  }, HOST_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// 回放条（静态断言：仓库没有 jsdom，加一个是未经批准的依赖）
// ---------------------------------------------------------------------------

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

describe("回放条", () => {
  it("转录区顶部有一条回放条，滑块的范围由事件下标给出", () => {
    const html = read("index.html");
    expect(html).toContain('id="replay-bar"');
    expect(html).toContain('type="range"');
    expect(html).toContain('id="replay-range"');
    expect(html).toContain('id="replay-count"');
    expect(html).toContain('id="replay-latest"');
    // It ships hidden and only an opened session reveals it.
    expect(html).toMatch(/id="replay-bar"[^>]*hidden/);

    // `min` and the step are constants, so the markup owns them; `max` is the
    // log's own last seq, which only the host knows.
    const range = html.slice(html.indexOf('id="replay-range"'), html.indexOf("/>", html.indexOf('id="replay-range"')));
    expect(range).toContain('min="0"');
    expect(range).toContain('step="1"');
    const app = read("app.js");
    expect(app).toContain("replayRange.max = String(replay.lastSeq)");
  });

  it("拖动只重投影并重绘，松手才发命令", () => {
    const app = read("app.js");
    const input = bodyOf(app, 'replayRange?.addEventListener("input"');
    // Dragging must not talk to the host: one command per pixel fills the IPC
    // pipe for a transcript that is already in hand.
    expect(input).not.toContain("api.send");
    // It repaints the readout in place — the count and the "back to latest"
    // button — rather than re-projecting anything.
    expect(input).toContain("replayCount.textContent");
    expect(input).toContain("t.replayPosition");
    // The renderer must not be holding the event array it would have to
    // re-project from: two integers are the whole replay state.
    expect(app).not.toContain("state.replay.messages");
    expect(app).not.toContain("state.replay.events");
    // The commit is on release, not on every movement.
    const commit = bodyOf(app, "function commitReplay(atSeq)");
    expect(commit).toContain('api.send({ cmd: "loadSession"');
    expect(commit).toContain("atSeq");
    // `pointerup` is the mouse's release; `change` is the keyboard's. Both go
    // through the same commit function, so there is one send site and the
    // input handler never reaches it.
    const pointer = bodyOf(app, 'replayRange?.addEventListener("pointerup"');
    expect(pointer).toContain("commitReplay(Number(replayRange.value))");
    const change = bodyOf(app, 'replayRange?.addEventListener("change"');
    expect(change).toContain("commitReplay(Number(replayRange.value))");
    // Only two send sites for the whole control (the commit and nothing else):
    // a third would be a second path to the same command.
    expect(app.match(/cmd: "loadSession", id: state\.sessionId, atSeq/g)).toHaveLength(1);
  });

  it("回放态禁用输入框并说明原因，退出后恢复", () => {
    const app = read("app.js");
    // `N < M` is the replay state, defined once: `renderReplayPosition`,
    // `submit()` and the Esc chain all ask this function rather than each
    // recomputing the comparison.
    const replaying = bodyOf(app, "function isReplaying(atSeq = state.replay?.atSeq)");
    expect(replaying).toContain("return state.replay !== null && atSeq < state.replay.lastSeq");

    const render = bodyOf(app, "function renderReplayPosition()");
    expect(render).toContain("renderComposerLock()");
    // The button that leaves replay is visible exactly when it is possible.
    expect(render).toContain("replayLatest.hidden = !isReplaying()");

    const composerLock = bodyOf(app, "function renderComposerLock()");
    expect(composerLock).toContain("input.disabled = replaying");
    expect(composerLock).toContain("composerLock.hidden = !replaying");
    expect(composerLock).toContain("t.replayLockedReason");
    // Sending from a replayed position would write at the head of the log
    // while the screen shows its middle, so `submit()` refuses first — and so
    // does the palette's entry point, which does not go through `submit()`.
    expect(bodyOf(app, "function submit()").slice(0, 500)).toContain("isReplaying()");
    expect(bodyOf(app, "function runSlashCommand({ name, args }, rawText = `/${name}`)").slice(0, 800))
      .toContain("isReplaying()");
    // The note the lock toggles is markup, so it lives in the document.
    expect(read("index.html")).toContain('id="composer-lock"');
    expect(read("index.html")).toContain('id="composer-lock-text"');
  });

  it("「回到最新」与 Esc 都能退出回放", () => {
    const app = read("app.js");
    const latest = bodyOf(app, 'replayLatest?.addEventListener("click"');
    expect(latest).toContain("exitReplay()");
    const exit = bodyOf(app, "function exitReplay()");
    expect(exit).toContain("commitReplay(state.replay.lastSeq)");
    // Esc is in the window-level chain, before "abort the turn": leaving
    // replay is the smaller action and must not be mistaken for a stop. The
    // chain is found from the listener that owns it — `if (event.key ===
    // "Escape") {` also appears in the confirmation dialog, which runs
    // earlier in the file and would be sliced instead.
    const chainStart = app.indexOf("if (handleModelMenuKey(event)) return;");
    expect(chainStart).toBeGreaterThan(-1);
    const chain = bodyOf(app.slice(chainStart), 'if (event.key === "Escape") {');
    const replayBranch = chain.indexOf("isReplaying()");
    const abortBranch = chain.indexOf('api.send({ cmd: "abort" })');
    expect(replayBranch).toBeGreaterThan(-1);
    expect(abortBranch).toBeGreaterThan(replayBranch);
    expect(chain).toContain("exitReplay()");
  });

  it("每次投影都先清空转录：回放到更早的位置是「行更少」，不是「行更多」", () => {
    const app = read("app.js");
    const loaded = bodyOf(app, 'case "session_loaded": {');
    // A scrub to an earlier event produces *fewer* rows than the screen holds.
    // Appending them onto the existing ones would leave the future on screen —
    // the one thing a replay must not show. So the wipe has to be there, and
    // has to come before the loop that draws.
    const wipe = loaded.indexOf('querySelectorAll(".turn, .tool-row');
    const draw = loaded.indexOf("for (const item of message.messages || [])");
    expect(wipe).toBeGreaterThan(-1);
    expect(draw).toBeGreaterThan(wipe);
    // The per-session renderer state is reset with the rows: a stale
    // `planCard` pointer would make the next plan update a node that is no
    // longer in the document.
    expect(loaded.slice(wipe, draw)).toContain("planCard = null");
    expect(loaded.slice(wipe, draw)).toContain("state.currentAssistant = null");
  });

  it("回放条只在已打开的会话上出现，新会话隐藏它", () => {
    const app = read("app.js");
    // `session_loaded` is what an opened session sends; `newSession` sends
    // `session_loaded` with an empty transcript too, which is why the bar is
    // driven by the replay state rather than by the event alone.
    const loaded = bodyOf(app, 'case "session_loaded": {');
    expect(loaded).toContain("setReplay(");
    const cleared = bodyOf(app, "function clearReplay()");
    expect(cleared).toContain("state.replay = null");
    // A new session clears it: there is no log to scrub.
    expect(bodyOf(app, "function startSessionIn(target)")).toContain("clearReplay()");
    // And so does a replayed position that reaches the head of the log.
    const setReplay = bodyOf(app, "function setReplay(");
    expect(setReplay).toContain("clearReplay()");
  });

  it("样式只用作令牌，且回放态的输入框与提示都可见", () => {
    const css = read("styles.css");
    // The new rules are one section (they sit between two `/* ---------- ` /
    // section headers), so the colour check can be exact rather than a slice
    // that happens to end somewhere later in the file.
    const header = css.indexOf("/* ---------- replay bar (BR-6)");
    expect(header).toBeGreaterThan(-1);
    const nextHeader = css.indexOf("/* ---------- ", header + 10);
    expect(nextHeader).toBeGreaterThan(header);
    const block = css.slice(header, nextHeader);
    for (const selector of [".replay-bar", ".replay-range", ".replay-count", ".composer-lock"]) {
      expect(block, selector).toContain(selector);
    }
    // No hard-coded colours in the new rules: the theme has four variants and
    // a literal hex would be wrong in three of them.
    expect(block).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(block).not.toMatch(/rgba?\(/i);
    // The locked composer has to look locked, or the sentence beside it is the
    // only signal.
    expect(block).toContain(".composer textarea:disabled");
    // The replay state is visible on the strip itself, not only in the text.
    expect(block).toContain(".replay-bar.replaying");
  });

  it("两条新文案两种语言都在，且不是同一句", async () => {
    const { dictionaries } = await import("../../desktop/renderer/i18n.js");
    for (const locale of ["en", "zh"]) {
      for (const key of ["replayLockedReason", "replayBackToLatest"]) {
        const value = dictionaries[locale][key];
        expect(typeof value, `${locale}.${key}`).toBe("string");
        expect(String(value).trim(), `${locale}.${key}`).not.toBe("");
      }
      // The position is a sentence with two numbers in it, so it is a
      // function like `changedFiles` — it still has to say both.
      const position = dictionaries[locale].replayPosition(2, 9);
      expect(typeof position, `${locale}.replayPosition`).toBe("string");
      expect(position).toContain("3");
      expect(position).toContain("10");
    }
    expect(dictionaries.en.replayLockedReason).not.toBe(dictionaries.zh.replayLockedReason);
    expect(dictionaries.en.replayBackToLatest).not.toBe(dictionaries.zh.replayBackToLatest);
    expect(dictionaries.en.replayPosition(0, 1)).not.toBe(dictionaries.zh.replayPosition(0, 1));
  });
});
