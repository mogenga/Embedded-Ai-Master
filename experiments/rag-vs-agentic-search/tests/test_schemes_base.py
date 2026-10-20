"""方案基类：契约、导航过滤与占位诚实性（§8.1、T11）。"""

from __future__ import annotations

import pytest

from raglab.assets import Candidate, Query
from raglab.errors import FeatureNotImplemented
from raglab.schemes.base import (
    RetrievalScheme,
    filter_navigation,
    get_scheme,
    validate_candidates,
)


def _query() -> Query:
    return Query(
        id="idx-001",
        track="index",
        text="串口收不到数据",
        gold=("protocols/uart-no-rx.md",),
        topic="protocols",
    )


class _FixedScheme(RetrievalScheme):
    key = "A"

    def __init__(self, status: str, candidates: list[Candidate], **kwargs: object) -> None:
        super().__init__(**kwargs)
        self._status = status
        self._candidates = candidates

    def _retrieve(self, query: Query, *, deadline_ms: float | None):
        return self._status, self._candidates, {"input_tokens": 7, "cost_estimated": True}


class _ExplodingScheme(RetrievalScheme):
    key = "B"

    def _retrieve(self, query: Query, *, deadline_ms: float | None):
        raise RuntimeError("boom")


def test_filter_navigation_keeps_order() -> None:
    candidates = [Candidate("a.md"), Candidate("index.yaml"), Candidate("b.md")]
    assert [c.path for c in filter_navigation(candidates, ["index.yaml"])] == ["a.md", "b.md"]


def test_validate_candidates_normalizes_and_rejects_escape() -> None:
    assert validate_candidates([Candidate("a\\b.md")])[0].path == "a/b.md"
    with pytest.raises(ValueError):
        validate_candidates([Candidate("../escape.md")])


def test_run_produces_unified_result_and_filters_navigation() -> None:
    scheme = _FixedScheme(
        "ok",
        [Candidate("protocols/a.md", 0.9), Candidate("index.yaml", 0.95)],
        navigation_files=["index.yaml"],
    )
    result = scheme.run(_query())
    assert result.status == "ok"
    assert result.scheme == "A"
    assert result.paths == ("protocols/a.md",)
    assert result.input_tokens == 7
    assert result.cost_estimated is True
    assert result.latency_ms >= 0


def test_run_turns_per_query_exception_into_error_status() -> None:
    result = _ExplodingScheme().run(_query())
    assert result.status == "error"
    assert result.error is not None and "boom" in result.error
    assert result.candidates == ()


def test_placeholder_schemes_fail_loudly() -> None:
    for key in ("A", "B", "C", "C_prime", "D"):
        scheme = get_scheme(key)
        with pytest.raises(FeatureNotImplemented):
            scheme.run(_query())


def test_unknown_scheme_key_rejected() -> None:
    with pytest.raises(ValueError):
        get_scheme("Z")
