import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkPaths, checkText, contradictionOf, formatResult } from "../scripts/check-ledger-status.mjs";

/**
 * `scripts/check-ledger-status.mjs` 的行为锁定（BACKLOG 4.5）。
 *
 * 这一步存在的原因是一个实测过的盲区：台账的**状态行**与**同一条目的正文/注记**
 * 会静默分叉，而没有任何检查会因此变红。2026-11-07 的手工审计（提交 `c8948a3`）
 * 在 `docs/deferred-issues.md` 里逐条核对代码后改掉了一批状态行——那次的教训是
 * 「状态行不是单一事实源」。本文件测的不是「当前仓库干净」（那只证明今天没坏），
 * 而是**它到底抓不抓得住**：造出每种矛盾形状，断言它点名；再造出每种合法形状，
 * 断言它闭嘴。
 *
 * **能力边界**：只对齐台账内部的文字。`c8948a3` 那批里的 D-134 / D-149 / D-189 /
 * D-221 是「状态行 vs 代码」的矛盾，本脚本读不到代码，按设计抓不到。测试里不假装能抓。
 */

describe("contradictionOf：状态块内部判词", () => {
  it("【RED】以「未解决」开头、后面又说「已解决」→ 命中", () => {
    // 这是历史缺陷的抽象形状：状态行没跟上正文里后续补写的结论。
    const result = contradictionOf("未解决;本轮只做单会话流。**已解决**（2026-10-22，对象已删除）。");

    expect(result?.rule).toBe("status-line");
    expect(result?.detail).toContain("未解决");
    expect(result?.detail).toContain("已解决");
  });

  it("【RED】以「已解决」开头、后面又说「仍未解决」→ 命中", () => {
    const result = contradictionOf("**已解决**（2026-10-25）。但冷启动路径仍未解决。");

    expect(result?.rule).toBe("status-line");
    expect(result?.detail).toContain("已解决");
    expect(result?.detail).toContain("仍未解决");
  });

  it("【不报】「部分解决」是合法状态", () => {
    // `deferred-issues.md` 的 D-003 / D-005 / T-040 就是这个形状：
    // 开头就写明只完成了一部分，后面列剩下的那部分，两者不矛盾。
    expect(contradictionOf("**部分解决**（2026-10-18）。已补 close 二次调用；`logCreated` 仍未解决。")).toBeUndefined();
    expect(contradictionOf("大部分解决（2026-10-22；第 1、2 项仍是能力缺口）。")).toBeUndefined();
  });

  it("【不报】未解决开头 + 按子项计的反证（①②③ / 第 N 项 / 前两项）", () => {
    expect(contradictionOf("未解决（① ② 已落地，③ 未变）。")).toBeUndefined();
    expect(contradictionOf("未解决；第 1 项已解决，第 2 项未动。")).toBeUndefined();
    expect(contradictionOf("仍未解决；前两项已解决，其余保留。")).toBeUndefined();
  });

  it("【不报】指向**别的条目**的已解决", () => {
    // 台账里常见「本条未解决；D-134 的桌面侧已解决」——说的是另一条。
    expect(contradictionOf("未解决；与 D-134 同根因（D-134 已解决）。")).toBeUndefined();
    expect(contradictionOf("仍未解决。注意 D-134 已解决；本条是内核侧。")).toBeUndefined();
  });

  it("【不报】引用旧状态（「原始记录：…」「修复前写下的」）", () => {
    // D-224 修好后的写法：把修复前的原文括起来留痕。
    expect(
      contradictionOf("**已解决（2026-11-07 复核）**。`clearAttachments()` 已落地。（原始记录：「未解决（既有行为）」是修复前写下的。）"),
    ).toBeUndefined();
    expect(
      contradictionOf("**已解决（2026-11-07）**。证据见测试。**原始状态**：仍未解决。"),
    ).toBeUndefined();
  });

  it("【不报】「已作废 / 已失效」是历史终止，不是与「未解决」并列的判词", () => {
    // 台账惯例：先说本轮未解决，再说对象已随哪次删除而作废。这条不构成读者歧义——
    // 「作废」说明条目本身不必再修，与「已解决」（修好了）是两件事。
    expect(contradictionOf("未解决;本轮按 spec 只做单会话流。**已作废**（2026-10-22，对象已删除）。")).toBeUndefined();
  });

  it("【不报】前后判词一致或没有判词", () => {
    expect(contradictionOf("未解决（已登记）。")).toBeUndefined();
    expect(contradictionOf("已解决（2026-10-18）。")).toBeUndefined();
    expect(contradictionOf("按设计接受，不改（2026-11-06 复核）。")).toBeUndefined();
  });
});

