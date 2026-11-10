import { describe, expect, it } from "vitest";
import { EFFORT_RANK, effortRank } from "../src/config/providers.js";
import { extractCatalog, parseCatalogEntry } from "../src/model/catalog.js";

/**
 * 网关能力目录的解析层。
 *
 * 这一层是外部输入的第一道门（`GET /v1/models` 的响应体），所以测试守的是
 * 诚实原则（R3）而不是「能解析出东西」：
 * - 认不出的形状必须返回 `undefined`，不能伪装成「没有能力」；
 * - 一个字段坏掉不牵连整条条目；
 * - 不认识的新档位不丢弃、不硬塞进秩序。
 */

describe("parseCatalogEntry：字段名别名表", () => {
  it.each<[string, string]>([
    ["可用档位", "reasoning_efforts"],
    ["可用档位", "supported_effort_levels"],
    ["可用档位", "reasoning_levels"],
    ["可用档位", "efforts"],
  ])("%s 的别名 %s 能被识别", (_label, key) => {
    const entry = { id: "m", [key]: ["low", "high"] };

    expect(parseCatalogEntry(entry)).toEqual({ efforts: ["low", "high"] });
  });

  it.each<[string, string]>([
    ["默认档", "reasoning_default_effort"],
    ["默认档", "default_reasoning_level"],
    ["默认档", "default_effort"],
  ])("%s 的别名 %s 能被识别", (_label, key) => {
    expect(parseCatalogEntry({ id: "m", [key]: "high" })).toEqual({ defaultEffort: "high" });
  });

  it.each<[string, string]>([
    ["锁死档", "reasoning_fixed_effort"],
    ["锁死档", "fixed_reasoning_effort"],
  ])("%s 的别名 %s 能被识别", (_label, key) => {
    expect(parseCatalogEntry({ id: "m", [key]: "medium" })).toEqual({ fixedEffort: "medium" });
  });

  it.each<[string, string]>([
    ["可关闭", "reasoning_can_disable"],
    ["可关闭", "can_disable_reasoning"],
  ])("%s 的别名 %s 能被识别", (_label, key) => {
    expect(parseCatalogEntry({ id: "m", [key]: false })).toEqual({ canDisable: false });
  });

  it("同一语义多个别名同时出现时，取别名表里第一个类型对的", () => {
    // 两个别名说的是同一件事，同时出现且互相矛盾时没有可信答案；取顺序里的
    // 第一个至少是确定的、可复现的。合并会造出一个哪家都没报过的集合。
    const entry = {
      reasoning_efforts: ["low"],
      supported_effort_levels: ["high"],
      efforts: ["max"],
    };

    expect(parseCatalogEntry(entry)).toEqual({ efforts: ["low"] });
  });

  it("排在前面的别名类型不对时，继续试后面的别名", () => {
    const entry = { reasoning_efforts: 3, supported_effort_levels: ["high"] };

    expect(parseCatalogEntry(entry)).toEqual({ efforts: ["high"] });
  });
});

describe("parseCatalogEntry：数组元素的两种形状", () => {
  it("嵌套形状：DeepSeek 的 effort.supported_levels（2026-11-10 实测）", () => {
    // 用户这台机器的 DeepSeek 官方 key 报的是这个形状，不是平铺的
    // `reasoning_efforts`。只支持平铺的话，那个模型会永远停在第 3 级。
    const entry = {
      id: "deepseek-flash",
      effort: { supported_levels: ["low", "high", "max"], default_level: "high" },
    };
    expect(parseCatalogEntry(entry)).toStrictEqual({
      efforts: ["low", "high", "max"],
      defaultEffort: "high",
    });
  });

  it("嵌套路径中途缺一层时，退回平铺别名", () => {
    // `effort` 不是对象（或者没有那个子键）不能挡住平铺字段。
    expect(parseCatalogEntry({ effort: "weird", reasoning_efforts: ["high"] }))
      .toStrictEqual({ efforts: ["high"] });
    expect(parseCatalogEntry({ effort: { default_level: "low" } }))
      .toStrictEqual({ defaultEffort: "low" });
  });

  it("字符串元素原样取用", () => {
    expect(parseCatalogEntry({ reasoning_efforts: ["low", "high"] })).toEqual({
      efforts: ["low", "high"],
    });
  });

  it("{ effort, description } 形状只取 effort", () => {
    const entry = {
      reasoning_efforts: [
        { effort: "low", description: "最快" },
        { effort: "high", description: "最慢" },
      ],
    };

    expect(parseCatalogEntry(entry)).toEqual({ efforts: ["low", "high"] });
  });

  it("两种形状可以混在同一个数组里", () => {
    const entry = { reasoning_efforts: ["low", { effort: "max" }] };

    expect(parseCatalogEntry(entry)).toEqual({ efforts: ["low", "max"] });
  });

  it("effort 不是字符串的那一项被跳过，其余项保留", () => {
    const entry = { reasoning_efforts: [{ effort: 5 }, "high", { description: "没有 effort" }] };

    expect(parseCatalogEntry(entry)).toEqual({ efforts: ["high"] });
  });

  it("数组里一个可用的项都没有时，efforts 是空数组（不是 undefined）", () => {
    // 网关确实报了这个字段、只是每项都认不出：这是「说了，但没有可用的值」。
    // 保留空数组，由调用方决定怎么显示，而不是替网关否认它说过话。
    expect(parseCatalogEntry({ reasoning_efforts: [3, null, {}] })).toEqual({ efforts: [] });
  });
});

