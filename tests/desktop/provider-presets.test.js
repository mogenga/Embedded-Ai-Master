import { describe, expect, it } from "vitest";
import {
  isAutoProviderName,
  nextProviderName,
  PRESETS_BY_ID,
  presetById,
  presetFillFor,
  PROVIDER_PRESETS,
  providerMark,
  providerPickerOptions,
} from "../../desktop/renderer/provider-presets.js";

describe("PROVIDER_PRESETS", () => {
  it("七家厂商齐全，id 唯一", () => {
    expect(PROVIDER_PRESETS).toHaveLength(7);
    const ids = PROVIDER_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(["deepseek", "kimi", "glm", "qwen", "minimax", "openai", "gemini"]);
  });

  it("每家都有 id / label / baseUrl / docsUrl", () => {
    for (const preset of PROVIDER_PRESETS) {
      expect(preset.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(preset.label.length).toBeGreaterThan(0);
      expect(preset.docsUrl).toMatch(/^https:\/\//);
    }
  });

  it("不预置模型名：列表由「在线获取」向端点现取", () => {
    for (const preset of PROVIDER_PRESETS) {
      expect(Object.hasOwn(preset, "models")).toBe(false);
    }
  });

  it("baseUrl 一律 https、不带尾斜杠、不带查询串", () => {
    for (const preset of PROVIDER_PRESETS) {
      const url = new URL(preset.baseUrl);
      expect(url.protocol).toBe("https:");
      // 内核用 `pathname + "/chat/completions"` 拼接；尾斜杠会被剥掉，
      // 但规则统一才不会有一个例外在下次修改时被漏掉。
      expect(preset.baseUrl.endsWith("/")).toBe(false);
      expect(url.search).toBe("");
      expect(url.hash).toBe("");
    }
  });

  it("baseUrl 自带版本段，拼接后落在 /chat/completions 上", () => {
    for (const preset of PROVIDER_PRESETS) {
      const pathname = new URL(preset.baseUrl).pathname.replace(/\/+$/, "");
      // 空路径（https://api.deepseek.com）也是一个合法落点：官方地址就是根。
      expect(pathname).not.toMatch(/\/$/);
      const url = new URL(`${preset.baseUrl.replace(/\/+$/, "")}/chat/completions`);
      expect(url.pathname.endsWith("/chat/completions")).toBe(true);
    }
  });
});

describe("providerMark", () => {
  it("取前两个字母数字并大写", () => {
    expect(providerMark("deepseek")).toBe("DE");
    expect(providerMark("my-gateway")).toBe("MY");
    expect(providerMark("Kimi")).toBe("KI");
  });

  it("只有一个字符时补中点，长度恒为 2", () => {
    expect(providerMark("x")).toBe("X·");
    expect(providerMark("-a-")).toBe("A·");
  });

  it("取不出字母数字时回退到 ?，不编造名字", () => {
    expect(providerMark("")).toBe("?");
    expect(providerMark("---")).toBe("?");
    expect(providerMark(null)).toBe("?");
    expect(providerMark(undefined)).toBe("?");
    expect(providerMark(42)).toBe("42");
  });

  it("数字开头的名字也照取", () => {
    expect(providerMark("9router")).toBe("9R");
  });
});

describe("providerPickerOptions", () => {
  it("归属指向某家预设时选中该厂商", () => {
    const view = providerPickerOptions("kimi");
    expect(view.selectedId).toBe("kimi");
    expect(view.custom).toBe(false);
    expect(view.options.find((option) => option.id === "kimi")?.selected).toBe(true);
  });

  it("null / 未知 id 一律是「自定义」，不硬套一个最像的厂商", () => {
    for (const vendor of [null, undefined, "", "  ", "my-gateway", "DeepSeek", "KI", 42]) {
      const view = providerPickerOptions(vendor);
      expect(view.selectedId).toBeNull();
      expect(view.custom).toBe(true);
      expect(view.options.some((option) => option.selected)).toBe(false);
    }
  });

  it("归属前后空白不影响反查", () => {
    expect(providerPickerOptions("  glm  ").selectedId).toBe("glm");
  });

  it("七个厂商都在、都可选：同一家厂商可以配多张卡", () => {
    const view = providerPickerOptions(null);
    expect(view.options.map((option) => option.id)).toEqual(PROVIDER_PRESETS.map((preset) => preset.id));
    expect(view.options.every((option) => option.disabled === undefined)).toBe(true);
  });
});

describe("nextProviderName", () => {
  it("厂商的第一个服务用厂商 id（兼容旧文件的命名）", () => {
    expect(nextProviderName([], "deepseek")).toBe("deepseek");
  });

  it("同厂商的第二、第三张卡加后缀，跳过已占用的序号", () => {
    expect(nextProviderName(["deepseek"], "deepseek")).toBe("deepseek-2");
    expect(nextProviderName(["deepseek", "deepseek-2"], "deepseek")).toBe("deepseek-3");
    // 序号空洞可以复用：`deepseek-2` 删掉之后，下一张仍是 2。
    expect(nextProviderName(["deepseek", "deepseek-3"], "deepseek")).toBe("deepseek-2");
  });

  it("自定义厂商没有 id 可依，用 providerN", () => {
    expect(nextProviderName([], null)).toBe("provider1");
    expect(nextProviderName(["provider1"], undefined)).toBe("provider2");
    expect(nextProviderName(["provider1", "provider3"], "")).toBe("provider2");
  });

  it("名字按 trim 比较，空白名不算占用", () => {
    expect(nextProviderName([" deepseek ", ""], "deepseek")).toBe("deepseek-2");
  });

  it("入参不是数组时按空列表处理", () => {
    expect(nextProviderName(undefined, "kimi")).toBe("kimi");
  });
});

describe("isAutoProviderName", () => {
  it("空名字、当前厂商的 id 与它的后缀都是页面自己生成的", () => {
    expect(isAutoProviderName("", "deepseek")).toBe(true);
    expect(isAutoProviderName("  ", "deepseek")).toBe(true);
    expect(isAutoProviderName("deepseek", "deepseek")).toBe(true);
    expect(isAutoProviderName("deepseek-2", "deepseek")).toBe(true);
  });

  it("自定义卡生成的 providerN 也算", () => {
    expect(isAutoProviderName("provider3", null)).toBe(true);
    expect(isAutoProviderName("provider3", "deepseek")).toBe(true);
  });

  it("手写的名字不是", () => {
    for (const name of ["my-gateway", "deepseek-home", "deepseek2", "kimi"]) {
      expect(isAutoProviderName(name, "deepseek")).toBe(false);
    }
  });

  it("厂商 id 里的正则元字符按字面处理", () => {
    expect(isAutoProviderName("a.b-2", "a.b")).toBe(true);
    expect(isAutoProviderName("axb-2", "a.b")).toBe(false);
  });
});

describe("presetFillFor", () => {
  it("没有预设（「自定义」）时返回 null，调用方据此不改任何东西", () => {
    expect(presetFillFor(null)).toBeNull();
    expect(presetFillFor(undefined)).toBeNull();
    expect(presetFillFor({})).toBeNull();
    expect(presetFillFor({ id: "" })).toBeNull();
  });

  it("地址空着时填预设地址，名字写成预设 id", () => {
    expect(presetFillFor(presetById("deepseek"), { baseUrl: "" })).toEqual({
      name: "deepseek",
      baseUrl: "https://api.deepseek.com",
    });
    expect(presetFillFor(presetById("kimi"), { baseUrl: "   " })).toEqual({
      name: "kimi",
      baseUrl: "https://api.moonshot.cn/v1",
    });
  });

  it("用户手填的地址不被覆盖", () => {
    expect(presetFillFor(presetById("kimi"), { baseUrl: "https://gateway.corp/v1" })).toEqual({
      name: "kimi",
      baseUrl: "https://gateway.corp/v1",
    });
  });

  it("连续换厂商时地址跟着换（上一个地址是预设填进去的）", () => {
    const first = presetFillFor(presetById("deepseek"), { baseUrl: "" });
    expect(first.baseUrl).toBe("https://api.deepseek.com");
    expect(presetFillFor(presetById("kimi"), { baseUrl: first.baseUrl })).toEqual({
      name: "kimi",
      baseUrl: "https://api.moonshot.cn/v1",
    });
  });

  it("拖尾空白的预设地址仍算「预设填进去的」", () => {
    expect(presetFillFor(presetById("glm"), { baseUrl: " https://api.moonshot.cn/v1 " }).baseUrl).toBe(
      "https://open.bigmodel.cn/api/paas/v4",
    );
  });

  it("没有 baseUrl 选项时按空地址处理", () => {
    expect(presetFillFor(presetById("gemini")).baseUrl).toBe(
      "https://generativelanguage.googleapis.com/v1beta/openai",
    );
  });
});

describe("PRESETS_BY_ID", () => {
  it("按 id 索引，与数组内容一致", () => {
    expect(PRESETS_BY_ID.get("deepseek")?.baseUrl).toBe("https://api.deepseek.com");
    expect(PRESETS_BY_ID.size).toBe(PROVIDER_PRESETS.length);
  });

  it("presetById 找不到时返回 undefined", () => {
    expect(presetById("my-gateway")).toBeUndefined();
  });
});
