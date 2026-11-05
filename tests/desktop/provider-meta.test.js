import { describe, expect, it } from "vitest";
import {
  duplicateDisplayName,
  PROVIDER_META_KEY,
  providerIdentity,
  providerRailRows,
  readProviderMeta,
  sanitizeProviderMeta,
  vendorIdFor,
  writeProviderMeta,
} from "../../desktop/renderer/provider-meta.js";

/** A Map-backed stand-in for localStorage: same two methods, no DOM. */
function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
    raw: (key) => data.get(key),
  };
}

describe("sanitizeProviderMeta", () => {
  it("保留合法的显示名称与厂商归属", () => {
    const meta = sanitizeProviderMeta({
      "deepseek-work": { displayName: "DeepSeek 工作", vendor: "deepseek" },
      "deepseek-home": { displayName: "DeepSeek 家里", vendor: "deepseek" },
    });
    expect(meta["deepseek-work"]).toEqual({ displayName: "DeepSeek 工作", vendor: "deepseek" });
    expect(meta["deepseek-home"]).toEqual({ displayName: "DeepSeek 家里", vendor: "deepseek" });
  });

  it("显示名称与「已存值等于服务名」都视为没设", () => {
    expect(sanitizeProviderMeta({ deepseek: { displayName: "deepseek", vendor: "deepseek" } })).toEqual({
      deepseek: { vendor: "deepseek" },
    });
    expect(sanitizeProviderMeta({ deepseek: { displayName: "   ", vendor: "deepseek" } })).toEqual({
      deepseek: { vendor: "deepseek" },
    });
  });

  it("显示名称按 trim 保存", () => {
    expect(sanitizeProviderMeta({ a: { displayName: "  工作  " } }).a.displayName).toBe("工作");
  });

  it("显式 null 的厂商（用户选了自定义）保留下来", () => {
    expect(sanitizeProviderMeta({ deepseek: { vendor: null } })).toEqual({ deepseek: { vendor: null } });
  });

  it("未知厂商 id 归一为自定义，不猜一个最像的（大小写也照旧敏感）", () => {
    expect(sanitizeProviderMeta({ a: { vendor: "my-gateway" } })).toEqual({ a: { vendor: null } });
    expect(sanitizeProviderMeta({ a: { vendor: "  Kimi " } })).toEqual({ a: { vendor: null } });
    expect(sanitizeProviderMeta({ a: { vendor: "  kimi " } })).toEqual({ a: { vendor: "kimi" } });
  });

  it("丢掉空条目、非对象条目与非对象整体", () => {
    expect(sanitizeProviderMeta({ a: {}, b: null, c: "x", d: { vendor: 42 } })).toEqual(
      Object.assign(Object.create(null), {}),
    );
    expect(sanitizeProviderMeta(null)).toEqual(Object.create(null));
    expect(sanitizeProviderMeta([{ vendor: "kimi" }])).toEqual(Object.create(null));
  });

  it("原型链上的名字只当作普通 key，不碰原型", () => {
    const meta = sanitizeProviderMeta(JSON.parse('{"__proto__": {"vendor": "kimi"}}'));
    expect(Object.getPrototypeOf(meta)).toBeNull();
    expect(Object.hasOwn(meta, "__proto__")).toBe(false);
    expect({}.vendor).toBeUndefined();
  });
});

describe("readProviderMeta / writeProviderMeta", () => {
  it("往返：写进去什么，读出来就是什么", () => {
    const storage = memoryStorage();
    const meta = sanitizeProviderMeta({
      "deepseek-work": { displayName: "工作", vendor: "deepseek" },
      "my-gateway": { vendor: null },
    });
    expect(writeProviderMeta(storage, meta)).toBe(true);
    expect(storage.raw(PROVIDER_META_KEY)).toBeTruthy();
    expect(readProviderMeta(storage)).toEqual(meta);
  });

  it("没存过、坏 JSON、非对象 JSON 都读成空表", () => {
    expect(readProviderMeta(memoryStorage())).toEqual(Object.create(null));
    expect(readProviderMeta(memoryStorage({ [PROVIDER_META_KEY]: "{oops" }))).toEqual(Object.create(null));
    expect(readProviderMeta(memoryStorage({ [PROVIDER_META_KEY]: "[]" }))).toEqual(Object.create(null));
    expect(readProviderMeta(memoryStorage({ [PROVIDER_META_KEY]: "" }))).toEqual(Object.create(null));
  });

  it("没有 storage（或它的 getter 抛错）时读成空表、写返回 false", () => {
    expect(readProviderMeta(null)).toEqual(Object.create(null));
    expect(writeProviderMeta(null, {})).toBe(false);
    const throwing = {
      getItem() {
        throw new Error("denied");
      },
      setItem() {
        throw new Error("denied");
      },
    };
    expect(readProviderMeta(throwing)).toEqual(Object.create(null));
    expect(writeProviderMeta(throwing, { a: { vendor: "kimi" } })).toBe(false);
  });
});

