import { describe, expect, it } from "vitest";
import {
  availableModelEntries,
  carriedFromModel,
  connectionSummary,
  contextWindowChoices,
  contextWindowForSave,
  CONTEXT_WINDOW_CHOICES,
  modelEntryForSave,
  modelRowState,
  serviceHeaderFacts,
  serviceKeyKind,
  shortWindow,
} from "../../desktop/renderer/settings-models.js";

describe("availableModelEntries", () => {
  it("丢掉非字符串、空白与首尾空格", () => {
    expect(availableModelEntries(["  deepseek-chat  ", "", "   ", null, 42, "qwen-max"], [])).toEqual([
      { name: "deepseek-chat", alreadyListed: false },
      { name: "qwen-max", alreadyListed: false },
    ]);
  });

  it("按 trim 后的名字去重，保留第一次出现的顺序", () => {
    expect(availableModelEntries(["b", " a ", "b", "a"], [])).toEqual([
      { name: "b", alreadyListed: false },
      { name: "a", alreadyListed: false },
    ]);
  });

  it("已在卡片里的模型不丢弃，只标记 alreadyListed", () => {
    expect(availableModelEntries(["a", "b", "c"], [" b ", "c"])).toEqual([
      { name: "a", alreadyListed: false },
      { name: "b", alreadyListed: true },
      { name: "c", alreadyListed: true },
    ]);
  });

  it("listedIds 也按 trim 匹配", () => {
    expect(availableModelEntries(["deepseek-chat"], ["deepseek-chat "])).toEqual([
      { name: "deepseek-chat", alreadyListed: true },
    ]);
  });

  it("输入不是数组时返回空列表", () => {
    expect(availableModelEntries(null, [])).toEqual([]);
    expect(availableModelEntries(undefined, undefined)).toEqual([]);
    expect(availableModelEntries("deepseek-chat", [])).toEqual([]);
  });

  it("listedIds 不是数组时按全未列出处理", () => {
    expect(availableModelEntries(["a"], null)).toEqual([{ name: "a", alreadyListed: false }]);
  });
});

describe("connectionSummary", () => {
  it("中文：模型数与延迟", () => {
    expect(connectionSummary("zh", { modelCount: 3, latencyMs: 125 })).toBe(
      "连接正常 · 3 个模型可用 · 125 ms",
    );
  });

  it("中文：延迟未知时不写这一段", () => {
    expect(connectionSummary("zh", { modelCount: 3 })).toBe("连接正常 · 3 个模型可用");
    expect(connectionSummary("zh", { modelCount: 3, latencyMs: Number.NaN })).toBe("连接正常 · 3 个模型可用");
    expect(connectionSummary("zh", { modelCount: 3, latencyMs: Number.POSITIVE_INFINITY })).toBe(
      "连接正常 · 3 个模型可用",
    );
  });

  it("中文：0 个模型是另一句话，不是「0 个模型可用」", () => {
    expect(connectionSummary("zh", { modelCount: 0, latencyMs: 125 })).toBe("端点可达，但没能列出模型");
  });

  it("英文：单复数正确", () => {
    expect(connectionSummary("en", { modelCount: 1 })).toBe("Connected · 1 model available");
    expect(connectionSummary("en", { modelCount: 3 })).toBe("Connected · 3 models available");
  });

  it("英文：延迟四舍五入到毫秒", () => {
    expect(connectionSummary("en", { modelCount: 1, latencyMs: 88.4 })).toBe(
      "Connected · 1 model available · 88 ms",
    );
  });

  it("英文：0 个模型", () => {
    expect(connectionSummary("en", { modelCount: 0 })).toBe(
      "The endpoint answered, but it did not list any models.",
    );
  });

  it("未知 locale 退回英文", () => {
    expect(connectionSummary("fr", { modelCount: 2 })).toBe("Connected · 2 models available");
  });
});

