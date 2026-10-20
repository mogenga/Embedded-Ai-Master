# 预注册（模板，未冻结）

> **状态：DRAFT — 未冻结，无哈希。** G0 导入通过后，由实验负责人在此文件填写最终内容并计算 SHA-256；
> `score --confirmatory` 必须校验该哈希（spec §6.2）。在冻结前，本文件不构成任何"主判定"依据。

本文件不复述设计，权威内容见
[`docs/superpowers/specs/2026-10-19-rag-vs-agentic-search-experiment-design.md`](../../../docs/superpowers/specs/2026-10-19-rag-vs-agentic-search-experiment-design.md)。

## 1. 假设

H1-H7 定义见 [`docs/rag-vs-agentic-search-todo.md`](../../../docs/rag-vs-agentic-search-todo.md) §3；本实验不重新定义。

## 2. 主指标与判定

| 项 | 预注册值 |
|---|---|
| 主指标 | Recall@2 |
| 主分析样本 | 全量 274 条（test 仅作偏差检查，§7.4） |
| 显著性 | 配对 McNemar 精确检验 + Holm 校正；配对 bootstrap 10,000 次 |
| 比较族 | A vs C′、A vs B、C′ vs C、D vs 最优单一方案 |
| 结论门槛 | 未达条件一律写"未决" |

## 3. 切分

| 项 | 值 |
|---|---|
| seed | `20261019` |
| 分层 | `track × topic × n_gold` |
| 比例 | 70% dev / 30% test |
| 扰动归属 | 跟随 base 查询同侧 |

> 冻结时把 `data/splits.json` 的 SHA-256 填入下方"冻结记录"。

## 4. 调参网格（dev-only）

| 方案 | 网格 |
|---|---|
| A | 切块 {整文件, section} × embedder {本地候选 1, API 候选 1} |
| B | 最大工具轮数 {6, 12, 20} |
| C | 无参数（忠实复现） |
| C′ | 切块 {整文件, section} × 分词 {CJK 二元, jieba} × k1 {0.9, 1.5} × b {0.5, 0.75} |
| D | 仅 D1/D2 两个预注册变体 |

网格内每个配置都必须写入 `results/tables/grid_search.csv`，不只报最优。

## 5. 模型候选（M4 到位后填写）

| 用途 | 候选 | 选择规则 |
|---|---|---|
| LLM | 待填 | dev Recall@2 最高；差距 < 2pp 时优先本地/低成本 |
| Embedding | 本地 bge-m3 类 / API 候选 | 同上 |

端点、模型名与版本写入 `config/models.yaml`；密钥只经环境变量注入，不进版本库。

## 6. 提示词与导航文件

| 项 | 预注册值 |
|---|---|
| Agentic system prompt | `config/prompts/agentic_system.txt`（冻结时记 SHA-256） |
| 导航文件 | `index.yaml`、`_vendor-index.md`、`_sources.md` |
| 导航文件规则 | 可读，但不得作为任何方案的候选输出（T11） |

## 7. 拒答阈值

阈值只在 **dev 负样本**上选择，规则固定：使 dev 正确拒答率 ≥ 80% 的最低阈值；选定后写入此节并冻结。

## 8. 冻结记录

| 项 | SHA-256 | 冻结时间 |
|---|---|---|
| 本文件 | （G0 时计算） | — |
| `config/resolved/A.json` | 未生成 | — |
| `config/resolved/B.json` | 未生成 | — |
| `config/resolved/C_prime.json` | 未生成 | — |
| `data/splits.json` | 未生成 | — |
