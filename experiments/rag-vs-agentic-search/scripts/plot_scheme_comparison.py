"""从真实评分结果生成四方案对比图（README 用）。

数据来源：results/scored/main/overall.csv —— 与 docs/rag-vs-agentic-search-todo.md §7.1
的表格同源，不手工录入任何数字。

输出两张：
  fig4_schemes_recall.png   四方案 Recall@2 / Hit@1 / MRR 分组柱状图
  fig5_schemes_latency.png  四方案 P50 / P95 延迟（对数轴）

本脚本只读 CSV、只写 figures/ 下的 PNG，不碰任何其他文件。
"""
import csv
import pathlib

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager

ROOT = pathlib.Path(__file__).resolve().parents[1]
CSV = ROOT / "results" / "scored" / "main" / "overall.csv"
OUT = ROOT / "results" / "diagnostic" / "c-diag" / "figures"

# 中文标签需要中文字体；找不到就退回英文，不报错。
CJK_CANDIDATES = ["Microsoft YaHei", "SimHei", "Noto Sans CJK SC", "Source Han Sans SC"]
_available = {f.name for f in font_manager.fontManager.ttflist}
CJK = next((name for name in CJK_CANDIDATES if name in _available), None)
if CJK:
    plt.rcParams["font.sans-serif"] = [CJK]
plt.rcParams["axes.unicode_minus"] = False

SCHEME_LABELS = {
    "A": "A 向量 RAG",
    "B": "B Agentic",
    "C": "C 现状基线",
    "C_prime": "C′ BM25+grep",
}
SCHEME_ORDER = ["A", "B", "C_prime", "C"]
COLORS = {"A": "#4c72b0", "B": "#55a868", "C": "#c44e52", "C_prime": "#8172b3"}


def load():
    with CSV.open(encoding="utf-8") as handle:
        rows = {row["scheme"]: row for row in csv.DictReader(handle)}
    return rows


def bar_metrics(rows):
    metrics = [("recall@2", "Recall@2"), ("hit@1", "Hit@1"), ("mrr", "MRR")]
    schemes = [s for s in SCHEME_ORDER if s in rows]
    width = 0.2
    fig, ax = plt.subplots(figsize=(8, 4.2))
    xs = range(len(metrics))
    for index, scheme in enumerate(schemes):
        values = [float(rows[scheme][key]) for key, _ in metrics]
        offset = (index - (len(schemes) - 1) / 2) * width
        bars = ax.bar(
            [x + offset for x in xs],
            values,
            width,
            label=SCHEME_LABELS[scheme],
            color=COLORS[scheme],
        )
        for bar, value in zip(bars, values):
            ax.text(
                bar.get_x() + bar.get_width() / 2,
                value + 0.015,
                f"{value:.3f}",
                ha="center",
                va="bottom",
                fontsize=7.5,
            )
    ax.set_xticks(list(xs))
    ax.set_xticklabels([label for _, label in metrics])
    ax.set_ylim(0, 1.05)
    ax.set_ylabel("得分" if CJK else "Score")
    ax.set_title(
        ("四方案检索质量对比（n=80，单标注者，探索性）" if CJK
         else "Retrieval quality across four schemes (n=80, single annotator, exploratory)")
    )
    ax.legend(frameon=False, fontsize=8.5)
    ax.grid(axis="y", alpha=0.3)
    fig.tight_layout()
    path = OUT / "fig4_schemes_quality.png"
    fig.savefig(path, dpi=150)
    plt.close(fig)
    return path


def bar_latency(rows):
    schemes = [s for s in SCHEME_ORDER if s in rows]
    p50 = [float(rows[s]["p50_latency_ms"]) for s in schemes]
    p95 = [float(rows[s]["p95_latency_ms"]) for s in schemes]
    width = 0.35
    fig, ax = plt.subplots(figsize=(8, 4.2))
    xs = range(len(schemes))
    bars50 = ax.bar([x - width / 2 for x in xs], p50, width, label="P50", color="#4c72b0")
    bars95 = ax.bar([x + width / 2 for x in xs], p95, width, label="P95", color="#c44e52")
    ax.set_yscale("log")
    ax.set_xticks(list(xs))
    ax.set_xticklabels([SCHEME_LABELS[s] for s in schemes], fontsize=8.5)
    ax.set_ylabel("延迟 ms（对数轴）" if CJK else "Latency ms (log)")
    ax.set_title(
        ("四方案延迟（对数轴）：B 与其余差三个数量级" if CJK
         else "Latency across four schemes (log): B is three orders slower")
    )

    def note(value):
        # CSV 的单位是毫秒：65032.77 → 65.0s，不是 65032775s。
        if value >= 1000:
            return f"{value / 1000:.1f}s"
        return f"{value:.1f}ms"

    def annotate(bars, values, above):
        for bar, value in zip(bars, values):
            ax.text(
                bar.get_x() + bar.get_width() / 2,
                value * (1.35 if above else 1 / 1.35),
                note(value),
                ha="center",
                va="bottom" if above else "top",
                fontsize=7.5,
            )

    # P95 标在柱子上方、P50 标在柱子下方：两者同一量级时不会叠在一起。
    annotate(bars95, p95, above=True)
    annotate(bars50, p50, above=False)
    # 对数轴上留够顶部空间，避免最高的那根柱子把标签顶出画布。
    ax.set_ylim(top=max(p95) * 12)
    ax.legend(frameon=False, fontsize=8.5)
    ax.grid(axis="y", alpha=0.3, which="both")
    fig.tight_layout()
    path = OUT / "fig5_schemes_latency.png"
    fig.savefig(path, dpi=150)
    plt.close(fig)
    return path


def main():
    rows = load()
    if CJK is None:
        print("[warn] 没找到中文字体，标签用英文")
    else:
        print("[info] 中文字体:", CJK)
    for path in (bar_metrics(rows), bar_latency(rows)):
        print("已写出:", path, path.stat().st_size, "bytes")


if __name__ == "__main__":
    main()
