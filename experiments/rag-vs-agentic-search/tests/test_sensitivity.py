"""敏感性分析：按覆盖率分层比较方案（纯函数，离线）。"""

from __future__ import annotations

from pathlib import Path

import pytest

from raglab.assets import Candidate, Query
from raglab.report.sensitivity import (
    corpus_vocabulary,
    query_coverage,
    run_sensitivity,
    run_sensitivity_from_runs,
)
from raglab.schemes.base import RetrievalScheme


class _FixedScheme(RetrievalScheme):
    """按查询 id 决定返回什么，用于构造已知的分层模式。"""

    def __init__(self, winners: set[str], **kwargs: object) -> None:
        super().__init__(**kwargs)
        self._winners = winners

    def _retrieve(self, query: Query, *, deadline_ms: float | None):
        if query.id in self._winners:
            return "ok", [Candidate("gold.md", 1.0)], {}
        return "no_match", [], {}


def _query(query_id: str, text: str) -> Query:
    return Query(id=query_id, track="index", text=text, gold=("gold.md",), topic="protocols")


def test_query_coverage_counts_only_multi_char_tokens() -> None:
    """单字在中文里几乎没有区分度，计入会把覆盖率虚抬到接近 1。"""

    vocab = {"串口", "输出", "uart"}
    assert query_coverage("串口输出 uart", vocab) == 1.0
    assert query_coverage("串口 乱码", vocab) == 0.5
    assert query_coverage("", vocab) == 0.0


def test_query_coverage_ignores_single_chars() -> None:
    vocab = {"串口"}
    # 「的」是单字，不计入分母。
    assert query_coverage("串口的", vocab) == 1.0


def test_corpus_vocabulary_reads_a_real_corpus(tmp_path: Path) -> None:
    root = tmp_path / "kb"
    root.mkdir()
    (root / "a.md").write_text("# 串口\n串口没有输出\n", encoding="utf-8")
    vocab = corpus_vocabulary(root)
    assert "串口" in vocab


def test_low_coverage_stratum_shrinks_gap(tmp_path: Path) -> None:
    """构造：低覆盖率查询上两方案打平，高覆盖率上候选方案全胜。

    威胁若成立，差距应随覆盖率上升而扩大——这就是该检验要抓的模式。
    """

    vocab = {"串口", "输出"}
    # 低覆盖率：两个方案都命中
    low = [_query(f"low-{i:02d}", "完全无关的量子话题") for i in range(1, 5)]
    # 高覆盖率：只有候选方案命中
    high = [_query(f"high-{i:02d}", "串口输出") for i in range(1, 5)]

    baseline = _FixedScheme({q.id for q in low})
    candidate = _FixedScheme({q.id for q in low} | {q.id for q in high})

    report = run_sensitivity(
        queries=low + high,
        baseline=baseline,
        candidate=candidate,
        vocab=vocab,
        strata=2,
    )
    assert report.total == 8
    assert len(report.strata) == 2
    assert report.strata[0].n == 4 and report.strata[1].n == 4
    assert report.strata[0].gap == pytest.approx(0.0)
    assert report.strata[1].gap == pytest.approx(1.0)


def test_strata_are_evenly_sized_when_not_divisible() -> None:
    """8 条 / 3 层不能切出 4 个桶——"三分位"要名副其实。"""

    vocab = {"串口"}
    queries = [_query(f"q-{index:02d}", "串口") for index in range(1, 9)]
    scheme = _FixedScheme(set())
    report = run_sensitivity(
        queries=queries, baseline=scheme, candidate=scheme, vocab=vocab, strata=3
    )
    assert len(report.strata) == 3
    assert sum(stratum.n for stratum in report.strata) == 8
    sizes = sorted(stratum.n for stratum in report.strata)
    assert sizes[-1] - sizes[0] <= 1, f"桶大小不均匀：{sizes}"


def test_zero_gap_when_schemes_agree_everywhere() -> None:
    vocab = {"串口"}
    queries = [_query(f"q-{i:02d}", "串口输出") for i in range(1, 7)]
    same = _FixedScheme({q.id for q in queries})
    report = run_sensitivity(
        queries=queries, baseline=same, candidate=same, vocab=vocab
    )
    assert all(stratum.gap == 0.0 for stratum in report.strata)
    assert report.correlation == 0.0


def test_empty_queries_reports_zero() -> None:
    report = run_sensitivity(
        queries=[], baseline=_FixedScheme(set()), candidate=_FixedScheme(set()), vocab={"x"}
    )
    assert report.total == 0
    assert report.strata == []


def test_report_dict_has_disclaimer(tmp_path: Path) -> None:
    vocab = {"串口"}
    queries = [_query(f"q-{i:02d}", "串口") for i in range(1, 7)]
    report = run_sensitivity(
        queries=queries, baseline=_FixedScheme(set()), candidate=_FixedScheme({q.id for q in queries}), vocab=vocab
    )
    payload = report.as_dict()
    assert "非因果推断" in str(payload["note"])
    assert payload["coverage_vs_win_correlation"] is not None