describe("checkText：顶部复核注记 vs 状态行", () => {
  it("【RED】注记写「已失效」，状态行仍以「未解决」开头 → 命中并报 id 与行号", () => {
    const text = [
      "# 台账",
      "",
      "### D-193 · 某面板两端都没有 handler",
      "",
      "> **2026-11-06 复核：本条已失效。** 面板已删除，全仓 grep 为 0 处。以下保留原始记录。",
      "",
      "- **发现**: 2026-10-22。",
      "- **状态**: 未解决（已登记）。",
      "",
    ].join("\n");

    const { entries, statusLines, problems } = checkText(text, "fixture.md");

    expect(entries).toBe(1);
    expect(statusLines).toBe(1);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ file: "fixture.md", line: 8, id: "D-193", rule: "top-note" });
    // 报错要能让读者直接找到两条互相矛盾的行，而不是只给一个「矛盾了」。
    expect(problems[0]?.detail).toContain("5");
    expect(problems[0]?.detail).toContain("未解决");
  });

  it("【RED】注记写「已解决」（不在「复核：」里）→ 同样命中", () => {
    // 这是 D-224 在 `9c2166e` 的原样形状：`> **2026-11-06 已解决**：…`
    const text = [
      "### D-224 · 切换会话不清附件条",
      "",
      "> **2026-11-06 已解决**：新增 `clearAttachments()`，两条会话边界都调它。以下保留原始记录。",
      "",
      "- **状态**: 未解决（既有行为，本批次未改）。",
      "",
    ].join("\n");

    const { problems } = checkText(text, "fixture.md");

    expect(problems).toHaveLength(1);
    expect(problems[0]?.id).toBe("D-224");
    expect(problems[0]?.rule).toBe("top-note");
  });

  it("【RED】注记写「已把决定用断言钉住」，状态行仍以「未解决」开头 → 命中", () => {
    const text = [
      "### D-189 · 没有整跑墙钟超时",
      "",
      "> **2026-11-06 复核：已把决定用断言钉住**（`tests/query.test.ts`）。",
      "",
      "- **状态**: 未解决（已登记）。",
      "",
    ].join("\n");

    expect(checkText(text, "fixture.md").problems.map((p) => p.id)).toStrictEqual(["D-189"]);
  });

  it("【不报】注记与状态行一致", () => {
    const text = [
      "### D-224 · 切换会话不清附件条",
      "",
      "> **2026-11-06 已解决**：新增 `clearAttachments()`。",
      "",
      "- **状态**: **已解决（2026-10-25）**。`clearAttachments()` 已落地。",
      "",
    ].join("\n");

    expect(checkText(text, "fixture.md").problems).toStrictEqual([]);
  });

  it("【不报】注记说的是「部分」，状态行写「未解决」但注记本身没有整条了结", () => {
    // D-212 的形状：注记说「两半都已落地」，但明说「一次真实更新从未跑过」，
    // 并且状态行自己写了「应用内自动更新已解决 / 残余仍未关闭」。
    const text = [
      "### D-212 · 发布链路从未真正跑过",
      "",
      "> **2026-10-25 状态更新**：两半都已落地，但「一次真实更新从未跑过」仍未验证。",
      "",
      "- **状态**: **应用内自动更新已解决（2026-10-25）**；「一次真实更新从未跑过」仍未关闭。",
      "",
    ].join("\n");

    expect(checkText(text, "fixture.md").problems).toStrictEqual([]);
  });

  it("【不报】注记属于**另一个条目**（跨标题边界）", () => {
    const text = [
      "### D-220 · 前一条，已解决且注记一致",
      "",
      "> **2026-11-06 复核：已作废。** 对象已删除。",
      "",
      "- **状态**: **已作废（2026-11-06 复核）**。",
      "",
      "### D-221 · 后一条，没有任何注记",
      "",
      "- **状态**: 未解决（已登记）。",
      "",
    ].join("\n");

    expect(checkText(text, "fixture.md").problems).toStrictEqual([]);
  });
});

