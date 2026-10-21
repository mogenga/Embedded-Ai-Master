"""向量索引（spec §8.2、§9.3）。

两件事必须讲清楚：

1. **缓存键是 ``sha256(chunk_text) + model_id``**（§9.3）。语料或模型一变，缓存自动失效，
   不会把旧向量当成新语料的。
2. **构建时间单独记录，不计入查询延迟**（§8.2）。embedding 是离线批处理，
   把它算进单查询延迟会让 A 看起来比实际慢两个数量级。

向量 L2 归一化后，余弦相似度退化为点积——省一次除法，且数值更稳。
"""

from __future__ import annotations

import hashlib
import json
import math
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

from .chunking import Chunk


def _normalize(vector: Sequence[float]) -> list[float]:
    norm = math.sqrt(sum(value * value for value in vector))
    if norm == 0:
        return list(vector)
    return [value / norm for value in vector]


def cosine(left: Sequence[float], right: Sequence[float]) -> float:
    """余弦相似度；两侧都已归一化时等价于点积。"""

    if len(left) != len(right):
        raise ValueError(f"向量维度不一致：{len(left)} vs {len(right)}")
    dot = sum(a * b for a, b in zip(left, right, strict=True))
    norm_l = math.sqrt(sum(value * value for value in left))
    norm_r = math.sqrt(sum(value * value for value in right))
    if norm_l == 0 or norm_r == 0:
        return 0.0
    return dot / (norm_l * norm_r)


def chunk_cache_key(chunk: Chunk, *, model_id: str) -> str:
    digest = hashlib.sha256(chunk.text.encode("utf-8")).hexdigest()
    return f"{digest}:{model_id}"


@dataclass
class EmbeddingBatch:
    """一次 embedding 调用的结果，含用量与耗时。"""

    vectors: list[list[float]]
    seconds: float
    cached: bool


class VectorIndex:
    """chunk 向量 + 最近邻查询。"""

    def __init__(
        self,
        *,
        chunks: Sequence[Chunk],
        vectors: Sequence[Sequence[float]],
        model_id: str,
        build_seconds: float,
        cached: bool,
        batch_size: int = 110,
        spacing_seconds: float = 0.0,
        chunking: str = "",
    ) -> None:
        if len(chunks) != len(vectors):
            raise ValueError(f"chunk 与向量数量不符：{len(chunks)} vs {len(vectors)}")
        self._chunks = list(chunks)
        self._vectors = [_normalize(vector) for vector in vectors]
        self.model_id = model_id
        self.build_seconds = build_seconds
        self.cached = cached
        self.batch_size = batch_size
        self.spacing_seconds = spacing_seconds
        self.chunking = chunking

    @property
    def size(self) -> int:
        return len(self._chunks)

    @property
    def files(self) -> int:
        return len({chunk.path for chunk in self._chunks})

    def search(
        self, query_vector: Sequence[float], *, top_k: int = 5
    ) -> list[tuple[Chunk, float]]:
        """返回 top-k chunk；并列按 ``(path, order)`` 打破。"""

        probe = _normalize(query_vector)
        scored = [
            (chunk, sum(a * b for a, b in zip(probe, vector, strict=True)))
            for chunk, vector in zip(self._chunks, self._vectors, strict=True)
        ]
        scored.sort(key=lambda pair: (-pair[1], pair[0].path, pair[0].order))
        return scored[: max(0, top_k)]

    def rank_files(
        self, query_vector: Sequence[float], *, top_k: int = 5
    ) -> list[tuple[str, float]]:
        """文件级排序：同一文件取最大 chunk 相似度（§8.2）。"""

        # 多取一些 chunk 再聚合，避免一个文件占满 top_k 导致别的文件进不来。
        hits = self.search(query_vector, top_k=max(top_k * 8, top_k))
        best: dict[str, float] = {}
        for chunk, score in hits:
            if score > best.get(chunk.path, float("-inf")):
                best[chunk.path] = score
        ranked = sorted(best.items(), key=lambda pair: (-pair[1], pair[0]))
        return ranked[: max(0, top_k)]


