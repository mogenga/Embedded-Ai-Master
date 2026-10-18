import { describe, expect, it } from "vitest";
import { createTokenMeter } from "../src/context/token-meter.js";
import type { ModelChatMessage } from "../src/model/protocol.js";

const messages: ModelChatMessage[] = [{ role: "user", content: "hello" }];

describe("TokenMeter", () => {
  it("初始 ratio=1，measure 等于启发式计数", () => {
    const meter = createTokenMeter(() => 100);

    expect(meter.ratio()).toBe(1);
    expect(meter.measure(messages)).toBe(100);
  });

  it("observe 按 usage 锚定并做 EMA", () => {
    const meter = createTokenMeter(() => 100);

    meter.observe(200, messages);

    expect(meter.ratio()).toBe(1.5);
    expect(meter.measure(messages)).toBe(150);
  });

  it("observe 对整十倍用量做 EMA", () => {
    const meter = createTokenMeter(() => 100);

    meter.observe(150, messages);

    expect(meter.ratio()).toBe(1.25);
    expect(meter.measure(messages)).toBe(125);
  });

  it("clamp 下界 0.5", () => {
    const meter = createTokenMeter(() => 100);

    meter.observe(1, messages);

    expect(meter.ratio()).toBe(0.75);
    expect(meter.measure(messages)).toBe(75);
  });

  it("clamp 上界 2.0", () => {
    const meter = createTokenMeter(() => 100);

    meter.observe(5000, messages);

    expect(meter.ratio()).toBe(1.5);
    expect(meter.measure(messages)).toBe(150);
  });

  it("非法 usage 不更新 ratio", () => {
    const meter = createTokenMeter(() => 100);

    meter.observe(0, messages);
    meter.observe(-10, messages);
    meter.observe(Number.NaN, messages);
    meter.observe(Number.POSITIVE_INFINITY, messages);
    meter.observe(Number.NEGATIVE_INFINITY, messages);

    expect(meter.ratio()).toBe(1);
    expect(meter.measure(messages)).toBe(100);
  });

  it("heuristic 为 0 时用 max(1, ...) 避免除零", () => {
    const meter = createTokenMeter(() => 0);

    meter.observe(2, messages);

    expect(meter.ratio()).toBe(1.5);
    expect(meter.measure(messages)).toBe(0);
  });

  it("measure 对启发式结果乘 ratio 后向上取整", () => {
    const meter = createTokenMeter(() => 5);

    meter.observe(100, messages);

    expect(meter.ratio()).toBe(1.5);
    expect(meter.measure(messages)).toBe(8);
  });

  it("measure 使用调用时传入的消息", () => {
    const meter = createTokenMeter((m) => m.length * 10);

    meter.observe(20, messages);

    expect(meter.ratio()).toBe(1.5);
    expect(meter.measure(messages)).toBe(15);
    expect(meter.measure([...messages, ...messages])).toBe(30);
  });

  it("多次 observe 连续收敛", () => {
    const meter = createTokenMeter(() => 100);

    meter.observe(200, messages);
    meter.observe(200, messages);
    meter.observe(200, messages);

    expect(meter.ratio()).toBe(1.875);
    expect(meter.measure(messages)).toBe(188);
  });
});