describe("parseCatalogEntry：认不出的形状", () => {
  it.each<[string, unknown]>([
    ["null", null],
    ["数组", []],
    ["字符串", "high"],
    ["数字", 3],
    ["只有 id", { id: "m" }],
    ["只有无关字段", { id: "m", owned_by: "x", created: 1 }],
    ["所有字段类型都不对", { reasoning_efforts: "high", reasoning_can_disable: "yes" }],
  ])("%s → undefined（不是空对象，不是抛错）", (_label, entry) => {
    expect(parseCatalogEntry(entry)).toBeUndefined();
  });

  it("不抛错：坏字段与好字段混在一起时，只要有一个能认出就返回", () => {
    expect(
      parseCatalogEntry({ reasoning_efforts: 3, reasoning_default_effort: "high" }),
    ).toEqual({ defaultEffort: "high" });
  });
});

describe("parseCatalogEntry：去重与排序", () => {
  it("去重，顺序按强度序", () => {
    const entry = { reasoning_efforts: ["high", "low", "high", "medium", "low"] };

    expect(parseCatalogEntry(entry)?.efforts).toEqual(["low", "medium", "high"]);
  });

  it("完整强度序（含 none / minimal / xhigh / max）", () => {
    const entry = {
      reasoning_efforts: ["max", "medium", "none", "xhigh", "minimal", "low", "high"],
    };

    expect(parseCatalogEntry(entry)?.efforts).toEqual([
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("认不出秩的值不丢弃，保持出现顺序排在末尾", () => {
    // 网关明天可能报出一个我们不认识的新档位。丢弃等于替它删掉一个它确实
    // 接受的值；硬塞进秩序里又会伪造一个我们并不理解的强弱关系。
    const entry = { reasoning_efforts: ["turbo", "high", "quantum", "low"] };

    expect(parseCatalogEntry(entry)?.efforts).toEqual(["low", "high", "turbo", "quantum"]);
  });

  it("认不出秩的值同样去重", () => {
    expect(parseCatalogEntry({ efforts: ["turbo", "turbo", "low"] })?.efforts).toEqual([
      "low",
      "turbo",
    ]);
  });

  it("空字符串项被跳过", () => {
    expect(parseCatalogEntry({ efforts: ["", "low"] })?.efforts).toEqual(["low"]);
  });
});

describe("extractCatalog", () => {
  it("按模型 id 收能力，id 不重复", () => {
    const payload = {
      data: [
        {
          id: "space-bunny",
          supports_reasoning: true,
          reasoning_efforts: ["low", "medium", "high", "xhigh", "max"],
          reasoning_default_effort: "max",
          reasoning_can_disable: false,
        },
        { id: "glm-5.1", reasoning_fixed_effort: "medium" },
      ],
    };

    expect(extractCatalog(payload)).toEqual(
      new Map([
        [
          "space-bunny",
          {
            efforts: ["low", "medium", "high", "xhigh", "max"],
            defaultEffort: "max",
            canDisable: false,
          },
        ],
        ["glm-5.1", { fixedEffort: "medium" }],
      ]),
    );
  });

  it("只报 id、不带能力字段的条目被跳过（不是空能力）", () => {
    // 一个只有 id 的条目说明这个网关没实现该扩展；把它当成空能力塞进 Map，
    // 会让调用方以为「这个模型确实什么都不接受」，把第三级回退提前截断。
    const payload = { data: [{ id: "plain" }, { id: "rich", reasoning_efforts: ["low"] }] };

    const catalog = extractCatalog(payload);

    expect(catalog?.has("plain")).toBe(false);
    expect(catalog?.get("rich")).toEqual({ efforts: ["low"] });
  });

  it("形状认不出时返回 undefined（不是空 Map）", () => {
    for (const payload of [null, [], "nope", { models: [] }, { data: "nope" }]) {
      expect(extractCatalog(payload)).toBeUndefined();
    }
  });

  it("形状认得但一个能力都没有时返回空 Map（不是 undefined）", () => {
    // `undefined` 是「目录不可用」，空 Map 是「目录可用，但没有任何模型报能力」。
    // 两者都会让第三级回退生效，但只有后者能说明网关确实应答过。
    expect(extractCatalog({ data: [] })).toEqual(new Map());
    expect(extractCatalog({ data: [{ id: "plain" }] })).toEqual(new Map());
  });

  it("没有 id 或 id 为空的条目被跳过，不抛错", () => {
    const payload = {
      data: [{ reasoning_efforts: ["low"] }, { id: "", reasoning_efforts: ["low"] }, null, 3],
    };

    expect(extractCatalog(payload)).toEqual(new Map());
  });
});

describe("effortRank", () => {
  it("强度序单调且覆盖全部已知值", () => {
    const ordered = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

    for (let index = 1; index < ordered.length; index += 1) {
      expect(effortRank(ordered[index] as string)).toBeGreaterThan(
        effortRank(ordered[index - 1] as string) as number,
      );
    }
  });

  it("ultra 与 persistent 同为最高秩（不编造强弱关系）", () => {
    expect(effortRank("ultra")).toBe(EFFORT_RANK.ultra);
    expect(effortRank("persistent")).toBe(EFFORT_RANK.persistent);
  });

  it("认不出的值返回 undefined（不猜）", () => {
    for (const value of ["turbo", "HIGH", "", "extra", "galaxy"]) {
      expect(effortRank(value)).toBeUndefined();
    }
  });
});
