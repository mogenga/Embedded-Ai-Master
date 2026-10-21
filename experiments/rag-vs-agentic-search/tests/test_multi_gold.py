"""多 gold 标注的接线（spec §7.3 第 5 条、§7.5）。

**核心不变量**：多 gold **只影响 nDCG@5**。主判定指标（Recall@k / Hit@1 / MRR）
一律用 `queries.jsonl` 的原始单 gold——这是 spec §7.3 第 5 条明写的
「主判定只用导入的原始 gold」。

接线前的状态（2026-10-21 实测）：`annotation_multi_gold.jsonl` 只被 intake 读进来
数了个条数，评分时用的是 `query.gold`。**多 gold 建了也进不了评分。**
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from raglab.assets import Query
from raglab.intake import (
    check_multi_gold_coverage,
    multi_gold_map,
)
from raglab.scoring import score_one, score_records


def _query(query_id: str = "idx-001", gold: tuple[str, ...] = ("a.md",)) -> Query:
    return Query(
        id=query_id,
        track="index",
        text="串口没输出",
        gold=gold,
        topic="protocols",
    )


# ---- 评分层：多 gold 只影响 nDCG ------------------------------------------


def test_multi_gold_does_not_change_primary_metrics() -> None:
    """**核心不变量**：给了多 gold，Recall/Hit/MRR 一个都不能变。"""

    query = _query(gold=("a.md",))
    paths = ["a.md", "b.md"]

    without = score_one(
        query=query, scheme="A", status="ok", paths=paths, latency_ms=1.0
    )
    with_multi = score_one(
        query=query,
        scheme="A",
        status="ok",
        paths=paths,
        latency_ms=1.0,
        multi_gold=("a.md", "b.md"),
    )

    assert with_multi.recall2 == without.recall2
    assert with_multi.recall5 == without.recall5
    assert with_multi.hit1 == without.hit1
    assert with_multi.mrr == without.mrr


def test_multi_gold_changes_ndcg() -> None:
    """多 gold 会改变 nDCG——IDCG 按 gold 数算，gold 多了 IDCG 就大。

    用「第二个 gold 没被召回」的情形：单 gold 时 nDCG 满分，
    多 gold 时因为 IDCG 变大而不再是满分。
    """

    query = _query(gold=("a.md",))
    paths = ["a.md", "x.md"]  # 第二个 gold（b.md）没被召回

    without = score_one(
        query=query, scheme="A", status="ok", paths=paths, latency_ms=1.0
    )
    with_multi = score_one(
        query=query,
        scheme="A",
        status="ok",
        paths=paths,
        latency_ms=1.0,
        multi_gold=("a.md", "b.md"),
    )

    assert without.ndcg5 == 1.0, "单 gold 时召回即满分"
    assert with_multi.ndcg5 < 1.0, "多 gold 时未召回的第二个 gold 拉低了 nDCG"
    assert with_multi.ndcg5_from_multi_gold is True
    assert without.ndcg5_from_multi_gold is False


def test_empty_multi_gold_falls_back_to_single() -> None:
    """给了空列表 = 没给，退化成单 gold 并标低置信。"""

    query = _query(gold=("a.md",))
    row = score_one(
        query=query,
        scheme="A",
        status="ok",
        paths=["a.md"],
        latency_ms=1.0,
        multi_gold=(),
    )
    assert row.ndcg5_from_multi_gold is False


def test_score_records_passes_multi_gold_per_query() -> None:
    """多 gold 是按 query_id 逐条给的，不是全局一套。"""

    queries = {"idx-001": _query("idx-001", ("a.md",)), "idx-002": _query("idx-002", ("b.md",))}
    records = [
        {"query_id": "idx-001", "scheme": "A", "status": "ok", "candidates": [{"path": "a.md"}]},
        {"query_id": "idx-002", "scheme": "A", "status": "ok", "candidates": [{"path": "b.md"}]},
    ]
    mapping = {"idx-002": ("b.md", "c.md")}

    rows = score_records(records, queries, multi_gold=mapping)
    by_id = {row.query_id: row for row in rows}
    assert by_id["idx-001"].ndcg5_from_multi_gold is False
    assert by_id["idx-002"].ndcg5_from_multi_gold is True


def test_score_records_without_multi_gold_is_unchanged() -> None:
    """没传映射时行为与接线前完全一致——这是「接线不改变已有结果」的保证。"""

    queries = {"idx-001": _query()}
    records = [
        {"query_id": "idx-001", "scheme": "A", "status": "ok", "candidates": [{"path": "a.md"}]}
    ]
    rows = score_records(records, queries)
    assert rows[0].ndcg5_from_multi_gold is False


# ---- 导入层：映射与门禁 ---------------------------------------------------


def test_multi_gold_map_reads_file(tmp_path: Path) -> None:
    (tmp_path / "annotation_multi_gold.jsonl").write_text(
        json.dumps(
            {
                "query_id": "idx-001",
                "gold": ["a.md", "b.md"],
                "annotator": "owner",
                "annotated_at": "2026-10-21T00:00:00+08:00",
                "blind": True,
            },
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )
    mapping, report = multi_gold_map(tmp_path)
    assert mapping == {"idx-001": ("a.md", "b.md")}
    assert not report.errors


def test_multi_gold_map_missing_file_is_warning_not_error(tmp_path: Path) -> None:
    """缺失是增强项缺失，不是错误——不阻塞主实验（spec §7.3 第 5 条）。"""

    mapping, report = multi_gold_map(tmp_path)
    assert mapping == {}
    assert not report.errors
    assert report.warnings


def test_multi_gold_map_rejects_duplicate_query_id(tmp_path: Path) -> None:
    """重复会让「覆盖了多少条」算错，必须报错。"""

    row = json.dumps(
        {
            "query_id": "idx-001",
            "gold": ["a.md"],
            "annotator": "owner",
            "annotated_at": "2026-10-21T00:00:00+08:00",
            "blind": True,
        },
        ensure_ascii=False,
    )
    (tmp_path / "annotation_multi_gold.jsonl").write_text(row + "\n" + row + "\n", encoding="utf-8")
    mapping, report = multi_gold_map(tmp_path)
    assert any("重复" in error for error in report.errors)


def test_coverage_flags_unknown_query_id(tmp_path: Path) -> None:
    problems = check_multi_gold_coverage(
        mapping={"idx-999": ("a.md",)},
        query_ids=["idx-001"],
        corpus_root=tmp_path,
    )
    assert any("不在查询集内" in problem for problem in problems)


def test_coverage_flags_missing_file(tmp_path: Path) -> None:
    problems = check_multi_gold_coverage(
        mapping={"idx-001": ("nope.md",)},
        query_ids=["idx-001"],
        corpus_root=tmp_path,
    )
    assert any("不存在" in problem for problem in problems)


def test_coverage_reports_incomplete_as_low_confidence(tmp_path: Path) -> None:
    """覆盖不全 → 低置信，**不是错误**（spec：多 gold 是增强项）。"""

    (tmp_path / "a.md").write_text("x", encoding="utf-8")
    problems = check_multi_gold_coverage(
        mapping={"idx-001": ("a.md",)},
        query_ids=["idx-001", "idx-002"],
        corpus_root=tmp_path,
    )
    assert any("标低置信" in problem for problem in problems)