describe("checkText：条目切分与状态块边界", () => {
  it("状态块包含缩进续行（D-134 / D-221 的补充段就写在续行里）", () => {
    const text = [
      "### D-134 · 进程内低延迟适配器未实现",
      "",
      "- **状态**: **桌面侧已解决（2026-11-07 复核）**。进程内加速通道已落地。",
      "  **仍未解决**：内核的 `LogTailEventSource` 仍是 200ms 轮询。",
      "",
    ].join("\n");

    // 开头的强判词是「已解决」，续行说「仍未解决」——但续行先用 `**` 标出了子项口径，
    // 且它在续行开头，属于「本条的两半」。这里的关键不是它报不报，而是**续行确实进了
    // 同一个状态块**：若续行没被并进来，下面这条断言会因为它扫不到而意外变成另一条规则。
    const { statusLines } = checkText(text, "fixture.md");
    expect(statusLines).toBe(1);
  });

  it("CRLF 台账照样解析（`embedded-defects-todolist.md` 是 CRLF）", () => {
    // 不归一化换行时 `.*$` 匹配不到 `\r` 结尾的行，状态行会被整批漏掉——
    // 漏掉的表现是「零命中」，正是这个脚本最不该有的假绿。
    const text = [
      "### T-001 · 某缺陷",
      "",
      "- **状态**: 未解决（已登记）。",
      "",
    ].join("\r\n");

    expect(checkText(text, "fixture.md").statusLines).toBe(1);
  });

  it("没有状态行的条目不计入状态行数，也不报", () => {
    const text = [
      "### 12.1 已落地（16 项全量 + 2 项部分）",
      "",
      "正文没有状态行。",
      "",
    ].join("\n");

    const { entries, statusLines, problems } = checkText(text, "fixture.md");
    expect(entries).toBe(1);
    expect(statusLines).toBe(0);
    expect(problems).toStrictEqual([]);
  });
});

/**
 * 真实历史数据：`9c2166e:docs/deferred-issues.md`（`c8948a3` 的父提交，文件当时
 * 还在 `docs/deferred-issues.md`）。下面每条 fixture 都是从那份文件**原样抄下来**的
 * 条目文本，不是照着记忆重写的形状——用它们钉住「这个脚本对真实台账有效」，
 * 而不只是对测试作者想出来的形状有效。
 */
