import { describe, expect, it } from "vitest";
import {
  COMMANDS,
  SKILL_ARGUMENT,
  contextReport,
  expandSkill,
  mergeCommands,
  parseSlashText,
} from "../../desktop/renderer/commands.js";
import { SKILL_NAME_PATTERN } from "../../src/skills/store.js";

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

  it("技能行保留 source 与宿主自己的描述和参数提示", () => {
    // The host tags skill rows; without honouring the tag the composer would
    // run `/review` as a local verb and never expand the saved prompt.
    expect(
      mergeCommands(
        [
          {
            name: "review",
            description: "Review the current diff",
            argumentHint: "[path]",
            source: "skill",
          },
        ],
        "zh",
      ),
    ).toStrictEqual([
      {
        name: "review",
        description: "Review the current diff",
        argumentHint: "[path]",
        source: "skill",
        known: false,
      },
    ]);
    // The host sends the skill file's own words, not a localized pair; a skill
    // without a hint keeps an empty string rather than inheriting one.
    expect(mergeCommands([{ name: "ship", source: "skill" }], "en")[0]).toStrictEqual({
      name: "ship",
      description: "",
      argumentHint: "",
      source: "skill",
      known: false,
    });
  });

  it("没有 source 和可疑 source 的行仍是内置行", () => {
    // Only the exact tag the host and this module share makes a skill: a typo
    // or a hostile value must not open the expansion path.
    expect(mergeCommands([{ name: "deploy" }], "zh")[0].source).toBe("builtin");
    expect(mergeCommands([{ name: "deploy", source: "root" }], "zh")[0].source).toBe("builtin");
    expect(mergeCommands([{ name: "deploy", source: "" }], "zh")[0].source).toBe("builtin");
    expect(mergeCommands([{ name: "deploy", source: 7 }], "zh")[0].source).toBe("builtin");
    expect(mergeCommands([{ name: "deploy", source: "Skill" }], "zh")[0].source).toBe("builtin");
  });

  it("同名的技能行不能改写内置命令的描述", () => {
    // The host already refuses to store a skill named after a builtin, so this
    // is defence in depth: a `/clear` that became a skill would hunt for a
    // body while no longer clearing anything.
    expect(
      mergeCommands(
        [
          {
            name: "clear",
            description: "Something else entirely",
            argumentHint: "[what]",
            source: "skill",
          },
        ],
        "zh",
      ),
    ).toStrictEqual([
      {
        name: "clear",
        description: "开始新会话",
        argumentHint: "",
        source: "builtin",
        known: true,
      },
    ]);
  });
});