describe("serviceKeyKind", () => {
  it("直接填了密钥就是 direct，即使还填了变量名", () => {
    expect(serviceKeyKind({ apiKey: "sk-abc", apiKeyEnv: "DEEPSEEK_API_KEY" })).toBe("direct");
  });

  it("只有变量名时是 env，不是「已配置」", () => {
    expect(serviceKeyKind({ apiKey: "", apiKeyEnv: "DEEPSEEK_API_KEY" })).toBe("env");
  });

  it("都空着（或只有空白）是 missing", () => {
    expect(serviceKeyKind({})).toBe("missing");
    expect(serviceKeyKind({ apiKey: "   ", apiKeyEnv: "\t" })).toBe("missing");
    expect(serviceKeyKind()).toBe("missing");
  });

  it("与内核同口径：trim 后为空就不算密钥", () => {
    expect(serviceKeyKind({ apiKey: " sk-x ", apiKeyEnv: "" })).toBe("direct");
  });
});

describe("serviceHeaderFacts", () => {
  it("模型数只算有名字的行，非有限数按 0", () => {
    expect(serviceHeaderFacts({ modelCount: 3 }).modelCount).toBe(3);
    expect(serviceHeaderFacts({ modelCount: Number.NaN }).modelCount).toBe(0);
    expect(serviceHeaderFacts({ modelCount: -2 }).modelCount).toBe(0);
    expect(serviceHeaderFacts({}).modelCount).toBe(0);
  });

  it("envName 只在 env 状态下给出，且是 trim 后的变量名", () => {
    expect(serviceHeaderFacts({ apiKeyEnv: "  KIMI_API_KEY " }).envName).toBe("KIMI_API_KEY");
    expect(serviceHeaderFacts({ apiKey: "sk-x", apiKeyEnv: "KIMI_API_KEY" }).envName).toBe("");
  });

  it("noBaseUrl 只看 trim 后是否为空：写了但写错不算「没填」", () => {
    expect(serviceHeaderFacts({ baseUrl: "  " }).noBaseUrl).toBe(true);
    expect(serviceHeaderFacts({ baseUrl: "not-a-url" }).noBaseUrl).toBe(false);
    expect(serviceHeaderFacts({}).noBaseUrl).toBe(true);
  });
});

/**
 * The page's round trip, without a DOM.
 *
 * `modelRowState` is what `addModelRow` calls to seed a row, and
 * `modelEntryForSave` is what `read()` calls to build the object it sends.
 * Chaining the two runs the same code the browser runs; only the `<select>`
 * element between them is missing, and it holds nothing but the string this
 * test passes as `selectValue`.
 */
const labels = {
  defaultLabel: "Default (128K)",
  customLabel: (n, short) => `Custom (${n} / ${short})`,
};

describe("contextWindowChoices", () => {
  it("默认档在最前，其后是六个档位", () => {
    const { options, selected } = contextWindowChoices(undefined, labels);
    expect(selected).toBe("");
    expect(options.map((option) => option.value)).toEqual([
      "",
      "32768",
      "65536",
      "131072",
      "200000",
      "262144",
      "1000000",
    ]);
    expect(options[0].label).toBe("Default (128K)");
    expect(options[1].label).toBe("32K");
    expect(options[6].label).toBe("1M");
  });

  it("已在档位里的值被选中", () => {
    expect(contextWindowChoices(200000, labels).selected).toBe("200000");
    // 恰好等于默认值也算「已选」，不另加自定义档：128000 是 128K 那一档。
    const at128k = contextWindowChoices(131072, labels);
    expect(at128k.selected).toBe("131072");
    expect(at128k.options).toHaveLength(7);
  });

  it("不在档位里的值单独加一档并选中，不会被静默改写", () => {
    const { options, selected } = contextWindowChoices(300000, labels);
    expect(selected).toBe("300000");
    expect(options).toHaveLength(8);
    const custom = options[options.length - 1];
    expect(custom).toEqual({ value: "300000", label: "Custom (300000 / 300K)" });
  });

  it("非正整数当作没有值：选默认，不加自定义档", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, "300000", null]) {
      const { options, selected } = contextWindowChoices(bad, labels);
      expect(selected).toBe("");
      expect(options).toHaveLength(7);
    }
  });
});

describe("shortWindow", () => {
  it("千与百万各自成单位，能整除时不带小数", () => {
    expect(shortWindow(300000)).toBe("300K");
    expect(shortWindow(1500000)).toBe("1.5M");
    expect(shortWindow(1000000)).toBe("1M");
    expect(shortWindow(999)).toBe("999");
  });
});

