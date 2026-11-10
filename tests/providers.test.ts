import { describe, expect, it, vi } from "vitest";
import {
  acceptedEfforts,
  ConfigValidationError,
  DEFAULT_EFFORT_MAP,
  EFFORT_TIERS,
  EXTENDED_EFFORTS,
  effortRank,
  isEffortTier,
  parseProviders,
  REASONING_EFFORTS,
  resolveEffortTier,
  resolveTierAgainst,
} from "../src/config/providers.js";
import type { EffortTier, ModelCfg } from "../src/config/providers.js";
import { extractCatalog } from "../src/model/catalog.js";
import type { ModelCapability } from "../src/model/catalog.js";
import { createOpenAIProvider } from "../src/model/openai.js";

/**
 * 三级回退：网关目录 → `providers.json` 的 `reasoningLevels` → `effortMap`。
 *
 * 这一层测试守两件事：
 * 1. 四级优先级的**顺序**（显式否定 > 目录 > 配置 > 都没有）；
 * 2. `undefined`（不知道）与 `[]`（确实没有）不可混同——三级回退靠这个区分成立。
 */

function providersText(model: Record<string, unknown>): string {
  return JSON.stringify({
    gw: {
      protocol: "openai-chat-completions",
      baseUrl: "http://127.0.0.1:9/v1",
      models: { m: model },
    },
  });
}

function modelOf(model: Record<string, unknown>): ModelCfg {
  return parseProviders(providersText(model)).gw.models.m;
}

/** 两张真实能力表（2026-11-09 实测自用户网关）。 */
const GLM_5_2: ModelCapability = { efforts: ["high", "xhigh"] };
const SPACE_BUNNY: ModelCapability = { efforts: ["low", "medium", "high", "xhigh", "max"] };

describe("EXTENDED_EFFORTS / effortRank", () => {
  it("REASONING_EFFORTS 仍是五个安全值（扩展值不改写它）", () => {
    expect(REASONING_EFFORTS).toEqual(["none", "minimal", "low", "medium", "high"]);
    for (const value of EXTENDED_EFFORTS) {
      expect(REASONING_EFFORTS as readonly string[]).not.toContain(value);
    }
  });

  it("扩展值都是可解析的已知值", () => {
    expect(EXTENDED_EFFORTS).toEqual(["xhigh", "max", "ultra", "persistent"]);
    for (const value of EXTENDED_EFFORTS) {
      expect(effortRank(value)).toBeTypeOf("number");
    }
  });
});

