#!/usr/bin/env node
/**
 * 台账状态自洽检查（BACKLOG 4.5）。
 *
 * **检查什么**：`docs/ledgers/*.md` 里每个条目（`### D-xxx · …` / `### T-xxx · …`）
 * 的「状态」字段是否与**同一条目自己的正文**打架。两类：
 *
 *   1. 顶部复核注记（`> **YYYY-MM-DD 复核：…**`、`> **YYYY-MM-DD 已解决**：…`）
 *      已经写了 已解决 / 已作废 / 已失效 / 已把决定用断言钉住，而条目的
 *      `- **状态**:` 仍以 未解决 / 仍未解决 / 待修 / 未修 开头。
 *   2. 状态块（状态行 + 缩进续行）里前后判词相反：先说未解决、后面又说已解决，
 *      或先说已解决、后面又说仍未解决。三种情况**不报**——
 *      a. 「部分解决」是合法状态（含 `部分`／`前两项` 这类按子项计的口径）；
 *      b. 引用旧状态（「原始记录：…」、修复前写下的原文）不构成现判词；
 *      c. `已作废` / `已失效` 是对「未解决」的历史终止（对象不存在了），不是
 *         与它并列的另一种判词。
 *
 * **不检查什么（能力边界，别把它当验收）**：本脚本只对齐**台账内部的文字**，
 * 不读 `src/` 与 `desktop/`，因此**无法**判断某个状态对代码是否为真。
 * 2026-11-07 的手工审计（`c8948a3`）做的正是后者——逐条 grep 代码再改状态行。
 * 那批里 D-134 / D-149 / D-189 / D-221 四条，状态行原文并没有与正文矛盾的文字
 * （矛盾在「状态行 vs 代码」），本脚本按设计抓不到；它抓到的是同一批里
 * D-193 / D-202 / D-203 / D-204 / D-205 / D-224 这种「顶部注记已改、状态行没跟」。
 * 绿色的 `check:ledgers` 只意味着「没有条目自相矛盾」，**不意味着每个状态都准确**。
 *
 * 退出码：0 = 无矛盾；1 = 有矛盾（逐条点名 file:line 与条目 id）。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 扫描目录。与 `check-doc-links.mjs` 同一份忽略名单，避免两边口径漂移。 */
const DEFAULT_DIR = "docs/ledgers";

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".tmp", "dist", "dist-mcp", "dist-installer", ".worktrees",
  "corpus", "build", "results", "figures-c-diag",
  ".claude", ".codeartsdoer", "experiments",
]);

/** 条目标题：`### D-134 · …` / `### T-001 · …` / `### 12.1 …`（后者无状态行，不报）。 */
const ENTRY_HEADING = /^###\s+(.+?)\s*$/;
/** 条目边界：`##` 或 `###` 标题。 */
const ANY_HEADING = /^#{2,3}\s+/;
/** 状态行。 */
const STATUS_LINE = /^\s*-\s+\*\*状态\*\*\s*[:：]\s*(.*)$/;
/** 带日期的粗体复核注记：`> **2026-11-06 复核：…**`。 */
const DATED_NOTE = /^>\s*\*\*\d{4}-\d{2}-\d{2}\b/;

/** 开头的「未了结」判词。 */
const UNRESOLVED_LEADS = ["仍未解决", "未解决", "未修复", "待修", "未修"];
/** 开头的「已了结」判词。 */
const RESOLVED_LEADS = ["已把决定用断言钉住", "已解决", "已作废", "已失效", "已修复"];
/** 与「未解决」正面冲突的判词——`已作废`/`已失效` 不在此列（见文件头 2.c）。 */
const RESOLVED_STRONG = ["已把决定用断言钉住", "已解决", "已修复"];
/** 与「已解决」正面冲突的判词。 */
const UNRESOLVED_MARKERS = ["仍未解决", "未解决", "未修复", "待修", "未修"];
/** 引用旧状态的括注特征：命中即视为「原文摘录」，不构成现判词。 */
const QUOTE_HINTS = ["原始记录", "原始状态", "原记录", "原状态", "修复前", "此前", "历史"];
/**
 * 标记**紧前面**写着这些词时同样算引用：`**原始状态**：仍未解决`。
 * 不带括注，所以 `isQuoted` 的括号扫描抓不到，得单独看前缀窗口。
 * 刻意不含「修复前 / 此前」——「此前未解决」本身就是一条现判词。
 */
const PREFIX_QUOTE_HINTS = ["原始记录", "原始状态", "原记录", "原状态"];
/** 按子项计的口径：出现即说明该判词只覆盖一部分，不是整条的状态。 */
const SCOPE_HINTS = /部分|大部分|前两项|后两项|一半|此半|第\s*[一二三四五六七八九十1-9]\s*项|[①②③④⑤⑥⑦⑧⑨⑩]/;
/** 指向**别的条目**的引用：`D-134 的桌面侧已解决` 说的是另一条，不是本条现判词。 */
const CROSS_REFERENCE = /[A-Z]+-\d+\s*(?:的)?[^\s。；;，,]{0,10}$/;