describe("contextWindowForSave", () => {
  it("空值表示「不写这个字段」", () => {
    expect(contextWindowForSave("")).toBeUndefined();
    expect(contextWindowForSave(undefined)).toBeUndefined();
    expect(contextWindowForSave(null)).toBeUndefined();
  });

  it("数字与数字字符串都写成数字", () => {
    expect(contextWindowForSave("300000")).toBe(300000);
    expect(contextWindowForSave("1")).toBe(1);
  });

  it("不是正整数的一律不写，而不是写 NaN", () => {
    expect(contextWindowForSave("abc")).toBeUndefined();
    expect(contextWindowForSave("0")).toBeUndefined();
    expect(contextWindowForSave("1.5")).toBeUndefined();
    expect(contextWindowForSave("-1")).toBeUndefined();
  });
});

describe("modelEntryForSave", () => {
  it("默认档把键删掉，而不是写成 undefined 或 128000", () => {
    const entry = modelEntryForSave({ maxOutput: 4096 }, "");
    expect(Object.hasOwn(entry, "contextWindow")).toBe(false);
    expect(entry).toEqual({ maxOutput: 4096 });
  });

  it("选具体档位写数字", () => {
    expect(modelEntryForSave({}, "65536")).toEqual({ contextWindow: 65536 });
  });

  it("不改动传进来的 carried", () => {
    const carried = { contextWindow: 300000, maxOutput: 4096 };
    modelEntryForSave(carried, "");
    expect(carried).toEqual({ contextWindow: 300000, maxOutput: 4096 });
  });
});

describe("上下文窗口往返", () => {
  it("文件里的 300000 经过建行与保存仍是 300000", () => {
    const saved = { contextWindow: 300000, maxOutput: 8192 };
    const row = modelRowState(saved, labels);
    expect(row.select.selected).toBe("300000");
    expect(Object.hasOwn(row.carried, "contextWindow")).toBe(false);
    expect(row.carried).toEqual({ maxOutput: 8192 });

    const written = modelEntryForSave(row.carried, row.select.selected);
    expect(written.contextWindow).toBe(300000);
    expect(written.maxOutput).toBe(8192);
    expect(written).toEqual(saved);
  });

  it("走真实入口链路也保留 300000：carriedFromModel → modelRowState → modelEntryForSave", () => {
    // `entryFrom` in settings.js does exactly this before handing a row to
    // `addModelRow`, and `addModelRow` hands that row to `modelRowState`.
    const providersFileModel = { contextWindow: 300000, maxOutput: 8192, supportsReasoning: true };
    const carried = carriedFromModel(providersFileModel);
    const row = modelRowState(carried, labels);
    expect(row.select.selected).toBe("300000");
    const written = modelEntryForSave(row.carried, row.select.selected);
    expect(written).toEqual(providersFileModel);
  });

  it("文件里本来没有这个字段的模型，往返后仍然没有", () => {
    const saved = { maxOutput: 8192, supportsReasoning: true };
    const row = modelRowState(saved, labels);
    expect(row.select.selected).toBe("");
    const written = modelEntryForSave(row.carried, row.select.selected);
    expect(Object.hasOwn(written, "contextWindow")).toBe(false);
    expect(written).toEqual(saved);
  });

  it("档位里的值往返不变", () => {
    for (const choice of CONTEXT_WINDOW_CHOICES) {
      const saved = { contextWindow: choice.value };
      const row = modelRowState(saved, labels);
      expect(modelEntryForSave(row.carried, row.select.selected)).toEqual(saved);
    }
  });

  it("用户主动换档才丢弃自定义值", () => {
    const row = modelRowState({ contextWindow: 300000 }, labels);
    expect(modelEntryForSave(row.carried, "65536")).toEqual({ contextWindow: 65536 });
    expect(modelEntryForSave(row.carried, "")).toEqual({});
  });

  it("carriedFromModel 丢掉 undefined，但保留 0 以外的假值判断不误伤 false", () => {
    expect(carriedFromModel({})).toEqual({});
    expect(carriedFromModel({ supportsReasoning: false })).toEqual({ supportsReasoning: false });
    expect(carriedFromModel(undefined)).toEqual({});
  });
});