describe("commands: expandSkill", () => {
  const skill = (body, extra = {}) => ({ name: "review", body, ...extra });

  it("把每个 $ARGUMENTS 都换成参数", () => {
    expect(SKILL_ARGUMENT).toBe("$ARGUMENTS");
    expect(expandSkill(skill("Review $ARGUMENTS now"), "src/main.ts")).toBe(
      "Review src/main.ts now",
    );
    // All occurrences, not just the first.
    expect(expandSkill(skill("A $ARGUMENTS B $ARGUMENTS C"), "x")).toBe("A x B x C");
    // The result never carries a literal placeholder when args were supplied.
    expect(expandSkill(skill("$ARGUMENTS$ARGUMENTS"), "y")).not.toContain(SKILL_ARGUMENT);
  });

  it("有占位符但没参数时替换为空，不改写作者的空白", () => {
    // The substitution is the only edit: trimming the double space here would
    // be rewriting prose this module did not write.
    expect(expandSkill(skill("Review  $ARGUMENTS  please"), "")).toBe("Review    please");
    expect(expandSkill(skill("Review $ARGUMENTS"), "   ")).toBe("Review");
    // Only the edges are trimmed.
    expect(expandSkill(skill("\n  Review $ARGUMENTS  \n"), "it")).toBe("Review it");
  });

  it("没有占位符时把参数接成新段落", () => {
    // `/review src/main.ts` must never lose the path just because the author
    // forgot the placeholder.
    expect(expandSkill(skill("Review the diff"), "src/main.ts")).toBe(
      "Review the diff\n\nsrc/main.ts",
    );
    // Trailing newlines in the body do not double up with the separator.
    expect(expandSkill(skill("Review the diff\n\n"), "a b")).toBe("Review the diff\n\na b");
  });

  it("没有占位符也没有参数时原文只去两端空白", () => {
    expect(expandSkill(skill("  Review the diff\n"), "")).toBe("Review the diff");
    expect(expandSkill(skill("Review  the  diff"), "  ")).toBe("Review  the  diff");
  });

  it("不可用的技能返回 null", () => {
    expect(expandSkill(skill("   "), "x")).toBeNull();
    expect(expandSkill(skill(""), "x")).toBeNull();
    expect(expandSkill(skill("\n\t \n"), "x")).toBeNull();
    expect(expandSkill({ name: "no-body" }, "x")).toBeNull();
    expect(expandSkill({ body: 42 }, "x")).toBeNull();
    expect(expandSkill(null, "x")).toBeNull();
    expect(expandSkill(undefined, "x")).toBeNull();
    expect(expandSkill("body", "x")).toBeNull();
    expect(expandSkill(["body"], "x")).toBeNull();
  });

  it("不碰 $HOME、$1 这类不是占位符的美元符号", () => {
    // A body may legitimately talk about shell variables; only the exact
    // token is a placeholder.
    expect(expandSkill(skill("Run $HOME/bin and $1 then $ARGUMENT"), "x")).toBe(
      "Run $HOME/bin and $1 then $ARGUMENT\n\nx",
    );
    expect(expandSkill(skill("Cost is $5; keep $ARGUMENTS"), "the path")).toBe(
      "Cost is $5; keep the path",
    );
  });

  it("参数里的 $& 与 $' 按字面插入", () => {
    // `String.replace` would expand those in a replacement string; split/join
    // keeps the user's text literal.
    expect(expandSkill(skill("Review $ARGUMENTS"), "a $& b $' c $` d")).toBe(
      "Review a $& b $' c $` d",
    );
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
    // 含路径分隔符的仍然不是命令：`_` 只是在名字里合法，不能把路径带进来。
    expect(parseSlashText("/usr_local/bin")).toBeNull();
  });

  it("下划线是合法的命令名字符", () => {
    // 内核的 SKILL_NAME_PATTERN 允许 `_`，命令面板的补全正则也允许，唯独
    // 这里曾经不允许：`/review_diff` 于是被当成散文原样发给模型——不展开、
    // 不报错。名字规则三处必须一致，否则存在但不可用的技能连提示都没有。
    expect(parseSlashText("/review_diff")).toStrictEqual({ name: "review_diff", args: "" });
    expect(parseSlashText("/review_diff src/a.ts")).toStrictEqual({
      name: "review_diff",
      args: "src/a.ts",
    });
  });

  it("内核接受的每个技能名都能被斜杠语法解析回来", () => {
    // 「能存在的名字」与「能敲出来的名字」必须是同一个集合（D-198）。两份正则
    // 分开写、又没有任何一处比较它们，落差就是「文件存在但永远调不动」——
    // 而且失败时不会报错，整行会当成散文发给模型。这条测试就是那道比较：
    // SKILL_NAME_PATTERN 说合法的名字，parseSlashText("/" + name) 必须原样还原。
    const names = [
      "review",
      "review-diff",
      "review_diff",
      "a",
      "a1",
      "r2d2",
      "x_",
      "x-y_z9",
      "a".repeat(64),
    ];
    for (const name of names) {
      expect(SKILL_NAME_PATTERN.test(name), `样例本身应是合法技能名: ${name}`).toBe(true);
      expect(parseSlashText(`/${name}`), `合法技能名解析不出来: ${name}`).toStrictEqual({
        name,
        args: "",
      });
      // 带参数时同样要还原，参数原样保留（含空格与斜杠）。
      expect(parseSlashText(`/${name} a/b c`)).toStrictEqual({ name, args: "a/b c" });
    }
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
