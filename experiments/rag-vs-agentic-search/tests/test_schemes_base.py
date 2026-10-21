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
    """五个方案都已实现；不应再有占位方案。

    保留这个测试是为了守住一条纪律：**新增方案必须真的实现**，
    而不是在注册表里挂个空壳。这里断言 `_Placeholder` 没有任何子类。
    """

    from raglab.schemes.base import _Placeholder, _scheme_registry

    registry = _scheme_registry()
    placeholders = [key for key, cls in registry.items() if issubclass(cls, _Placeholder)]
    assert placeholders == [], f"这些方案还是占位：{placeholders}"


def test_all_five_schemes_are_registered() -> None:
    from raglab.schemes.base import _scheme_registry

    assert set(_scheme_registry()) == {"A", "B", "C", "C_prime", "D"}


@pytest.mark.parametrize("key", ["C", "C_prime"])
def test_corpus_schemes_require_corpus_root(key: str) -> None:
    """C / C′ 要求显式传语料根——避免用错语料却毫无提示。"""

    with pytest.raises(TypeError):
        get_scheme(key)


def test_scheme_a_without_index_fails_loudly() -> None:
    """A 缺索引时必须显式报错，不能返回空候选冒充"什么都找不到"。"""

    from raglab.errors import BlockedError

    scheme = get_scheme("A")
    with pytest.raises(BlockedError, match="向量索引"):
        scheme.run(_query())


def test_scheme_a_without_query_encoder_fails_loudly() -> None:
    from raglab.errors import BlockedError
    from raglab.retrieval.chunking import Chunk
    from raglab.retrieval.vector_index import VectorIndex

    index = VectorIndex(
        chunks=[Chunk("a.md", 0, "x")],
        vectors=[[1.0, 0.0]],
        model_id="m",
        build_seconds=0.0,
        cached=False,
    )
    scheme = get_scheme("A", index=index)
    with pytest.raises(BlockedError, match="查询编码器"):
        scheme.run(_query())


def test_scheme_d_without_h5_signal_fails_loudly(tmp_path: Path) -> None:
    """D 必须显式声明 H5 有信号才能构造。"""

    from raglab.errors import BlockedError

    (tmp_path / "a.md").write_text("# a\nuart\n", encoding="utf-8")
    with pytest.raises(BlockedError, match="h5_signal"):
        get_scheme(
            "D", corpus_root=tmp_path, system_prompt="你是检索助手"
        )


def test_scheme_b_without_chat_client_fails_loudly(tmp_path: Path) -> None:
    """B 缺模型客户端时必须显式报错，不能返回空候选冒充"没找到"。"""

    from raglab.errors import BlockedError

    (tmp_path / "a.md").write_text("# a\nuart\n", encoding="utf-8")
    scheme = get_scheme(
        "B", corpus_root=tmp_path, system_prompt="你是检索助手"
    )
    with pytest.raises(BlockedError, match="模型客户端"):
        scheme.run(_query())


def test_unknown_scheme_key_rejected() -> None:
    with pytest.raises(ValueError):
        get_scheme("Z")
