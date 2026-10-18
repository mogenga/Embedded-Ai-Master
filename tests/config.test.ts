import { describe, expect, it } from "vitest";
import { resolveHarnessHome } from "../src/config/harness-home.js";
import {
  ConfigLoadError,
  ConfigValidationError,
  loadProviders,
  ModelReferenceError,
  parseProviders,
  resolveModelRef,
} from "../src/config/providers.js";

const GOOD = JSON.stringify({
  "local-gw": {
    protocol: "openai-chat-completions",
    baseUrl: "http://127.0.0.1:8080/v1",
    models: { flash: { contextWindow: 128000, maxOutput: 8192 } },
  },
});

describe("配置加载", () => {
  it("parseProviders 接受有效配置", () => {
    expect(parseProviders(GOOD)["local-gw"]?.models.flash.contextWindow).toBe(128000);
  });

  it("parseProviders 接受缺省 cachedInput 的价格表", () => {
    const text = JSON.stringify({
      "local-gw": {
        protocol: "openai-chat-completions",
        baseUrl: "http://127.0.0.1:8080/v1",
        models: { flash: { contextWindow: 128000, maxOutput: 8192 } },
        pricePerMillion: { input: 1, output: 2 },
      },
    });
    expect(parseProviders(text)["local-gw"]?.pricePerMillion).toEqual({ input: 1, output: 2 });
  });

  it("parseProviders 接受含 cachedInput 的正常价格", () => {
    const text = JSON.stringify({
      "local-gw": {
        protocol: "openai-chat-completions",
        baseUrl: "http://127.0.0.1:8080/v1",
        models: { flash: { contextWindow: 128000, maxOutput: 8192 } },
        pricePerMillion: { input: 1.5, output: 2.5, cachedInput: 0.5 },
      },
    });
    expect(parseProviders(text)["local-gw"]?.pricePerMillion).toEqual({
      input: 1.5,
      output: 2.5,
      cachedInput: 0.5,
    });
  });

  it("parseProviders 接受零价格", () => {
    const text = JSON.stringify({
      "local-gw": {
        protocol: "openai-chat-completions",
        baseUrl: "http://127.0.0.1:8080/v1",
        models: { flash: { contextWindow: 128000, maxOutput: 8192 } },
        pricePerMillion: { input: 0, output: 0, cachedInput: 0 },
      },
    });
    expect(parseProviders(text)["local-gw"]?.pricePerMillion).toEqual({
      input: 0,
      output: 0,
      cachedInput: 0,
    });
  });

  it("parseProviders 拒绝负 input 价格", () => {
    const text = JSON.stringify({
      "local-gw": {
        protocol: "openai-chat-completions",
        baseUrl: "http://127.0.0.1:8080/v1",
        models: { flash: { contextWindow: 128000, maxOutput: 8192 } },
        pricePerMillion: { input: -1, output: 2 },
      },
    });
    expect(() => parseProviders(text)).toThrowError(
      expect.objectContaining({ code: "providers_invalid" }),
    );
  });

  it("parseProviders 拒绝负 output 价格", () => {
    const text = JSON.stringify({
      "local-gw": {
        protocol: "openai-chat-completions",
        baseUrl: "http://127.0.0.1:8080/v1",
        models: { flash: { contextWindow: 128000, maxOutput: 8192 } },
        pricePerMillion: { input: 1, output: -2 },
      },
    });
    expect(() => parseProviders(text)).toThrowError(
      expect.objectContaining({ code: "providers_invalid" }),
    );
  });

  it("parseProviders 拒绝负 cachedInput 价格", () => {
    const text = JSON.stringify({
      "local-gw": {
        protocol: "openai-chat-completions",
        baseUrl: "http://127.0.0.1:8080/v1",
        models: { flash: { contextWindow: 128000, maxOutput: 8192 } },
        pricePerMillion: { input: 1, output: 2, cachedInput: -0.5 },
      },
    });
    expect(() => parseProviders(text)).toThrowError(
      expect.objectContaining({ code: "providers_invalid" }),
    );
  });

  it("parseProviders 拒绝缺少 contextWindow", () => {
    expect(() => parseProviders(JSON.stringify({
      p: { protocol: "openai-chat-completions", baseUrl: "http://x/v1", models: { m: { maxOutput: 1 } } },
    }))).toThrowError(expect.objectContaining({ code: "providers_invalid" }));
  });

  it("parseProviders 拒绝非法 JSON", () => {
    expect(() => parseProviders("{oops")).toThrowError(expect.objectContaining({
      code: "providers_invalid_json",
    }));
  });

  it("resolveModelRef 返回 provider 和 model", () => {
    expect(resolveModelRef(parseProviders(GOOD), "local-gw/flash")).toMatchObject({
      providerName: "local-gw",
      modelName: "flash",
      model: { contextWindow: 128000, maxOutput: 8192 },
    });
  });

  it("resolveModelRef 不存在时列出合法引用", () => {
    try {
      resolveModelRef(parseProviders(GOOD), "nope/x");
      expect.fail("应拒绝未知模型引用");
    } catch (error) {
      expect(error).toBeInstanceOf(ModelReferenceError);
      expect(error).toMatchObject({
        code: "model_reference_invalid",
        message: expect.stringContaining("local-gw/flash"),
        detail: { ref: "nope/x", validReferences: ["local-gw/flash"] },
      });
    }
  });

  it("HARNESS_HOME env 优先于缺省", () => {
    expect(resolveHarnessHome({ HARNESS_HOME: "C:/custom/home" })).toBe("C:/custom/home");
  });

  it("HARNESS_HOME 保留非空路径首尾空格", () => {
    expect(resolveHarnessHome({ HARNESS_HOME: "  C:/custom home  " })).toBe("  C:/custom home  ");
  });

  it("HARNESS_HOME 缺省时使用用户目录下的 .harness", () => {
    expect(resolveHarnessHome({})).toMatch(/\.harness$/);
  });

  it("HARNESS_HOME 为空或仅空白时使用用户目录下的 .harness", () => {
    expect(resolveHarnessHome({ HARNESS_HOME: "" })).toMatch(/\.harness$/);
    expect(resolveHarnessHome({ HARNESS_HOME: "   " })).toMatch(/\.harness$/);
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
