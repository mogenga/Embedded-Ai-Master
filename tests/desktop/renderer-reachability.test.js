import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dictionaries } from "../../desktop/renderer/i18n.js";

/**
 * Static checks for three surfaces the renderer gained without a DOM to test
 * them in (OPT-04 / OPT-18 / OPT-19).
 *
 * The repository has no jsdom and adding one is a new dependency the user has
 * not approved, so these read the sources the way `composer-copy.test.js`
 * does: the thing being asserted is not behaviour but *wiring* — a command
 * that has a caller, a DOM id that has a listener, a class the stylesheet and
 * the code agree on. That is exactly the class of bug all three of these
 * started as (an entry point nobody could reach, a handler with no producer,
 * a field dropped between two layers).
 */
const RENDERER = path.join(import.meta.dirname, "..", "..", "desktop", "renderer");
const read = (name) => readFileSync(path.join(RENDERER, name), "utf8");

// 这里原本是「产物面板可达」一整组（⋯ 菜单入口、getArtifacts、页签回到列表、
// 工具行的「预览」入口、空态文案）。2026-11-09 产物面板按用户要求删除，
// 这一组没有可断言的界面了。

describe("evidence 出口（OPT-19 的渲染侧）", () => {
  it("转录里有「只看证据」开关，并绑定了翻转处理", () => {
    const html = read("index.html");
    expect(html).toContain('id="evidence-filter"');
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('data-i18n="evidenceFilter"');
    const app = read("app.js");
    expect(app).toContain('$("evidence-filter").addEventListener("click"');
    expect(app).toContain("setEvidenceFilter(!state.evidenceOnly)");
    expect(app).toContain("function setEvidenceFilter(");
  });

  it("过滤由状态 + 样式规则完成，不是每次事件遍历 DOM", () => {
    const app = read("app.js");
    const css = read("styles.css");
    expect(app).toContain("state.evidenceOnly");
    expect(app).toContain("document.documentElement.classList.toggle(\"evidence-only\"");
    // The rule keys off the same attribute the protocol carries, and both
    // sides of the toggle are covered by a selector.
    expect(css).toContain(":root.evidence-only");
    expect(css).toContain('[data-evidence="true"]');
    // The switch's pressed state has its own style; without it the control
    // looks identical on and off.
    expect(css).toContain('.status-tab-filter[aria-pressed="true"]');
  });

  it("打开筛选时把证据行的输出块展开，否则只看得见工具名", () => {
    const app = read("app.js");
    expect(app).toContain("function revealEvidenceOutput()");
    const setter = app.slice(app.indexOf("function setEvidenceFilter(on)"));
    expect(setter.slice(0, 400)).toContain("revealEvidenceOutput()");
    // A result arriving after the filter was switched on must be revealed
    // too; otherwise the newest evidence stays folded behind its chevron.
    const end = app.slice(app.indexOf('case "tool_end"'));
    expect(end.slice(0, end.indexOf('case "tool_output"'))).toContain("revealEvidenceOutput()");
  });

  it("行上的 evidence 来自 tool_end 的布尔判定，缺省不写", () => {
    const app = read("app.js");
    const start = app.indexOf('case "tool_end"');
    expect(start).toBeGreaterThan(-1);
    const block = app.slice(start, app.indexOf('case "tool_output"', start));
    expect(block).toContain("typeof message.evidence === \"boolean\"");
    expect(block).toContain("row.dataset.evidence = String(message.evidence)");
    // The reopened transcript carries the same verdict, or the filter would
    // only work on turns run in this window.
    const replay = app.slice(app.indexOf('case "session_loaded"'));
    expect(replay).toContain("if (typeof item.evidence === \"boolean\") row.dataset.evidence");
  });

  it("空态有一句话，且随语言切换；两种语言都在", () => {
    const html = read("index.html");
    expect(html).toContain('id="evidence-empty"');
    expect(html).toContain('data-i18n="evidenceFilterEmpty"');
    for (const locale of ["en", "zh"]) {
      const text = dictionaries[locale].evidenceFilterEmpty;
      expect(typeof text).toBe("string");
      expect(text.trim()).not.toBe("");
    }
    expect(dictionaries.en.evidenceFilterEmpty).not.toBe(dictionaries.zh.evidenceFilterEmpty);
    // Derived visibility, re-applied on a language switch as well.
    const app = read("app.js");
    expect(app).toContain("function renderEvidenceFilter()");
    expect(app.slice(app.indexOf("function applyLocale("))).toContain("renderEvidenceFilter();");
  });

  it("会话边界把过滤器复位，不把上一个会话的筛选带过来", () => {
    const app = read("app.js");
    // New session.
    const startSession = app.slice(app.indexOf("function startSessionIn(target)"));
    expect(startSession.slice(0, 500)).toContain("setEvidenceFilter(false)");
    // Opening a session.
    const loaded = app.slice(app.indexOf('case "session_loaded"'));
    const nextCase = loaded.indexOf('case "', 10);
    expect(loaded.slice(0, nextCase === -1 ? undefined : nextCase)).toContain("setEvidenceFilter(false)");
  });
});