describe("vendorIdFor", () => {
  it("存过的归属优先——包括显式 null（用户选了自定义）", () => {
    const meta = sanitizeProviderMeta({ deepseek: { vendor: null } });
    expect(vendorIdFor(meta, "deepseek")).toBeNull();
    const kimi = sanitizeProviderMeta({ "deepseek-work": { vendor: "kimi" } });
    expect(vendorIdFor(kimi, "deepseek-work")).toBe("kimi");
  });

  it("没存过时从名字兼容旧数据：名字等于预设 id 才算那一家", () => {
    expect(vendorIdFor({}, "deepseek")).toBe("deepseek");
    expect(vendorIdFor({}, "deepseek-2")).toBeNull();
    expect(vendorIdFor({}, "my-gateway")).toBeNull();
    expect(vendorIdFor({}, "")).toBeNull();
  });

  it("不从 baseUrl 推厂商：没有任何入口能看地址", () => {
    // 该函数只接受 meta 与名字两个参数；这条断言固定住签名，防止以后被
    // 「顺便用地址猜一下」的改动塞进来。
    expect(vendorIdFor.length).toBe(2);
  });
});

describe("providerIdentity", () => {
  it("显示名称缺失时回退到服务名，不编一个", () => {
    expect(providerIdentity({}, "deepseek-work")).toEqual({
      id: "deepseek-work",
      displayName: "deepseek-work",
      vendor: null,
    });
  });

  it("存过的显示名称与厂商都带上", () => {
    const meta = sanitizeProviderMeta({ "deepseek-work": { displayName: "工作", vendor: "deepseek" } });
    expect(providerIdentity(meta, "deepseek-work")).toEqual({
      id: "deepseek-work",
      displayName: "工作",
      vendor: "deepseek",
    });
  });
});

describe("duplicateDisplayName", () => {
  it("没有重复时返回 null", () => {
    expect(
      duplicateDisplayName([
        { name: "deepseek", displayName: "工作" },
        { name: "deepseek-2", displayName: "家里" },
      ]),
    ).toBeNull();
  });

  it("两个相同的显示名称返回后一个的下标，供聚焦", () => {
    expect(
      duplicateDisplayName([
        { name: "a", displayName: "工作" },
        { name: "b", displayName: "家里" },
        { name: "c", displayName: " 工作 " },
      ]),
    ).toEqual({ displayName: "工作", index: 2 });
  });

  it("不区分大小写与首尾空白：窄栏里两者看着一样", () => {
    expect(
      duplicateDisplayName([
        { name: "a", displayName: "DeepSeek 工作" },
        { name: "b", displayName: "deepseek 工作" },
      ]),
    ).toEqual({ displayName: "deepseek 工作", index: 1 });
  });

  it("空显示名称按服务名算", () => {
    expect(duplicateDisplayName([{ name: "kimi", displayName: "" }, { name: "kimi", displayName: "" }])).toEqual({
      displayName: "kimi",
      index: 1,
    });
    // 一个空（= kimi）、一个写着 kimi，也是重复。
    expect(duplicateDisplayName([{ name: "kimi", displayName: "" }, { name: "x", displayName: "kimi" }])).toEqual({
      displayName: "kimi",
      index: 1,
    });
  });

  it("两张空卡（没有名字也没有显示名称）不算重复", () => {
    expect(duplicateDisplayName([{ name: "", displayName: "" }, { name: "", displayName: "" }])).toBeNull();
  });

  it("入参不是数组时返回 null", () => {
    expect(duplicateDisplayName(undefined)).toBeNull();
  });
});

describe("providerRailRows", () => {
  const groups = [
    { provider: "deepseek", models: [{ id: "deepseek/flash" }] },
    { provider: "deepseek-2", models: [{ id: "deepseek-2/pro" }] },
    { provider: "my-gateway", models: [{ id: "my-gateway/m" }] },
  ];

  it("一个服务一行，按模型到达顺序", () => {
    const meta = sanitizeProviderMeta({
      deepseek: { displayName: "工作", vendor: "deepseek" },
      "deepseek-2": { displayName: "家里", vendor: "deepseek" },
    });
    const rows = providerRailRows(groups, meta);
    expect(rows.map((row) => row.id)).toEqual(["deepseek", "deepseek-2", "my-gateway"]);
    expect(rows.map((row) => row.displayName)).toEqual(["工作", "家里", "my-gateway"]);
    expect(rows.map((row) => row.vendor)).toEqual(["deepseek", "deepseek", null]);
  });

  it("模型跟着行一起走，调用方不用再查一次", () => {
    const rows = providerRailRows(groups, {});
    expect(rows[0].models).toEqual([{ id: "deepseek/flash" }]);
  });

  it("provider 为空的组不出一行（没有服务名可显示）", () => {
    expect(providerRailRows([{ provider: "", models: [] }], {})).toEqual([]);
  });

  it("入参不是数组时返回空列表", () => {
    expect(providerRailRows(null, {})).toEqual([]);
  });
});
