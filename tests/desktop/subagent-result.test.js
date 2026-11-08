import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createContext,
  sessionEventToHostEvents,
  summarizeSubagentResult,
} from "../../desktop/renderer/protocol.js";

/**
 * `subagent_result` 的绘制与宿主抽取（批次 9 · 9.4 的 Task 2）。
 *
 * Two halves, each with the tool that can actually observe it:
 *
 *   - the protocol half is a pure function, so it is asserted directly — the
 *     payload shape is the kernel's `SubagentSummary`, and the four terminal
 *     statuses have three different registers to get right;
 *   - the host half has no importable function (`desktop/host/host.js` starts
 *     the NDJSON loop at module scope), so it is asserted against the source,
 *     the same way `replay-scrubber.test.js` and `renderer-reachability.test.js`
 *     assert wiring. That is honest about what it proves: a static check can
 *     show the pump exists, names the kernel's queue and carries the failure
 *     texts; it cannot show the lock behaviour end to end.
 *
 * Why a static check for the host rather than a spawned host process: the pump
 * only fires for a subagent completion, and producing one needs a compiled
 * `dist/subagent/runner.js` plus a session that has already finished a turn
 * with a live subagent. That is Task 1's test (`tests/subagent.test.ts`) plus a
 * live pump; a green here would otherwise depend on a build the CI checkout
 * may not have.
 */
const ROOT = path.join(import.meta.dirname, "..", "..");
const readHost = () => readFileSync(path.join(ROOT, "desktop", "host", "host.js"), "utf8");
const readRenderer = (name) => readFileSync(path.join(ROOT, "desktop", "renderer", name), "utf8");

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

/**
 * A terminal `SubagentSummary` as `src/subagent/runner.ts` builds it.
 *
 * Copied field by field from the type rather than abbreviated: the renderer
 * reads `status`, `label`, `id`, `text`, `error` and `killedBy` off this
 * object, and a fixture with only the two fields a given case happens to use
 * would let the others rot unnoticed.
 */
function summary(overrides = {}) {
  return {
    id: "sa_0123456789ab",
    sessionDir: "/home/sessions/parent/subagents/sa_0123456789ab",
    status: "finished",
    startedAt: "2026-11-09T00:00:00.000Z",
    finishedAt: "2026-11-09T00:01:00.000Z",
    turns: 3,
    toolCalls: 5,
    promptTokens: 1200,
    completionTokens: 300,
    text: "UART1 的时钟没使能：RCC_APB2ENR 的 bit14 是 0，先开时钟再配波特率。",
    textBytes: 96,
    capturedBytes: 96,
    promptPreview: "查一下 UART1 为什么没有输出",
    ...overrides,
  };
}

function translate(payload, type = "subagent_result") {
  const ctx = createContext({ sessionId: "parent" });
  return sessionEventToHostEvents(ev(0, type, payload), ctx);
}

describe("subagent_result 画成一行 notice", () => {
  it("给出一条 notice，而不是「未识别的事件类型」", () => {
    const out = translate(summary());

    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("notice");
    // The unknown-type branch produces exactly this sentence; its absence is
    // what proves the type is registered, not merely tolerated.
    expect(String(out[0].text)).not.toContain("未识别的事件类型");
    expect(String(out[0].text)).toContain("UART1 的时钟没使能");
  });

  it("画的是结论的首行摘要，不是整段正文", () => {
    // The full text is in the child session's log and one `subagent_check`
    // away; a completion row that dumps 8 KiB of conclusions buries the
    // transcript it is supposed to annotate.
    const out = translate(summary({ text: "结论在第一行\n第二行细节\n第三行细节" }));
    expect(String(out[0].text)).toContain("结论在第一行");
    expect(String(out[0].text)).not.toContain("第二行细节");
  });

  it("首行过长时截断并标明，不是硬塞一整段", () => {
    const out = translate(summary({ text: "长".repeat(400) }));
    const text = String(out[0].text);
    expect(text.length).toBeLessThan(400);
    expect(text).toContain("…");
  });

  it("没有正文时说「没有留下结论」，不编一个结论", () => {
    const out = translate(summary({ text: "" }));
    expect(out[0].type).toBe("notice");
    expect(String(out[0].text)).toContain("没有留下结论正文");
  });

  it("只有一条 notice：渲染器没有子代理面板，不画卡片", () => {
    // D-185 removed the card UI wholesale; a second event (a panel, a list, a
    // counter) would be a new dead surface by construction.
    const out = translate(summary());
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("notice");
  });
});

