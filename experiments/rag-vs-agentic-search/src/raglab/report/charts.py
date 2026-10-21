"""图表生成（spec §11）。

**只画数据支撑得住的图**。`CHART_MANIFEST` 是 §11 的完整清单，其中需要多方案对比、
扰动集或规模实验的图，在数据不到位时**显式跳过并记录原因**，绝不产出空图——
空图会被读成"无差异"。

当前（2026-10-20）只有方案 C 可跑，因此可用的是单方案诊断类图表。
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

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

# 本实验额外的一张三读法对照图（预注册 §6bis 强制全报）。
DISPATCH_FIGURE = "fig_dispatch_variants.png"

# 中文字体候选；找到第一个可用的就用，找不到退回英文标签并告警。
_CJK_FONTS = ("Microsoft YaHei", "SimHei", "DengXian", "SimSun")


@dataclass
class RenderReport:
    """产出了什么、跳过了什么、为什么。"""

    written: list[str] = field(default_factory=list)
    skipped: list[tuple[str, str]] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "written": list(self.written),
            "skipped": [{"file": name, "reason": reason} for name, reason in self.skipped],
            "warnings": list(self.warnings),
        }


def _use_cjk_font() -> bool:
    """尝试启用中文字体；成功返回 True。失败时图表仍能画，只是标签得用英文。"""

    import matplotlib

    matplotlib.use("Agg")
    from matplotlib import font_manager

    available = {font.name for font in font_manager.fontManager.ttflist}
    for name in _CJK_FONTS:
        if name in available:
            matplotlib.rcParams["font.family"] = [name]
            matplotlib.rcParams["axes.unicode_minus"] = False
            return True
    return False


def _require_pyplot():
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    return plt


def render_metrics_overall(
    rows: Sequence[dict[str, Any]],
    output: Path,
    *,
    cjk: bool,
) -> Path:
    """fig2：单方案（或分组）的指标总览柱状图。"""

    plt = _require_pyplot()
    metrics = [("recall@2", "Recall@2"), ("recall@5", "Recall@5"),
               ("hit@1", "Hit@1"), ("mrr", "MRR"), ("ndcg@5", "nDCG@5")]
    labels = [label for _, label in metrics]
    values = [float(rows[0].get(key, 0) or 0) for key, _ in metrics]
    n = rows[0].get("n", "?")

    fig, ax = plt.subplots(figsize=(7, 4))
    bars = ax.bar(labels, values, color="#4c72b0", width=0.6)
    ax.set_ylim(0, 1)
    ax.set_ylabel("Score" if not cjk else "得分")
    scheme = rows[0].get("scheme", "?")
    ax.set_title(
        f"{scheme}: overall metrics (n={n})" if not cjk else f"{scheme}：总体指标（n={n}）"
    )
    for bar, value in zip(bars, values, strict=True):
        ax.text(
            bar.get_x() + bar.get_width() / 2,
            value + 0.02,
            f"{value:.3f}",
            ha="center",
            va="bottom",
            fontsize=9,
        )
    ax.grid(axis="y", alpha=0.3)
    fig.tight_layout()
    fig.savefig(output, dpi=150)
    plt.close(fig)
    return output


def render_latency_cdf(
    latencies: Sequence[float],
    output: Path,
    *,
    cjk: bool,
) -> Path:
    """fig3：延迟 CDF，标注 P50/P95。"""

    plt = _require_pyplot()
    ordered = sorted(float(value) for value in latencies)
    total = len(ordered)
    cdf = [(index + 1) / total for index in range(total)]

    fig, ax = plt.subplots(figsize=(7, 4))
    ax.plot(ordered, cdf, drawstyle="steps-post", color="#4c72b0", linewidth=1.6)
    for q, label in ((50, "P50"), (95, "P95")):
        position = (total - 1) * q / 100
        lower, upper = math.floor(position), math.ceil(position)
        value = ordered[lower] if lower == upper else (
            ordered[lower] * (1 - (position - lower)) + ordered[upper] * (position - lower)
        )
        ax.axvline(value, linestyle="--", linewidth=0.9, color="#c44e52", alpha=0.8)
        ax.text(
            value,
            0.05 + 0.08 * (q / 100),
            f"{label} = {value:.1f} ms",
            color="#c44e52",
            fontsize=9,
            rotation=0,
        )
    ax.set_xlabel("Latency (ms)" if not cjk else "延迟（毫秒）")
    ax.set_ylabel("Cumulative share" if not cjk else "累计占比")
    ax.set_title(
        f"Query latency CDF (n={total})" if not cjk else f"单查询延迟 CDF（n={total}）"
    )
    ax.set_ylim(0, 1.02)
    ax.grid(alpha=0.3)
    fig.tight_layout()
    fig.savefig(output, dpi=150)
    plt.close(fig)
    return output


def render_rejection(
    rows: Sequence[dict[str, Any]],
    output: Path,
    *,
    cjk: bool,
) -> Path:
    """fig6：负样本正确拒答率与假候选率（单方案 + 分组）。"""

    plt = _require_pyplot()
    labels = [str(row.get("scenario", "?")) for row in rows]
    refusal = [float(row.get("correct_refusal_rate", 0) or 0) for row in rows]
    false_candidate = [float(row.get("false_candidate_rate", 0) or 0) for row in rows]

    fig, ax = plt.subplots(figsize=(7, 4))
    positions = range(len(labels))
    width = 0.36
    ax.bar([p - width / 2 for p in positions], refusal, width,
           label="Correct refusal" if not cjk else "正确拒答", color="#55a868")
    ax.bar([p + width / 2 for p in positions], false_candidate, width,
           label="False candidate" if not cjk else "假候选", color="#c44e52")
    ax.set_xticks(list(positions))
    ax.set_xticklabels(labels, fontsize=9)
    ax.set_ylim(0, 1.02)
    ax.set_ylabel("Rate" if not cjk else "比例")
    ax.set_title(
        "Negative-sample behaviour (H7)" if not cjk else "负样本表现（H7）"
    )
    ax.legend(fontsize=9)
    ax.grid(axis="y", alpha=0.3)
    fig.tight_layout()
    fig.savefig(output, dpi=150)
    plt.close(fig)
    return output


def render_dispatch_variants(
    variants: Sequence[dict[str, Any]],
    output: Path,
    *,
    cjk: bool,
) -> Path:
    """三读法对照：预注册 §6bis 强制全报，不是模型选择。"""

    plt = _require_pyplot()
    labels = [str(row["rule"]) for row in variants]
    values = [float(row["recall@2"]) for row in variants]
    primary = [bool(row.get("primary")) for row in variants]

    fig, ax = plt.subplots(figsize=(7, 4))
    colors = ["#4c72b0" if is_primary else "#a8b8d4" for is_primary in primary]
    bars = ax.bar(labels, values, color=colors, width=0.55)
    for bar, value in zip(bars, values, strict=True):
        ax.text(
            bar.get_x() + bar.get_width() / 2,
            value + 0.01,
            f"{value:.4f}",
            ha="center",
            va="bottom",
            fontsize=9,
        )
    ax.set_ylim(0, max(values) * 1.25 if values else 1)
    ax.set_ylabel("Recall@2")
    ax.set_title(
        "Scheme C: dispatch read-outs (sensitivity, not selection)"
        if not cjk
        else "方案 C：dispatch 读法对照（稳健性检查，非选型）"
    )
    ax.grid(axis="y", alpha=0.3)
    fig.tight_layout()
    fig.savefig(output, dpi=150)
    plt.close(fig)
    return output


def render_all(
    *,
    overall: Sequence[dict[str, Any]] | None = None,
    latencies: Sequence[float] | None = None,
    rejection_rows: Sequence[dict[str, Any]] | None = None,
    dispatch_variants: Sequence[dict[str, Any]] | None = None,
    schemes_available: int = 1,
    output_dir: str | Path,
) -> RenderReport:
    """按可用数据产出图表；缺数据的图显式跳过并记录原因。

    参数缺失不是错误——但**静默跳过更不是**，因此每一张跳过的图都会进
    `report.skipped`，最终写进 `report_manifest.json`。
    """

    report = RenderReport()
    target_dir = Path(output_dir)
    target_dir.mkdir(parents=True, exist_ok=True)
    cjk = _use_cjk_font()
    if not cjk:
        report.warnings.append("未找到中文字体，图表标签退回英文（数值不受影响）")

    if overall:
        path = render_metrics_overall(overall, target_dir / "fig2_metrics_overall.png", cjk=cjk)
        report.written.append(path.name)
    else:
        report.skipped.append(("fig2_metrics_overall.png", "缺少 overall 指标行"))

    if latencies:
        path = render_latency_cdf(latencies, target_dir / "fig3_latency_cdf.png", cjk=cjk)
        report.written.append(path.name)
    else:
        report.skipped.append(("fig3_latency_cdf.png", "缺少逐查询延迟"))

    if rejection_rows:
        path = render_rejection(rejection_rows, target_dir / "fig6_rejection_roc.png", cjk=cjk)
        report.written.append(path.name)
    else:
        report.skipped.append(("fig6_rejection_roc.png", "缺少负样本结果"))

    if dispatch_variants and len(dispatch_variants) >= 2:
        path = render_dispatch_variants(
            dispatch_variants, target_dir / DISPATCH_FIGURE, cjk=cjk
        )
        report.written.append(path.name)
    else:
        report.skipped.append((DISPATCH_FIGURE, "需要至少两种 dispatch 读法的结果"))

    # 需要多方案或额外素材的图，按 §11 的定义给出确切的缺失原因。
    if schemes_available < 2:
        reason = f"仅有 {schemes_available} 个方案可跑，对比图无意义（不得以单方案冒充对比）"
        for name in ("fig1_recall_by_type.png", "fig4_cost_quality.png", "fig8_domain_heatmap.png"):
            report.skipped.append((name, reason))
    else:
        for name in ("fig1_recall_by_type.png", "fig4_cost_quality.png", "fig8_domain_heatmap.png"):
            report.skipped.append((name, "多方案对比图尚未实现"))
    report.skipped.append(("fig5_perturbation_decay.png", "扰动集未建（H6 已按 §5.2 降级）"))
    report.skipped.append(("fig7_scale_recall.png", "规模实验（H3）为可选阶段，未运行"))

    return report
