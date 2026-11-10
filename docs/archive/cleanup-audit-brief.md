# 思考强度改造后的整体清理 —— 审计与实施（2026-11-10）

> 用户原话：「发代理整体优化一下，前面踩得坑多，可能很多废弃代码废弃文件」
>
> 授权是**清理**，不是重构。判定标准只有一条：
> **删掉之后行为不变，且没有任何代码/文档/测试再引用它。**

## 背景：这一轮改了什么

2026-11-09 至 11-10，思考强度这块被连改了十几轮（`git log --oneline -18` 全是）。
功能形态最终定成：

- **界面**：脑形滑块卡片，**固定六格**（Low / Medium / High / Extra / Max / Galaxy），
  每格下方标出实际会发的协议值。**没有 `auto` 那一格**。
- **解析**：三级回退 —— 网关目录 → `providers.json` 的 `reasoningLevels` →
  `effortMap` / `DEFAULT_EFFORT_MAP`。语义秩规则「取 ≤ 该档的最高可用值」。
- **能力来源**：`GET /v1/models`，字段名有别名（含嵌套的 `effort.supported_levels`）。
- **缓存**：按 provider 分开，带代次号防竞态。

中间被推翻的设计（现在多半已经死了，但可能留有残骸）：

| 曾经的形态 | 何时被推翻 |
|---|---|
| 原生 `<input type="range">` 六档滑块 | 2026-11-09 换成脑形卡片 |
| `Auto` 独立按钮（在卡片外） | 先搬进卡片，后并入轨道，最后整个删掉 |
| 轨道上有 `Auto`/`Off` 一格 | 2026-11-10 「AUTO删掉」 |
| **按协议值去重**的档位（轨道长度随模型变） | 2026-11-10 「永远六格」 |
| 模型不支持时**隐藏**控件 | 2026-11-09 「思考强度应该始终显示」 |
| 卡片外的 `#effort-note` 声明句 | 声明并入卡片 → 自适应映射后整个删掉 |
| 中文档位名（低/中/高/加强/极强/星系） | 2026-11-09 「用英文，不用自动翻译」 |
| `TIER_NAMES` / `EFFORT_TIER_LABELS` 作为标签来源 | 标签改由宿主的 `stops[i].label` 提供 |

## 已知的死东西（我核实过的，直接删）

### 1. `desktop/renderer/i18n.js` 里十个无人读的键

实测 readers = 0（`grep "t.<key>" desktop/renderer/*.js` 排除 i18n.js 自身）：

```
effortLow, effortMedium, effortHigh, effortFixed
effortTierLow, effortTierMedium, effortTierHigh, effortTierExtra, effortTierMax, effortTierGalaxy
```

两套字典都要删（`en` 与 `zh`）。**保留**这四个（仍在使用）：

- `effortAuto`（芯片在 `auto` 状态下的标签）
- `effortLabel`（面板 aria-label）
- `effortSends`（每格的「sends X」由 `renderEffortPanel` 用）
- `settingsEffort`（设置页，虽然没有渲染者，但它是设置页面的词条，删它属于另一个决定）

删完要更新 i18n.js 里那段解释「这几个键为什么中英相同」的注释——它引用了已删的键。

### 2. `desktop/renderer/effort-tiers.js` 的去留

**先判断再动手。** 它导出 `EFFORT_TIERS` / `EFFORT_TIER_LABELS` / `effortTierIndex` / `effortTierAt`。

- `effortTierIndex` —— **仍在用**（`app.js` 的 `effortStopIndex` 之外还有调用点，核实）。
- `effortTierAt` —— 查所有调用点，若无则删。
- `EFFORT_TIERS` / `EFFORT_TIER_LABELS` —— 查 `app.js` / `host.js` / 测试。

**如果整个文件只剩测试在用，不要删文件**：`tests/desktop/effort-slider.test.js`
有「渲染层的 EFFORT_TIERS 与内核逐项相同」这条断言，它是防止两份常量漂移的钉子。
这种情况的正确做法是**删无用的导出、保留有断言价值的**，并在文件头说明为什么留。

### 3. 文档里对已删机制的描述

`docs/specs/effort-tiers.md` 与 `docs/operations/*` 可能还写着：

- 「滑块长度就是能力声明」——**已推翻**，现在是固定六格
- 把 `effortMap` 写成无条件生效（它是第 3 级）
- 「六档里有三档发同一个值」作为**问题**来描述（现在它是**已知且已披露**的行为，每格下方标了实际值）

改文档时保留日期注记，不要重写历史。

### 4. `.superpowers/sdd/` 下的计划与报告

