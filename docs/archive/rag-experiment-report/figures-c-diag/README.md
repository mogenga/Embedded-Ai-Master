# 方案 C 单方案诊断图（探索性）

> **这不是方案对比图。** 这 4 张图只画**方案 C 一个方案**，
> 回答「这套 C 的实现到底在做什么」，不回答「哪个方案更好」。
> 四方案对照图在上级目录（`../fig1`–`fig5`）。

| 文件 | 内容 |
|---|---|
| `fig2_metrics_overall.png` | C 的总体指标（Recall@2/5、Hit@1、MRR、nDCG@5） |
| `fig3_latency_cdf.png` | C 的单查询延迟 CDF，标注 P50/P95 |
| `fig6_rejection_roc.png` | C 在负样本上的正确拒答率与假候选率 |
| `fig_dispatch_variants.png` | C 的三种 dispatch 读法对照（`deployed` / `lexical` / `lookup_only`） |

**为什么 dispatch 要三种都画**（预注册 §6bis 强制全报）：
`deployed` 与 `lexical` 差 8.75pp、与 `lookup_only` 差 5pp，
**跨度超过本实验主判定用的 5pp 门槛**。只看一种读法得出的结论，
换一种读法可能反向。

**未产出的图及原因**（不产出空图——空图会被读成「无差异」）：

| 文件 | 原因 |
|---|---|
| `fig1_recall_by_type.png` | 仅有 1 个方案可跑，对比图无意义（不得以单方案冒充对比） |
| `fig4_cost_quality.png` | 同上 |
| `fig8_domain_heatmap.png` | 同上 |
| `fig5_perturbation_decay.png` | 扰动集未建（H6 已按 §5.2 降级） |
| `fig7_scale_recall.png` | 规模实验（H3）为可选阶段，未运行 |

原文：[`experiments/rag-vs-agentic-search/results/diagnostic/c-diag/report.md`](../../../experiments/rag-vs-agentic-search/results/diagnostic/c-diag/report.md)
