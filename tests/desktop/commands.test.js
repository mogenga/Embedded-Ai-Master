import { describe, expect, it } from "vitest";
import {
  COMMANDS,
  contextReport,
  mergeCommands,
  parseSlashText,
} from "../../desktop/renderer/commands.js";

describe("commands: catalogue", () => {
  it("三个内置命令都没有参数", () => {
    expect(COMMANDS.map((command) => command.name)).toStrictEqual(["clear", "context", "compact"]);
    for (const command of COMMANDS) {
      // No argument syntax: the kernel's compaction has no focus/keep option,
      // so advertising one would be a promise nothing honours.
      expect(command.argumentHint).toBe("");
      expect(command.description.zh).not.toBe("");
      expect(command.description.en).not.toBe("");
    }
  });
});

describe("commands: mergeCommands", () => {
  it("按宿主顺序输出，已知命令用本地文案", () => {
    const merged = mergeCommands([{ name: "compact" }, { name: "clear" }], "zh");
    expect(merged.map((entry) => entry.name)).toStrictEqual(["compact", "clear"]);
    expect(merged[0]).toStrictEqual({
      name: "compact",
      description: "立即压缩上下文",
      argumentHint: "",
      source: "builtin",
      known: true,
    });
  });

  it("按 locale 切换描述，未知 locale 退回英文", () => {
    expect(mergeCommands([{ name: "context" }], "zh")[0].description).toBe("查看上下文占用");
    expect(mergeCommands([{ name: "context" }], "en")[0].description).toBe("Show context usage");
    expect(mergeCommands([{ name: "context" }], "fr")[0].description).toBe("Show context usage");
  });

  it("宿主报了目录里没有的名字时保留宿主的描述", () => {
    expect(
      mergeCommands([{ name: "deploy", description: { zh: "部署", en: "Deploy" } }], "zh"),
    ).toStrictEqual([
      { name: "deploy", description: "部署", argumentHint: "", source: "builtin", known: false },
    ]);
    expect(mergeCommands([{ name: "deploy", description: "Deploy it" }], "en")[0].description).toBe(
      "Deploy it",
    );
    // A host that names a verb without describing it still gets a row; the
    // description is empty rather than invented.
    expect(mergeCommands([{ name: "deploy" }], "zh")[0].description).toBe("");
  });

  it("空列表与坏条目不产生命令，重复名字只留一个", () => {
    expect(mergeCommands([], "zh")).toStrictEqual([]);
    expect(mergeCommands(undefined, "zh")).toStrictEqual([]);
    expect(mergeCommands("clear", "zh")).toStrictEqual([]);
    expect(
      mergeCommands([null, {}, { name: "" }, { name: "clear" }, { name: "clear" }], "zh").map(
        (entry) => entry.name,
      ),
    ).toStrictEqual(["clear"]);
  });

  it("宿主名字的大小写与空白归一", () => {
    expect(mergeCommands([{ name: "  CLEAR " }], "zh").map((entry) => entry.name)).toStrictEqual([
      "clear",
    ]);
  });

  it("目录里有、宿主没报的命令不会出现", () => {
    // The host owns the capability list: the browser form cannot compact, so
    // merging must not add `/compact` behind its back.
    expect(mergeCommands([{ name: "clear" }], "zh").map((entry) => entry.name)).toStrictEqual([
      "clear",
    ]);
  });
});

describe("commands: parseSlashText", () => {
  it("识别命令名与参数", () => {
    expect(parseSlashText("/clear")).toStrictEqual({ name: "clear", args: "" });
    expect(parseSlashText("  /clear  ")).toStrictEqual({ name: "clear", args: "" });
    expect(parseSlashText("/compact")).toStrictEqual({ name: "compact", args: "" });
    expect(parseSlashText("/compact --keep 3")).toStrictEqual({
      name: "compact",
      args: "--keep 3",
    });
    expect(parseSlashText("/clear now")).toStrictEqual({ name: "clear", args: "now" });
  });

  it("命令名一律转小写", () => {
    expect(parseSlashText("/CONTEXT")).toStrictEqual({ name: "context", args: "" });
    expect(parseSlashText("/Clear")).toStrictEqual({ name: "clear", args: "" });
  });

  it("不像命令的斜杠文本是散文，不是命令", () => {
    expect(parseSlashText("// note")).toBeNull();
    expect(parseSlashText("/usr/bin/env is broken")).toBeNull();
    expect(parseSlashText("/")).toBeNull();
    expect(parseSlashText("please run /clear")).toBeNull();
    expect(parseSlashText("C:/tmp")).toBeNull();
    expect(parseSlashText("/\\server\\share")).toBeNull();
    // 语法里没有下划线：带下划线的名字按散文处理，原样发给模型。
    expect(parseSlashText("/foo_bar")).toBeNull();
  });

  it("空值与非字符串返回 null", () => {
    expect(parseSlashText("")).toBeNull();
    expect(parseSlashText("   ")).toBeNull();
    expect(parseSlashText(null)).toBeNull();
    expect(parseSlashText(undefined)).toBeNull();
  });
});