describe("成功与失败的语气分开", () => {
  it("finished 是普通（dim）notice", () => {
    // `addNotice` draws exactly three levels — warn / error / dim — and drops
    // anything else, so "ordinary" has to be `dim`; the background pump's
    // clean-exit line made the same choice for the same reason.
    const out = translate(summary({ status: "finished" }));
    expect(out[0].level).toBe("dim");
  });

  it("failed 是 warn，且正文带内核记录的原因", () => {
    const out = translate(
      summary({ status: "failed", error: "subagent stopped before finishing: max_turns" }),
    );
    expect(out[0].level).toBe("warn");
    expect(String(out[0].text)).toContain("失败");
    expect(String(out[0].text)).toContain("max_turns");
  });

  it("failed 但没有原因时如实说「未记录原因」", () => {
    const out = translate(summary({ status: "failed", error: undefined }));
    expect(out[0].level).toBe("warn");
    expect(String(out[0].text)).toContain("未记录原因");
  });

  it("killed 是 warn，并说出是谁要它停", () => {
    const byKill = translate(summary({ status: "killed", killedBy: "kill" }));
    expect(byKill[0].level).toBe("warn");
    expect(String(byKill[0].text)).toContain("已终止");
    expect(String(byKill[0].text)).toContain("终止请求");

    const byAbort = translate(summary({ status: "killed", killedBy: "abort" }));
    expect(byAbort[0].level).toBe("warn");
    expect(String(byAbort[0].text)).toContain("宿主中止");
  });

  it("timed_out 是 warn，并说明是跑满了自身时限", () => {
    const out = translate(summary({ status: "timed_out", killedBy: "timeout" }));
    expect(out[0].level).toBe("warn");
    expect(String(out[0].text)).toContain("超时");
  });

  it("三种非正常终局都是 warn，没有一种落回 success", () => {
    for (const status of ["failed", "killed", "timed_out"]) {
      const out = translate(summary({ status }));
      expect(out[0].level, status).toBe("warn");
    }
  });
});

describe("有 label 用 label，没有就报 id 而不冒充名字", () => {
  it("label 出现在提示里", () => {
    const out = translate(summary({ label: "UART 排查" }));
    expect(String(out[0].text)).toContain("UART 排查");
  });

  it("没有 label 时打印 id，并标明它是一个 id", () => {
    const out = translate(summary());
    expect(String(out[0].text)).toContain("sa_0123456789ab");
    expect(String(out[0].text)).toContain("子代理");
  });
});

describe("未知事件守卫（这条分支不是兜底吞掉）", () => {
  it("类型拼错时仍然产出 warn notice", () => {
    // If `subagent_result` were drawing via the unrecognised-type path, the
    // case above would be green with no handler at all. Renaming the type must
    // bring the warning back.
    const out = translate(summary(), "subagent_resultt");
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("notice");
    expect(out[0].level).toBe("warn");
    expect(String(out[0].text)).toContain("未识别的事件类型");
    expect(String(out[0].text)).toContain("subagent_resultt");
  });

  it("缺少可画状态的 payload 什么都不画，也不冒充成功", () => {
    // A `running` payload is not a terminal state, and the event is named
    // `subagent_result`. Returning nothing keeps the old log's silence; the
    // alternative — drawing a "finished" line for a running job — is the one
    // failure mode this whole feature exists to avoid.
    expect(summarizeSubagentResult({ id: "sa_x", status: "running" })).toBeNull();
    expect(summarizeSubagentResult(null)).toBeNull();
    expect(translate({ status: "running" })).toStrictEqual([]);
  });
});

