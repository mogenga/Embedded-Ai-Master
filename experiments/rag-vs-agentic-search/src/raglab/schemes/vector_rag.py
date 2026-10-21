"""方案 A：向量 RAG（spec §8.2）。

**构建与查询分开计时**（§8.2）：embedding 是离线批处理，把它算进单查询延迟会让 A
看起来比实际慢两个数量级。构建耗时记在 ``stats["build_seconds"]``，查询延迟只算
编码查询本身加检索。

**索引必须显式传入**，不在构造函数里自动构建：构建要访问网络、耗时几分钟，
隐式触发会让"我只是想跑一下"变成一次长时间网络调用。`raglab index` 负责建并落盘。

**缺索引即失败**，不回退到"用空索引返回空候选"——那会把一个配置问题伪装成
"这个方案什么都找不到"。
"""

from __future__ import annotations

import time
from collections.abc import Callable, Iterable, Sequence

from ..assets import Candidate, Query
from ..errors import BlockedError
from ..retrieval.vector_index import VectorIndex
from .base import RetrievalScheme


class SchemeA(RetrievalScheme):
    """向量检索：chunk → embedding → 余弦 top-k → 文件级取最大分。"""

    key = "A"
    display_name = "向量 RAG"

    def __init__(
        self,
        *,
        index: VectorIndex | None = None,
        navigation_files: Iterable[str] = (),
        embed_query: Callable[[str], list[float]] | None = None,
        top_k: int = 5,
    ) -> None:
        super().__init__(navigation_files=navigation_files)
        self._index = index
        self._embed_query = embed_query
        self._top_k = top_k

    @property
    def stats(self) -> dict[str, object]:
        if self._index is None:
            return {"ready": False}
        return {
            "ready": True,
            "chunks": self._index.size,
            "files": self._index.files,
            "model_id": self._index.model_id,
            "build_seconds": round(self._index.build_seconds, 1),
            "index_cached": self._index.cached,
        }

    def warm_up(self) -> None:
        """A 的索引已由 `raglab index` 建好；此方法只为接口一致。"""

    def _retrieve(
        self,
        query: Query,
        *,
        deadline_ms: float | None,
    ) -> tuple[str, list[Candidate], dict[str, float | int | bool]]:
        if self._index is None:
            raise BlockedError(
                "方案 A 缺少向量索引：先运行 `raglab index --scheme A`（需 RAGLAB_LIVE=1）"
            )
        if self._embed_query is None:
            raise BlockedError("方案 A 缺少查询编码器")

        started = time.perf_counter()
        query_vector = self._embed_query(query.text)
        embed_ms = (time.perf_counter() - started) * 1000

        ranked = self._index.rank_files(query_vector, top_k=self._top_k)
        extra: dict[str, float | int | bool] = {
            "embed_ms": embed_ms,
            "chunks": self._index.size,
            "input_tokens": 0,
            "output_tokens": 0,
            "cost_estimated": False,
        }
        if not ranked:
            extra["status_reason"] = "empty_index"
            return "no_match", [], extra

        candidates = [Candidate(path=path, score=score) for path, score in ranked]
        return "ok", candidates, extra


def build_index(
    *,
    corpus_root,
    navigation_files: Sequence[str],
    chunking: str,
    max_chars: int,
    overlap_chars: int,
    embed_fn,
    model_id: str,
    cache_dir=None,
    batch_size: int = 110,
    spacing_seconds: float = 0.0,
    sleep=None,
) -> VectorIndex:
    """把语料切块并编码成向量索引。

    导航文件**不进索引**：否则它们会先占候选名额再被 T11 过滤掉，
    等于变相压缩了真正可用的候选数。
    """

    from ..retrieval.chunking import chunk_corpus
    from ..retrieval.vector_index import encode_chunks

    chunks = chunk_corpus(
        corpus_root,
        mode=chunking,
        max_chars=max_chars,
        overlap=overlap_chars,
        exclude=tuple(navigation_files),
    )
    if not chunks:
        raise BlockedError(f"语料为空或全部被排除：{corpus_root}")

    started = time.perf_counter()
    vectors, stats = encode_chunks(
        chunks,
        embed_fn=embed_fn,
        model_id=model_id,
        cache_dir=cache_dir,
        batch_size=batch_size,
        spacing_seconds=spacing_seconds,
        sleep=sleep,
    )
    elapsed = time.perf_counter() - started

    index = VectorIndex(
        chunks=chunks,
        vectors=vectors,
        model_id=model_id,
        build_seconds=elapsed,
        cached=int(stats["cache_misses"]) == 0,
        batch_size=batch_size,
        spacing_seconds=spacing_seconds,
    )
    return index
