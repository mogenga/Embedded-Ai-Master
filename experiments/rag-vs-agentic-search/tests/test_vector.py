"""向量索引与方案 A（§8.2、§9.3）。

全部离线：`embed_fn` 一律注入假实现，绝不触网。
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

from raglab.assets import Query
from raglab.errors import BlockedError, ConfigurationError
from raglab.retrieval.chunking import Chunk
from raglab.retrieval.vector_index import (
    VectorIndex,
    chunk_cache_key,
    cosine,
    encode_chunks,
    load_cache,
    load_index,
    save_cache,
    save_index,
)
from raglab.schemes.vector_rag import SchemeA, build_index


def _chunks(*texts: str) -> list[Chunk]:
    return [Chunk(path=f"doc{i}.md", order=0, text=text) for i, text in enumerate(texts, 1)]


class _FakeEmbed:
    """确定性的假编码器：按字符和生成向量，便于断言相似度关系。"""

    def __init__(self) -> None:
        self.calls: list[list[str]] = []

    def __call__(self, texts: list[str]) -> list[list[float]]:
        self.calls.append(list(texts))
        vectors = []
        for text in texts:
            # 三维：字符数、元音数、是否含 "uart"
            vectors.append(
                [
                    float(len(text)),
                    float(sum(ch in "aeiou" for ch in text)),
                    1.0 if "uart" in text else 0.0,
                ]
            )
        return vectors


def _query(text: str = "uart 串口没输出") -> Query:
    return Query(id="idx-001", track="index", text=text, gold=("doc1.md",), topic="protocols")


# ---- 相似度 ----------------------------------------------------------------


def test_cosine_of_identical_vectors_is_one() -> None:
    assert cosine([1.0, 2.0, 3.0], [1.0, 2.0, 3.0]) == pytest.approx(1.0)


def test_cosine_of_orthogonal_is_zero() -> None:
    assert cosine([1.0, 0.0], [0.0, 1.0]) == pytest.approx(0.0)


def test_cosine_rejects_dimension_mismatch() -> None:
    with pytest.raises(ValueError, match="维度不一致"):
        cosine([1.0, 2.0], [1.0])


def test_cosine_handles_zero_vector() -> None:
    assert cosine([0.0, 0.0], [1.0, 1.0]) == 0.0


# ---- 索引 ------------------------------------------------------------------


def test_index_requires_matching_counts() -> None:
    with pytest.raises(ValueError, match="数量不符"):
        VectorIndex(
            chunks=_chunks("a"), vectors=[[1.0], [2.0]], model_id="m",
            build_seconds=0.0, cached=False,
        )


def test_index_normalises_vectors_on_construction() -> None:
    index = VectorIndex(
        chunks=_chunks("a"), vectors=[[3.0, 4.0]], model_id="m",
        build_seconds=0.0, cached=False,
    )
    # 3-4-5 直角三角形归一化后是 0.6 / 0.8。
    chunk, score = index.search([1.0, 0.0])[0]
    assert score == pytest.approx(0.6)


def test_index_ranks_by_similarity_then_path() -> None:
    index = VectorIndex(
        chunks=[Chunk("b.md", 0, "x"), Chunk("a.md", 0, "y")],
        vectors=[[1.0, 0.0], [1.0, 0.0]],
        model_id="m", build_seconds=0.0, cached=False,
    )
    ranked = index.search([1.0, 0.0])
    assert [chunk.path for chunk, _ in ranked] == ["a.md", "b.md"]


def test_file_score_is_max_chunk_score() -> None:
    index = VectorIndex(
        chunks=[Chunk("a.md", 0, "weak"), Chunk("a.md", 1, "strong")],
        vectors=[[0.1, 1.0], [1.0, 0.0]],
        model_id="m", build_seconds=0.0, cached=False,
    )
    ranked = dict(index.rank_files([1.0, 0.0], top_k=1))
    assert ranked["a.md"] == pytest.approx(1.0)


def test_rank_files_dedupes_paths() -> None:
    index = VectorIndex(
        chunks=[Chunk("a.md", 0, "x"), Chunk("a.md", 1, "y"), Chunk("b.md", 0, "z")],
        vectors=[[1.0, 0.0], [1.0, 0.0], [0.0, 1.0]],
        model_id="m", build_seconds=0.0, cached=False,
    )
    assert [path for path, _ in index.rank_files([1.0, 0.0], top_k=5)] == ["a.md", "b.md"]


# ---- 缓存（§9.3） ----------------------------------------------------------


def test_cache_key_depends_on_text_and_model() -> None:
    chunk = Chunk("a.md", 0, "hello")
    assert chunk_cache_key(chunk, model_id="m1") != chunk_cache_key(chunk, model_id="m2")
    assert chunk_cache_key(chunk, model_id="m1") == chunk_cache_key(
        Chunk("b.md", 5, "hello"), model_id="m1"
    ), "同文本不同路径应共享向量缓存"


def test_encode_uses_cache_on_second_run(tmp_path: Path) -> None:
    chunks = _chunks("uart", "spi")
    fake = _FakeEmbed()

    encode_chunks(chunks, embed_fn=fake, model_id="m", cache_dir=tmp_path)
    assert len(fake.calls) == 1

    encode_chunks(chunks, embed_fn=fake, model_id="m", cache_dir=tmp_path)
    assert len(fake.calls) == 1, "第二次应全部命中缓存，不发起调用"


def test_encode_batches_respect_size(tmp_path: Path) -> None:
    chunks = _chunks(*[f"t{i}" for i in range(5)])
    fake = _FakeEmbed()
    _, stats = encode_chunks(
        chunks, embed_fn=fake, model_id="m", cache_dir=tmp_path, batch_size=2
    )
    assert stats["embedding_calls"] == 3
    assert [len(call) for call in fake.calls] == [2, 2, 1]


def test_encode_spacing_sleeps_between_calls_not_after_last(tmp_path: Path) -> None:
    chunks = _chunks(*[f"t{i}" for i in range(5)])
    slept: list[float] = []
    encode_chunks(
        chunks,
        embed_fn=_FakeEmbed(),
        model_id="m",
        cache_dir=tmp_path,
        batch_size=2,
        spacing_seconds=15.0,
        sleep=slept.append,
    )
    # 3 批 → 中间 2 次间隔，最后一次后面不睡。
    assert slept == [15.0, 15.0]


def test_encode_rejects_truncated_response(tmp_path: Path) -> None:
    class _Short:
        def __call__(self, texts: list[str]) -> list[list[float]]:
            return [[1.0]]

    with pytest.raises(ValueError, match="数量不符"):
        encode_chunks(_chunks("a", "b"), embed_fn=_Short(), model_id="m", cache_dir=tmp_path)


def test_corrupt_cache_is_ignored(tmp_path: Path) -> None:
    (tmp_path / "m.json").write_text("{not json", encoding="utf-8")
    assert load_cache(tmp_path, "m") == {}


def test_save_and_load_cache_roundtrip(tmp_path: Path) -> None:
    save_cache(tmp_path, "m", {"k": [1.0, 2.0]})
    assert load_cache(tmp_path, "m") == {"k": [1.0, 2.0]}


# ---- 索引落盘 --------------------------------------------------------------


def test_index_roundtrip(tmp_path: Path) -> None:
    index = VectorIndex(
        chunks=_chunks("uart", "spi"),
        vectors=[[1.0, 0.0], [0.0, 1.0]],
        model_id="m",
        build_seconds=12.5,
        cached=False,
        chunking="section",
    )
    path = save_index(index, tmp_path / "idx.json")
    restored = load_index(path)
    assert restored is not None
    assert restored.size == 2
    assert restored.model_id == "m"
    assert restored.chunking == "section"
    assert restored.build_seconds == pytest.approx(12.5)


def test_load_index_missing_returns_none(tmp_path: Path) -> None:
    assert load_index(tmp_path / "nope.json") is None


def test_load_index_corrupt_returns_none(tmp_path: Path) -> None:
    path = tmp_path / "bad.json"
    path.write_text(json.dumps({"chunks": "not a list"}), encoding="utf-8")
    assert load_index(path) is None


# ---- 方案 A ----------------------------------------------------------------


def test_scheme_a_without_index_raises() -> None:
    with pytest.raises(BlockedError, match="向量索引"):
        SchemeA().run(_query())


def test_scheme_a_without_encoder_raises() -> None:
    index = VectorIndex(
        chunks=_chunks("a"), vectors=[[1.0]], model_id="m", build_seconds=0.0, cached=False
    )
    with pytest.raises(BlockedError, match="查询编码器"):
        SchemeA(index=index).run(_query())


def test_scheme_a_returns_ranked_candidates() -> None:
    index = VectorIndex(
        chunks=[Chunk("match.md", 0, "x"), Chunk("other.md", 0, "y")],
        vectors=[[1.0, 0.0], [0.0, 1.0]],
        model_id="m", build_seconds=0.0, cached=False,
    )
    scheme = SchemeA(index=index, embed_query=lambda _text: [1.0, 0.0], top_k=2)
    result = scheme.run(_query())
    assert result.status == "ok"
    assert result.paths[0] == "match.md"
    assert result.extra["chunks"] == 2


def test_scheme_a_records_embed_latency_separately() -> None:
    """构建耗时不得混进查询延迟（§8.2）。"""

    index = VectorIndex(
        chunks=_chunks("a"), vectors=[[1.0, 0.0]], model_id="m",
        build_seconds=999.0, cached=False,
    )
    scheme = SchemeA(index=index, embed_query=lambda _text: [1.0, 0.0])
    result = scheme.run(_query())
    assert result.latency_ms < 1000, "单查询延迟不应包含 999 秒的构建时间"
    assert "embed_ms" in result.extra


def test_scheme_a_filters_navigation_at_exit() -> None:
    index = VectorIndex(
        chunks=[Chunk("_sources.md", 0, "x"), Chunk("real.md", 0, "y")],
        vectors=[[1.0, 0.0], [0.9, 0.1]],
        model_id="m", build_seconds=0.0, cached=False,
    )
    scheme = SchemeA(
        index=index, navigation_files=("_sources.md",), embed_query=lambda _text: [1.0, 0.0]
    )
    result = scheme.run(_query())
    assert "_sources.md" not in result.paths


def test_build_index_excludes_navigation(tmp_path: Path) -> None:
    root = tmp_path / "kb"
    root.mkdir()
    (root / "a.md").write_text("# a\nuart\n", encoding="utf-8")
    (root / "_sources.md").write_text("# 来源\nuart\n", encoding="utf-8")

    index = build_index(
        corpus_root=root,
        navigation_files=["_sources.md"],
        chunking="whole_file",
        max_chars=1200,
        overlap_chars=100,
        embed_fn=_FakeEmbed(),
        model_id="m",
    )
    assert index.files == 1


def test_build_index_rejects_empty_corpus(tmp_path: Path) -> None:
    root = tmp_path / "empty"
    root.mkdir()
    with pytest.raises(BlockedError, match="语料为空"):
        build_index(
            corpus_root=root,
            navigation_files=[],
            chunking="whole_file",
            max_chars=1200,
            overlap_chars=100,
            embed_fn=_FakeEmbed(),
            model_id="m",
        )


def test_scheme_a_stats_report_readiness() -> None:
    assert SchemeA().stats == {"ready": False}
    index = VectorIndex(
        chunks=_chunks("a"), vectors=[[1.0]], model_id="m",
        build_seconds=1.0, cached=True, chunking="section",
    )
    stats = SchemeA(index=index).stats
    assert stats["ready"] is True
    assert stats["chunks"] == 1
    assert stats["index_cached"] is True
