import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 模型选择器里「厂商轨」的状态归属（2026-11-10 用户报告）。
 *
 * 用户原话：「在模型选择界面，切换厂商后，若不点击模型进行切换直接关闭，再次
 * 打开还是切换后的厂商，而不是当前使用的模型的厂商」。
 *
 * 厂商轨是面板的**视图过滤**，不是选择：点它只换右边列出的模型，不换模型本身。
 * 既然如此，它就不该跨面板存活——关掉再打开，面板必须重新指向**当前在用的
 * 模型**所在的厂商。之前它只在"该厂商已不在列表里"时才重置，所以翻到别家、
 * 看一眼、关掉，下次打开仍停在别家。
 *
 * 仓库没有 jsdom，这条测的是**接线**而不是行为：重置发生在 `openModelMenu`
 * 里（打开那一刻），且用的值是当前模型。
 *
 * 另有渲染函数内部那一处 fallback，职责不同（面板开着时列表变了），保留它，
 * 本文件也钉住它还在——两处的条件不能合并，合并会重新打开这个缺陷。
 */
const RENDERER = path.join(import.meta.dirname, "..", "..", "desktop", "renderer");
const read = (name) => readFileSync(path.join(RENDERER, name), "utf8");

/** 取自 `effort-slider.test.js`：从 `header` 起到同缩进的 `}` 为止。 */
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

describe("厂商轨每次打开都回到当前模型的厂商", () => {
  it("openModelMenu 在画之前把 rail 重置成当前模型的 provider", () => {
    const app = read("app.js");
    const body = bodyOf(app, "function openModelMenu() {");
    expect(body).toContain("state.modelRailProvider = providerOf(state.model");
    // 必须在 `renderModelMenu()` **之前**：那个函数读这个状态决定列哪些模型，
    // 写在它后面等于这一次打开仍用旧值，下一次才生效。
    const resetAt = body.indexOf("state.modelRailProvider = providerOf(");
    const renderAt = body.indexOf("renderModelMenu()");
    expect(renderAt).toBeGreaterThan(-1);
    expect(resetAt).toBeLessThan(renderAt);
  });

  it("`providerOf` 是 rail 与当前模型之间的唯一换算点", () => {
    const app = read("app.js");
    // 两处都调同一个函数：自己再写一次 `split("/")[0]` 会在 provider 名里
    // 带斜杠时给出两个答案。
    expect(app).toContain("function providerOf(");
    const opens = bodyOf(app, "function openModelMenu() {");
    expect(opens).toContain("providerOf(");
  });

  it("渲染函数里的 fallback 仍在，但它不是打开时的重置", () => {
    const app = read("app.js");
    const body = bodyOf(app, "function renderModelMenu() {");
    // 面板**开着**时列表变了（`models` 事件裁掉正在看的厂商）：rail 不能指向
    // 一个不存在的分组。条件仍然是「当前值不在 groups 里」。
    expect(body).toContain("!groups.some((group) => group.provider === state.modelRailProvider)");
    // 这条 fallback 不能挪进 `openModelMenu` 顶替打开时的无条件重置：
    // 切换厂商后那个值仍在组里，条件不成立，缺陷就回来了。
    const opens = bodyOf(app, "function openModelMenu() {");
    expect(opens).not.toContain("!groups.some(");
  });
});