def test_correlation_detects_monotone_pattern() -> None:
    """覆盖率与"候选方案赢"同向时，相关系数应为正。"""

    vocab = {"串口", "输出"}
    queries = []
    for index in range(1, 9):
        # 前 4 条低覆盖率、后 4 条高覆盖率。
        text = "无关 话题" if index <= 4 else "串口输出"
        queries.append(_query(f"q-{index:02d}", text))
    baseline = _FixedScheme(set())
    candidate = _FixedScheme({f"q-{index:02d}" for index in range(5, 9)})
    report = run_sensitivity(
        queries=queries, baseline=baseline, candidate=candidate, vocab=vocab
    )
    assert report.correlation > 0


# ---- 离线多方案分层（从跑批结果读，不重跑方案）---------------------------


def test_from_runs_matches_live_run_sensitivity_split():
    """离线版与现跑版必须切出**同一批**查询——否则两次数字没法对照。"""

    vocab = {"串口", "输出"}
    low = [_query(f"low-{i:02d}", "完全无关的量子话题") for i in range(1, 5)]
    high = [_query(f"high-{i:02d}", "串口输出") for i in range(1, 5)]
    queries = low + high

    baseline = _FixedScheme({q.id for q in low})
    candidate = _FixedScheme({q.id for q in low} | {q.id for q in high})
    live = run_sensitivity(
        queries=queries, baseline=baseline, candidate=candidate, vocab=vocab, strata=2
    )

    low_ids = {q.id for q in low}
    all_ids = low_ids | {q.id for q in high}
    hits = {
        "A": {q.id: q.id in low_ids for q in queries},
        "C_prime": {q.id: q.id in all_ids for q in queries},
    }
    offline = run_sensitivity_from_runs(
        queries=queries, hits_by_scheme=hits, vocab=vocab, strata=2, reference="A"
    )
    assert [s.n for s in offline.strata] == [s.n for s in live.strata]
    assert offline.strata[1].rates["C_prime"] == pytest.approx(
        live.strata[1].gap + live.strata[1].baseline_rate
    )


def test_from_runs_compares_multiple_schemes_against_reference():
    """多方案版：每个方案相对参照方案的差距都要给出。"""

    vocab = {"串口"}
    queries = [_query(f"q-{i:02d}", "串口输出") for i in range(1, 7)]
    hits = {
        "A": {q.id: True for q in queries},
        "B": {q.id: q.id != "q-01" for q in queries},
        "C": {q.id: False for q in queries},
    }
    report = run_sensitivity_from_runs(
        queries=queries, hits_by_scheme=hits, vocab=vocab, reference="A"
    )
    payload = report.as_dict()
    assert payload["reference"] == "A"
    assert set(payload["coverage_vs_win_correlation"]) == {"B", "C"}
    stratum = payload["strata"][0]
    assert "B" in stratum["gap_vs_reference_pp"]
    assert "C" in stratum["gap_vs_reference_pp"]


def test_from_runs_uses_only_queries_present_in_all_schemes():
    """某个方案缺的查询不能参与分层——否则各层的 n 不可比。"""

    vocab = {"串口"}
    queries = [_query(f"q-{i:02d}", "串口输出") for i in range(1, 6)]
    hits = {
        "A": {q.id: True for q in queries},
        "B": {q.id: True for q in queries[:3]},  # 少 2 条
    }
    report = run_sensitivity_from_runs(
        queries=queries, hits_by_scheme=hits, vocab=vocab, reference="A"
    )
    assert report.total == 3


def test_from_runs_on_empty_queries_reports_zero():
    report = run_sensitivity_from_runs(
        queries=[], hits_by_scheme={"A": {}, "B": {}}, vocab=set()
    )
    assert report.total == 0
    assert report.strata == []


def test_from_runs_correlation_detects_source_bias_pattern():
    """构造词频红利形态：候选方案只在高覆盖率层赢 → 相关系数为正。

    这是「B 的优势不塌」能有意义的前提——方法本身要能测出这类偏差。
    """

    vocab = {"串口", "输出"}
    queries = []
    for index in range(1, 9):
        text = "无关 话题" if index <= 4 else "串口输出"
        queries.append(_query(f"q-{index:02d}", text))
    # 两个方案都要覆盖全部 8 条——缺一条就会被「只取各方案都有的查询」
    # 那一步滤掉，样本量变化会让相关系数变成别的意思。
    hits = {
        "A": {q.id: False for q in queries},
        "C_prime": {q.id: q.id in {f"q-{i:02d}" for i in range(5, 9)} for q in queries},
    }
    report = run_sensitivity_from_runs(
        queries=queries, hits_by_scheme=hits, vocab=vocab, reference="A"
    )
    assert report.total == 8
    assert report.correlations["C_prime"] > 0
