import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeProviders } from "../src/config/app-config.js";
import {
  ConfigValidationError,
  parseProviders,
  resolveReasoningEffort,
  supportsReasoning,
} from "../src/config/providers.js";
import type { ModelCfg, ProvidersConfig } from "../src/config/providers.js";

const homes: string[] = [];

function makeHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "eam-providers-effort-"));
  homes.push(home);
  return home;
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function fileWith(model: Record<string, unknown>): string {
  return JSON.stringify({
    gw: {
      protocol: "openai-chat-completions",
      baseUrl: "http://gw/v1",
      models: { flash: model },
    },
  });
}

function modelOf(model: Record<string, unknown>): ModelCfg {
  return parseProviders(fileWith(model)).gw.models.flash;
}

describe("providers.json 的推理强度字段", () => {
  it("supportsReasoning 与 reasoningEffort 原样读回", () => {
    const providers = parseProviders(
      fileWith({ supportsReasoning: true, reasoningEffort: "high" }),
    );

    expect(providers.gw.models.flash).toStrictEqual({
      supportsReasoning: true,
      reasoningEffort: "high",
    });
  });

  it("缺省时不补默认值", () => {
    // 与 contextWindow 同理：缺省必须保持 undefined，读值方才能区分「没填」与
    // 「填了恰好等于默认值的值」——推理强度没有默认值，凭空补一个会改变所有
    // 既有用户的请求。
    expect(modelOf({})).toStrictEqual({});
  });

  it.each<[string, unknown]>([
    ["max", "max"],
    ["xhigh", "xhigh"],
    ["大小写不符", "HIGH"],
    ["数字", 3],
    ["布尔", true],
  ])("非法的 reasoningEffort（%s）在解析时被拒绝", (_label, value) => {
    expect(() => parseProviders(fileWith({ reasoningEffort: value }))).toThrowError(
      ConfigValidationError,
    );
    // 报错必须指名字段，用户才知道改哪一行（R3）。
    expect(() => parseProviders(fileWith({ reasoningEffort: value }))).toThrowError(
      /reasoningEffort/,
    );
  });

  it("显式 none 是合法值，且与缺省不同", () => {
    const none = modelOf({ reasoningEffort: "none" });
    const absent = modelOf({});

    expect(none.reasoningEffort).toBe("none");
    expect(absent.reasoningEffort).toBeUndefined();
    expect(resolveReasoningEffort(none)).toBe("none");
    expect(resolveReasoningEffort(absent)).toBeUndefined();
  });

  it("supportsReasoning: false 与 reasoningEffort 并存时被拒绝", () => {
    // 显式说「不支持」又写了一个等级，是自相矛盾的配置：无论信哪一半，
    // 另一半都会在某个界面上被当成事实展示。
    expect(() =>
      parseProviders(fileWith({ supportsReasoning: false, reasoningEffort: "low" })),
    ).toThrowError(/supportsReasoning/);
  });
});

describe("supportsReasoning / resolveReasoningEffort", () => {
  it("supportsReasoning: true 即声明支持", () => {
    expect(supportsReasoning(modelOf({ supportsReasoning: true }))).toBe(true);
  });

  it("只写了 reasoningEffort 也算声明支持（值本身就是声明）", () => {
    expect(supportsReasoning(modelOf({ reasoningEffort: "low" }))).toBe(true);
  });

  it("两者都没有就是不支持", () => {
    expect(supportsReasoning(modelOf({ contextWindow: 1000 }))).toBe(false);
  });

  it("显式 false 就是不支持", () => {
    expect(supportsReasoning(modelOf({ supportsReasoning: false }))).toBe(false);
  });

  it("override 优先于模型配置", () => {
    expect(resolveReasoningEffort(modelOf({ reasoningEffort: "high" }), "minimal")).toBe("minimal");
  });

  it("没有 override 时用模型配置", () => {
    expect(resolveReasoningEffort(modelOf({ reasoningEffort: "high" }))).toBe("high");
  });

  it("两边都没有时是 undefined（调用方据此不发该字段）", () => {
    expect(resolveReasoningEffort(modelOf({ supportsReasoning: true }))).toBeUndefined();
  });
});

describe("providers.json 落盘往返", () => {
  it("写入后再读回，推理强度字段仍在", async () => {
    const home = makeHome();
    const input: ProvidersConfig = parseProviders(
      fileWith({ supportsReasoning: true, reasoningEffort: "medium" }),
    );

    const written = await writeProviders(home, input);

    expect(written.gw.models.flash).toStrictEqual({
      supportsReasoning: true,
      reasoningEffort: "medium",
    });
    expect(readFileSync(path.join(home, "providers.json"), "utf8")).toContain(
      '"reasoningEffort": "medium"',
    );
    expect(parseProviders(readFileSync(path.join(home, "providers.json"), "utf8")).gw.models.flash)
      .toStrictEqual({ supportsReasoning: true, reasoningEffort: "medium" });
  });

  it("非法等级在落盘前被拒绝，原文件不受影响", async () => {
    const home = makeHome();
    await writeProviders(home, parseProviders(fileWith({ reasoningEffort: "low" })));
    const before = readFileSync(path.join(home, "providers.json"), "utf8");

    // 设置页整份写回，所以这里也整份给：只有改坏的那一个字段不同。
    await expect(
      writeProviders(home, {
        gw: {
          protocol: "openai-chat-completions",
          baseUrl: "http://gw/v1",
          models: { flash: { reasoningEffort: "xhigh" } },
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_config" });

    expect(readFileSync(path.join(home, "providers.json"), "utf8")).toBe(before);
  });
});
