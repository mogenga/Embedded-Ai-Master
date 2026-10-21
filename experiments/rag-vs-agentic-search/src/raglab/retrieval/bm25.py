"""BM25（spec §8.5），自实现，不引入第三方库。

公式与常见实现一致：

    score(q, d) = Σ_t IDF(t) · (f(t,d) · (k1 + 1)) / (f(t,d) + k1 · (1 - b + b · |d| / avgdl))

    IDF(t) = ln(1 + (N - n(t) + 0.5) / (n(t) + 0.5))

用 ``ln(1 + …)`` 而不是经典 Robertson-Sparck Jones，因为后者对 n(t) > N/2 的词会给出
负 IDF——那会让"常见词命中"变成**扣分**，在只有 108 个文件的小语料上很容易触发。
这处选择在报告里要写明，因为它影响长文档的排序。

设计上刻意保持"无状态分数"：同一份索引、同一个查询必然得到同一排序，
不依赖字典遍历顺序（并列按 ``(path, order)`` 打破）。
"""

from __future__ import annotations

import math
from collections import Counter
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field

from .chunking import Chunk
from .tokenize import tokenize


@dataclass(frozen=True)
class Bm25Params:
    k1: float = 1.5
    b: float = 0.75

    def __post_init__(self) -> None:
        if self.k1 < 0:
            raise ValueError("k1 必须 ≥ 0")
        if not 0 <= self.b <= 1:
            raise ValueError("b 必须在 [0, 1] 区间")


@dataclass
class Bm25Index:
    """倒排索引 + 文档长度统计。构建一次，查询多次。"""

    chunks: list[Chunk]
    params: Bm25Params
    token_mode: str
    _freqs: list[Counter[str]] = field(default_factory=list, repr=False)
    _lengths: list[int] = field(default_factory=list, repr=False)
    _doc_freq: Counter[str] = field(default_factory=Counter, repr=False)
    _avgdl: float = 0.0

    @classmethod
    def build(
        cls,
        chunks: Sequence[Chunk],
        *,
        params: Bm25Params | None = None,
        token_mode: str = "cjk_bigram",
    ) -> "Bm25Index":
        index = cls(
            chunks=list(chunks),
            params=params or Bm25Params(),
            token_mode=token_mode,
        )
        doc_freq: Counter[str] = Counter()
        for chunk in index.chunks:
            counts = Counter(tokenize(chunk.text, mode=token_mode))
            index._freqs.append(counts)
            index._lengths.append(sum(counts.values()))
            doc_freq.update(counts.keys())
        index._doc_freq = doc_freq
        total = sum(index._lengths)
        index._avgdl = total / len(index.chunks) if index.chunks else 0.0
        return index

    @property
    def avgdl(self) -> float:
        return self._avgdl

    def idf(self, token: str) -> float:
        n = self._doc_freq.get(token, 0)
        total = len(self.chunks)
        if total == 0:
            return 0.0
        return math.log(1 + (total - n + 0.5) / (n + 0.5))

    def score_chunk(self, query_tokens: Sequence[str], position: int) -> float:
        counts = self._freqs[position]
        if not counts:
            return 0.0
        length = self._lengths[position]
        denom_norm = self.params.k1 * (
            1 - self.params.b + self.params.b * (length / self._avgdl if self._avgdl else 0.0)
        )
        score = 0.0
        for token in query_tokens:
            freq = counts.get(token, 0)
            if not freq:
                continue
            score += self.idf(token) * (freq * (self.params.k1 + 1)) / (freq + denom_norm)
        return score

    def search(
        self,
        query: str,
        *,
        top_k: int = 5,
        query_token_mode: str | None = None,
    ) -> list[tuple[Chunk, float]]:
        """返回 top-k 的 ``(chunk, score)``；只含得分 > 0 的块。

        并列按 ``(path, order)`` 打破，保证同分排序稳定且与插入顺序无关。
        """

        tokens = tokenize(query, mode=query_token_mode or self.token_mode)
        if not tokens:
            return []
        scored = [
            (chunk, self.score_chunk(tokens, position))
            for position, chunk in enumerate(self.chunks)
        ]
        scored = [pair for pair in scored if pair[1] > 0]
        scored.sort(key=lambda pair: (-pair[1], pair[0].path, pair[0].order))
        return scored[: max(0, top_k)]

    def rank_files(
        self, query: str, *, top_k: int = 5, query_token_mode: str | None = None
    ) -> list[tuple[str, float]]:
        """文件级排序：同一文件取**最大 chunk 分**（§8.5）。

        返回 ``(path, file_score)``；并列按路径字典序。
        """

        chunk_hits = self.search(
            query, top_k=max(top_k * 4, top_k), query_token_mode=query_token_mode
        )
        best: dict[str, float] = {}
        for chunk, score in chunk_hits:
            if score > best.get(chunk.path, float("-inf")):
                best[chunk.path] = score
        ranked = sorted(best.items(), key=lambda pair: (-pair[1], pair[0]))
        return ranked[: max(0, top_k)]


def token_overlap(chunk_text: str, tokens: Iterable[str], *, mode: str) -> set[str]:
    """grep 复核用：chunk 里真实出现的精确 token（大小写不敏感）。"""

    present = set(tokenize(chunk_text, mode=mode))
    return {token.lower() for token in tokens if token.lower() in present}