describe("checkText：真实历史片段（9c2166e）", () => {
  it("D-134：状态行「未解决;本轮按用户决策保留日志投影 + 轮询。」", () => {
    // 出处：9c2166e:docs/deferred-issues.md 第 1232-1240 行。
    // 注意：这条**不**被本脚本抓到——它的状态行内部没有矛盾，注记也没有。
    // `c8948a3` 是靠读 `desktop/host/host.js` 才发现桌面侧已落地的；本脚本读不到代码。
    // 把这条留在测试里，是为了钉住能力边界，防止有人误以为「check:ledgers 绿 = 状态准确」。
    const text = [
      "### D-134 · 进程内低延迟适配器未实现,当前依赖 200ms 日志轮询",
      "",
      "- **发现**: 2026-10-20,M2 事件总线 Task 7。",
      "- **现象**: `LogTailEventSource.follow` 以 200ms 间隔轮询增量字节;SSE 实际延迟还受文件读取与事件循环调度影响,未压测、无硬上限。没有 `EventEmitter`/共享注册表等进程内发布通道。",
      "- **影响**: 对毫秒级工具/设备状态反馈不足;高频事件会合并到轮询批次。跨进程仍是最兼容的方案,但同进程场景多付一次轮询延迟。",
      "- **触发升级条件**: 需要亚 100ms 延迟、高频设备事件,或轮询 I/O 成为开销。",
      "- **修复建议**: 在同一 `SessionEventSource` 接口下增加进程内适配器(append 后立即通知,仍以日志为事实源并保留文件跟随作为补偿),SSE 与客户端协议不变。",
      "- **状态**: 未解决;本轮按用户决策保留日志投影 + 轮询。",
      "",
    ].join("\n");

    expect(checkText(text, "9c2166e:docs/deferred-issues.md").problems).toStrictEqual([]);
  });

  it("D-189：状态行「未解决（已登记；与 D-022「超时≠强制终止」是同一根因的两个层次）。」", () => {
    // 出处：9c2166e:docs/deferred-issues.md 第 1674 / 1683 行。
    // 同样**不**被本脚本抓到：矛盾在「状态行 vs 代码」（`deadlineMs` 已落地），
    // 不在状态行内部。这里的「超时≠强制终止」是引用不是判词，不能误报成「另一个判词」。
    const text = [
      "### D-189 · 没有整跑墙钟超时，`timeoutMs` 只管单次工具调用",
      "",
      "- **发现**: 2026-10-22（同上）。",
      "- **修复建议**: `RunOptions` 加 `deadlineMs`（整跑上限），`runSession` 起一个 `AbortSignal.timeout` 与外部 signal 合并，到时写 `interrupted{reason:\"deadline\"}`。",
      "- **状态**: 未解决（已登记；与 D-022「超时≠强制终止」是同一根因的两个层次）。",
      "",
    ].join("\n");

    // D-022 在正文里被提到，但它不是「已解决」——这条不能因为出现了别的编号就命中。
    expect(checkText(text, "9c2166e:docs/deferred-issues.md").problems).toStrictEqual([]);
  });

  it("【RED】D-193：顶部「本条已失效」+ 状态行「未解决（已登记）」→ 命中", () => {
    // 出处：9c2166e:docs/deferred-issues.md 第 1597-1608 行。**这是真被抓到的历史矛盾。**
    const text = [
      "### D-193 · Board 面板是唯一可见的工作台页签，但它发的 `getBoardState` 两端都没有 handler",
      "",
      "> **2026-11-06 复核：本条已失效。** Board 面板于 2026-10-26 随目标板页面整体删除（`desktop/renderer/app.js` 的 `SUPPORTED_PANES` 现为 `file / artifact / serial`，`dev-notes/M3-发布.md:1148-1174` 记录了删除决定）。全仓 grep `getBoardState` 为 0 处；`device_status` 事件仍在内核产出，但渲染器 `case \"device_status\"` 刻意不画任何东西（`app.js:3085-3091` 有注释说明「事件保留、当前无 UI 消费者」）。以下保留原始记录。",
      "",
      "- **发现**: 2026-10-22（第十四轮复核「还有什么没做完」时逐个命令交叉核对）。",
      "- **现象**: `app.js:116` 只允许恢复 `board` 一个 pane，打开它就会执行 `app.js:3518` 的 `api.send({ cmd: \"getBoardState\" })`。",
      "- **影响**: 唯一常驻的页签点开即报错；用户会以为整个工作台不可用。",
      "- **状态**: 未解决（已登记）。**2026-10-22 补充**：`bridge.js` 已删除，「两端都没有 handler」现在只剩桌面宿主一端的缺口（`getBoardState` 仍无 handler）。",
      "",
    ].join("\n");

    const { problems } = checkText(text, "9c2166e:docs/deferred-issues.md");

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ id: "D-193", rule: "top-note", line: 8 });
  });

  it("【RED】D-224：顶部「已解决」+ 状态行「未解决（既有行为，本批次未改）」→ 命中", () => {
    // 出处：9c2166e:docs/deferred-issues.md 第 2329-2340 行。**真被抓到的历史矛盾。**
    const text = [
      "### D-224 · 切换会话不清附件条，旧图片继续阻止发送",
      "",
      "> **2026-11-06 已解决**：新增 `clearAttachments()`，`startSessionIn`（新建）与",
      "> `session_loaded`（打开）两条会话边界都调它；`composer-copy.test.js` 加了静态",
      "> 断言钉住两处调用。以下保留原始记录。",
      "",
      "- **发现**: 2026-11-06，批次 1 / OPT-07 实现时顺带发现。",
      "- **现象**: `state.attachments` 只在用户点移除时收缩，`session_loaded` 分支不清空。切换会话后，上一会话的缩略图仍留在输入框上方。",
      "- **状态**: 未解决（既有行为，本批次未改）。",
      "",
    ].join("\n");

    const { problems } = checkText(text, "9c2166e:docs/deferred-issues.md");

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ id: "D-224", rule: "top-note", line: 9 });
  });

  it("D-202 / D-203 / D-204 / D-205：顶部「已作废」+ 状态行「未解决。」→ 四条全中", () => {
    // 出处：9c2166e:docs/deferred-issues.md 第 1964-2003 行。
    // 这四条是同一类：后端随 `f03473b` 移除，顶部注记写「已作废」，状态行停在「未解决。」。
    const entries = ["D-202", "D-203", "D-204", "D-205"].map((id, index) => [
      `### ${id} · 第 ${index + 1} 条已移除后端的缺口`,
      "",
      "> **2026-11-06 复核：已作废。** 后端已随 `f03473b` 从产品移除。以下保留原始记录。",
      "",
      "- **状态**: 未解决。",
      "",
    ].join("\n"));

    const { problems } = checkText(entries.join("\n"), "9c2166e:docs/deferred-issues.md");

    expect(problems.map((problem) => problem.id)).toStrictEqual(["D-202", "D-203", "D-204", "D-205"]);
    expect(problems.every((problem) => problem.rule === "top-note")).toBe(true);
  });
});

