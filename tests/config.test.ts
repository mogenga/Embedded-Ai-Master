import { describe, expect, it } from "vitest";
import { resolveHarnessHome } from "../src/config/harness-home.js";
import {
  ConfigLoadError,
  ConfigValidationError,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_OUTPUT,
  loadProviders,
  ModelReferenceError,
  parseProviders,
  resolveContextWindow,
  resolveMaxOutput,
  resolveModelRef,
  resolveProviderApiKey,
} from "../src/config/providers.js";

const GOOD = JSON.stringify({
  "local-gw": {
    protocol: "openai-chat-completions",
    baseUrl: "http://127.0.0.1:8080/v1",
    models: { flash: { contextWindow: 128000, maxOutput: 8192 } },
  },
});

describe("内核估算默认值（不是服务商真实上限）", () => {
  it("默认值就是既定常量", () => {
    expect(DEFAULT_CONTEXT_WINDOW).toBe(128_000);
    expect(DEFAULT_MAX_OUTPUT).toBe(4_096);
  });

  it("用户没填时 resolve 落到内核默认值", () => {
    expect(resolveContextWindow({})).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(resolveMaxOutput({})).toBe(DEFAULT_MAX_OUTPUT);
  });

  it("用户填了就以用户为准，不被默认值覆盖", () => {
    expect(resolveContextWindow({ contextWindow: 32_000, maxOutput: 1_024 })).toBe(32_000);
    expect(resolveMaxOutput({ contextWindow: 32_000, maxOutput: 1_024 })).toBe(1_024);
  });

  it("只填了一个字段时另一个仍走默认值", () => {
    expect(resolveContextWindow({ contextWindow: 32_000 })).toBe(32_000);
    expect(resolveMaxOutput({ contextWindow: 32_000 })).toBe(DEFAULT_MAX_OUTPUT);
    expect(resolveContextWindow({ maxOutput: 1_024 })).toBe(DEFAULT_CONTEXT_WINDOW);
    expect(resolveMaxOutput({ maxOutput: 1_024 })).toBe(1_024);
  });
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

  it("parseProviders 接受缺少 contextWindow/maxOutput 的模型：缺省为 undefined，由调用方兜底", () => {
    const parsed = parseProviders(JSON.stringify({
      p: { protocol: "openai-chat-completions", baseUrl: "http://x/v1", models: { m: {} } },
    }));
    // 缺省不是被填成默认值：读值的人必须显式兜底，才能让「用户没填」与
    // 「用户填了同一个数」在日志/设置页里保持可区分。
    expect(parsed.p?.models.m).toEqual({});
    expect(parsed.p?.models.m.contextWindow).toBeUndefined();
    expect(parsed.p?.models.m.maxOutput).toBeUndefined();
  });

  it("parseProviders 兼容旧文件：用户显式写下的 contextWindow/maxOutput 原样保留", () => {
    const parsed = parseProviders(JSON.stringify({
      p: {
        protocol: "openai-chat-completions",
        baseUrl: "http://x/v1",
        models: { m: { contextWindow: 32000, maxOutput: 1024 } },
      },
    }));
    expect(parsed.p?.models.m).toEqual({ contextWindow: 32000, maxOutput: 1024 });
  });

  it("parseProviders 仍拒绝非正整数的 contextWindow/maxOutput", () => {
    expect(() => parseProviders(JSON.stringify({
      p: { protocol: "openai-chat-completions", baseUrl: "http://x/v1", models: { m: { contextWindow: 0 } } },
    }))).toThrowError(expect.objectContaining({ code: "providers_invalid" }));
    expect(() => parseProviders(JSON.stringify({
      p: { protocol: "openai-chat-completions", baseUrl: "http://x/v1", models: { m: { maxOutput: 1.5 } } },
    }))).toThrowError(expect.objectContaining({ code: "providers_invalid" }));
  });

  it("parseProviders 接受直接写在文件里的 apiKey", () => {
    const parsed = parseProviders(JSON.stringify({
      p: {
        protocol: "openai-chat-completions",
        baseUrl: "http://x/v1",
        apiKey: "sk-direct-value",
        models: { m: {} },
      },
    }));
    expect(parsed.p?.apiKey).toBe("sk-direct-value");
    expect(parsed.p?.apiKeyEnv).toBeUndefined();
  });

  it("apiKey 与 apiKeyEnv 允许并存（schema 不互斥）", () => {
    const parsed = parseProviders(JSON.stringify({
      p: {
        protocol: "openai-chat-completions",
        baseUrl: "http://x/v1",
        apiKey: "sk-direct",
        apiKeyEnv: "SOME_ENV_NAME",
        models: { m: {} },
      },
    }));
    expect(parsed.p?.apiKey).toBe("sk-direct");
    expect(parsed.p?.apiKeyEnv).toBe("SOME_ENV_NAME");
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

  it.each(["local-gw/__proto__", "local-gw/constructor", "local-gw/toString"])(
    "resolveModelRef 拒绝原型链模型键 %s",
    (ref) => {
      expect(() => resolveModelRef(parseProviders(GOOD), ref)).toThrowError(ModelReferenceError);
    },
  );

  it.each(["__proto__/flash", "constructor/flash", "toString/flash"])(
    "resolveModelRef 拒绝原型链 provider 键 %s",
    (ref) => {
      expect(() => resolveModelRef(parseProviders(GOOD), ref)).toThrowError(ModelReferenceError);
    },
  );

  it("模型引用解析后仍能取到调用方兜底前的原始值", () => {
    const resolved = resolveModelRef(
      parseProviders(JSON.stringify({
        p: { protocol: "openai-chat-completions", baseUrl: "http://x/v1", models: { m: {} } },
      })),
      "p/m",
    );
    expect(resolved.model.contextWindow).toBeUndefined();
    expect(resolved.model.maxOutput).toBeUndefined();
  });

  it("HARNESS_HOME env 优先于缺省", () => {
    expect(resolveHarnessHome({ HARNESS_HOME: "C:/custom/home" })).toBe("C:/custom/home");
  });

  it("HARNESS_HOME 返回 trim 后的路径", () => {
    expect(resolveHarnessHome({ HARNESS_HOME: "  C:/custom home  " })).toBe("C:/custom home");
  });

  it("HARNESS_HOME 缺省时使用用户目录下的 .harness", () => {
    expect(resolveHarnessHome({})).toMatch(/\.harness$/);
  });

  it("HARNESS_HOME 为空或仅空白时使用用户目录下的 .harness", () => {
    expect(resolveHarnessHome({ HARNESS_HOME: "" })).toMatch(/\.harness$/);
    expect(resolveHarnessHome({ HARNESS_HOME: "   " })).toMatch(/\.harness$/);
  });

  // D-170：测试忘了隔离就会写进用户真实配置目录，且事后难以追溯来源。
  // 这里宁可硬失败，也不返回一个「看起来能用」的真实路径。
  describe("D-170 vitest 环境下的 home 隔离守卫", () => {
    it("VITEST 下没有 HARNESS_HOME 时抛错，且错误信息说明原因", () => {
      let caught: unknown;
      try {
        resolveHarnessHome({ VITEST: "true" });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      const message = (caught as Error).message;
      expect(message).toContain("VITEST");
      expect(message).toContain("HARNESS_HOME");
      expect(message).toContain("harnessHome");
      // 错误不得把真实 home 泄露成「可用值」。
      expect(message).not.toMatch(/\.harness/);
    });

    it("NODE_ENV=test 同样触发守卫", () => {
      expect(() => resolveHarnessHome({ NODE_ENV: "test" })).toThrowError(/HARNESS_HOME/);
    });

    it("VITEST 下设置了 HARNESS_HOME 时正常返回，不抛错", () => {
      expect(resolveHarnessHome({ VITEST: "true", HARNESS_HOME: "C:/tmp/isolated" })).toBe(
        "C:/tmp/isolated",
      );
    });

    it("非测试环境行为不变：没有 HARNESS_HOME 时仍返回用户目录下的 .harness", () => {
      expect(resolveHarnessHome({ NODE_ENV: "production" })).toMatch(/\.harness$/);
      expect(resolveHarnessHome({ VITEST: "" })).toMatch(/\.harness$/);
    });
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

/**
 * 密钥解析：桌面应用的用户不可能为了填一个 key 去设系统环境变量，
 * 所以 providers.json 允许直接存密钥（`apiKey`）。`apiKeyEnv` 仍然支持，
 * 供「不把密钥落到配置文件」的用户使用。
 *
 * 优先级是**显式值覆盖间接值**：同时存在时 `apiKey` 赢。
 * 空值（""、纯空白）一律等于没配，任何一层都不把空串当有效密钥发出去。
 */
describe("resolveProviderApiKey", () => {
  const env = { PROVIDER_KEY_ENV: "  from-env  " } as NodeJS.ProcessEnv;

  it("只有 apiKey 时直接返回（trim 后）", () => {
    expect(resolveProviderApiKey({ apiKey: "  sk-direct  " }, env)).toBe("sk-direct");
  });

  it("apiKey 与 apiKeyEnv 并存时 apiKey 优先", () => {
    expect(
      resolveProviderApiKey({ apiKey: "sk-direct", apiKeyEnv: "PROVIDER_KEY_ENV" }, env),
    ).toBe("sk-direct");
  });

  it("只有 apiKeyEnv 时取该环境变量的值（trim 后）", () => {
    expect(resolveProviderApiKey({ apiKeyEnv: "PROVIDER_KEY_ENV" }, env)).toBe("from-env");
  });

  it("什么都没配时返回 undefined", () => {
    expect(resolveProviderApiKey({}, env)).toBeUndefined();
  });

  it("apiKey 为空串等于没配：回落到 apiKeyEnv", () => {
    expect(
      resolveProviderApiKey({ apiKey: "", apiKeyEnv: "PROVIDER_KEY_ENV" }, env),
    ).toBe("from-env");
    expect(resolveProviderApiKey({ apiKey: "" }, env)).toBeUndefined();
  });

  it("apiKey 只有空白也等于没配", () => {
    expect(resolveProviderApiKey({ apiKey: "   " }, env)).toBeUndefined();
    expect(
      resolveProviderApiKey({ apiKey: "  ", apiKeyEnv: "PROVIDER_KEY_ENV" }, env),
    ).toBe("from-env");
  });

  it("apiKeyEnv 指向不存在的变量时返回 undefined", () => {
    expect(resolveProviderApiKey({ apiKeyEnv: "NO_SUCH_ENV_VAR_HERE" }, env)).toBeUndefined();
  });

  it("apiKeyEnv 指向的变量是空串或纯空白时返回 undefined", () => {
    const blankEnv = { BLANK_KEY: "   ", EMPTY_KEY: "" } as NodeJS.ProcessEnv;
    expect(resolveProviderApiKey({ apiKeyEnv: "BLANK_KEY" }, blankEnv)).toBeUndefined();
    expect(resolveProviderApiKey({ apiKeyEnv: "EMPTY_KEY" }, blankEnv)).toBeUndefined();
  });

  it("apiKeyEnv 本身是空串或纯空白时视为未配置", () => {
    expect(resolveProviderApiKey({ apiKeyEnv: "" }, env)).toBeUndefined();
    expect(resolveProviderApiKey({ apiKeyEnv: "   " }, env)).toBeUndefined();
  });

  it("apiKey 为空但 apiKeyEnv 指向缺失变量时仍返回 undefined", () => {
    expect(
      resolveProviderApiKey({ apiKey: "", apiKeyEnv: "NO_SUCH_ENV_VAR_HERE" }, env),
    ).toBeUndefined();
  });

  it("默认读 process.env（不显式传 env 时）", () => {
    // 用当前进程里必然存在的一个变量证明默认参数接的是 process.env。
    const name = "PATH";
    const value = process.env.PATH?.trim();
    expect(resolveProviderApiKey({ apiKeyEnv: name })).toBe(
      value === undefined || value === "" ? undefined : value,
    );
  });
});
