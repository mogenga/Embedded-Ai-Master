"""跑批骨架：ITT、网关错误中止与落盘格式（§9.4、§8.1）。"""

from __future__ import annotations

import json
from pathlib import Path

from raglab.assets import Candidate, Query, QueryResult
from raglab.runner import (
    MAX_CONSECUTIVE_GATEWAY_ERRORS,
    run_queries,
    summarize_status,
    write_results_jsonl,
)
from raglab.schemes.base import RetrievalScheme


def _queries(count: int) -> list[Query]:
    return [
        Query(
            id=f"idx-{index:03d}",
            track="index",
            text=f"查询 {index}",
            gold=("a.md",),
            topic="protocols",
        )
        for index in range(1, count + 1)
    ]


class _ScriptedScheme(RetrievalScheme):
    key = "C"

    def __init__(self, behaviours: list[str], **kwargs: object) -> None:
        super().__init__(**kwargs)
        # 拷贝：避免运行期的 pop 把调用方用于断言的列表清空。
        self._behaviours = list(behaviours)

    def _retrieve(self, query: Query, *, deadline_ms: float | None):
        behaviour = self._behaviours.pop(0) if self._behaviours else "ok"
        if behaviour == "ok":
            return "ok", [Candidate("a.md", 1.0)], {}
        raise RuntimeError("gateway down")


def test_results_use_itt_denominator() -> None:
    scheme = _ScriptedScheme(["ok", "boom", "ok"])
    summary = run_queries(scheme, _queries(3), run_id="r1")
    assert summary.total == 3
    counts = summarize_status(summary)
    assert counts == {"ok": 2, "error": 1, "total": 3}


def test_aborts_after_consecutive_gateway_errors() -> None:
    errors = ["boom"] * (MAX_CONSECUTIVE_GATEWAY_ERRORS + 2)
    scheme = _ScriptedScheme(errors)
    summary = run_queries(
        scheme,
        _queries(MAX_CONSECUTIVE_GATEWAY_ERRORS + 2),
        run_id="r2",
        is_gateway_error=lambda result: result.status == "error",
    )
    assert summary.aborted is True
    assert summary.total == MAX_CONSECUTIVE_GATEWAY_ERRORS
    assert summary.abort_reason is not None


def test_ok_between_errors_resets_counter() -> None:
    behaviours = ["boom", "boom", "ok", "boom", "boom", "ok", "boom"]
    scheme = _ScriptedScheme(behaviours)
    summary = run_queries(
        scheme,
        _queries(len(behaviours)),
        run_id="r3",
        is_gateway_error=lambda result: result.status == "error",
    )
    assert summary.aborted is False
    assert summary.total == len(behaviours)


def test_write_results_jsonl_matches_output_contract(tmp_path: Path) -> None:
    summary = run_queries(_ScriptedScheme(["ok"]), _queries(1), run_id="r4")
    target = write_results_jsonl(summary, tmp_path / "runs" / "r4" / "C.jsonl")
    record = json.loads(target.read_text(encoding="utf-8").strip())
    assert record["query_id"] == "idx-001"
    assert record["scheme"] == "C"
    assert record["status"] == "ok"
    assert record["candidates"] == [{"path": "a.md", "score": 1.0}]
    assert set(record["cost"]) == {"input_tokens", "output_tokens", "estimated"}


def test_empty_run_is_allowed() -> None:
    summary = run_queries(_ScriptedScheme([]), [], run_id="r5")
    assert summary.total == 0
    assert summarize_status(summary) == {"total": 0}


def test_query_result_paths_follow_candidate_order() -> None:
    result = QueryResult(
        query_id="idx-001",
        scheme="A",
        status="ok",
        candidates=(Candidate("b.md"), Candidate("a.md")),
    )
    assert result.paths == ("b.md", "a.md")
