"""指标口径（spec §10.1）。"""

from __future__ import annotations

import math

import pytest

from raglab.metrics import (
    auroc,
    hit_at_k,
    is_correct_refusal,
    is_false_candidate,
    ndcg_at_k,
    percentile,
    perturbation_decay,
    recall_fraction,
    reciprocal_rank,
    score_query,
)


def test_recall_at_k_uses_min_k_gold_rule() -> None:
    gold = ["a.md", "b.md"]
    # |gold|=2，k=2：需要同时命中两个才算命中。
    assert hit_at_k("ok", ["a.md", "c.md"], gold, 2) is False
    assert hit_at_k("ok", ["a.md", "b.md"], gold, 2) is True
    # k=1 时只要命中 1 个即可。
    assert hit_at_k("ok", ["a.md", "c.md"], gold, 1) is True


def test_non_ok_status_is_miss_regardless_of_candidates() -> None:
    for status in ("error", "timeout", "no_match"):
        assert hit_at_k(status, ["a.md"], ["a.md"], 2) is False
        assert reciprocal_rank(status, ["a.md"], ["a.md"]) == 0.0


def test_unknown_status_rejected() -> None:
    with pytest.raises(ValueError):
        hit_at_k("bogus", ["a.md"], ["a.md"], 2)


def test_recall_fraction_counts_hits_over_gold_size() -> None:
    assert recall_fraction("ok", ["a.md", "x.md"], ["a.md", "b.md"], 2) == pytest.approx(0.5)


def test_reciprocal_rank_first_gold_position() -> None:
    assert reciprocal_rank("ok", ["x.md", "a.md"], ["a.md"]) == pytest.approx(0.5)
    assert reciprocal_rank("ok", ["a.md", "b.md"], ["b.md"]) == pytest.approx(0.5)


def test_ndcg_single_gold_matches_discount() -> None:
    assert ndcg_at_k("ok", ["a.md", "x.md"], ["a.md"], 5) == pytest.approx(1.0)
    expected = 1 / math.log2(3)
    assert ndcg_at_k("ok", ["x.md", "a.md"], ["a.md"], 5) == pytest.approx(expected)


def test_ndcg_multi_gold_ideal_ordering() -> None:
    gold = ["a.md", "b.md"]
    assert ndcg_at_k("ok", ["a.md", "b.md"], gold, 5) == pytest.approx(1.0)
    # 只命中一个 gold 时 DCG/IDCG 小于 1。
    partial = ndcg_at_k("ok", ["a.md", "x.md"], gold, 5)
    assert 0 < partial < 1


def test_score_query_exposes_fixed_keys() -> None:
    scores = score_query(status="ok", paths=["a.md"], gold=["a.md"])
    for key in ("hit@1", "mrr", "ndcg@5", "recall@2", "recall@5", "ok"):
        assert key in scores


def test_percentile_linear_interpolation() -> None:
    values = [10.0, 20.0, 30.0, 40.0]
    assert percentile(values, 50) == pytest.approx(25.0)
    assert percentile(values, 0) == pytest.approx(10.0)
    assert percentile(values, 100) == pytest.approx(40.0)
    assert math.isnan(percentile([], 50))


def test_false_candidate_and_refusal_semantics() -> None:
    assert is_false_candidate("ok", 2) is True
    assert is_false_candidate("no_match", 0) is False
    assert is_correct_refusal("no_match", [], None) is True
    assert is_correct_refusal("ok", [], None) is True
    assert is_correct_refusal("ok", [0.4], None) is False
    assert is_correct_refusal("ok", [0.4], 0.5) is True
    assert is_correct_refusal("ok", [0.6], 0.5) is False


def test_auroc_separates_perfectly_and_handles_ties() -> None:
    assert auroc([0.9], [0.1]) == pytest.approx(1.0)
    assert auroc([0.5], [0.5]) == pytest.approx(0.5)
    assert auroc([], [0.1]) is None


def test_perturbation_decay() -> None:
    assert perturbation_decay(0.8, 0.6) == pytest.approx(0.25)
    assert math.isnan(perturbation_decay(0.0, 0.0))
