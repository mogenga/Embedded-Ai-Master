import { describe, expect, it } from "vitest";
import { settingsFailure } from "../../desktop/renderer/settings.js";

/**
 * The pure half of OPT-08: "which settings page must show this refusal".
 *
 * The dialog is a `showModal()` over the transcript, so a save that fails and
 * only answers with a plain `notice` looks exactly like a click that did
 * nothing (R3). The host tags those notices with `domain: "settings"` and the
 * page id; this mapping decides whether the open page consumes one, or whether
 * it belongs in the transcript where every other notice goes.
 */
describe("settingsFailure", () => {
  it("四个保存命令的失败各归其页", () => {
    const notice = (page, text) => ({ type: "notice", level: "warn", domain: "settings", page, text });
    expect(settingsFailure(notice("mcp", "MCP 配置未保存：disk full"))).toStrictEqual({
      page: "mcp",
      text: "MCP 配置未保存：disk full",
    });
    expect(settingsFailure(notice("behavior", "权限配置未保存：x")).page).toBe("behavior");
    expect(settingsFailure(notice("behavior", "运行参数未保存：x")).page).toBe("behavior");
    expect(settingsFailure(notice("connection", "模型配置未保存：x")).page).toBe("connection");
  });

  it("error 级别的失败同样归页", () => {
    expect(
      settingsFailure({ level: "error", domain: "settings", page: "mcp", text: "坏了" }),
    ).toStrictEqual({ page: "mcp", text: "坏了" });
  });

  it("没有 domain 的普通 notice 不属于设置页", () => {
    expect(settingsFailure({ type: "notice", level: "warn", text: "当前回合尚未结束" })).toBeNull();
    expect(settingsFailure({ type: "notice", level: "warn", page: "mcp", text: "x" })).toBeNull();
  });

  it("skills 域有它自己的旧路由，不走这条", () => {
    expect(
      settingsFailure({ type: "notice", level: "warn", domain: "skills", page: "mcp", text: "x" }),
    ).toBeNull();
  });

  it("不认识的页不消费：宁可在转录里看见，也不画到错误的页上", () => {
    expect(
      settingsFailure({ type: "notice", level: "warn", domain: "settings", page: "kernel", text: "x" }),
    ).toBeNull();
    expect(
      settingsFailure({ type: "notice", level: "warn", domain: "settings", text: "x" }),
    ).toBeNull();
  });

  it("info 不是失败：它不画错误条", () => {
    expect(
      settingsFailure({ type: "notice", level: "info", domain: "settings", page: "mcp", text: "x" }),
    ).toBeNull();
  });

  it("没有文字的 notice 不消费，免得画出一条空的红线", () => {
    expect(
      settingsFailure({ type: "notice", level: "warn", domain: "settings", page: "mcp", text: "  " }),
    ).toBeNull();
    expect(settingsFailure({ type: "notice", level: "warn", domain: "settings", page: "mcp" })).toBeNull();
  });

  it("不是对象时安全返回 null", () => {
    expect(settingsFailure(null)).toBeNull();
    expect(settingsFailure(undefined)).toBeNull();
    expect(settingsFailure("notice")).toBeNull();
  });
});