describe("checkPaths：当前仓库与历史文件", () => {
  const root = path.join(import.meta.dirname, "..");

  it("当前 docs/ledgers/ 四个台账零命中（2026-11-07 的修复已清理）", () => {
    // 若这条变红：要么是真实遗留矛盾（报告给人，不要改台账），要么是规则太松。
    const report = checkPaths([path.join(root, "docs", "ledgers")]);

    expect(report.files).toHaveLength(4);
    expect(report.statusLines).toBeGreaterThan(200);
    expect(report.problems).toStrictEqual([]);
  });

  it("目录不存在时返回空结果，不抛错", () => {
    const report = checkPaths([path.join(root, "docs", "no-such-ledger-dir")]);

    expect(report.files).toStrictEqual([]);
    expect(report.problems).toStrictEqual([]);
  });

  it("formatResult：全绿一行摘要，有命中则逐条点名", () => {
    const clean = formatResult({ files: ["a.md", "b.md"], entries: 2, statusLines: 7, problems: [] });
    expect(clean).toHaveLength(1);
    expect(clean[0]).toContain("2 个台账");
    expect(clean[0]).toContain("7 条状态行");
    expect(clean[0]).toContain("无自相矛盾");

    const dirty = formatResult({
      files: ["a.md"],
      entries: 1,
      statusLines: 1,
      problems: [{ file: "a.md", line: 8, id: "D-1", rule: "top-note", detail: "伪造的矛盾" }],
    });
    expect(dirty).toHaveLength(2);
    expect(dirty[0]).toContain("1 处状态自相矛盾");
    expect(dirty[1]).toContain("a.md:8");
    expect(dirty[1]).toContain("D-1");
  });

  it("真实台账的 20 条状态行一条不漏（内容漂移会被这条抓到）", () => {
    // 这条**不**断言文件是 CRLF。上一版断言了，于是它只在本机绿：
    // `.gitattributes` 写的是 `eol=lf`，index 里全是 LF，CI 全新检出拿到的是
    // LF；而本机工作区有 353 个文件早于该属性、检出后没再重新检出，仍是 CRLF。
    // 断言工作区换行符 = 断言「这台机器检出过什么」，不是断言代码行为。
    //
    // CRLF 的解析能力由上一个合成用例（`join("\r\n")`）覆盖，那里不依赖磁盘状态。
    // 这条留下的是另一半价值：台账真的被解析出 20 条状态行，而不是零条。
    const file = path.join(root, "docs", "ledgers", "embedded-defects-todolist.md");
    const raw = readFileSync(file, "utf8");

    expect(checkText(raw, file).statusLines).toBe(20);
  });
});
