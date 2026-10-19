import { describe, expect, it } from "vitest";
import { truncateSurrogateSafe } from "../src/context/text.js";

describe("truncateSurrogateSafe", () => {
  it("空串与非法上限返回空串", () => {
    expect(truncateSurrogateSafe("", 10)).toBe("");
    expect(truncateSurrogateSafe("abc", 0)).toBe("");
    expect(truncateSurrogateSafe("abc", -1)).toBe("");
    expect(truncateSurrogateSafe("abc", Number.NaN)).toBe("");
    expect(truncateSurrogateSafe("abc", Number.POSITIVE_INFINITY)).toBe("");
  });

  it("长度不超过上限时原样返回", () => {
    expect(truncateSurrogateSafe("abc", 3)).toBe("abc");
    expect(truncateSurrogateSafe("abc", 10)).toBe("abc");
  });

  it("按上限截断且不切断代理对", () => {
    expect(truncateSurrogateSafe("abcd", 3)).toBe("abc");
    expect(truncateSurrogateSafe("a😀b", 2)).toBe("a");
    expect(truncateSurrogateSafe("😀x", 1)).toBe("");
  });

  it("小数上限向下取整", () => {
    expect(truncateSurrogateSafe("abcd", 2.9)).toBe("ab");
  });
});