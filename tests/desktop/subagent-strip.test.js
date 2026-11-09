import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createContext,
  sessionEventToHostEvents,
  sessionEventsToMessages,
  subagentStartedEvent,
} from "../../desktop/renderer/protocol.js";
import {
  elapsedClock,
  subagentName,
  subagentOverflow,
} from "../../desktop/renderer/subagent-strip.js";
import { subagentSessionDir } from "../../desktop/host/subagent-session.js";
import { isValidSessionId } from "../../src/session/handle.js";

/**
 * 运行中的子代理条 + 只读回放子会话（计划 Task 2，2026-11-09）。
 *
 * Three surfaces, each with the tool that can actually observe it:
 *
 *   - `subagentStartedEvent` and the three clock helpers are pure functions, so
 *     they are asserted directly;
 *   - `subagentSessionDir` is a **boundary**, so it is asserted by calling it —
 *     with the kernel's real `isValidSessionId`, not a stand-in. A second
 *     validator invented here would prove that this file agrees with itself;
 *   - the strip's drawing, the 1 s ticker and the read-only refusal live in a
 *     file that needs a DOM (`app.js` loads against `window.prometheus`), and
 *     the repository has no jsdom — adding one is an unapproved dependency.
 *     They are therefore asserted against the source, the way
 *     `replay-scrubber.test.js` and `renderer-reachability.test.js` assert
 *     wiring. **What that proves and what it does not is written at the bottom
 *     of this file** — a static assertion can show that the guard exists and
 *     names the right predicate; it cannot show a pixel.
 *
 * The host's `loadSubagent` is deliberately **not** covered. `desktop/host/
 * host.js` starts the NDJSON loop at module scope, and driving it needs a
 * compiled `dist/` plus a session directory holding a real subagent log; the
 * path rule it depends on is `subagentSessionDir`, which is covered below by
 * calling it. The gap is stated in the task report rather than papered over.
 */
const ROOT = path.join(import.meta.dirname, "..", "..");
const RENDERER = path.join(ROOT, "desktop", "renderer");
const readRenderer = (name) => readFileSync(path.join(RENDERER, name), "utf8");
const readHost = () => readFileSync(path.join(ROOT, "desktop", "host", "host.js"), "utf8");

/** A start payload as `src/subagent/runner.ts` writes it, field for field. */
function started(overrides = {}) {
  return {
    id: "sa_a1b2c3d4e5f6",
    sessionDir: "/home/sessions/parent/subagents/sa_a1b2c3d4e5f6",
    promptPreview: "确认主频",
    startedAt: "2026-11-09T00:00:00.000Z",
    maxTurns: 30,
    timeoutMs: 600_000,
    ...overrides,
  };
}

function translate(payload, type = "subagent_started") {
  const ctx = createContext({ sessionId: "parent" });
  return sessionEventToHostEvents({ seq: 0, ts: "2026-11-09T00:00:00.000Z", type, payload }, ctx);
}

// ---------------------------------------------------------------------------
// 验收行 1：subagentStartedEvent 映射
// ---------------------------------------------------------------------------