describe("provider.json 的 reasoningLevels 校验", () => {
  it("已知协议值（含扩展值）被接受", () => {
    const levels = ["minimal", "low", "high", "xhigh", "max"];

    expect(modelOf({ reasoningLevels: levels }).reasoningLevels).toEqual(levels);
  });

  it("空数组合法：这是「这个模型确实一档都没有」", () => {
    expect(modelOf({ reasoningLevels: [] }).reasoningLevels).toEqual([]);
  });

  it("缺省保持 undefined（不补默认值）", () => {
    // 补一个默认值会把「没写」与「写了空」压成同一种，三级回退就少了一级。
    expect(modelOf({ reasoningLevels: undefined }).reasoningLevels).toBeUndefined();
    expect(Object.hasOwn(modelOf({}), "reasoningLevels")).toBe(false);
  });

  it.each<[string, unknown]>([
    ["未知值", ["turbo"]],
    ["档位名当值", ["galaxy"]],
    ["大写", ["HIGH"]],
    ["空字符串", [""]],
    ["数字", [3]],
    ["不是数组", "high"],
    ["对象", { high: true }],
  ])("%s 被拒绝", (_label, value) => {
    expect(() => parseProviders(providersText({ reasoningLevels: value }))).toThrowError(
      ConfigValidationError,
    );
  });

  it("报错列出合法值（R3：不只说「无效」）", () => {
    let caught: unknown;
    try {
      parseProviders(providersText({ reasoningLevels: ["turbo"] }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigValidationError);
    const message = (caught as Error).message;
    expect(message).toContain("turbo");
    expect(message).toContain("none, minimal, low, medium, high, xhigh, max, ultra, persistent");
    expect(message).toContain("reasoningLevels");
  });
});

describe("acceptedEfforts：四条优先级", () => {
  it("1. supportsReasoning: false 最优先，看都不看目录", () => {
    const cfg = modelOf({ supportsReasoning: false });

    expect(acceptedEfforts(cfg, SPACE_BUNNY)).toBeUndefined();
  });

  it("2. 网关目录优先于配置", () => {
    // 网关是执行方，它的表决定请求会不会被接受；配置是用户的猜测。
    const cfg = modelOf({ supportsReasoning: true, reasoningLevels: ["low"] });

    expect(acceptedEfforts(cfg, GLM_5_2)).toEqual(["high", "xhigh"]);
  });

  it("3. 没有目录时用 providers.json 的 reasoningLevels", () => {
    const cfg = modelOf({ supportsReasoning: true, reasoningLevels: ["low", "max"] });

    expect(acceptedEfforts(cfg)).toEqual(["low", "max"]);
  });

  it("4. 都没有时是 undefined（交给第三级回退）", () => {
    expect(acceptedEfforts(modelOf({ supportsReasoning: true }))).toBeUndefined();
  });

  it("目录条目存在但没报 efforts 时，继续往下回退到配置", () => {
    // 「目录说了别的字段」不等于「目录说了能力集合」。
    const cfg = modelOf({ reasoningLevels: ["high"] });

    expect(acceptedEfforts(cfg, { fixedEffort: "medium" })).toEqual(["high"]);
  });

  it("undefined 与 [] 都能表达，且不相等", () => {
    const unknown = acceptedEfforts(modelOf({ supportsReasoning: true }));
    const emptyFromCatalog = acceptedEfforts(modelOf({}), { efforts: [] });
    const emptyFromConfig = acceptedEfforts(modelOf({ reasoningLevels: [] }));

    expect(unknown).toBeUndefined();
    expect(emptyFromCatalog).toEqual([]);
    expect(emptyFromConfig).toEqual([]);
  });
});

describe("resolveTierAgainst：glm-5.2 的 {high, xhigh}", () => {
  const cfg = modelOf({});

  it.each<[EffortTier, string | null]>([
    ["low", null],
    ["medium", null],
    ["high", "high"],
    ["extra", "xhigh"],
    ["max", "xhigh"],
    ["galaxy", "xhigh"],
  ])("%s → %s", (tier, expected) => {
    expect(resolveTierAgainst(cfg, tier, GLM_5_2)).toBe(expected);
  });

  it("界面只剩 High / Extra 两档（去重后）", () => {
    const distinct = new Set(EFFORT_TIERS.map((tier) => resolveTierAgainst(cfg, tier, GLM_5_2)));

    expect([...distinct].filter((value) => value !== null)).toEqual(["high", "xhigh"]);
  });
});

describe("resolveTierAgainst：space-bunny 的 {low, medium, high, xhigh, max}", () => {
  const cfg = modelOf({});

  it.each<[EffortTier, string | null]>([
    ["low", "low"],
    ["medium", "medium"],
    ["high", "high"],
    ["extra", "xhigh"],
    ["max", "max"],
    ["galaxy", "max"],
  ])("%s → %s", (tier, expected) => {
    expect(resolveTierAgainst(cfg, tier, SPACE_BUNNY)).toBe(expected);
  });

  it("界面是 Low / Medium / High / Extra / Max 五档", () => {
    const distinct = new Set(EFFORT_TIERS.map((tier) => resolveTierAgainst(cfg, tier, SPACE_BUNNY)));

    expect([...distinct]).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });
});

describe("resolveTierAgainst：语义秩规则", () => {
  it("只有一个 low 时，所有档都落到 low（最高者就是它自己）", () => {
    const cfg = modelOf({});

    for (const tier of EFFORT_TIERS) {
      expect(resolveTierAgainst(cfg, tier, { efforts: ["low"] })).toBe("low");
    }
  });

  it("accepted 里有 none 时，凡是 ≤ 该档的最高者仍是 none", () => {
    // none 是 0：没有比它更低的候选，但它本身也不是任何档位的"最优解"，
    // 只要集合里还有别的候选，就会被更高的那个取代。
    const cfg = modelOf({});

    expect(resolveTierAgainst(cfg, "low", { efforts: ["none"] })).toBe("none");
    expect(resolveTierAgainst(cfg, "low", { efforts: ["none", "medium"] })).toBe("none");
    expect(resolveTierAgainst(cfg, "medium", { efforts: ["none", "medium"] })).toBe("medium");
  });

  it("不认识的秩不参与比较，也不被选中", () => {
    // 认不出的值是「目录报了什么我们不知道强弱的东西」，硬把它当成某档会
    // 伪造一个不存在的强弱关系。
    const cfg = modelOf({});

    expect(resolveTierAgainst(cfg, "galaxy", { efforts: ["turbo"] })).toBeNull();
    expect(resolveTierAgainst(cfg, "galaxy", { efforts: ["turbo", "high"] })).toBe("high");
  });

  it("空 accepted → 每一档都是 null（确实一档都没有）", () => {
    const cfg = modelOf({ reasoningLevels: [] });

    for (const tier of EFFORT_TIERS) {
      expect(resolveTierAgainst(cfg, tier)).toBeNull();
    }
  });

  it("非法档位与非档位输入被拒绝（与 resolveEffortTier 同一口径）", () => {
    for (const value of ["none", "minimal", "turbo", "HIGH", "", 3, null, undefined]) {
      expect(() =>
        resolveTierAgainst(modelOf({}), value as unknown as EffortTier, GLM_5_2),
      ).toThrowError(TypeError);
    }
  });
});

describe("resolveTierAgainst：没有 accepted 时回落到 resolveEffortTier", () => {
  it("逐档与 resolveEffortTier 结果相同（第三级回退的回归）", () => {
    const configs = [
      modelOf({}),
      modelOf({ supportsReasoning: true }),
      modelOf({ effortMap: { extra: "medium" } }),
      modelOf({
        effortMap: {
          low: "minimal",
          medium: "minimal",
          high: "medium",
          extra: "medium",
          max: "high",
          galaxy: "high",
        },
      }),
    ];

    for (const cfg of configs) {
      for (const tier of EFFORT_TIERS) {
        expect(resolveTierAgainst(cfg, tier)).toBe(resolveEffortTier(cfg, tier));
      }
    }
  });

  it("显式否定时也回落到 resolveEffortTier（目录被忽略）", () => {
    const cfg = modelOf({ supportsReasoning: false });

    for (const tier of EFFORT_TIERS) {
      expect(resolveTierAgainst(cfg, tier, SPACE_BUNNY)).toBe(resolveEffortTier(cfg, tier));
      expect(resolveTierAgainst(cfg, tier, SPACE_BUNNY)).toBe(DEFAULT_EFFORT_MAP[tier]);
    }
  });
});

describe("effortMap 只在没有 accepted 时生效", () => {
  it("有目录时 effortMap 完全不参与（不给第二个答案）", () => {
    const cfg = modelOf({ effortMap: { galaxy: "medium" } });

    expect(resolveTierAgainst(cfg, "galaxy", GLM_5_2)).toBe("xhigh");
    expect(resolveTierAgainst(cfg, "galaxy")).toBe("medium");
  });

  it("有 reasoningLevels 时 effortMap 也不参与", () => {
    const cfg = modelOf({ effortMap: { extra: "high" }, reasoningLevels: ["low", "max"] });

    expect(resolveTierAgainst(cfg, "extra")).toBe("low");
  });
});

describe("适配层只校验格式，不校验白名单", () => {
  /**
   * 白名单判断归 `acceptedEfforts` / `resolveTierAgainst`（上面那些用例）。
   * 适配层再持一份，就会和解析层各说各话：目录说 space-bunny 接受 `xhigh`，
   * 宿主选到 Extra 时算出 `xhigh`，适配层在这里把它拒掉，请求根本发不出去。
   */
  function construct(reasoningEffort: string): () => unknown {
    return () =>
      createOpenAIProvider({
        baseUrl: "http://gw/v1",
        model: "m",
        fetchImpl: (async () => {
          throw new Error("不应发出请求");
        }) as unknown as typeof fetch,
        reasoningEffort,
      });
  }

  it.each(["xhigh", "max", "ultra", "persistent", "turbo", "none"])(
    "目录可能报出的值 %s 能过构造期",
    (value) => {
      expect(construct(value)).not.toThrow();
    },
  );

  it.each<[string, string]>([
    ["空字符串", ""],
    ["前导空白", " high"],
    ["换行", "a\nb"],
    ["制表符", "a\tb"],
    ["NUL", "a\u0000b"],
  ])("%s 被拒绝（格式问题，不是白名单问题）", (_label, value) => {
    expect(construct(value)).toThrowError(TypeError);
    expect(construct(value)).toThrowError(/格式非法/);
  });

  it("拒绝发生在构造期，没有任何出站请求", () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    expect(() =>
      createOpenAIProvider({ baseUrl: "http://gw/v1", model: "m", fetchImpl, reasoningEffort: "" }),
    ).toThrowError(TypeError);
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
  });

  it("端到端：目录的 xhigh 一路走到请求体（回归点）", async () => {
    // 目录说 space-bunny 接受 xhigh → 选 Extra 时算出 xhigh → 适配层必须收下。
    // 适配层留一份白名单，这条链就会在这里断掉，请求根本发不出去。
    const catalog = extractCatalog({
      data: [{ id: "space-bunny", reasoning_efforts: ["low", "medium", "high", "xhigh", "max"] }],
    });
    const cfg = modelOf({});
    const resolved = resolveTierAgainst(cfg, "extra", catalog?.get("space-bunny"));
    expect(resolved).toBe("xhigh");

    const bodies: Array<Record<string, unknown>> = [];
    const okBody = { choices: [{ message: { content: "hi" }, finish_reason: "stop" }] };
    const impl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return {
        ok: true,
        status: 200,
        json: async () => okBody,
        text: async () => JSON.stringify(okBody),
      };
    }) as unknown as typeof fetch;

    await createOpenAIProvider({
      baseUrl: "http://gw/v1",
      model: "space-bunny",
      fetchImpl: impl,
      ...(resolved === null ? {} : { reasoningEffort: resolved }),
    }).complete([{ role: "user", content: "hi" }], [], {
      signal: new AbortController().signal,
      maxOutputTokens: 1,
    });

    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.reasoning_effort).toBe("xhigh");
  });
});
