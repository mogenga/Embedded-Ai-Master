import { describe, expect, it } from "vitest";
import { onChangeMedia, resolveTheme } from "../../src/ui/theme.js";

describe("theme", () => {
  it("system 跟随 media", () => {
    expect(resolveTheme("system", "dark")).toBe("dark");
    expect(resolveTheme("system", "light")).toBe("light");
  });
  it("显式 choice 优先于 media", () => {
    expect(resolveTheme("dark", "light")).toBe("dark");
    expect(resolveTheme("light", "dark")).toBe("light");
  });
  it("onChangeMedia 映射 matches", () => {
    expect(onChangeMedia({ matches: true })).toBe("light");
    expect(onChangeMedia({ matches: false })).toBe("dark");
  });
});