describe("subagentStartedEvent：一条开始事件 → 一条内部消息", () => {
  it("完整 payload 的五个字段都到达", () => {
    const out = translate(started());
    expect(out).toHaveLength(1);
    expect(out[0]).toStrictEqual({
      type: "subagent_started",
      id: "sa_a1b2c3d4e5f6",
      promptPreview: "确认主频",
      startedAt: "2026-11-09T00:00:00.000Z",
      sessionDir: "/home/sessions/parent/subagents/sa_a1b2c3d4e5f6",
      maxTurns: 30,
      timeoutMs: 600_000,
    });
  });

  it("label 有就带上", () => {
    const out = translate(started({ label: "UART 排查" }));
    expect(out[0].label).toBe("UART 排查");
  });

  it("没有 label 时整键缺席，不写 null 也不拿 id 冒充名字", () => {
    const out = translate(started());
    expect(out[0]).not.toHaveProperty("label");
  });

  it("缺 id → null，一条消息都不产出", () => {
    // 没有 id 就没有可以删除的键：画出来会变成一条永远「运行中」的条目。
    expect(subagentStartedEvent(started({ id: undefined }))).toBeNull();
    expect(subagentStartedEvent(started({ id: "" }))).toBeNull();
    expect(subagentStartedEvent(null)).toBeNull();
    expect(subagentStartedEvent("sa_x")).toBeNull();
    expect(translate(started({ id: undefined }))).toStrictEqual([]);
  });

  it("可选的数字与字符串缺失时整键缺席，不补 0", () => {
    // 补 0 会让折叠行画出「上限 0 轮」——一个内核从没设过的上限（R3）。
    const out = subagentStartedEvent({ id: "sa_x" });
    expect(out).toStrictEqual({ type: "subagent_started", id: "sa_x" });
  });

  it("不改时长：消息里没有任何已算好的「跑了多久」", () => {
    // 纯函数算出的秒数在下一秒就是错的；这一刻意留给渲染层的定时器。
    const out = subagentStartedEvent(started());
    for (const key of ["elapsedMs", "elapsed", "runningMs", "durationMs"]) {
      expect(out).not.toHaveProperty(key);
    }
  });

  it("不会被当成「未识别的事件类型」", () => {
    const out = translate(started());
    expect(out.filter((message) => String(message.text ?? "").includes("未识别的事件类型"))).toStrictEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 验收行 2：不画已完成的
// ---------------------------------------------------------------------------

describe("完成走 subagent_result，开始事件不画完成态", () => {
  it("payload 带 status 时仍按开始处理", () => {
    // 这条事件的名字就是 `*_started`；一个恰好带了 status 的载荷仍是开始，
    // 完成由 `subagent_result` 单独报告。把它当完成会让两条生产者描述同一事实。
    const out = translate(started({ status: "running" }));
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("subagent_started");
    expect(out[0]).not.toHaveProperty("status");
  });

  it("subagent_result 的 notice 带 subagentId，且仍只有一条消息", () => {
    // 渲染层用这个字段把同 id 从 `state.liveSubagents` 里删掉。**只有一条**
    // 是既有契约（`subagent-result.test.js` 的「不画卡片」），所以 id 挂在
    // notice 上，而不是另发一条 `subagent_settled`。
    const out = translate(
      { id: "sa_a1b2c3d4e5f6", status: "finished", text: "结论：72 MHz。" },
      "subagent_result",
    );
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("notice");
    expect(out[0].subagentId).toBe("sa_a1b2c3d4e5f6");
  });

  it("subagent_result 没有 id 时不写这个字段（旧日志逐字段相同）", () => {
    const out = translate({ status: "finished", text: "结论" }, "subagent_result");
    expect(out[0]).not.toHaveProperty("subagentId");
  });

  it("渲染层删除 state.liveSubagents 的同 id（静态）", () => {
    const app = readRenderer("app.js");
    const body = functionBody(app, "function noteSubagentSettled(");
    // The delete itself, keyed by the id the caller passed — not a rebuild of
    // the map, which would clear runs that did not finish.
    expect(body).toContain("state.liveSubagents.delete(id)");
    // And the notice branch is where it is called from.
    const notice = caseBody(app, 'case "notice":');
    expect(notice).toContain("noteSubagentSettled(message.subagentId)");
    // `subagent_started` is the other half: it inserts.
    const start = caseBody(app, 'case "subagent_started":');
    expect(start).toContain("noteSubagentStarted(message)");
    const startedBody = functionBody(app, "function noteSubagentStarted(");
    expect(startedBody).toContain("state.liveSubagents.set(message.id");
  });
});

// ---------------------------------------------------------------------------
// 验收行 3：计时器只在有子代理时存在
// ---------------------------------------------------------------------------

describe("1 s 计时器随「有东西在跑」生灭", () => {
  it("创建点受 size > 0 保护", () => {
    const app = readRenderer("app.js");
    const body = functionBody(app, "function startSubagentTicker(");
    // The guard has to be before the `setInterval`, or an empty map still
    // leaves a timer running for the life of the window.
    const guard = body.indexOf("state.liveSubagents.size === 0");
    const create = body.indexOf("setInterval(");
    expect(guard).toBeGreaterThan(-1);
    expect(create).toBeGreaterThan(guard);
    // One timer, ever: a second interval would double the tick rate.
    expect(body).toContain("subagentTicker !== null");
  });

  it("清空处 clearInterval", () => {
    const app = readRenderer("app.js");
    const body = functionBody(app, "function haltSubagentTicker(");
    expect(body).toContain("clearInterval(subagentTicker)");
    expect(body).toContain("subagentTicker = null");
    // Both ways the set can empty go through it: a result arriving, and the
    // whole map being cleared by a session switch.
    const settle = functionBody(app, "function noteSubagentSettled(");
    expect(settle).toContain("haltSubagentTicker()");
    const clear = functionBody(app, "function clearSubagents(");
    expect(clear).toContain("haltSubagentTicker()");
  });

  it("tick 不重建 DOM，只改文本", () => {
    // `paintSubagentClocks` must not call the row builder: rebuilding once a
    // second steals focus from the row button under the cursor (the mistake
    // `renderPlan` was rewritten to avoid).
    const app = readRenderer("app.js");
    const body = functionBody(app, "function paintSubagentClocks(");
    expect(body).not.toContain("paintSubagentRows(");
    expect(body).not.toContain("renderSubagentStrip(");
    expect(body).toContain("paintSubagentClock(");
  });
});

// ---------------------------------------------------------------------------
// 验收行 4：回放态隐藏
// ---------------------------------------------------------------------------

describe("回放态隐藏子代理条", () => {
  it("renderSubagentStrip 里 isReplaying() 为真时 hidden", () => {
    const app = readRenderer("app.js");
    const body = functionBody(app, "function renderSubagentStrip(");
    const guard = body.indexOf("isReplaying()");
    expect(guard).toBeGreaterThan(-1);
    expect(body).toContain("subagentStrip.hidden = true");
    // The predicate decides, and the hidden assignment comes after it: a
    // "running now" line over a picture of the past is a false statement.
    expect(guard).toBeLessThan(body.indexOf("subagentStrip.hidden = true"));
  });

  it("没有子代理时整条 hidden（不占位）", () => {
    const app = readRenderer("app.js");
    const body = functionBody(app, "function renderSubagentStrip(");
    expect(body).toContain("runs.length === 0");
    // And the markup ships hidden, so a window that never had a subagent has
    // no empty band above the composer.
    expect(readRenderer("index.html")).toContain('id="subagent-strip" hidden');
  });

  it("回放位置变化时重新判一次可见性", () => {
    // Otherwise the strip would stay hidden after "back to latest".
    const app = readRenderer("app.js");
    const body = functionBody(app, "function renderReplayPosition(");
    expect(body).toContain("renderSubagentStrip()");
  });
});

// ---------------------------------------------------------------------------
// 验收行 5：路径不拼接用户输入
// ---------------------------------------------------------------------------

describe("subagentSessionDir：两段 id 各自校验，subagents 是字面量", () => {
  const sessionsRoot = path.join(path.sep === "/" ? "/" : "C:\\", "home", "sessions");
  const dirOf = (parentId, childId) =>
    subagentSessionDir({ sessionsRoot, parentId, childId, isValidSessionId });

  it("合法输入返回 <root>/a/subagents/b", () => {
    expect(dirOf("a", "b")).toBe(path.join(sessionsRoot, "a", "subagents", "b"));
    // The real shape: a parent session id and a generated `sa_` + 12 hex.
    expect(dirOf("2026-11-09T00-00-00-abcd", "sa_a1b2c3d4e5f6")).toBe(
      path.join(sessionsRoot, "2026-11-09T00-00-00-abcd", "subagents", "sa_a1b2c3d4e5f6"),
    );
  });

  it("三条越界输入全部返回 undefined", () => {
    // Each of these is a way to make one caller-supplied string address two
    // directories. They fail because `isValidSessionId` rejects `/` and `.` —
    // the assertions below prove which half rejected them, so this test cannot
    // pass for the wrong reason.
    expect(dirOf("a/../b", "c")).toBeUndefined();
    expect(dirOf("../a", "b")).toBeUndefined();
    expect(dirOf("a", "../b")).toBeUndefined();
    expect(isValidSessionId("a/../b")).toBe(false);
    expect(isValidSessionId("../a")).toBe(false);
    expect(isValidSessionId("../b")).toBe(false);
  });

  it("反斜杠与其它分隔符同样被拒", () => {
    // Windows is the first-class platform here, and `path.join` also treats
    // `\` as a separator there; the validator must not be the only reason a
    // backslash never reaches a path.
    for (const bad of ["a\\b", "a\\..\\b", "..", ".", "", "a b", "a:b", "con", "CON"]) {
      expect(isValidSessionId(bad), JSON.stringify(bad)).toBe(false);
      expect(dirOf(bad, "c"), `parent ${JSON.stringify(bad)}`).toBeUndefined();
      expect(dirOf("c", bad), `child ${JSON.stringify(bad)}`).toBeUndefined();
    }
  });

  it("非字符串一律 undefined，不靠隐式转换", () => {
    for (const bad of [null, undefined, 42, {}, []]) {
      expect(dirOf(bad, "c")).toBeUndefined();
      expect(dirOf("c", bad)).toBeUndefined();
    }
  });

  it("结果永远在 sessionsRoot 之下（不逃逸）", () => {
    // The property the three traversal cases are instances of. Asserted on the
    // resolved path so a future validator that accepts some new shape would
    // still be caught if it let a `..` through.
    const dir = dirOf("a", "b");
    const relative = path.relative(path.resolve(sessionsRoot), path.resolve(dir));
    expect(relative.startsWith("..")).toBe(false);
    expect(path.isAbsolute(relative)).toBe(false);
  });

  it("宿主只用这一个函数解析子会话目录", () => {
    // A second `path.join(sessionsRoot, …)` for a subagent anywhere in the host
    // would be a second, unverified boundary.
    const host = readHost();
    expect(host).toContain('import { subagentSessionDir } from "./subagent-session.js"');
    const body = functionBody(host, "async function handleLoadSubagent(");
    expect(body).toContain("subagentSessionDir(");
    expect(body).not.toContain("subagents\", childId");
    expect(body).not.toContain('"subagents"');
  });
});

// ---------------------------------------------------------------------------
// 验收行 6：只读不冒充
// ---------------------------------------------------------------------------

describe("只读：宿主拒绝 prompt，渲染层禁用输入框", () => {
  it("prompt 分支里有 readonlySession 拒绝，且措辞含「只读」", () => {
    const host = readHost();
    const body = functionBody(host, "async function handlePrompt(");
    // The guard has to be a live `if (...) {` — a text match alone passes for
    // `&& false` and for a comment, both of which refuse nothing.
    const guard = body.indexOf("if (readonlySession !== null) {");
    expect(guard, "the refusal must be a real conditional").toBeGreaterThan(-1);
    // Before the turn starts, or the refusal would arrive after `run_start`.
    const runStart = body.indexOf("ctx.running = true");
    expect(guard).toBeLessThan(runStart);
    // The refusal returns; falling through to `runner.start` would run the
    // prompt anyway.
    const refusal = body.slice(guard, body.indexOf("if (ctx.running) {", guard));
    expect(refusal).toContain("return;");
    expect(refusal).toContain("只读");
    // And it is a notice, not an `error` banner: the operator did not break
    // anything, they are reading a record.
    expect(refusal).toContain('level: "warn"');
  });

  it("loadSubagent 把 sessionId 留在父会话，并置 readonlySession", () => {
    const host = readHost();
    const body = functionBody(host, "async function handleLoadSubagent(");
    // The parent's id, never the child's: a child has no runner, so an adopted
    // id would point the next prompt at a directory nothing consumes.
    expect(body).toContain("sessionId = parentId");
    expect(body).not.toContain("sessionId = childId");
    expect(body).toContain("readonlySession = { parentId, childId }");
    // And it says so on the wire, for the banner.
    expect(body).toContain("loaded.readonly = { parentId, childId }");
  });

  it("loadSession 与 newSession 都清掉只读标记", () => {
    // Otherwise the banner would survive a return to an ordinary conversation
    // and keep claiming the screen is a record.
    const host = readHost();
    expect(functionBody(host, "async function handleLoadSession(")).toContain("readonlySession = null");
    expect(functionBody(host, "function handleNewSession(")).toContain("readonlySession = null");
  });

  it("渲染层有一条常驻横幅，且它带「返回父会话」", () => {
    const html = readRenderer("index.html");
    expect(html).toContain('id="readonly-banner"');
    expect(html).toContain('id="readonly-back"');
    const app = readRenderer("app.js");
    const body = functionBody(app, "function renderReadonlyBanner(");
    expect(body).toContain("t.readonlySubagent(readonly.childId)");
    // No dismiss: the only exit is the parent session.
    expect(body).not.toContain("dismiss");
    expect(functionBody(app, "function exitReadonly(")).toContain('api.send({ cmd: "loadSession", id: parentId })');
  });

  it("只读子会话里输入框也被禁用，并说明原因（不是回放那句）", () => {
    const app = readRenderer("app.js");
    const body = functionBody(app, "function renderComposerLock(");
    // A live conditional, not a mention: `&& false` left every other assertion
    // in this file green while nothing was actually disabled.
    const guard = body.indexOf("if (state.readonly !== null) {");
    expect(guard, "the read-only lock must be a real conditional").toBeGreaterThan(-1);
    const block = body.slice(guard);
    expect(block).toContain("input.disabled = true");
    expect(block).toContain("t.readonlyComposerReason");
    // Two different reasons, two different sentences.
    expect(body).toContain("t.replayLockedReason");
    const dict = readRenderer("i18n.js");
    expect(dict).toContain("readonlyComposerReason");
  });

  it("进入只读态时重新上锁：session_loaded 是唯一写 state.readonly 的地方", () => {
    // The lock is a function of `state.readonly`, and nothing else on the
    // `session_loaded` path calls it — `setReplay` only reaches it when the
    // event carries a position, which a child's answer deliberately does not.
    // Without the call, opening a record from a live conversation leaves an
    // enabled composer over a transcript nothing can answer.
    const app = readRenderer("app.js");
    const loaded = caseBody(app, 'case "session_loaded":');
    expect(loaded).toContain("state.readonly =");
    expect(loaded).toContain("renderComposerLock()");
    expect(loaded.indexOf("state.readonly =")).toBeLessThan(loaded.indexOf("renderComposerLock()"));
  });

  it("submit 与 runSlashCommand 都拒绝只读态（不只是禁用输入框）", () => {
    // Disabling the box closes the mouse and the keyboard; it does not close
    // the palette, which reaches `runSlashCommand` directly.
    const app = readRenderer("app.js");
    for (const header of ["function submit()", "function runSlashCommand("]) {
      const body = functionBody(app, header);
      const guard = body.indexOf("if (state.readonly !== null) {");
      expect(guard, `${header} must refuse a read-only transcript`).toBeGreaterThan(-1);
      expect(body.slice(guard)).toContain("t.readonlyComposerReason");
      // And the refusal has to return — a notice plus a fallthrough sends it.
      expect(body.slice(guard, body.indexOf("}", guard) + 1)).toContain("return");
    }
  });

  it("只读态不发布回放位置：子日志的 seq 不能交给父日志", () => {
    // `state.replay` drives a control that commits `loadSession{atSeq}` against
    // `state.sessionId` (the parent). Publishing the child's position would
    // scrub the parent to an unrelated event.
    const host = readHost();
    const body = functionBody(host, "async function handleLoadSubagent(");
    // The projection is destructured so the two fields are **left out**, not
    // blanked: a `lastSeq` of `undefined` still travels as a key, and this
    // answer must carry neither.
    expect(body).toContain("const { lastSeq: _lastSeq, atSeq: _atSeq, ...loaded } = projection");
    expect(body).not.toContain("loaded.lastSeq");
    expect(body).not.toContain("loaded.atSeq");
  });
});

// ---------------------------------------------------------------------------
// 验收行 7：事件登记
// ---------------------------------------------------------------------------

describe("事件登记", () => {
  it("KNOWN_TYPES 含 subagent_started，且有 case 分支", () => {
    const protocol = readRenderer("protocol.js");
    const start = protocol.indexOf("const KNOWN_TYPES = new Set([");
    const known = protocol.slice(start, protocol.indexOf("]);", start));
    expect(known).toContain('"subagent_started"');
    // Registered and drawn: half of this pair is the "known but draws nowhere"
    // shape the subagent strip exists to avoid.
    expect(protocol).toContain('case "subagent_started"');
  });

  it("回放投影不把开始事件画成气泡", () => {
    // `sessionEventsToMessages` drops unknown types silently; this one is known
    // and must still produce no row, or reopening a session would gain a line
    // it never had.
    expect(
      sessionEventsToMessages([{ seq: 0, ts: "t", type: "subagent_started", payload: started() }]),
    ).toStrictEqual([]);
  });
});

describe("泵写入的完成事件必须自己投递（否则条带永远显示「运行中」）", () => {
  // A completion is by definition written after the turn that started it. By
  // then neither delivery path exists: `follow` returned when the header went
  // `closed` (`src/events/log-tail.ts`), and `handleLiveEvent` drops anything
  // arriving while `!ctx.running` and only takes a contiguous seq. A pump that
  // appends without delivering writes a line nobody ever sees — and the next
  // prompt's `since = headSeq` skips it too, so it is not merely late.
  it("两条队列的 append 都把事件交给了投递函数", () => {
    const host = readHost();
    const body = bodyOf(host, "async function pumpCompletions()");
    // Both kinds, not just the new one: the same defect already existed for
    // `background_result` and was invisible only because the write itself was
    // failing (D-230).
    expect(body).toContain("deliverPumpedEvent(written)");
    const backgroundAppend = body.indexOf('type: "background_result"');
    const subagentAppend = body.indexOf('type: "subagent_result"');
    expect(backgroundAppend).toBeGreaterThan(-1);
    expect(subagentAppend).toBeGreaterThan(-1);
    // Each append is captured so the written event (with its seq) can be drawn.
    expect(body.slice(backgroundAppend, backgroundAppend + 200)).toContain("deliverPumpedEvent");
    expect(body.slice(subagentAppend, subagentAppend + 200)).toContain("deliverPumpedEvent");
  });

  it("投递函数把游标退到该事件之前，翻译之后再让协议层推进", () => {
    // `sessionEventToHostEvents` skips any event whose seq is `<= ctx.lastSeq`.
    // Winding back one place is what lets the pump's own event through while
    // still leaving the cursor at the log's real position afterwards.
    const host = readHost();
    const body = bodyOf(host, "function deliverPumpedEvent(event)");
    expect(body).toContain("ctx.lastSeq = event.seq - 1");
    expect(body).toContain("deliverKernelEvent(event)");
  });

  it("投递失败时说明「已写入日志但未能显示」，不伪装成写失败", () => {
    // Two different facts: the line IS in the log (readable after reopening),
    // and the screen did not get it. Saying "写入失败" would be a lie about a
    // write that succeeded; saying nothing would leave the strip running.
    const host = readHost();
    const body = bodyOf(host, "function deliverPumpedEvent(event)");
    expect(body).toContain("已写入日志但未能显示");
    expect(body).toContain('level: "warn"');
  });
});

// ---------------------------------------------------------------------------
// 纯函数：时钟
// ---------------------------------------------------------------------------

describe("elapsedClock", () => {
  const start = "2026-11-09T00:00:00.000Z";
  const at = (seconds) => Date.parse(start) + seconds * 1000;

  it("分:秒，秒补零", () => {
    expect(elapsedClock(start, at(0))).toBe("0:00");
    expect(elapsedClock(start, at(5))).toBe("0:05");
    expect(elapsedClock(start, at(83))).toBe("1:23");
    expect(elapsedClock(start, at(600))).toBe("10:00");
    expect(elapsedClock(start, at(3600))).toBe("60:00");
  });

  it("时钟解析不出来时返回 null，而不是 0:00", () => {
    // 0:00 是「刚开始跑」的断言，而这里的事实是「不知道什么时候开始的」。
    expect(elapsedClock("", at(10))).toBeNull();
    expect(elapsedClock("not a date", at(10))).toBeNull();
    expect(elapsedClock(undefined, at(10))).toBeNull();
    expect(elapsedClock(12345, at(10))).toBeNull();
  });

  it("开始时间在未来时不画负数", () => {
    expect(elapsedClock(start, at(-30))).toBe("0:00");
  });
});

describe("subagentName / subagentOverflow", () => {
  it("有 label 用 label", () => {
    expect(subagentName({ id: "sa_a1b2c3d4e5f6", label: "UART 排查" })).toBe("UART 排查");
  });

  it("没有 label 时是 id，且今天的 id 全部显示", () => {
    // `sa_` + 12 hex is 15 characters and the cap is 15, so a generated id is
    // printed whole — the reader can paste it into `subagent_check`.
    expect(subagentName({ id: "sa_a1b2c3d4e5f6" })).toBe("sa_a1b2c3d4e5f6");
    expect(subagentName({ id: "short" })).toBe("short");
  });

  it("更长的 id 被截断并标出省略号，不冒充完整 id", () => {
    const long = `sa_${"a".repeat(40)}`;
    const shown = subagentName({ id: long });
    expect(shown).toBe(`${long.slice(0, 15)}…`);
    expect(shown).not.toBe(long);
  });

  it("+N 数的是「其余」而不是总数", () => {
    expect(subagentOverflow(0)).toBe(0);
    expect(subagentOverflow(1)).toBe(0);
    expect(subagentOverflow(2)).toBe(1);
    expect(subagentOverflow(5)).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// 静态扫描的小工具
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

const functionBody = bodyOf;

/**
 * The body of one `case "x":` in `handleEvent`, ending at the next case.
 *
 * `bodyOf` cannot be used: a case is not a block at a fixed indent, and the
 * next `case` is the only reliable terminator.
 */
function caseBody(text, header) {
  const start = text.indexOf(header);
  expect(start, `${header} not found`).toBeGreaterThan(-1);
  const next = text.indexOf("\n    case ", start + header.length);
  return text.slice(start, next === -1 ? text.length : next);
}
