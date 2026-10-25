import { describe, expect, it } from "vitest";
import {
  nextThinkingExpanded,
  normalizeTranscriptView,
  thinkingExpandedOnEnd,
} from "../../desktop/renderer/thinking-view.js";

describe("normalizeTranscriptView", () => {
  it("verbose 保留：它还控制工具结果到达时是否直接展开", () => {
    expect(normalizeTranscriptView("verbose")).toBe("verbose");
  });

  it("normal 原样", () => {
    expect(normalizeTranscriptView("normal")).toBe("normal");
  });

  it("旧的 thinking 收敛为 normal：思考块现在由各自的标题栏控制", () => {
    // 这一档原先的意思是「显示思考正文」。每块都能自己展开之后，它就成了
    // 一个改了不产生任何效果的下拉值（R3：控件不许声称它没做的事）。
    expect(normalizeTranscriptView("thinking")).toBe("normal");
  });

  it("未知值与缺失值一律 normal", () => {
    expect(normalizeTranscriptView("expanded")).toBe("normal");
    expect(normalizeTranscriptView("")).toBe("normal");
    expect(normalizeTranscriptView(null)).toBe("normal");
    expect(normalizeTranscriptView(undefined)).toBe("normal");
  });

  it("只认精确的 verbose，大小写与其他拼写不生效", () => {
    expect(normalizeTranscriptView("VERBOSE")).toBe("normal");
    expect(normalizeTranscriptView(" verbose ")).toBe("normal");
  });
});

describe("nextThinkingExpanded", () => {
  it("折叠态点击展开", () => {
    expect(nextThinkingExpanded("false")).toBe(true);
  });

  it("展开态点击折叠", () => {
    expect(nextThinkingExpanded("true")).toBe(false);
  });

  it("属性缺失或拼错一律当作折叠，点一下就展开", () => {
    // 读的是 DOM 上的字符串；一个写坏的属性不能让整块永远打不开。
    expect(nextThinkingExpanded(undefined)).toBe(true);
    expect(nextThinkingExpanded(null)).toBe(true);
    expect(nextThinkingExpanded("")).toBe(true);
    expect(nextThinkingExpanded("TRUE")).toBe(true);
    expect(nextThinkingExpanded("1")).toBe(true);
  });

  it("连续点击在两态之间来回", () => {
    let attr;
    attr = nextThinkingExpanded(attr) ? "true" : "false";
    expect(attr).toBe("true");
    attr = nextThinkingExpanded(attr) ? "true" : "false";
    expect(attr).toBe("false");
    attr = nextThinkingExpanded(attr) ? "true" : "false";
    expect(attr).toBe("true");
  });
});

describe("thinkingExpandedOnEnd", () => {
  it("没被点过的块结束时自动收起成一行", () => {
    // 流式期间是展开的（看着它想），结束后收成一行等待读者点开。
    expect(thinkingExpandedOnEnd("true", undefined)).toBe(false);
    expect(thinkingExpandedOnEnd("true", "false")).toBe(false);
  });

  it("读者在流式期间点开过，结束时保持展开——自动折叠不许撤销那一次点击", () => {
    expect(thinkingExpandedOnEnd("true", "true")).toBe(true);
  });

  it("读者在流式期间点收了，结束时保持折叠", () => {
    expect(thinkingExpandedOnEnd("false", "true")).toBe(false);
  });
});
