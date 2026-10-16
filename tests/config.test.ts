import { describe, expect, it } from "vitest";
import { resolveHarnessHome } from "../src/config/harness-home.js";
import {
  ConfigLoadError,
  ConfigValidationError,
  loadProviders,
  parseProviders,
  resolveModelRef,
} from "../src/config/providers.js";

const GOOD = JSON.stringify({
  providers: {
    "local-gw": {
      protocol: "openai-chat-completions",
      baseUrl: "http://127.0.0.1:8080/v1",
      models: { flash: { contextWindow: 128000, maxOutput: 8192 } },
    },
  },
});

describe("配置加载", () => {
  it("parseProviders 接受有效配置", () => {
    expect(parseProviders(GOOD).providers["local-gw"]?.models.flash.contextWindow).toBe(128000);
  });

  it("parseProviders 拒绝缺少 contextWindow", () => {
    expect(() => parseProviders(JSON.stringify({
      providers: { p: { protocol: "openai-chat-completions", baseUrl: "http://x/v1", models: { m: { maxOutput: 1 } } } },
    }))).toThrowError(expect.objectContaining({ code: "providers_invalid" }));
  });

  it("parseProviders 拒绝非法 JSON", () => {
    expect(() => parseProviders("{oops")).toThrowError(expect.objectContaining({
      code: "providers_invalid_json",
    }));
  });

  it("resolveModelRef 返回 provider 和 model", () => {
    expect(resolveModelRef(parseProviders(GOOD).providers, "local-gw/flash")).toMatchObject({
      providerName: "local-gw",
      modelName: "flash",
      model: { contextWindow: 128000, maxOutput: 8192 },
    });
  });

  it("resolveModelRef 不存在时列出合法引用", () => {
    expect(() => resolveModelRef(parseProviders(GOOD).providers, "nope/x")).toThrow(/local-gw\/flash/);
  });

  it("HARNESS_HOME env 优先于缺省", () => {
    expect(resolveHarnessHome({ HARNESS_HOME: "C:/custom/home" })).toBe("C:/custom/home");
  });

  it("HARNESS_HOME 缺省时使用用户目录下的 .harness", () => {
    expect(resolveHarnessHome({})).toMatch(/\.harness$/);
  });

  it("loadProviders 文件缺失抛 providers_not_found", () => {
    expect(() => loadProviders("/tmp/home", () => {
      const error = Object.assign(new Error("missing"), { code: "ENOENT" });
      throw error;
    })).toThrowError(ConfigLoadError);
    try {
      loadProviders("/tmp/home", () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); });
    } catch (error) {
      expect(error).toMatchObject({ code: "providers_not_found" });
    }
  });

  it("loadProviders 读取错误抛 providers_read_failed", () => {
    expect(() => loadProviders("/tmp/home", () => { throw new Error("permission denied"); })).toThrowError(
      expect.objectContaining({ code: "providers_read_failed" }),
    );
  });

  it("loadProviders 不把坏 JSON 误分类为读取错误", () => {
    expect(() => loadProviders("/tmp/home", () => "{oops")).toThrowError(
      expect.objectContaining({ code: "providers_invalid_json" }),
    );
    expect(() => loadProviders("/tmp/home", () => "{oops")).not.toThrowError(ConfigLoadError);
    expect(ConfigValidationError).toBeDefined();
  });
});