def save_index(index: VectorIndex, path: str | Path) -> Path:
    """把索引落盘，供 `raglab run --scheme A` 复用。

    **存的是 chunk 文本与向量，不是文件路径**：语料变了而缓存没失效，会把旧向量
    当成新语料的。这里靠 `raglab index` 的重新构建保证一致。
    """

    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "model_id": index.model_id,
        "build_seconds": index.build_seconds,
        "chunking": index.chunking,
        "chunks": [
            {"path": chunk.path, "order": chunk.order, "text": chunk.text}
            for chunk in index._chunks  # noqa: SLF001 —— 同类内的序列化
        ],
        "vectors": index._vectors,  # noqa: SLF001
    }
    target.write_text(
        json.dumps(payload, ensure_ascii=False), encoding="utf-8", newline="\n"
    )
    return target


def load_index(path: str | Path) -> VectorIndex | None:
    """读回索引；文件缺失或损坏返回 None（由调用方决定是报错还是重建）。"""

    target = Path(path)
    if not target.is_file():
        return None
    try:
        payload = json.loads(target.read_text(encoding="utf-8"))
        chunks = [
            Chunk(path=str(item["path"]), order=int(item["order"]), text=str(item["text"]))
            for item in payload["chunks"]
        ]
        vectors = [[float(value) for value in vector] for vector in payload["vectors"]]
        model_id = str(payload["model_id"])
        build_seconds = float(payload.get("build_seconds", 0.0))
    except (OSError, json.JSONDecodeError, KeyError, TypeError, ValueError):
        return None

    return VectorIndex(
        chunks=chunks,
        vectors=vectors,
        model_id=model_id,
        build_seconds=build_seconds,
        cached=True,
        chunking=str(payload.get("chunking", "")),
    )


def _cache_path(cache_dir: Path, model_id: str) -> Path:
    safe = "".join(ch if ch.isalnum() or ch in "-_." else "_" for ch in model_id)
    return cache_dir / f"{safe}.json"


def load_cache(cache_dir: Path, model_id: str) -> dict[str, list[float]]:
    path = _cache_path(cache_dir, model_id)
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        # 缓存坏了就当没有；不因为缓存问题让整个实验失败。
        return {}
    if not isinstance(data, dict):
        return {}
    return {
        key: [float(value) for value in vector]
        for key, vector in data.items()
        if isinstance(vector, list)
    }


def save_cache(cache_dir: Path, model_id: str, cache: dict[str, list[float]]) -> Path:
    cache_dir.mkdir(parents=True, exist_ok=True)
    path = _cache_path(cache_dir, model_id)
    path.write_text(
        json.dumps(cache, ensure_ascii=False), encoding="utf-8", newline="\n"
    )
    return path


def encode_chunks(
    chunks: Sequence[Chunk],
    *,
    embed_fn,
    model_id: str,
    cache_dir: Path | None = None,
    batch_size: int = 110,
    spacing_seconds: float = 0.0,
    sleep=None,
) -> tuple[list[list[float]], dict[str, object]]:
    """把 chunk 编码成向量；命中缓存的跳过调用。

    ``embed_fn(texts) -> list[list[float]]`` 由调用方注入，便于离线测试。
    ``sleep`` 同样可注入，测试里不必真的等。
    ``spacing_seconds`` 用于避开网关限流——实测需 ≥ 15s。
    """

    if sleep is None:
        import time

        sleep = time.sleep

    cache = load_cache(cache_dir, model_id) if cache_dir else {}
    keys = [chunk_cache_key(chunk, model_id=model_id) for chunk in chunks]

    missing_positions = [index for index, key in enumerate(keys) if key not in cache]
    calls = 0
    if missing_positions:
        for start in range(0, len(missing_positions), batch_size):
            group = missing_positions[start : start + batch_size]
            texts = [chunks[index].text for index in group]
            vectors = embed_fn(texts)
            if len(vectors) != len(texts):
                raise ValueError(
                    f"embedding 返回数量不符：{len(vectors)} != {len(texts)}"
                )
            for index, vector in zip(group, vectors, strict=True):
                cache[keys[index]] = list(vector)
            calls += 1
            if spacing_seconds and start + batch_size < len(missing_positions):
                sleep(spacing_seconds)
        if cache_dir:
            save_cache(cache_dir, model_id, cache)

    vectors = [cache[key] for key in keys]
    stats: dict[str, object] = {
        "chunks": len(chunks),
        "cache_hits": len(chunks) - len(missing_positions),
        "cache_misses": len(missing_positions),
        "embedding_calls": calls,
        "batch_size": batch_size,
        "spacing_seconds": spacing_seconds,
        "model_id": model_id,
    }
    return vectors, stats
