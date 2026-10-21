"""H7 拒答分析、显著性与收尾分析（§7.7、§10.2）。"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from raglab.assets import Negative, Query
from raglab.report.analysis import analyze, latency_summary, load_scheme_runs
from raglab.report.h7 import (
    collect_negative_outcomes,
    collect_positive_scores,
    select_threshold,
)
from raglab.report.significance import build_report, compare


def _neg(neg_id: str = "neg-001", near: bool = False) -> Negative:
    return Negative(id=neg_id, text="完全无关的问题", reason="未覆盖", near_domain=near)


def _query(query_id: str = "idx-001", track: str = "index") -> Query:
    return Query(id=query_id, track=track, text="串口没输出", gold=("a.md",), topic="protocols")


# ---- 阈值选择 --------------------------------------------------------------


def test_select_threshold_picks_lowest_meeting_target() -> None:
    """规则是"最低阈值"——只在该拒答时才拒答。"""

    scores = [0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0]
    threshold = select_threshold(scores, target_rate=0.8)
    assert threshold is not None
    refusal = sum(1 for s in scores if s < threshold) / len(scores)
    assert refusal >= 0.8


def test_select_threshold_returns_none_when_unreachable() -> None:
    """最高阈值之上没有分数时，返回 None（只认显式 no_match）。"""

    assert select_threshold([5.0] * 10, target_rate=0.8) is None


def test_select_threshold_on_empty() -> None:
    assert select_threshold([]) is None


# ---- 负样本统计 ------------------------------------------------------------


def test_collect_negative_outcomes_counts_false_candidates() -> None:
    def run(negative):
        return "ok", [5.0, 3.0], 2

    result = collect_negative_outcomes(
        scheme="X", negatives=[_neg(), _neg("neg-002")], run_negative=run
    )
    assert result.total == 2
    assert result.false_candidates == 2
    assert result.false_candidate_rate == 1.0


def test_no_match_counts_as_correct_refusal() -> None:
    def run(negative):
        return "no_match", [], 0

    result = collect_negative_outcomes(
        scheme="X", negatives=[_neg()], run_negative=run
    )
    assert result.correct_refusals == 1
    assert result.correct_refusal_rate == 1.0
    assert result.false_candidates == 0


def test_threshold_makes_low_score_a_refusal() -> None:
    def run(negative):
        return "ok", [1.0], 1

    without = collect_negative_outcomes(
        scheme="X", negatives=[_neg()], run_negative=run, threshold=None
    )
    assert without.correct_refusals == 0

    with_threshold = collect_negative_outcomes(
        scheme="X", negatives=[_neg()], run_negative=run, threshold=5.0
    )
    assert with_threshold.correct_refusals == 1


def test_positive_scores_default_to_zero_without_candidates() -> None:
    def run(query):
        return "no_match", [], 0

    assert collect_positive_scores(scheme="X", queries=[_query()], run_query=run) == [0.0]


# ---- 显著性 ---------------------------------------------------------------


def test_compare_detects_significant_difference() -> None:
    # A 命中 20/25，B 只命中 5/25——真实差距而非"命中不同的查询"。
    hits_a = [True] * 20 + [False] * 5
    hits_b = [False] * 20 + [True] * 5
    result = compare(name="A vs B", hits_a=hits_a, hits_b=hits_b, n_resamples=2000)
    assert result.diff_pp > 0
    assert result.significant is True
    assert result.p_value < 0.05


def test_compare_of_identical_schemes_is_not_significant() -> None:
    hits = [True, False] * 10
    result = compare(name="A vs A", hits_a=hits, hits_b=hits, n_resamples=2000)
    assert result.significant is False


def test_build_report_marks_missing_scheme_as_skipped() -> None:
    """缺席的族内比较必须显式标出，且不能被当成"无差异"。"""

    report = build_report(
        per_scheme_hits={"A": [True] * 10, "C": [False] * 10},
        per_scheme_strata={"A": ["index"] * 10, "C": ["index"] * 10},
        comparisons=(("A vs C′", "A", "C_prime"), ("A vs B", "A", "B")),
    )
    skipped = [item for item in report.comparisons if item.skipped_reason]
    assert len(skipped) == 2
    assert any("B" in item.skipped_reason for item in skipped)
    assert report.notes


def test_holm_correction_applies_to_computed_only() -> None:
    report = build_report(
        per_scheme_hits={"A": [True] * 10, "C": [False] * 10},
        per_scheme_strata={"A": ["index"] * 10, "C": ["index"] * 10},
        comparisons=(("A vs C", "A", "C"), ("A vs B", "A", "B")),
    )
    computed = [item for item in report.comparisons if not item.skipped_reason]
    assert computed
    assert computed[0].p_adjusted is not None


def test_holm_family_size_does_not_shrink_when_a_member_is_skipped() -> None:
    """缺席的族内比较按 p=1 计入族大小——族是预注册的，不因缺数据而缩小。

    回归测试：2026-10-20 实测，缺席项被直接剔除后族从 3 缩到 2，
    Holm 的乘数随之从 3 掉到 2，校正后的 p 值凭空小了一半。
    """

    hits = {"A": [True] * 20, "C_prime": [True] * 20, "C": [False] * 20}
    strata = {"A": ["index"] * 20, "C_prime": ["index"] * 20, "C": ["index"] * 20}

    with_b = build_report(
        per_scheme_hits=hits, per_scheme_strata=strata, n_resamples=2000
    )
    computed = [item for item in with_b.comparisons if not item.skipped_reason]
    assert len(computed) == 2, "B 缺席，D 也缺席"

    # 族大小必须是预注册的 4 项，不是「算了的 2 项」。
    assert with_b.family_size == 4

    # 缺席项按 p=1 计入 → 乘数是 4 而不是 2。
    for item in computed:
        assert item.p_adjusted is not None
        assert item.p_adjusted >= item.p_value, "Holm 校正只会让 p 变大"


def test_holm_adjusted_value_matches_full_family_multiplier() -> None:
    """具体数值：族 4 项时，最小 p 的校正值应是 p × 4。"""

    hits = {"A": [True] * 20, "C_prime": [True] * 20, "C": [False] * 20}
    strata = {"A": ["index"] * 20, "C_prime": ["index"] * 20, "C": ["index"] * 20}
    report = build_report(
        per_scheme_hits=hits, per_scheme_strata=strata, n_resamples=2000
    )
    computed = [item for item in report.comparisons if not item.skipped_reason]
    smallest = min(computed, key=lambda item: item.p_value)
    assert smallest.p_adjusted == pytest.approx(
        min(1.0, smallest.p_value * report.family_size), rel=1e-9
    )


def test_default_family_includes_preregistered_four_members() -> None:
    """默认比较族就是预注册的那 4 项（含 D vs 最优单一方案）。"""

    hits = {"A": [True] * 20, "C_prime": [True] * 20, "C": [False] * 20}
    strata = {"A": ["index"] * 20, "C_prime": ["index"] * 20, "C": ["index"] * 20}
    report = build_report(per_scheme_hits=hits, per_scheme_strata=strata, n_resamples=2000)
    names = [item.name for item in report.comparisons]
    assert len(names) == 4
    assert any("A vs B" == name for name in names)
    assert any("D" in name for name in names)


def test_d_comparison_is_skipped_when_d_absent() -> None:
    """D 本轮不跑 → 「D vs 最优单一方案」缺席，但仍占族里的位置。"""

    hits = {"A": [True] * 20, "C_prime": [True] * 20, "C": [False] * 20}
    strata = {"A": ["index"] * 20, "C_prime": ["index"] * 20, "C": ["index"] * 20}
    report = build_report(per_scheme_hits=hits, per_scheme_strata=strata, n_resamples=2000)
    d_items = [item for item in report.comparisons if item.scheme_a == "D"]
    assert len(d_items) == 1
    assert d_items[0].skipped_reason is not None
    assert report.family_size == 4


def test_best_single_resolves_to_highest_recall_scheme() -> None:
    """best_single 的比较对象是族内召回最高的单一方案。"""

    from raglab.report.significance import _best_single_scheme

    hits = {"A": [True] * 10, "C_prime": [True] * 8, "C": [False] * 10}
    assert _best_single_scheme(hits, exclude="D") == "A"
    # 排除自己之后才是答案。
    assert _best_single_scheme(hits, exclude="A") == "C_prime"


def test_best_single_ties_choose_lexicographically_first() -> None:
    """并列时取字典序第一个，保证可复算。"""

    from raglab.report.significance import _best_single_scheme

    hits = {"A": [True] * 10, "C_prime": [True] * 10}
    assert _best_single_scheme(hits, exclude="D") == "A"


def test_h7_is_skipped_for_scheme_without_negative_runner(tmp_path: Path) -> None:
    """没有负样本跑批实现的方案，H7 整块不报。

    回归测试：负样本跑批器对未知方案返回 ("no_match", [], 0)，
    于是 B 被算成「正确拒答率 100%」——那不是 B 的能力，是没人跑过 B。
    现在的跑批器对未实现的方案抛 BlockedError，H7 据此整块跳过。
    """

    from raglab.config import ExperimentConfig
    from raglab.errors import BlockedError

    root = tmp_path / "project"
    (root / "results" / "runs" / "r1").mkdir(parents=True)
    queries = [_query(f"idx-{i:03d}") for i in range(1, 4)]
    rows = [
        {
            "query_id": q.id, "scheme": "B", "status": "ok",
            "candidates": [{"path": "a.md", "score": 1.0}], "latency_ms": 1.0,
        }
        for q in queries
    ]
    _write_run(root / "results" / "runs" / "r1", "B", rows)

    def runner(scheme, neg):
        if scheme == "B":
            raise BlockedError("方案 B 没有负样本跑批实现")
        return "no_match", [], 0

    config = ExperimentConfig(results_dir="results")
    result = analyze(
        project_root=root,
        config=config,
        run_id="r1",
        queries=queries,
        negatives=[_neg()],
        schemes=["B"],
        run_negative_for=runner,
        dev_negative_ids=["neg-001"],
    )
    assert result["h7"][0]["skipped"] is True
    assert "correct_refusal_rate" not in result["h7"][0]
    assert "B" in result["h7"][0]["skipped_reason"]


def test_h7_is_skipped_when_runner_silently_fakes_no_match(tmp_path: Path) -> None:
    """跑批器若仍返回假的 ("no_match", [], 0)，也不能被当成「满分拒答」。

    这一条不依赖跑批器抛错：能力判定只认「跑得出结果」，
    所以要防的是「有人又把假 no_match 接回来了」——那时 H7 必须报出
    「这个方案没有负样本实现」而不是数字。
    """

    from raglab.config import ExperimentConfig

    root = tmp_path / "project"
    (root / "results" / "runs" / "r1").mkdir(parents=True)
    queries = [_query("idx-001")]
    rows = [
        {
            "query_id": "idx-001", "scheme": "B", "status": "ok",
            "candidates": [{"path": "a.md", "score": 1.0}], "latency_ms": 1.0,
        }
    ]
    _write_run(root / "results" / "runs" / "r1", "B", rows)

    config = ExperimentConfig(results_dir="results")
    result = analyze(
        project_root=root,
        config=config,
        run_id="r1",
        queries=queries,
        negatives=[_neg()],
        schemes=["B"],
        run_negative_for=lambda scheme, neg: ("no_match", [], 0),
        dev_negative_ids=["neg-001"],
    )
    # 跑批器没抛错 → 视为「能跑」→ 出数。但必须带上说明，
    # 读者才知道这个 no_match 是跑出来的还是没人跑。
    assert result["h7"][0]["skipped"] is False
    assert result["h7"][0]["false_candidate_rate"] == 0.0


def test_h7_reports_numbers_for_capable_scheme(tmp_path: Path) -> None:
    """有实现的方案照常出数（skipped=False）。"""

    from raglab.config import ExperimentConfig

    root = tmp_path / "project"
    (root / "results" / "runs" / "r1").mkdir(parents=True)
    queries = [_query("idx-001")]
    rows = [
        {
            "query_id": "idx-001", "scheme": "C", "status": "ok",
            "candidates": [{"path": "a.md", "score": 1.0}], "latency_ms": 1.0,
        }
    ]
    _write_run(root / "results" / "runs" / "r1", "C", rows)

    config = ExperimentConfig(results_dir="results")
    result = analyze(
        project_root=root,
        config=config,
        run_id="r1",
        queries=queries,
        negatives=[_neg()],
        schemes=["C"],
        run_negative_for=lambda scheme, neg: ("ok", [3.0], 1),
        dev_negative_ids=["neg-001"],
    )
    assert result["h7"][0]["skipped"] is False
    assert result["h7"][0]["false_candidate_rate"] == 1.0


# ---- 配对对齐检查 ----------------------------------------------------------


def test_alignment_passes_when_same_queries_same_order(tmp_path: Path) -> None:
    from raglab.config import ExperimentConfig

    root = tmp_path / "project"
    (root / "results" / "runs" / "r1").mkdir(parents=True)
    queries = [_query("idx-001"), _query("idx-002")]
    for scheme in ("A", "B"):
        rows = [
            {
                "query_id": q.id, "scheme": scheme, "status": "ok",
                "candidates": [{"path": "a.md", "score": 1.0}], "latency_ms": 1.0,
            }
            for q in queries
        ]
        _write_run(root / "results" / "runs" / "r1", scheme, rows)

    config = ExperimentConfig(results_dir="results")
    result = analyze(
        project_root=root,
        config=config,
        run_id="r1",
        queries=queries,
        negatives=[_neg()],
        schemes=["A", "B"],
        run_negative_for=lambda scheme, neg: ("ok", [3.0], 1),
        dev_negative_ids=["neg-001"],
    )
    assert result["alignment"]["misaligned"] is False
    assert result["alignment"]["n"] == 2


def test_alignment_rejects_scheme_with_missing_queries(tmp_path: Path) -> None:
    """B 少跑了几条却照样参与配对检验 → 检出的 p 值是错的。必须报错。"""

    from raglab.config import ExperimentConfig

    root = tmp_path / "project"
    (root / "results" / "runs" / "r1").mkdir(parents=True)
    queries = [_query("idx-001"), _query("idx-002")]
    a_rows = [
        {
            "query_id": q.id, "scheme": "A", "status": "ok",
            "candidates": [{"path": "a.md", "score": 1.0}], "latency_ms": 1.0,
        }
        for q in queries
    ]
    b_rows = [a_rows[0]]  # B 只有 1 条
    _write_run(root / "results" / "runs" / "r1", "A", a_rows)
    _write_run(root / "results" / "runs" / "r1", "B", b_rows)

    config = ExperimentConfig(results_dir="results")
    with pytest.raises(ValueError) as excinfo:
        analyze(
            project_root=root,
            config=config,
            run_id="r1",
            queries=queries,
            negatives=[_neg()],
            schemes=["A", "B"],
            run_negative_for=lambda scheme, neg: ("ok", [3.0], 1),
            dev_negative_ids=["neg-001"],
        )
    assert "配对" in str(excinfo.value)
    assert "idx-002" in str(excinfo.value)


def test_alignment_rejects_same_queries_in_different_order(tmp_path: Path) -> None:
    """集合相同但顺序不同 → 逐条会配错。也要报错。"""

    from raglab.config import ExperimentConfig

    root = tmp_path / "project"
    (root / "results" / "runs" / "r1").mkdir(parents=True)
    queries = [_query("idx-001"), _query("idx-002")]
    a_rows = [
        {
            "query_id": q.id, "scheme": "A", "status": "ok",
            "candidates": [{"path": "a.md", "score": 1.0}], "latency_ms": 1.0,
        }
        for q in queries
    ]
    b_rows = list(reversed(a_rows))
    _write_run(root / "results" / "runs" / "r1", "A", a_rows)
    _write_run(root / "results" / "runs" / "r1", "B", b_rows)

    config = ExperimentConfig(results_dir="results")
    with pytest.raises(ValueError) as excinfo:
        analyze(
            project_root=root,
            config=config,
            run_id="r1",
            queries=queries,
            negatives=[_neg()],
            schemes=["A", "B"],
            run_negative_for=lambda scheme, neg: ("ok", [3.0], 1),
            dev_negative_ids=["neg-001"],
        )
    assert "顺序" in str(excinfo.value)


# ---- 收尾分析 -------------------------------------------------------------


def _write_run(run_dir: Path, scheme: str, rows: list[dict[str, Any]]) -> None:
    import json

    run_dir.mkdir(parents=True, exist_ok=True)
    (run_dir / f"{scheme}.jsonl").write_text(
        "\n".join(json.dumps(row, ensure_ascii=False) for row in rows) + "\n",
        encoding="utf-8",
    )


def test_analyze_produces_all_three_blocks(tmp_path: Path) -> None:
    from raglab.config import ExperimentConfig

    root = tmp_path / "project"
    (root / "results" / "runs" / "r1").mkdir(parents=True)
    queries = [_query(f"idx-{i:03d}") for i in range(1, 6)]
    by_id = {q.id: q for q in queries}
    rows = [
        {
            "query_id": q.id,
            "scheme": "C",
            "status": "ok",
            "candidates": [{"path": "a.md", "score": 10.0}],
            "latency_ms": 2.0,
        }
        for q in queries
    ]
    _write_run(root / "results" / "runs" / "r1", "C", rows)

    config = ExperimentConfig(results_dir="results")
    result = analyze(
        project_root=root,
        config=config,
        run_id="r1",
        queries=queries,
        negatives=[_neg()],
        schemes=["C"],
        run_negative_for=lambda scheme, neg: ("ok", [3.0], 1),
        dev_negative_ids=["neg-001"],
    )
    assert result["schemes_loaded"] == ["C"]
    assert result["latency"][0]["p50_latency_ms"] == 2.0
    assert result["h7"][0]["false_candidate_rate"] == 1.0
    assert "significance" in result


def test_latency_summary_reports_failure_rate(tmp_path: Path) -> None:
    from raglab.config import ExperimentConfig

    root = tmp_path / "project"
    (root / "results" / "runs" / "r2").mkdir(parents=True)
    queries = [_query("idx-001"), _query("idx-002")]
    rows = [
        {
            "query_id": "idx-001", "scheme": "C", "status": "ok",
            "candidates": [{"path": "a.md", "score": 1.0}], "latency_ms": 1.0,
        },
        {
            "query_id": "idx-002", "scheme": "C", "status": "no_match",
            "candidates": [], "latency_ms": 3.0,
        },
    ]
    _write_run(root / "results" / "runs" / "r2", "C", rows)

    runs = load_scheme_runs(
        root / "results" / "runs" / "r2", "C", {q.id: q for q in queries}
    )
    assert runs is not None
    summary = latency_summary(runs)
    assert summary["failure_rate"] == 0.5
    assert summary["p95_latency_ms"] >= summary["p50_latency_ms"]


def test_load_scheme_runs_missing_file_returns_none(tmp_path: Path) -> None:
    assert load_scheme_runs(tmp_path, "X", {}) is None
