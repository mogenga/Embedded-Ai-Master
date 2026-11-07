import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dictionaries } from "../../desktop/renderer/i18n.js";

/**
 * D-185 / BACKLOG 5.5 — goals, sub-agents and checkpoints were a complete
 * renderer implementation with no producer anywhere behind them.
 *
 * Why a static check: the thing being asserted is the *absence* of a wiring,
 * not behaviour. A behavioural test could only show that some event still
 * draws a card — it could not show that the kernel never emits that event.
 * The producer half is therefore checked against the two vocabularies the
 * renderer actually consults (`KNOWN_TYPES`, the i18n dictionaries) and
 * against the sources that could emit; the renderer half is a plain text
 * scan over every file that could still name a removed symbol.
 *
 * The grep that justifies the deletion (2026-11-07, re-run before deleting):
 *   grep -rn 'goal_start|goal_round|goal_end' src/                     -> 0
 *   grep -rn 'subagent_start|subagents|subagent_activity|subagent_end' src/ -> 0
 *   grep -rn 'getCheckpoints|restoreCheckpoint|restoreFile|redo' src/  -> 0
 *   same four patterns in desktop/host/host.js + desktop/renderer/protocol.js -> 0
 * The only hit for "goal" in `src/` is a compression prompt that happens to
 * contain the English word ("user goals") — not an event.
 */
const ROOT = path.join(import.meta.dirname, "..", "..");
const RENDERER = path.join(ROOT, "desktop", "renderer");
const readRenderer = (name) => readFileSync(path.join(RENDERER, name), "utf8");
const readRepo = (relative) => readFileSync(path.join(ROOT, relative), "utf8");

/** Event types the renderer used to handle for the three dead features. */
const DEAD_EVENT_TYPES = [
  "goal_start",
  "goal_round",
  "goal_end",
  "subagent_start",
  "subagent_activity",
  "subagent_end",
  "subagents",
  "checkpoints",
  "recovery",
];

/** Renderer symbols that only these features used. */
const DEAD_SYMBOLS = [
  "renderGoalBadge",
  "renderSubagents",
  "renderCheckpoints",
  "startAutonomous",
  "stopGoal",
  "stopSubagent",
  "state.goalRun",
  "state.subagents",
  "state.currentSubagent",
  "state.checkpoints",
  "state.checkpointRedo",
];

/** i18n keys that belonged to the three features. */
const DEAD_KEYS = [
  "tabTasks",
  "tabHistory",
  "noTasks",
  "taskMeta",
  "subagentLabel",
  "subagentStop",
  "subagentExpand",
  "subagentCollapse",
  "subagentDone",
  "subagentFailed",
  "recoveryTitle",
  "recoveryOpen",
  "noCheckpoints",
  "checkpointTurn",
  "restoreStart",
  "restoreFile",
  "redoSafe",
  "restoreConfirm",
  "startGoal",
  "startTaskLoop",
  "goalPrompt",
  "loopPrompt",
  "goalAlreadyRunning",
  "goalStarted",
  "loopStarted",
  "goalRound",
  "loopPlanRound",
  "goalEnded",
  "goalBadge",
  "loopBadge",
  "goalStopTitle",
];

/** CSS selectors that only these blocks used. */
const DEAD_SELECTORS = [
  ".tasks-root",
  ".tasks-list",
  ".task-row",
  ".task-state",
  ".task-label",
  ".task-meta",
  ".subagent",
  ".subagent-stop",
  ".subagent-head",
  ".subagent-glyph",
  ".subagent-title",
  ".subagent-count",
  ".subagent-prompt",
  ".subagent-activities",
  ".subagent-line",
  ".subagent-toggle",
  ".checkpoint-turn",
  ".checkpoint-row",
  ".checkpoint-time",
  ".checkpoint-path",
  ".history-root",
  ".restore-start",
  ".goal-badge",
  ".goal-summary",
  ".recovery-row",
  ".recovery-title",
  ".recovery-note",
  ".recovery-actions",
];

