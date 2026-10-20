import { describe, expect, it } from "vitest";
import { parseDeviceStatus } from "../src/mcp/device-status.js";

describe("parseDeviceStatus", () => {
  it("接受普通对象并保留原引用", () => {
    const state = { probe: "attached" };
    const result = parseDeviceStatus(state);

    expect(result).toEqual({ ok: true, value: { state: { probe: "attached" } } });
    if (result.ok) {
      expect(result.value.state).toBe(state);
    }
  });

  it("拒绝 null / 数组 / 原始值", () => {
    for (const value of [null, [], "x", 1, true, undefined]) {
      expect(parseDeviceStatus(value).ok).toBe(false);
    }
  });

  it("容器深度最多 4 层", () => {
    expect(parseDeviceStatus({ a: { b: { c: { d: { e: "x" } } } } }).ok).toBe(false);
    expect(parseDeviceStatus({ a: { b: { c: { d: "x" } } } }).ok).toBe(true);
    expect(parseDeviceStatus({ a: [[[["x"]]]] }).ok).toBe(false);
    expect(parseDeviceStatus({ a: [[["x"]]] }).ok).toBe(true);
  });

  it("UTF-8 JSON 超过 8192 字节被拒绝", () => {
    expect(parseDeviceStatus({ big: "x".repeat(9000) }).ok).toBe(false);
    expect(parseDeviceStatus({ big: "中".repeat(2800) }).ok).toBe(false);
    expect(parseDeviceStatus({ ok: "x".repeat(100) }).ok).toBe(true);
  });

  it("循环引用返回失败而不是抛错", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    const result = parseDeviceStatus(cyclic);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
  });

  it("不执行对象上的 getter 或 toJSON", () => {
    let getterCalls = 0;
    let toJsonCalls = 0;
    const value = {
      toJSON() {
        toJsonCalls += 1;
        return { leak: true };
      },
    };
    Object.defineProperty(value, "probe", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "attached";
      },
    });

    const result = parseDeviceStatus(value);

    expect(result.ok).toBe(false);
    expect(getterCalls).toBe(0);
    expect(toJsonCalls).toBe(0);
  });

  it("数组按下标读取数据属性，不触发索引 getter 或自定义迭代器", () => {
    let indexGetterCalls = 0;
    let iteratorCalls = 0;
    const indexed: unknown[] = [];
    indexed.length = 1;
    Object.defineProperty(indexed, "0", {
      enumerable: true,
      get() {
        indexGetterCalls += 1;
        return "x";
      },
    });

    expect(parseDeviceStatus({ a: indexed }).ok).toBe(false);
    expect(indexGetterCalls).toBe(0);

    const iterated = ["x"];
    Object.defineProperty(iterated, Symbol.iterator, {
      enumerable: false,
      value: () => {
        iteratorCalls += 1;
        return [][Symbol.iterator]();
      },
    });
    expect(parseDeviceStatus({ a: iterated }).ok).toBe(true);
    expect(iteratorCalls).toBe(0);
  });

  it("拒绝稀疏数组空槽", () => {
    const sparse = new Array(1);

    expect(parseDeviceStatus({ a: sparse }).ok).toBe(false);
    expect(parseDeviceStatus({ a: [1, "x"] }).ok).toBe(true);
  });

  it("拒绝函数 / symbol / bigint 等非 JSON 值", () => {
    expect(parseDeviceStatus({ fn: () => 1 }).ok).toBe(false);
    expect(parseDeviceStatus({ sym: Symbol("x") }).ok).toBe(false);
    expect(parseDeviceStatus({ big: 1n }).ok).toBe(false);
  });
});