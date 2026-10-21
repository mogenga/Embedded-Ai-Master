# 指标定义与实现映射

> 权威口径：主仓库 spec §10.1 与 todo §6.1。本文件只给出**代码位置**与边界用例，避免两处口径漂移。

| 指标 | 实现 | 边界 |
|---|---|---|
| Recall@k（二值） | `metrics.hit_at_k` | 命中数 ≥ `min(k, |gold|)`；`status != ok` 一律 miss |
| 分数型召回（辅助） | `metrics.recall_fraction` | 交集 / `|gold|` |
| Hit@1 | `metrics.hit_at_k(..., k=1)` | 同上 |
| MRR | `metrics.reciprocal_rank` | 首个 gold 名次倒数；未命中 0 |
| nDCG@5 | `metrics.ndcg_at_k` | 二值相关；IDCG 按 `min(k, |gold|)`；**gold 集合用多 gold 补标**（见下） |
| 假候选率 | `metrics.is_false_candidate` | `status=ok` 且候选非空 |
| 正确拒答率 | `metrics.is_correct_refusal` | `no_match` 或最高分 < dev 选定阈值 |
| AUROC | `metrics.auroc` | 用候选最高分；并列计 0.5 |
| 扰动衰减率 | `metrics.perturbation_decay` | 干净分为 0 时返回 nan |
| P50/P95 延迟 | `metrics.percentile` | 线性插值；不引入 numpy |
| McNemar 精确检验 | `stats.exact_mcnemar` | `scipy.stats.binomtest`，双侧，`p=0.5` |
| 配对 bootstrap CI | `stats.paired_bootstrap_ci` | 默认 10,000 次；支持按 track 分层 |
| Holm 校正 | `stats.holm_adjust` | step-down，保持输入顺序 |
| 逐查询评分 | `scoring.score_one` | 输出 `ScoredQuery`，字段固定 |
| 分组汇总 | `scoring.summarize` | 维度限 `scheme/track/topic/n_gold`；未知维度报错 |

## 计分前必须完成的两件事

1. **导航文件过滤**：`schemes.base.filter_navigation`，在计入指标之前。
2. **ITT 分母固定**：`status != ok` 计入分母但记为 miss，不得从样本里剔除。

## 2026-10-21 实测后补充的边界

### 1. H7 的阈值必须**按方案各自选**

`is_correct_refusal` 的 `threshold` 参数**不能跨方案共用**——各方案的分数量纲不同
（C 的 lookup 分是正数 BM25 分，C′ 的 search 分支用负名次）。
拿 C 的阈值去判 C′ 会得出「返回了候选、却又算正确拒答」的矛盾结果。
2026-10-20 实测踩到过：C′ 假候选率 100% 而正确拒答率只有 72%。
现由 `report/h7.py` 的 `select_threshold` 按方案各自在 dev 负样本上选。

### 2. 没有负样本跑批实现的方案，H7 **整块不报**

不是报 0，也不是报 100%。2026-10-20 实测踩到过：负样本跑批器对未知方案返回
`("no_match", [], 0)`，方案 B 因此被算成「假候选率 0%、正确拒答率 100%」，
看起来像最强的拒答方案，实际只是**没人跑过 B 的负样本**。
「没跑」和「跑出来满分」在报告里长得一模一样，读者分辨不出来。
现改为：跑批器对未实现的方案抛 `BlockedError`，`report/analysis.py` 捕获后
把该方案的 H7 标 `skipped`，不产出任何数字。

### 3. Holm 的族大小固定，不因缺数据而缩小

`stats.holm_adjust` 的乘数是传入 p 值的个数。调用方（`report/significance.py`）
**必须把缺席的族内比较按 p = 1 一并传入**，否则乘数会变小、校正后的 p 值凭空变小。
2026-10-21 实测踩到过：族从 4 缩到 2，C′ vs C 的 p_adj 从 9.9e−07 变成 4.9e−07。
族是预注册时定死的，缺数据不会让它变小。

### 4. 配对检验前必须校验配对

McNemar 与配对 bootstrap 要求两方案在**同一批查询、同序**上比较。
`report/analysis.py` 的 `check_alignment` 会校验 query_id 集合与顺序，
不一致直接报错——不校验就会算出「A 的第 3 条 vs B 的第 7 条」这种无意义比较，
**而且 p 值看上去还挺正常**。

### 5. nDCG@5 的 gold 集合来自多 gold 补标（spec §7.3 第 5 条 / §7.5）

- `data/annotation_multi_gold.jsonl` 记录每条 index 查询的**全部**相关文件（含主 gold）。评分时 `scoring.score_records` 的 `multi_gold` 参数传入该映射，
  **只用来算 nDCG@5**。
- **主判定指标（Recall@k / Hit@1 / MRR）一律用 `queries.jsonl` 的原始单 gold。**
  spec §7.3 第 5 条明写「主判定只用导入的原始 gold」。
  理由：多 gold 回答的是「还需要读哪些文件」，用它改 Recall@2 会让
  「top-2 里放了 2 个正确答案」被误判成未命中——可 top-2 本来就只能放 2 个。
- 没有这个文件时 nDCG **退化成单 gold**并标低置信，**不是不报**。
- **接线前这是个真缺口**（2026-10-21 实测）：该文件只被 `intake` 读进来数条数，
  评分时用的仍是 `query.gold`——**多 gold 建了也进不了评分**。现补上，
  并用「primary 指标必须一字未变」作为接线正确性的验收标准。

### 6. 已实现的汇总

- 延迟 P50/P95 汇总表：`report/analysis.py` 的 `latency_summary`，
  产物在 `results/analysis/main.json` 的 `latency` 段。
- AUROC 的正/负查询配对：`report/h7.py` 的 `collect_positive_scores` +
  `metrics.auroc`。正样本取全部查询的最高候选分数，负查询记 0 分。
