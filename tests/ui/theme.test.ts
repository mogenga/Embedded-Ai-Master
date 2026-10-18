// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  applyTheme,
  onChangeMedia,
  persistTheme,
  readStoredTheme,
  resolveTheme,
} from "../../src/ui/theme.js";

describe("theme", () => {
  it("system 跟随 media", () => {
    expect(resolveTheme("system", "dark")).toBe("dark");
    expect(resolveTheme("system", "light")).toBe("light");
  });
  it("显式 choice 优先于 media", () => {
    expect(resolveTheme("dark", "light")).toBe("dark");
    expect(resolveTheme("light", "dark")).toBe("light");
  });
  it("非法存储值回落 system", () => {
    localStorage.setItem("eam-theme", "banana");
    expect(readStoredTheme()).toBe("system");
  });
  it("无存储值时默认 system", () => {
    localStorage.removeItem("eam-theme");
    expect(readStoredTheme()).toBe("system");
  });
  it("applyTheme 写入 data-theme", () => {
    applyTheme("light", "dark");
    expect(document.documentElement.dataset.theme).toBe("light");
  });
  it("applyTheme 保留 system 交由 CSS 媒体查询解析", () => {
    applyTheme("system", "dark");
    expect(document.documentElement.dataset.theme).toBe("system");
  });
  it("onChangeMedia 映射 matches", () => {
    expect(onChangeMedia({ matches: true })).toBe("light");
    expect(onChangeMedia({ matches: false })).toBe("dark");
  });
  it("persistTheme 写入 localStorage", () => {
    persistTheme("dark");
    expect(localStorage.getItem("eam-theme")).toBe("dark");
  });
});