describe("死 UI（goals / subagents / checkpoints）已整块删除（D-185）", () => {
  it("协议层不认识这些类型，内核也没有对应的事件名（删除的前提）", () => {
    // `KNOWN_TYPES` is the renderer's whitelist of kernel event types. A type
    // missing here does not pass silently: it becomes an "unrecognised event"
    // warning, so these never drew anything from a real kernel — the handlers
    // were unreachable by construction.
    const protocol = readRenderer("protocol.js");
    const knownStart = protocol.indexOf("const KNOWN_TYPES = new Set([");
    expect(knownStart).toBeGreaterThan(-1);
    const knownEnd = protocol.indexOf("]);", knownStart);
    const known = protocol.slice(knownStart, knownEnd);
    for (const type of DEAD_EVENT_TYPES) {
      expect(known, `${type} is a known kernel type`).not.toContain(`"${type}"`);
    }
    // And the kernel's own event union does not name them either. `src/` is
    // what compiles to `dist/`, so it is the only place an event type can
    // originate.
    const kernel = readRepo("src/loop/events.ts");
    for (const type of ["goal_start", "goal_round", "goal_end", "subagent_start", "subagents", "checkpoints"]) {
      expect(kernel).not.toContain(type);
    }
    // `recovery` is a renderer-only name too: the host never sends it.
    expect(readRepo("desktop/host/host.js")).not.toContain('type: "recovery"');
  });

  it("渲染层不再有这些事件的 case 分支", () => {
    const app = readRenderer("app.js");
    for (const type of DEAD_EVENT_TYPES) {
      expect(app, `case "${type}" still handled`).not.toContain(`case "${type}"`);
    }
  });

  it("渲染层不再有只属于这三块的符号", () => {
    // `settings.js` is included because a stray helper there would be just as
    // orphaned as one in `app.js`; the scan costs nothing and closes the gap a
    // revert proved was open.
    const files = ["app.js", "settings.js", "index.html", "styles.css"];
    const offenders = [];
    for (const file of files) {
      const text = readRenderer(file);
      for (const symbol of DEAD_SYMBOLS) {
        if (text.includes(symbol)) offenders.push(`${file}: ${symbol}`);
      }
    }
    expect(offenders).toStrictEqual([]);
  });

  it("没有残留的 DOM 入口（goal 徽标、任务页、检查点页）", () => {
    const html = readRenderer("index.html");
    for (const id of ["goal-badge", "goal-badge-text", "tasks-root", "tasks-list", "history-root", "checkpoint-list"]) {
      expect(html, `${id} still in index.html`).not.toContain(`id="${id}"`);
    }
  });

  it("两种语言的字典里这些键都不在了", () => {
    const missing = [];
    for (const locale of ["en", "zh"]) {
      for (const key of DEAD_KEYS) {
        if (Object.hasOwn(dictionaries[locale], key)) missing.push(`${locale}.${key}`);
      }
    }
    expect(missing).toStrictEqual([]);
  });

  it("样式表里没有只给这三块用的选择器", () => {
    const css = readRenderer("styles.css");
    const offenders = [];
    for (const selector of DEAD_SELECTORS) {
      // Word-boundary-ish: `.subagent` must not match `.subagentX`, and a class
      // used as a prefix elsewhere would still be an orphan here.
      const pattern = new RegExp(`${selector.replace(/[.]/g, "\\.")}(?![\\w-])`);
      if (pattern.test(css)) offenders.push(selector);
    }
    expect(offenders).toStrictEqual([]);
  });

  it("保留的东西仍有生产者：todos / background_result 不受牵连", () => {
    // The deletion must not have taken a live handler with it. Both types are
    // in the protocol's known set and have kernel producers (`todo_write`,
    // `summary.background_result` / the host's 1s completion pump).
    const protocol = readRenderer("protocol.js");
    const knownStart = protocol.indexOf("const KNOWN_TYPES = new Set([");
    const known = protocol.slice(knownStart, protocol.indexOf("]);", knownStart));
    expect(known).toContain('"todos"');
    expect(known).toContain('"background_result"');
    const app = readRenderer("app.js");
    expect(app).toContain('case "todos"');
    // `background_result` is consumed one layer down: the protocol turns it
    // into `background_report`, which is what the renderer draws.
    expect(protocol).toContain('case "background_result"');
    expect(app).toContain('case "background_report"');
  });
});
