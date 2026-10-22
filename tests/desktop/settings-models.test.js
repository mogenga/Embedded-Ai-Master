import { describe, expect, it } from "vitest";
import { availableModelEntries, connectionSummary } from "../../desktop/renderer/settings-models.js";

describe("availableModelEntries", () => {
  it("丢掉非字符串、空白与首尾空格", () => {
    expect(availableModelEntries(["  deepseek-chat  ", "", "   ", null, 42, "qwen-max"], [])).toEqual([
      { name: "deepseek-chat", alreadyListed: false },
      { name: "qwen-max", alreadyListed: false },
    ]);
  });

  it("按 trim 后的名字去重，保留第一次出现的顺序", () => {
    expect(availableModelEntries(["b", " a ", "b", "a"], [])).toEqual([
      { name: "b", alreadyListed: false },
      { name: "a", alreadyListed: false },
    ]);
  });

  it("已在卡片里的模型不丢弃，只标记 alreadyListed", () => {
    expect(availableModelEntries(["a", "b", "c"], [" b ", "c"])).toEqual([
      { name: "a", alreadyListed: false },
      { name: "b", alreadyListed: true },
      { name: "c", alreadyListed: true },
    ]);
  });

  it("listedIds 也按 trim 匹配", () => {
    expect(availableModelEntries(["deepseek-chat"], ["deepseek-chat "])).toEqual([
      { name: "deepseek-chat", alreadyListed: true },
    ]);
  });

  it("输入不是数组时返回空列表", () => {
    expect(availableModelEntries(null, [])).toEqual([]);
    expect(availableModelEntries(undefined, undefined)).toEqual([]);
    expect(availableModelEntries("deepseek-chat", [])).toEqual([]);
  });

  it("listedIds 不是数组时按全未列出处理", () => {
    expect(availableModelEntries(["a"], null)).toEqual([{ name: "a", alreadyListed: false }]);
  });
});

describe("connectionSummary", () => {
  it("中文：模型数与延迟", () => {
    expect(connectionSummary("zh", { modelCount: 3, latencyMs: 125 })).toBe(
      "连接正常 · 3 个模型可用 · 125 ms",
    );
  });

  it("中文：延迟未知时不写这一段", () => {
    expect(connectionSummary("zh", { modelCount: 3 })).toBe("连接正常 · 3 个模型可用");
    expect(connectionSummary("zh", { modelCount: 3, latencyMs: Number.NaN })).toBe("连接正常 · 3 个模型可用");
    expect(connectionSummary("zh", { modelCount: 3, latencyMs: Number.POSITIVE_INFINITY })).toBe(
      "连接正常 · 3 个模型可用",
    );
  });

  it("中文：0 个模型是另一句话，不是「0 个模型可用」", () => {
    expect(connectionSummary("zh", { modelCount: 0, latencyMs: 125 })).toBe("端点可达，但没能列出模型");
  });

  it("英文：单复数正确", () => {
    expect(connectionSummary("en", { modelCount: 1 })).toBe("Connected · 1 model available");
    expect(connectionSummary("en", { modelCount: 3 })).toBe("Connected · 3 models available");
  });

  it("英文：延迟四舍五入到毫秒", () => {
    expect(connectionSummary("en", { modelCount: 1, latencyMs: 88.4 })).toBe(
      "Connected · 1 model available · 88 ms",
    );
  });

  it("英文：0 个模型", () => {
    expect(connectionSummary("en", { modelCount: 0 })).toBe(
      "The endpoint answered, but it did not list any models.",
    );
  });

  it("未知 locale 退回英文", () => {
    expect(connectionSummary("fr", { modelCount: 2 })).toBe("Connected · 2 models available");
  });
});
