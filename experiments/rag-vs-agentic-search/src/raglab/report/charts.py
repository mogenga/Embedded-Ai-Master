"""图表骨架（§11，fig1-fig8）。

**骨架期不产图**：没有评分数据时生成图表会把"空图"误读成"无差异"。
每张图的实现绑定在对应的 CSV 之后，跑批完成后另行实现。
"""

from __future__ import annotations

from ..errors import FeatureNotImplemented

# §11 的固定图表清单；文件名即契约。
CHART_MANIFEST: dict[str, str] = {
    "fig1_recall_by_type.png": "两类查询 × 方案 Recall@2，95% CI（H1/H2）",
    "fig2_metrics_overall.png": "Recall@2/5、Hit@1、MRR、nDCG@5（主指标）",
    "fig3_latency_cdf.png": "延迟 CDF，标注 P50/P95（H4）",
    "fig4_cost_quality.png": "token 成本 vs Recall@2（H4）",
    "fig5_perturbation_decay.png": "三档扰动 ΔRecall@2（H6）",
    "fig6_rejection_roc.png": "拒答 ROC + 假候选率（H7）",
    "fig7_scale_recall.png": "1x/10x/100x 规模曲线（H3）",
    "fig8_domain_heatmap.png": "主题域 × 方案 Recall@2 热力图",
}


def render_all(*_: object, **__: object) -> None:
    raise FeatureNotImplemented(
        "图表需在 results/scored/*.csv 生成后实现；骨架期不产出空图"
    )