function startsWithAny(text, list) {
  for (const token of list) {
    if (text.startsWith(token)) return token;
  }
  return undefined;
}

/** 去掉行首空白与包裹标记（`**` / `~~` / `*`），得到判词正文。 */
function leadOf(text) {
  return text.replace(/^\s+/, "").replace(/^(\*\*|~~|\*)+/, "").trimStart();
}

/** 把 `【...】`/`（...）`/`「...」` 的区间收出来，用于「引用旧状态」判定。 */
function bracketSpans(text) {
  const spans = [];
  for (const [open, close] of [["「", "」"], ["（", "）"], ["(", ")"]]) {
    let from = 0;
    for (;;) {
      const start = text.indexOf(open, from);
      if (start < 0) break;
      const end = text.indexOf(close, start + 1);
      if (end < 0) break;
      spans.push({ start, end: end + close.length, open, close, inner: text.slice(start + 1, end) });
      from = end + 1;
    }
  }
  return spans;
}

/** 该位置是否落在「引用旧状态」的片段里。 */
function isQuoted(text, index) {
  for (const span of bracketSpans(text)) {
    if (index < span.start || index >= span.end) continue;
    // 直角引号一律算引用；圆括号只在括注明说是旧记录时才算。
    if (span.open === "「") return true;
    if (QUOTE_HINTS.some((hint) => span.inner.includes(hint))) return true;
  }
  return false;
}

/** 找出 text 里所有**未被引用**且**不是指向别的条目**的标记位置。 */
function findLive(text, markers, from = 0) {
  const hits = [];
  for (const marker of markers) {
    let index = text.indexOf(marker, from);
    while (index >= 0) {
      // 往前看一个短窗口：紧贴在别的条目编号后面时，说的是那条，不是本条。
      const window = text.slice(Math.max(0, index - 16), index);
      const quotedByPrefix = PREFIX_QUOTE_HINTS.some((hint) => window.includes(hint));
      if (!isQuoted(text, index) && !quotedByPrefix && !CROSS_REFERENCE.test(window)) {
        hits.push({ index, marker });
      }
      index = text.indexOf(marker, index + marker.length);
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}

/**
 * 判定一个状态块是否自相矛盾。返回 `{ rule, detail }` 或 `undefined`。
 *
 * 只在**开头判词**与**后续反证**之间判矛盾；中段出现什么都不算——
 * 台账的惯例是「原判词 + 后续补充」，补充只在与开头判词相反时才说明状态行没跟上。
 */
export function contradictionOf(statusText) {
  const lead = leadOf(statusText);
  const unresolvedLead = startsWithAny(lead, UNRESOLVED_LEADS);
  const resolvedLead = startsWithAny(lead, RESOLVED_LEADS);
  const leadLength = statusText.length - lead.length + (unresolvedLead ?? resolvedLead ?? "").length;

  if (unresolvedLead !== undefined) {
    // 「部分解决」等按子项计的口径由开头判词本身承担；这里只看开头之后的强反证。
    const hits = findLive(statusText, RESOLVED_STRONG, leadLength);
    // 子项口径：反证前出现过「部分 / 前两项 / ①②③ / 第 N 项 / 一半」，说明它只覆盖一部分。
    if (hits.length > 0 && !SCOPE_HINTS.test(statusText.slice(0, hits[0].index))) {
      return {
        rule: "status-line",
        detail: `状态行以「${unresolvedLead}」开头，后面又写「${hits[0].marker}」`,
      };
    }
  }

  if (resolvedLead !== undefined) {
    const hits = findLive(statusText, UNRESOLVED_MARKERS, leadLength);
    if (hits.length > 0 && !SCOPE_HINTS.test(statusText.slice(0, hits[0].index))) {
      return {
        rule: "status-line",
        detail: `状态行以「${resolvedLead}」开头，后面又写「${hits[0].marker}」`,
      };
    }
  }

  return undefined;
}

/**
 * 解析一份台账文本，返回条目、状态行数与矛盾列表。
 *
 * 条目 = `### …` 标题到下一个 `##`/`###` 标题之间的正文；状态块 = 状态行 + 其后的
 * 缩进续行（D-134 / D-221 的补充段就写在续行里）。
 */
export function checkText(text, file = "<inline>") {
  // 台账里既有 LF 也有 CRLF（`embedded-defects-todolist.md` 是 CRLF）。
  // 不归一化的话，`.*$` 匹配不到 `\r` 结尾的行——状态行会被整批漏掉，
  // 而漏掉的表现是「零命中」，正是这个脚本最不该有的假绿。
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  /** @type {{ id: string, line: number, bodyStart: number, bodyEnd: number }[]} */
  const entries = [];
  for (let i = 0; i < lines.length; i += 1) {
    const heading = ENTRY_HEADING.exec(lines[i]);
    if (heading === null) continue;
    const idMatch = /^([A-Z]+-\d+)\b/.exec(heading[1]);
    const id = idMatch === null ? heading[1].replace(/^[`*_]+|[`*_]+$/g, "") : idMatch[1];
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (ANY_HEADING.test(lines[j])) {
        end = j;
        break;
      }
    }
    entries.push({ id, line: i + 1, bodyStart: i + 1, bodyEnd: end });
  }

  const problems = [];
  let statusLines = 0;

  for (const entry of entries) {
    const body = lines.slice(entry.bodyStart, entry.bodyEnd);

    // 顶部复核注记：连续的 `> ` 行里，只要有一行以带日期的粗体开头就算一条注记。
    const notes = [];
    for (let i = 0; i < body.length; i += 1) {
      if (!DATED_NOTE.test(body[i])) continue;
      let noteEnd = i;
      while (noteEnd + 1 < body.length && /^>\s?/.test(body[noteEnd + 1])) noteEnd += 1;
      notes.push({
        line: entry.bodyStart + i + 1,
        text: body.slice(i, noteEnd + 1).map((line) => line.replace(/^>\s?/, "")).join(" "),
      });
    }

    // 状态块。
    const statuses = [];
    for (let i = 0; i < body.length; i += 1) {
      const match = STATUS_LINE.exec(body[i]);
      if (match === null) continue;
      let blockEnd = i;
      while (
        blockEnd + 1 < body.length
        && /^(\s{2,}|\t)\S/.test(body[blockEnd + 1])
        && STATUS_LINE.exec(body[blockEnd + 1]) === null
      ) {
        blockEnd += 1;
      }
      statuses.push({
        line: entry.bodyStart + i + 1,
        // 首行只取状态行冒号之后的部分，续行原样拼接——判词从正文开头看。
        text: [match[1], ...body.slice(i + 1, blockEnd + 1)].join("\n"),
      });
    }
    statusLines += statuses.length;

    for (const status of statuses) {
      const lead = leadOf(status.text);
      const unresolved = startsWithAny(lead, UNRESOLVED_LEADS);

      // 规则 1：顶部注记已了结，状态行仍以未了结开头。
      const note = unresolved === undefined
        ? undefined
        : notes.find((candidate) => /已解决|已作废|已失效|已把决定用断言钉住/.test(candidate.text));
      if (unresolved !== undefined && note !== undefined) {
        problems.push({
          file,
          line: status.line,
          id: entry.id,
          rule: "top-note",
          detail: `第 ${note.line} 行注记写「${note.text.slice(0, 40)}…」，状态行仍以「${unresolved}」开头`,
        });
        continue;
      }

      // 规则 2：状态块内前后判词相反。两个方向都判——已解决开头 + 后面仍未解决
      // 同样让读者无法判断，不能只查「未解决开头」那一个方向。
      const contradiction = contradictionOf(status.text);
      if (contradiction !== undefined) {
        problems.push({ file, line: status.line, id: entry.id, ...contradiction });
      }
    }
  }

  return { entries: entries.length, statusLines, problems };
}

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
      continue;
    }
    if (/\.md$/i.test(entry.name)) out.push(full.replace(/\\/g, "/"));
  }
  return out;
}

