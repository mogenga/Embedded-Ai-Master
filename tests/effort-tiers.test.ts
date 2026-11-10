import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConfigValidationError,
  DEFAULT_EFFORT_MAP,
  EFFORT_TIERS,
  isEffortTier,
  parseProviders,
  REASONING_EFFORTS,
  resolveEffortTier,
} from "../src/config/providers.js";
import type { EffortTier, ModelCfg } from "../src/config/providers.js";
import { runSession } from "../src/index.js";

/**
 * 六档是**界面语言**，不是协议值。
 *
 * 这一层测试守的是那条边界：界面上的 `extra` / `max` / `galaxy` 可以在内核里
 * 流动，但请求体里只允许出现 `REASONING_EFFORTS` 那五个。任何时候这里出现
 * 一个 `"galaxy"` 上了线，就说明映射被绕过了。
 */

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "effort-tiers-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function providersText(models: Record<string, Record<string, unknown>>): string {
  return JSON.stringify({
    gw: {
      protocol: "openai-chat-completions",
      baseUrl: "http://127.0.0.1:9/v1",
      models,
    },
  });
}

function modelOf(model: Record<string, unknown>): ModelCfg {
  return parseProviders(providersText({ m: model })).gw.models.m;
}

const EMPTY_RESPONSE = {
  choices: [{ message: { content: "done" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1 },
};

/** Capture every request body `runSession` puts on the wire. */
function capturingFetch(impl?: (url: string | URL | Request, init?: RequestInit) => Promise<unknown>) {
  const calls: Array<Record<string, unknown>> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    if (impl !== undefined) return await impl(url, init);
    return {
      ok: true,
      status: 200,
      json: async () => EMPTY_RESPONSE,
      text: async () => JSON.stringify(EMPTY_RESPONSE),
    };
  }) as unknown as typeof fetch;
  return { impl: fetchImpl, calls };
}

async function collect(generator: AsyncGenerator<unknown>): Promise<void> {
  for await (const _event of generator) {
    // 只关心请求体，事件本身不在此处断言。
  }
}

async function runWithReasoningEffort(
  reasoningEffort: unknown,
  models: Record<string, Record<string, unknown>> = { m: {} },
): Promise<Record<string, unknown>> {
  const home = await tempDir();
  vi.stubEnv("HARNESS_HOME", home);
  const fetch = capturingFetch();
  await collect(
    runSession({
      input: "hi",
      model: "gw/m",
      providersText: providersText(models),
      sessionDir: path.join(home, "session"),
      fetchImpl: fetch.impl,
      reasoningEffort: reasoningEffort as never,
    }),
  );
  expect(fetch.calls).toHaveLength(1);
  return fetch.calls[0] as Record<string, unknown>;
}

describe("六档常量", () => {
  it("EFFORT_TIERS 是稳定升序的六档", () => {
    expect(EFFORT_TIERS).toEqual(["low", "medium", "high", "extra", "max", "galaxy"]);
  });

  it("档位与协议白名单不重叠地扩张：协议值一个都没多", () => {
    // 这条是整层的护栏：`max` 进 EFFORT_TIERS 不等于进 REASONING_EFFORTS。
    expect(REASONING_EFFORTS).toEqual(["none", "minimal", "low", "medium", "high"]);
    for (const tier of ["extra", "max", "galaxy"]) {
      expect(REASONING_EFFORTS as readonly string[]).not.toContain(tier);
    }
  });

  it("isEffortTier 只认六档", () => {
    for (const tier of EFFORT_TIERS) expect(isEffortTier(tier)).toBe(true);
    for (const other of ["none", "minimal", "turbo", "HIGH", "", " high", 3, true, null, undefined]) {
      expect(isEffortTier(other)).toBe(false);
    }
  });
});

describe("resolveEffortTier：缺省映射", () => {
  it("六档分别解析为 low/medium/high/high/high/high", () => {
    const cfg = modelOf({});
    expect(EFFORT_TIERS.map((tier) => resolveEffortTier(cfg, tier))).toEqual([
      "low",
      "medium",
      "high",
      "high",
      "high",
      "high",
    ]);
  });

  it("DEFAULT_EFFORT_MAP 与上面的解析结果一致", () => {
    expect(DEFAULT_EFFORT_MAP).toEqual({
      low: "low",
      medium: "medium",
      high: "high",
      extra: "high",
      max: "high",
      galaxy: "high",
    });
  });

  it("每个解析结果都在协议白名单里（档位永远到不了请求体）", () => {
    const cfg = modelOf({});
    for (const tier of EFFORT_TIERS) {
      expect(REASONING_EFFORTS as readonly string[]).toContain(resolveEffortTier(cfg, tier));
    }
  });
});

describe("resolveEffortTier：逐档覆盖", () => {
  it("只改 extra 时其余仍走缺省", () => {
    const cfg = modelOf({ effortMap: { extra: "medium" } });

    expect(resolveEffortTier(cfg, "extra")).toBe("medium");
    expect(EFFORT_TIERS.map((tier) => resolveEffortTier(cfg, tier))).toEqual([
      "low",
      "medium",
      "high",
      "medium",
      "high",
      "high",
    ]);
  });
});

describe("resolveEffortTier：全档覆盖", () => {
  it("六档全覆盖时缺省表完全不被使用", () => {
    const cfg = modelOf({
      effortMap: {
        low: "minimal",
        medium: "minimal",
        high: "medium",
        extra: "medium",
        max: "high",
        galaxy: "high",
      },
    });

    // 每个值都与默认表不同（或至少与默认表在该档的取值不同），所以只要有一处
    // 回落到 DEFAULT_EFFORT_MAP，这条断言就会红。
    const resolved = EFFORT_TIERS.map((tier) => resolveEffortTier(cfg, tier));
    expect(resolved).toEqual(["minimal", "minimal", "medium", "medium", "high", "high"]);
    for (const tier of EFFORT_TIERS) {
      if (tier === "max" || tier === "galaxy") continue;
      expect(resolveEffortTier(cfg, tier)).not.toBe(DEFAULT_EFFORT_MAP[tier]);
    }
  });
});