describe("宿主抽取（静态断言）", () => {
  it("泵把两条完成队列都排空，且子代理的载荷原样落盘", () => {
    const host = readHost();
    const body = bodyOf(host, "async function pumpCompletions()");
    expect(body).toContain("takeSubagentCompletions");
    expect(body).toContain("takeBackgroundCompletions");
    // The payload is the summary itself: Task 1's `SubagentSummary` is the
    // event payload, so a reassembly here would be a second place the field
    // names could drift.
    expect(body).toContain('handle.append({ type: "subagent_result", payload })');
    expect(body).toContain('handle.append({ type: "background_result", payload })');
  });

  it("只有一个泵、一个定时器：两条队列共用一个写入者", () => {
    // They used to be two functions started side by side on the same tick, each
    // opening its own handle. Two handles on one session directory mean two
    // event lists, two seq counters, and (measured) the same seq written twice
    // — after which `readSessionDir` throws `invalid_seq` forever.
    const host = readHost();
    expect(host).not.toContain("async function pumpBackgroundResults()");
    expect(host).not.toContain("async function pumpSubagentResults()");
    const start = bodyOf(host, "function startBackgroundPump()");
    expect(start.match(/setInterval\(/g)).toHaveLength(1);
    expect(start).toContain("pumpCompletions()");
  });

  it("回合进行中不取第二份 handle（同进程锁可重入，第二份会撞 seq）", () => {
    // `src/session/lock.ts` treats a second acquire by the same process as a
    // re-entrant success, so "if the lock is busy we skip" was never true
    // mid-turn. Measured: run -> seq 1, pump -> seq 1, then the log is
    // unreadable. The guard has to be the host's own `running` flag, and it
    // has to come before the first `await`.
    const host = readHost();
    const body = bodyOf(host, "async function pumpCompletions()");
    const guard = body.indexOf("if (running) return;");
    expect(guard, "the `running` guard must exist").toBeGreaterThan(-1);
    const firstAwait = body.indexOf("await ");
    expect(guard, "the guard must come before any await").toBeLessThan(firstAwait);
    // A skipped tick must not consume the queues: an entry is only taken once
    // there is a handle to write it through.
    const takeInside = body.indexOf("takeSubagentCompletions(id)");
    const handleOpened = body.indexOf("await kernel.resumeSession");
    expect(takeInside).toBeGreaterThan(handleOpened);
  });

  it("会话被占用时明说「结果未能写入日志」，不是静默丢弃（R3）", () => {
    const host = readHost();
    const body = bodyOf(host, "async function pumpCompletions()");
    expect(body).toContain("结果未能写入日志");
    // The reason travels with it: "the session was busy" with no cause leaves
    // the operator with nothing to act on.
    expect(body).toContain("${messageOf(error)}");
  });

  it("append 失败时发 warn 说明写入失败，不说成已写入", () => {
    const host = readHost();
    const body = bodyOf(host, "async function pumpCompletions()");
    expect(body).toContain("结果写入失败");
    expect(body).toContain('level: "warn"');
    // The handle is released on every path, or the lock outlives the pump.
    expect(body).toContain("handle.close()");
  });

  it("内核没有子代理运行时（旧 dist/）时安静跳过，不崩宿主", () => {
    const host = readHost();
    // `kernel.subagent` comes from an optional import; a `dist/` built before
    // the feature has no queue at all, and that is not an error — no subagent
    // was ever started there.
    expect(host).toContain('import(dist("subagent/runner.js")).catch(() => undefined)');
    expect(host).toContain("kernel.subagent");
    // The queue is probed for both presence and callability; a module that
    // loaded but exports no drain function must not be called.
    expect(host).toContain('typeof subagent.takeSubagentCompletions === "function"');
    // Same for the background queue: an even older `dist/` has no
    // `tools/background.js`, and the pump must boot regardless.
    expect(host).toContain('typeof background.takeBackgroundCompletions === "function"');
  });

  it("泵需要的 resumeSession 真的在 kernel 上（不是一条会抛 TypeError 的调用）", () => {
    // This is a regression the background pump had from 2026-10-22 until now:
    // it called `kernel.resumeSession` while the `kernel` object never defined
    // it, so every background result took the "session busy" branch and looked
    // like a lock conflict. It also means that path never actually wrote — the
    // only reason the seq collision above never fired in the field.
    const host = readHost();
    expect(host).toContain('import(dist("session/session.js"))');
    const literal = host.slice(host.indexOf("  kernel = {"), host.indexOf("} catch (error) {"));
    expect(literal).toContain("resumeSession,");
    expect(bodyOf(host, "async function pumpCompletions()")).toContain("kernel.resumeSession");
  });
});

describe("协议层登记", () => {
  it("KNOWN_TYPES 里有 subagent_result，且有专门的 case 分支", () => {
    const protocol = readRenderer("protocol.js");
    const knownStart = protocol.indexOf("const KNOWN_TYPES = new Set([");
    expect(knownStart).toBeGreaterThan(-1);
    const known = protocol.slice(knownStart, protocol.indexOf("]);", knownStart));
    expect(known).toContain('"subagent_result"');
    // Registered + a case that produces something: half of this pair is the
    // "known but draws nothing" shape the background result avoided too.
    expect(protocol).toContain('case "subagent_result"');
  });
});
