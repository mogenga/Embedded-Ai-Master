# docs/ 目录说明

> 2026-11-07 起按**角色**分目录。之前 29 个文件平铺在 `docs/` 根下，找东西只能靠翻目录。

## 先看两张表

| 你想知道 | 看这里 |
|---|---|
| **接下来做什么、先做哪个** | [`BACKLOG.md`](BACKLOG.md) —— 唯一排期入口，按批次 4~10 划分 |
| **某个模块现在支持什么、为什么隐藏** | [`../AGENTS.md`](../AGENTS.md) 的「当前能力边界」、[`../desktop/MATRIX.md`](../desktop/MATRIX.md) |

## 目录结构

```
docs/
├── BACKLOG.md          ← 待实现功能，按批次划分（唯一排期入口）
├── BRD.md              ← 业务需求、硬性规则 R1-R9、路线图 M1-M4
├── README.md           ← 本文件
├── assets/             ← 图标等静态资源
├── specs/              ← 设计与规范：东西「应该长什么样」
├── operations/         ← 操作手册与契约：东西「怎么用、怎么发」
├── ledgers/            ← 台账：缺陷、审计、实验记录（只登记不改代码）
├── archive/            ← 已完成的一次性任务书与历史报告
└── superpowers/
    └── specs/          ← 分期任务的设计稿（按日期命名）
```

### `specs/` — 设计与规范

| 文件 | 角色 |
|---|---|
| [`p0-kernel-design.md`](specs/p0-kernel-design.md) | 内核六项设计：主循环 / 模型 / 上下文 / 工具 / MCP / 会话 |
| [`frontend-design.md`](specs/frontend-design.md) | 前端设计规范（v2.0 起以实现为准） |
| [`system-prompt-design.md`](specs/system-prompt-design.md) | 系统提示词分节组装（只实现了 `environment` 一节） |
| [`m2-roadmap.md`](specs/m2-roadmap.md) | M2 任务分期与决策记录（文首有 Web/HTTP 形态已下线的说明） |
| [`framework-architecture-inventory.md`](specs/framework-architecture-inventory.md) | 框架能力清单 24 项 + 10 个决策点 |
| [`harness-comparison.md`](specs/harness-comparison.md) | 七工具横向调研 |
| [`ontology-scope-note.md`](specs/ontology-scope-note.md) | Ontology 暂缓纳入检索比对的**范围决策** |

### `operations/` — 操作手册与契约

| 文件 | 角色 |
|---|---|
| [`release.md`](operations/release.md) | 发布流程的**唯一操作手册** |
| [`code-signing.md`](operations/code-signing.md) | Windows 代码签名 |
| [`corpus-ota.md`](operations/corpus-ota.md) | 语料 OTA 接口契约（唯一契约源） |
| [`toolchain-packs.md`](operations/toolchain-packs.md) | 工具链包管理器的结构、不变量与权限语义 |
| [`keil-headless.md`](operations/keil-headless.md) | Keil 后端接线与已知限制 |
| [`datasheet-mcp.md`](operations/datasheet-mcp.md) | 数据手册检索的设计与工具面 |
| [`serial-panel-spec.md`](operations/serial-panel-spec.md) | 串口助手调研、实现方案与事后结论 |
| [`subagent.md`](operations/subagent.md) | 只读子代理的工具面、只读边界、事件契约与已知边界 |
| [`hooks.md`](operations/hooks.md) | 外部命令钩子的配置格式、退出码语义、fail-closed 理由与已知边界 |

### `ledgers/` — 台账

| 文件 | 角色 | 编号 |
|---|---|---|
| [`deferred-issues.md`](ledgers/deferred-issues.md) | 已知问题、触发条件、修复建议 | **D-xxx**（227 条） |
| [`optimization-and-new-features.md`](ledgers/optimization-and-new-features.md) | 2026-11-06 的 44 项审计与落地对照 | **OPT-xx**（§12 是当前状态） |
| [`embedded-defects-todolist.md`](ledgers/embedded-defects-todolist.md) | 嵌入式子系统复查 | **T-xxx**（只剩 T-035 / T-040） |
| [`rag-vs-agentic-search-todo.md`](ledgers/rag-vs-agentic-search-todo.md) | 检索层对照实验的判据与结论 | — |

> [!WARNING]
> **台账的状态行不是单一事实源。** 条目顶部可能有 `> **YYYY-MM-DD 复核：…**` 的注记，两者矛盾时**以正文证据为准**。2026-11-07 的核对就发现 7 处状态行落后于正文（D-134 / D-149 / D-189 / D-193 / D-202~D-205 / D-221 / D-224）。改状态前先读条目全文。

### `archive/` — 已完成的任务书

这些文件**不是当前事实源**，只在追溯需求与取舍时读：

| 文件 | 状态 |
|---|---|
| [`datasheet-mcp-todolist.md`](archive/datasheet-mcp-todolist.md) | 已完成（D1–D20 全部有结论，D16 评估后不做） |
| [`packs-porting-todolist.md`](archive/packs-porting-todolist.md) | 已完成（T1–T15） |
| [`page-optimization-todolist.md`](archive/page-optimization-todolist.md) + `page-optimization-task-{a..f}.md` | 已完成；`dev-notes/页面优化.md` 逐轮引用它们 |
| [`rag-experiment-report/`](archive/rag-experiment-report/README.md) | 实验图与结论；完整报告在 `experiments/rag-vs-agentic-search/` |

## 编号体系怎么读

三套编号并行，**互不替代**：

- **D-xxx** —— 缺陷与缺口。登记的是「知道但暂不修」，每条带**触发升级条件**。修好后标「已解决」但保留条目。
- **OPT-xx** —— 2026-11-06 审计的 44 项。**只此一次**，不再新增；`§12` 记录了每项最终的落地状态。
- **T-xxx** —— 嵌入式子系统复查（2026-10-25）。与 D 分开是因为那轮用了不同的复查方法。

要把某条变成任务：先在 [`BACKLOG.md`](BACKLOG.md) 里找到它所在的批次，再按批次开工。

## 维护规则

1. **新增文档先选目录**：设计/规范进 `specs/`，操作手册与契约进 `operations/`，只登记不改代码的进 `ledgers/`，已完成的一次性任务书进 `archive/`。
2. **移动或改名后跑 `npm run check:docs`**：它检查所有 markdown 本地链接与 `<img src>`，CI 也会跑。
3. **`docs/` 根只放三样**：`BACKLOG.md`、`BRD.md`、本文件；其余一律进子目录。
4. **跨目录引用用相对路径**（`../ledgers/x.md`），不要写 `docs/ledgers/x.md` —— 后者在 GitHub 上是死链，在本地只是纯文本。