describe("commands: contextReport", () => {
  const unknown = {
    known: false,
    used: null,
    window: null,
    percent: null,
    free: null,
    compactAt: null,
    headroom: null,
    parts: [],
  };

  it("内核报过占用时给出真实数字与剩余空间", () => {
    expect(contextReport({ tokens: 42000, percent: 32.8, window: 128000 })).toStrictEqual({
      known: true,
      used: 42000,
      window: 128000,
      percent: 32.8,
      free: 86000,
      compactAt: null,
      headroom: null,
      parts: [],
    });
  });

  it("没有窗口就不编一个，剩余空间也为 null", () => {
    expect(contextReport({ tokens: 42000, percent: 32.8 })).toStrictEqual({
      known: true,
      used: 42000,
      window: null,
      percent: 32.8,
      free: null,
      compactAt: null,
      headroom: null,
      parts: [],
    });
  });

  it("窗口为 0 不是已知窗口", () => {
    expect(contextReport({ tokens: 10, percent: 1, window: 0 })).toStrictEqual({
      known: true,
      used: 10,
      window: null,
      percent: 1,
      free: null,
      compactAt: null,
      headroom: null,
      parts: [],
    });
  });

  it("超出窗口时剩余按 0 记，不出现负数", () => {
    expect(contextReport({ tokens: 130000, percent: 100, window: 128000 }).free).toBe(0);
  });

  it("有拆分时透出类别，压缩触发点换算成余量", () => {
    const report = contextReport(
      { tokens: 42000, percent: 32.8, window: 128000 },
      {
        used: 42003,
        window: 128000,
        percent: 32.8,
        compactAt: 102400,
        parts: [
          { key: "systemPrompt", tokens: 3200 },
          { key: "messages", tokens: 28900 },
          { key: "toolResults", tokens: 7000 },
          { key: "mcpTools", tokens: 2900 },
        ],
      },
    );
    // The total is the measured one, not the split's rounded sum: the report
    // and the chip must not disagree about how full the window is.
    expect(report.used).toBe(42000);
    expect(report.compactAt).toBe(102400);
    expect(report.headroom).toBe(60400);
    expect(report.parts).toStrictEqual([
      { key: "systemPrompt", tokens: 3200 },
      { key: "messages", tokens: 28900 },
      { key: "toolResults", tokens: 7000 },
      { key: "mcpTools", tokens: 2900 },
    ]);
  });

  it("没有拆分时 parts 是空数组而不是 null", () => {
    const report = contextReport({ tokens: 10, percent: 1, window: 100 });
    expect(report.parts).toStrictEqual([]);
    expect(report.compactAt).toBeNull();
    expect(report.headroom).toBeNull();
    // A caller passing `null` or a malformed split gets the same answer as one
    // that passed nothing.
    expect(contextReport({ tokens: 10, percent: 1, window: 100 }, null).parts).toStrictEqual([]);
    expect(contextReport({ tokens: 10, percent: 1, window: 100 }, "nope").compactAt).toBeNull();
    expect(
      contextReport({ tokens: 10, percent: 1, window: 100 }, { compactAt: 90, parts: "x" }),
    ).toStrictEqual({
      known: true,
      used: 10,
      window: 100,
      percent: 1,
      free: 90,
      compactAt: 90,
      headroom: 80,
      parts: [],
    });
  });

  it("坏类别被丢弃，不补成 0", () => {
    const report = contextReport(
      { tokens: 100, percent: 1, window: 10000 },
      {
        compactAt: 9000,
        parts: [
          { key: "messages", tokens: 60 },
          { key: "", tokens: 10 },
          { key: "toolResults", tokens: 0 },
          { key: "mcpTools", tokens: -5 },
          { key: "systemPrompt", tokens: Number.NaN },
          { key: 7, tokens: 10 },
          { key: "orphan" },
          null,
          "messages",
        ],
      },
    );
    expect(report.parts).toStrictEqual([{ key: "messages", tokens: 60 }]);
  });

  it("压缩触发点已过时余量为 0，不是负数", () => {
    const report = contextReport(
      { tokens: 110000, percent: 85.9, window: 128000 },
      { used: 110000, window: 128000, percent: 85.9, compactAt: 102400, parts: [{ key: "messages", tokens: 110000 }] },
    );
    expect(report.compactAt).toBe(102400);
    expect(report.headroom).toBe(0);
  });

  it("没有测量结果时所有字段为 null，不打印 0", () => {
    expect(contextReport(null)).toStrictEqual(unknown);
    expect(contextReport(undefined)).toStrictEqual(unknown);
    expect(contextReport({})).toStrictEqual(unknown);
    expect(contextReport({ tokens: 10 })).toStrictEqual(unknown);
    expect(contextReport({ percent: 10 })).toStrictEqual(unknown);
    expect(contextReport({ tokens: Number.NaN, percent: 1 })).toStrictEqual(unknown);
    expect(contextReport({ tokens: -1, percent: 1 })).toStrictEqual(unknown);
    expect(contextReport({ tokens: 10, percent: Number.POSITIVE_INFINITY })).toStrictEqual(unknown);
    expect(contextReport("42000")).toStrictEqual(unknown);
    expect(contextReport([42000, 32.8])).toStrictEqual(unknown);
  });
});
