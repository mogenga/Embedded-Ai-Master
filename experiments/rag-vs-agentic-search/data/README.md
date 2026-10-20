# 评测数据（data/）

本目录存放**进版本库**的评测集标注文件，不含受版权限制的语料正文。语料本体在 `corpus/`，被 `.gitignore` 忽略。

## 当前状态（2026-10-20）

原 M2 回归查询集（274 条）确认无法取得，改为**自建查询集**（视同 M5 人工标注）：

| 文件 | 状态 | 说明 |
|---|---|---|
| `queries.jsonl` | **已建 80 条** | index 轨 50 条（自然语言症状）+ search 轨 30 条（精确 token）；单标注者，全部单 gold |
| `splits.json` | **已生成** | seed 20261019，分层 `track × topic × n_gold`，dev 55 / test 25 |
| `negatives.jsonl` | **已建 25 条** | 覆盖"KB 有相近主题无对应文件""型号外设未覆盖""非 KB 可答"三类 |
| `perturbations.jsonl` | **未建** | H6 专用；缺失只标记 H6 `BLOCKED`，不阻断主实验 |
| `annotation_multi_gold.jsonl` | **未建** | 增强项；缺失时 nDCG@5 按单 gold 计并标低置信 |

**已知偏差（必须在报告中披露，不得隐藏在汇总里）**

1. **单标注者**：查询与 gold 均由同一人（项目所有者）编写，无一致性系数（spec §6.5）。
2. **gold 部分不在索引中**：80 条里有 **11 条**的 gold 不在 `index.yaml`（见 `raglab import` 的 warning）。这些查询上方案 C 结构性无法命中，必须按"gold 是否被索引"分层报告，不能直接与 A/B/C′ 的全量成绩比。
3. **样本量**：80 条低于 spec 功效估算所依据的 274 条；10pp 效应下的检验功效会显著下降，结论更可能落入"未决"。

## 字段说明

## 文件与字段

| 文件 | 必需 | 说明 |
|---|---|---|
| `queries.jsonl` | 是 | 主评测集，274 条查询与 gold |
| `splits.json` | 是 | dev/test 分层切分 |
| `perturbations.jsonl` | H6 需要 | 三档扰动查询，`reviewed=true` 才计分 |
| `negatives.jsonl` | H7 需要 | KB 外负样本 |
| `annotation_multi_gold.jsonl` | 否（增强项） | 多 gold 标注；缺失时 nDCG@5 标低置信 |

字段定义以主仓库 spec §7.2 为准，本文件不另立口径：

- [`queries.jsonl`](../../../docs/superpowers/specs/2026-10-19-rag-vs-agentic-search-experiment-design.md) 的 schema 与校验规则见 §7.2、§7.3。
- `id` 必须匹配 `^[a-z]+-[0-9]{3,}$`；`track ∈ {index, search}`；`topic` 取 todo §6.1 的七个主题域。
- `gold` 为相对 `corpus/kb/` 的 POSIX 路径，导入时逐条校验存在性。
- 查询文本不得包含 gold 路径或文件名（防止答案写在问题里）。

## 许可

评测语料与查询集来自 Phase 0 内容资产，许可按主仓库 BRD R7 执行；导入后语料不进版本库，`data/` 中的标注文件随实验版本库保存。
