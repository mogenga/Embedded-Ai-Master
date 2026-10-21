"""单方案诊断报告与图表：诚实性优先（§11）。

三条硬要求，逐条测：
1. 单方案时**不得**产出对比图（空图会被读成"无差异"）；
2. 跳过的图必须带原因，不能静默消失；
3. 报告正文必须在开头就声明"这不是实验结论"。
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from raglab.assets import Query
from raglab.report.charts import CHART_MANIFEST, DISPATCH_FIGURE, render_all
from raglab.report.diagnostic import (
    DISPATCH_ORDER,
    PRIMARY_RULE,
    NegativeResult,
    run_diagnostic,
    write_diagnostic,
)
from raglab.report.diagnostic_md import render_markdown


def _corpus(tmp_path: Path) -> Path:
    root = tmp_path / "kb"
    (root / "protocols").mkdir(parents=True)
    (root / "index.yaml").write_text(
        "entries:\n"
        "  - id: uart\n"
        "    title: 串口无输出\n"
        "    path: protocols/uart.md\n"
        "    tags: [uart]\n"
        "    keywords: [没输出, 无输出]\n"
        "    summary: x\n",
        encoding="utf-8",
    )
    (root / "protocols" / "uart.md").write_text("# 串口\nUART 接线要共地\n", encoding="utf-8")
    return root


def _queries() -> list[Query]:
    return [
        Query(id="idx-001", track="index", text="串口没输出", gold=("protocols/uart.md",), topic="protocols"),
        Query(id="idx-002", track="index", text="完全无关的问题", gold=("missing.md",), topic="system"),
    ]


# ---- 图表：跳过要有理由 ----------------------------------------------------


def test_single_scheme_never_emits_comparison_charts(tmp_path: Path) -> None:
    """只有一个方案时，对比类图表必须跳过——不得以单方案冒充对比。"""

    report = render_all(
        overall=[{"scheme": "C", "n": 1, "recall@2": 0.5}],
        latencies=[1.0, 2.0],
        output_dir=tmp_path / "figures",
        schemes_available=1,
    )
    comparison = ("fig1_recall_by_type.png", "fig4_cost_quality.png", "fig8_domain_heatmap.png")
    for name in comparison:
        assert name not in report.written
        assert any(skipped == name for skipped, _ in report.skipped)


def test_every_skipped_chart_has_a_reason(tmp_path: Path) -> None:
    report = render_all(output_dir=tmp_path / "figures", schemes_available=1)
    assert report.skipped, "什么都不产出时必须全部标注跳过"
    for name, reason in report.skipped:
        assert name in CHART_MANIFEST or name == DISPATCH_FIGURE
        assert reason.strip(), f"{name} 的跳过原因不能为空"


def test_dispatch_chart_needs_at_least_two_variants(tmp_path: Path) -> None:
    single = render_all(
        dispatch_variants=[{"rule": "deployed", "recall@2": 0.45, "primary": True}],
        output_dir=tmp_path / "a",
        schemes_available=1,
    )
    assert DISPATCH_FIGURE not in single.written

    pair = render_all(
        dispatch_variants=[
            {"rule": "deployed", "recall@2": 0.45, "primary": True},
            {"rule": "lexical", "recall@2": 0.53, "primary": False},
        ],
        output_dir=tmp_path / "b",
        schemes_available=1,
    )
    assert DISPATCH_FIGURE in pair.written


def test_charts_are_png_files_with_content(tmp_path: Path) -> None:
    report = render_all(
        overall=[{"scheme": "C", "n": 80, "recall@2": 0.45, "recall@5": 0.45,
                  "hit@1": 0.35, "mrr": 0.40, "ndcg@5": 0.41}],
        latencies=[1.0, 2.0, 3.0, 100.0],
        rejection_rows=[{"scenario": "deployed", "correct_refusal_rate": 0.08,
                         "false_candidate_rate": 0.92}],
        dispatch_variants=[
            {"rule": "deployed", "recall@2": 0.45, "primary": True},
            {"rule": "lexical", "recall@2": 0.53, "primary": False},
        ],
        output_dir=tmp_path / "figures",
        schemes_available=1,
    )
    for name in report.written:
        path = tmp_path / "figures" / name
        assert path.is_file()
        assert path.stat().st_size > 1000, f"{name} 看起来是空图"
        assert path.read_bytes()[:4] == b"\x89PNG"


# ---- 诊断：三种读法都要跑 --------------------------------------------------


def test_diagnostic_covers_three_rules(tmp_path: Path) -> None:
    bundle = run_diagnostic(
        run_id="t1",
        queries=_queries(),
        negatives=[],
        corpus_root=_corpus(tmp_path),
        navigation_files=(),
    )
    assert [variant.rule for variant in bundle.variants] == list(DISPATCH_ORDER)
    assert sum(1 for variant in bundle.variants if variant.primary) == 1


def test_diagnostic_primary_rule_is_deployed(tmp_path: Path) -> None:
    bundle = run_diagnostic(
        run_id="t2",
        queries=_queries(),
        negatives=[],
        corpus_root=_corpus(tmp_path),
        navigation_files=(),
    )
    assert bundle.variants[0].rule == PRIMARY_RULE == "deployed"
    assert bundle.variants[0].primary is True
    assert all(not variant.primary for variant in bundle.variants[1:])


def test_diagnostic_warns_about_implicit_assumption(tmp_path: Path) -> None:
    """deployed 有回退时必须告警：该读法依赖一个未被工具描述强制的假设。"""

    bundle = run_diagnostic(
        run_id="t3",
        queries=_queries(),
        negatives=[],
        corpus_root=_corpus(tmp_path),
        navigation_files=(),
    )
    assert any("换工具" in warning for warning in bundle.warnings)


def test_diagnostic_measures_negatives_per_rule(tmp_path: Path) -> None:
    from raglab.assets import Negative

    bundle = run_diagnostic(
        run_id="t4",
        queries=_queries(),
        negatives=[Negative(id="neg-001", text="完全无关的问题", reason="x", near_domain=True)],
        corpus_root=_corpus(tmp_path),
        navigation_files=(),
    )
    assert len(bundle.negative_results) == len(DISPATCH_ORDER)
    for result in bundle.negative_results:
        assert 0.0 <= result.correct_refusal_rate <= 1.0
        assert 0.0 <= result.false_candidate_rate <= 1.0


def test_write_diagnostic_marks_exploratory(tmp_path: Path) -> None:
    bundle = run_diagnostic(
        run_id="t5",
        queries=_queries(),
        negatives=[],
        corpus_root=_corpus(tmp_path),
        navigation_files=(),
    )
    path = write_diagnostic(bundle, tmp_path / "out")
    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload["mode"] == "exploratory"
    assert payload["schemes_available"] == 1
    assert payload["primary_rule"] == PRIMARY_RULE
    assert len(payload["variants"]) == len(DISPATCH_ORDER)


# ---- 报告正文：必须在开头声明边界 ------------------------------------------


def test_report_declares_not_a_conclusion_upfront(tmp_path: Path) -> None:
    bundle = run_diagnostic(
        run_id="t6",
        queries=_queries(),
        negatives=[],
        corpus_root=_corpus(tmp_path),
        navigation_files=(),
    )
    markdown = render_markdown(bundle, figures=[], skipped=[], corpus_files=3)
    head = "\n".join(markdown.splitlines()[:6])
    assert "不是实验结论" in head
    assert "探索性" in head
    assert "不得被读成方案对比" in head


def test_report_lists_skipped_charts(tmp_path: Path) -> None:
    bundle = run_diagnostic(
        run_id="t7",
        queries=_queries(),
        negatives=[],
        corpus_root=_corpus(tmp_path),
        navigation_files=(),
    )
    markdown = render_markdown(
        bundle,
        figures=[],
        skipped=[("fig1_recall_by_type.png", "仅有 1 个方案可跑")],
        corpus_files=3,
    )
    assert "跳过的图及原因" in markdown
    assert "fig1_recall_by_type.png" in markdown
    assert "仅有 1 个方案可跑" in markdown


def test_report_has_no_empty_table_header(tmp_path: Path) -> None:
    """表头不允许出现空列名（数据行留空是正常的，例如非主口径那列）。"""

    bundle = run_diagnostic(
        run_id="t8",
        queries=_queries(),
        negatives=[],
        corpus_root=_corpus(tmp_path),
        navigation_files=(),
    )
    markdown = render_markdown(bundle, figures=[], skipped=[], corpus_files=3)
    lines = markdown.splitlines()
    for index, line in enumerate(lines[:-1]):
        if not line.startswith("|"):
            continue
        # 表头是"分隔线行的上一行"。
        separator = lines[index + 1].strip("|").split("|")
        if not all(cell.strip() == "---" for cell in separator):
            continue
        cells = [cell.strip() for cell in line.strip("|").split("|")]
        assert all(cell for cell in cells), f"空表头单元格：{line}"


def test_report_discloses_known_deviations(tmp_path: Path) -> None:
    bundle = run_diagnostic(
        run_id="t9",
        queries=_queries(),
        negatives=[],
        corpus_root=_corpus(tmp_path),
        navigation_files=(),
    )
    markdown = render_markdown(bundle, figures=[], skipped=[], corpus_files=3)
    assert "单标注者" in markdown
    assert "11/80" in markdown
    assert "不能回答" in markdown
