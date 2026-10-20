# 指标定义与实现映射

> 权威口径：主仓库 spec §10.1 与 todo §6.1。本文件只给出**代码位置**与边界用例，避免两处口径漂移。

| 指标 | 实现 | 边界 |
|---|---|---|
| Recall@k（二值） | `metrics.hit_at_k` | 命中数 ≥ `min(k, |gold|)`；`status != ok` 一律 miss |
| 分数型召回（辅助） | `metrics.recall_fraction` | 交集 / `|gold|` |
| Hit@1 | `metrics.hit_at_k(..., k=1)` | 同上 |
| MRR | `metrics.reciprocal_rank` | 首个 gold 名次倒数；未命中 0 |
| nDCG@5 | `metrics.ndcg_at_k` | 二值相关；IDCG 按 `min(k, |gold|)` |
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

## 未实现

- 延迟 CDF 的 P50/P95 汇总表（需 run 结果）。
- AUROC 的正/负查询配对（需负样本集跑批）。