`effort-tiers-plan/`、`galaxy-effort-plan/`、`adaptive-effort-plan/`、`effort-catalog-plan/`
已由 `.superpowers/sdd/.gitignore`（内容 `*`）整体忽略，**不进版本库**。不要删它们——
它们是这一轮的过程记录，且本来就不会被提交。

`docs/archive/` 下的四份 plan 是**已提交的历史留档**，按 `AGENTS.md` 的规则：
事实源写事实，历史留档加日期注记、保留原文。**不要删，也不要改写它们的语气**；
如果里面有与现状矛盾的地方，在文首加一行日期注记指向现状。

## 你要做的事

### 第一步：审计（不要改任何文件）

把下面的清单做出来，写进报告：

1. **未被引用的导出**：对 `desktop/renderer/` 下每个模块，列出 `export` 的名字与全仓库引用数
   （排除自身定义行、排除 `tests/` 里只为断言存在的引用要单独标注）。
2. **未被读的 i18n 键**：`dictionaries.en` 与 `dictionaries.zh` 里所有 `effort*` 开头的键，
   各自的读者数。
3. **未被引用的 CSS 类**：`styles.css` 与 `galaxy-effort.css` 里 `effort` / `ge-` 开头的
   选择器，哪些在 `desktop/renderer/*.js` / `*.html` 里找不到。
4. **未被使用的内核导出**：`src/config/providers.ts`、`src/model/catalog.ts` 里这一轮新增的
   导出，各自的引用数（`desktop/host/host.js` 通过 `dist/` 消费，算引用）。
5. **孤儿文件**：有没有整个文件已经没人 import 了。
6. **重复实现**：同一件事有两份实现的（例如 `foldReveal` 与组件内联的 `foldRevealAt`），
   列出各自位置与**为什么当初分开**（读注释，别猜）。

**每条都要给出证据**：`grep` 命令 + 结果行数，或"我查了 X 处，见 file:line"。

### 第二步：删除

只删审计里**证据充分**的（引用数为 0，且不是"保留理由"那一类）。每删一处：
- 跑一次 `npm run check:js` 与相关测试
- 在报告里记：删了什么、删之前引用数、删之后哪条测试变绿/是否变红

**不确定的一律不动**，列进「建议但不删」一节并说明理由。

### 第三步：验证

1. `npm run verify`（typecheck + check:js + check:docs + check:ledgers + test）
2. 全量 `npx vitest run --maxWorkers=4`
3. 两次结果写进报告。**vitest 对不存在的路径也退出 0**，看 `Test Files N passed` 那一行。
   并行负载下有已知偶发红（`background-terminal` / `process-tree-terminate` / `packs` /
   `verify-signature`），单跑必绿的那种不算回归——如实报告，别去调超时。

## 硬约束（违反即停）

- **禁止依赖安装/变更命令**（`npm install` / `npm ci` / `npm update` / `yarn` / `pnpm` / `bun install`）。
- **禁止真实执行危险命令**：`del /s /q <盘符根>`、`rm -rf /`、`rm -rf ~`、`format`、`diskpart`、
  `mkfs*`、`dd ... of=/dev/...`、`shutdown`/`reboot`/`poweroff`/`halt`、fork bomb、
  `reg delete HKLM`、`bcdedit`、`cipher /w`。
- **禁止任何 git 写操作**：`add`/`commit`/`reset`/`checkout`/`stash`/`switch`/`branch`/
  `worktree`/`merge`。只读的 `git status`/`git diff`/`git log` 可以。
- **写文件用 Write/Edit**，不要 `node -e` / `bash -c` / `python - <<EOF` 拼含反引号、
  `$()`、`${}` 的文本。
- **不要删 `.tmp/`** 下的东西：那是主控的一次性探针，已被 gitignore，主控自己会清。
- **不要改** `docs/ledgers/deferred-issues.md` 的既有条目（新增可以）。
- 不得删改仍然被引用的东西，即使你觉得"应该没人用"。
- **不得触网**。

## 报告

写到 `.superpowers/sdd/cleanup-report.md`。结构：

```
# 思考强度改造后的清理报告

## 一、审计结果
（六个清单，每条带证据）

## 二、已删除
（表格：文件、删了什么、删前引用数、验证结果）

## 三、建议但不删
（每条：什么东西、为什么可疑、为什么不动）

## 四、验证
（原始终端输出）

## 五、意外发现
（顺手看到的、与本次清理无关但值得记的问题）
```

在**回复正文**里给我 600 字以内的浓缩版：删了什么、留了什么、验证结果。
