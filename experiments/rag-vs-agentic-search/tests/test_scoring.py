"""评分与汇总（spec §10）。"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from raglab.assets import Query
from raglab.scoring import (
    read_results_jsonl,
    score_one,
    score_records,
    summarize,
)


def _query(query_id: str = "idx-001", **overrides: object) -> Query:
    data: dict[str, object] = {
        "id": query_id,
        "track": "index",
        "text": "串口收不到数据",
        "gold": ("protocols/a.md",),
        "topic": "protocols",
    }
    data.update(overrides)
    return Query(**data)  # type: ignore[arg-type]


def test_score_one_marks_hit() -> None:
    row = score_one(
        query=_query(), scheme="A", status="ok", paths=["protocols/a.md"], latency_ms=12.0
    )
    assert row.recall2 is True
    assert row.hit1 is True
    assert row.mrr == 1.0
    assert row.ndcg5 == pytest.approx(1.0)


def test_non_ok_status_scores_zero() -> None:
    row = score_one(
        query=_query(), scheme="B", status="timeout", paths=["protocols/a.md"], latency_ms=5.0
    )
    assert row.recall2 is False
    assert row.hit1 is False
    assert row.mrr == 0.0


def test_summarize_groups_by_scheme() -> None:
    rows = [
        score_one(query=_query(), scheme="A", status="ok", paths=["protocols/a.md"], latency_ms=10),
        score_one(query=_query(), scheme="A", status="ok", paths=["x.md"], latency_ms=30),
        score_one(query=_query(), scheme="B", status="ok", paths=["protocols/a.md"], latency_ms=20),
    ]
    summary = {entry["scheme"]: entry for entry in summarize(rows)}
    assert summary["A"]["n"] == 2
    assert summary["A"]["recall@2"] == pytest.approx(0.5)
    assert summary["B"]["recall@2"] == pytest.approx(1.0)
    assert summary["A"]["failure_rate"] == pytest.approx(0.0)


def test_summarize_rejects_unknown_group_dimension() -> None:
    with pytest.raises(ValueError):
        summarize([], group_by=("unknown",))


def test_summarize_empty_is_zero_rows() -> None:
    assert summarize([]) == []


def test_read_results_jsonl_rejects_bad_lines(tmp_path: Path) -> None:
    path = tmp_path / "r.jsonl"
    path.write_text("{not json}\n", encoding="utf-8")
    with pytest.raises(ValueError):
        read_results_jsonl(path)


def test_read_results_jsonl_skips_blank_lines(tmp_path: Path) -> None:
    path = tmp_path / "r.jsonl"
    path.write_text(
        json.dumps({"query_id": "idx-001", "scheme": "A", "status": "ok"}) + "\n\n",
        encoding="utf-8",
    )
    assert len(read_results_jsonl(path)) == 1


def test_score_records_rejects_unknown_query_id() -> None:
    with pytest.raises(ValueError):
        score_records([{"query_id": "idx-999", "status": "ok"}], {"idx-001": _query()})


def test_score_records_reads_candidate_paths() -> None:
    records = [
        {
            "query_id": "idx-001",
            "scheme": "C",
            "status": "ok",
            "candidates": [{"path": "protocols/a.md", "score": 0.9}],
            "latency_ms": 3.0,
        }
    ]
    rows = score_records(records, {"idx-001": _query()})
    assert rows[0].recall2 is True
    assert rows[0].latency_ms == 3.0