/** 扫一组 markdown 文件（或目录）并汇总。目录不存在时返回空结果，不抛错。 */
export function checkPaths(paths) {
  const files = [];
  for (const target of paths) {
    if (/\.md$/i.test(target)) {
      if (existsSync(target)) files.push(target.replace(/\\/g, "/"));
      continue;
    }
    try {
      walk(target, files);
    } catch {
      // 目录不存在 = 没有台账可查，由调用方按 files.length 报告。
    }
  }
  files.sort();

  const problems = [];
  let entries = 0;
  let statusLines = 0;
  for (const file of files) {
    const result = checkText(readFileSync(file, "utf8"), file);
    entries += result.entries;
    statusLines += result.statusLines;
    problems.push(...result.problems);
  }
  return { files, entries, statusLines, problems };
}

/** 输出一行摘要 + 逐条问题。纯函数便于测试与复用。 */
export function formatResult({ files, statusLines, problems }) {
  if (problems.length === 0) {
    return [`check-ledger-status: ${files.length} 个台账、${statusLines} 条状态行，无自相矛盾`];
  }
  const lines = [`check-ledger-status: ${problems.length} 处状态自相矛盾（共 ${statusLines} 条状态行）`];
  for (const problem of problems) {
    lines.push(`  ${problem.file}:${problem.line} ${problem.id} [${problem.rule}] ${problem.detail}`);
  }
  return lines;
}

const invokedDirectly = process.argv[1] !== undefined
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  // 可传路径覆盖默认目录：回归用（对 `git show <rev>:docs/deferred-issues.md`
  // 抽出来的历史文件跑），或从仓库外调用。
  const targets = process.argv.slice(2).length > 0
    ? process.argv.slice(2).map((target) => path.resolve(target))
    : [path.join(root, DEFAULT_DIR)];
  const result = checkPaths(targets);
  if (result.files.length === 0) {
    console.error(`check-ledger-status: 没找到任何台账文件——扫描路径写错了？(${targets.join(", ")})`);
    process.exit(1);
  }
  const lines = formatResult(result);
  if (result.problems.length === 0) {
    console.log(lines[0]);
    process.exit(0);
  }
  console.error(lines[0]);
  for (const line of lines.slice(1)) console.error(line);
  process.exit(1);
}