describe("resolveEffortTier：非法档位", () => {
  it.each(["none", "minimal", "turbo", "HIGH", "", 3, null, undefined])(
    "拒绝非档位输入 %s（不静默落回 high）",
    (value) => {
      // 类型层挡 TS 调用方，但宿主是 JS，读的是 JSON 字符串；运行期必须也挡。
      expect(() => resolveEffortTier(modelOf({}), value as unknown as EffortTier)).toThrowError(
        TypeError,
      );
    },
  );

  it("报错里带档位白名单", () => {
    expect(() => resolveEffortTier(modelOf({}), "none" as never)).toThrowError(
      /low, medium, high, extra, max, galaxy/,
    );
  });
});

describe("providers.json 的 effortMap 校验", () => {
  it("接受只覆盖一档的写法（不是必须六档全写）", () => {
    const parsed = parseProviders(providersText({ m: { effortMap: { extra: "medium" } } }));
    expect(parsed.gw.models.m.effortMap).toEqual({ extra: "medium" });
  });

  it("接受六档全覆盖", () => {
    const map = {
      low: "low",
      medium: "medium",
      high: "high",
      extra: "high",
      max: "high",
      galaxy: "high",
    };
    expect(parseProviders(providersText({ m: { effortMap: map } })).gw.models.m.effortMap).toEqual(
      map,
    );
  });

  it("缺省不补默认表：effortMap 保持 undefined", () => {
    // 与 contextWindow 同理：补一张默认表会让「用户没配」与「用户配了默认值」
    // 不可区分，而设置页整份写回时会把那张表写进用户文件。
    expect(modelOf({})).toStrictEqual({});
  });

  it("未知档位名被拒绝，错误信息含档位白名单", () => {
    let caught: unknown;
    try {
      parseProviders(providersText({ m: { effortMap: { turbo: "high" } } }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigValidationError);
    const message = (caught as Error).message;
    expect(message).toContain("turbo");
    expect(message).toContain("low, medium, high, extra, max, galaxy");
  });

  it("未知协议值（值里写档位名）被拒绝", () => {
    expect(() =>
      parseProviders(providersText({ m: { effortMap: { max: "xhigh" } } })),
    ).toThrowError(ConfigValidationError);
    // 把档位名写进值里也是错的：值只能是协议值。
    expect(() =>
      parseProviders(providersText({ m: { effortMap: { max: "galaxy" } } })),
    ).toThrowError(ConfigValidationError);
  });

  it("effortMap 不是对象时被拒绝", () => {
    for (const value of ["high", 3, [], null, true]) {
      expect(() =>
        parseProviders(providersText({ m: { effortMap: value } })),
      ).toThrowError(ConfigValidationError);
    }
  });

  it("__proto__ 不会被当成一个能改写原型的档位", () => {
    const parsed = parseProviders(
      JSON.stringify({
        gw: {
          protocol: "openai-chat-completions",
          baseUrl: "http://x/v1",
          models: { m: { effortMap: JSON.parse('{"__proto__":"high"}') } },
        },
      }),
    );
    // Zod 写输出时跳过 `__proto__`（否则会撞上原型 setter），所以它既不是档位
    // 也没有污染原型；解析结果里不含它。
    expect(parsed.gw.models.m.effortMap).toEqual({});
    expect(({} as Record<string, unknown>)["high"]).toBeUndefined();
  });
});

describe("端到端：档位在请求体里已折算成协议值", () => {
  it("reasoningEffort: galaxy → 请求体 reasoning_effort === high", async () => {
    const body = await runWithReasoningEffort("galaxy");
    expect(body.reasoning_effort).toBe("high");
  });

  it("reasoningEffort: extra / max 也落到 high（缺省表）", async () => {
    expect((await runWithReasoningEffort("extra")).reasoning_effort).toBe("high");
    expect((await runWithReasoningEffort("max")).reasoning_effort).toBe("high");
  });

  it("reasoningEffort: minimal → 请求体原样是 minimal（协议值不被映射改写）", async () => {
    const body = await runWithReasoningEffort("minimal");
    expect(body.reasoning_effort).toBe("minimal");
  });

  it("模型配了 effortMap 时档位按该表折算", async () => {
    const body = await runWithReasoningEffort("galaxy", {
      m: { effortMap: { galaxy: "medium" } },
    });
    expect(body.reasoning_effort).toBe("medium");
  });

  it("请求体里永远不会出现档位名", async () => {
    for (const tier of EFFORT_TIERS) {
      const body = await runWithReasoningEffort(tier);
      expect(REASONING_EFFORTS as readonly string[]).toContain(body.reasoning_effort);
    }
  });

  it("档位覆盖仍压过模型配置里的默认等级", async () => {
    const body = await runWithReasoningEffort("extra", { m: { reasoningEffort: "low" } });
    expect(body.reasoning_effort).toBe("high");
  });

  it("没有覆盖时模型配置的默认等级照旧生效（档位逻辑不改变既有路径）", async () => {
    const home = await tempDir();
    vi.stubEnv("HARNESS_HOME", home);
    const fetch = capturingFetch();
    await collect(
      runSession({
        input: "hi",
        model: "gw/m",
        providersText: providersText({ m: { reasoningEffort: "low" } }),
        sessionDir: path.join(home, "session"),
        fetchImpl: fetch.impl,
      }),
    );
    expect(fetch.calls[0]?.reasoning_effort).toBe("low");
  });
});
