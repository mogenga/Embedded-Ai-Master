"""方案 C′：BM25 + grep（spec §8.5）。

与 C 的差别只在检索机制：C 用 `index.yaml` 的**人工关键词表**做路由，C′ 用全语料的
**词频统计**（BM25）。因此 C′ 不需要索引文件，也不受"哪些文件被收录进 index.yaml"限制
——这正是 C 的 11/80 条结构性缺陷想被检验的地方。

grep 复核的作用是**打破近分并列**，不是二次检索：

- 对 BM25 top-20 的 chunk 提取查询里的精确 token；
- 在 chunk 内真实出现的 token 数 × `grep_bonus` 加到分数上；
- **不改变 top-5 之外的块进入候选的资格**（预注册要求，防止 grep 变成第二套检索）。
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from pathlib import Path

from ..assets import Candidate, Query
from ..retrieval.bm25 import Bm25Index, Bm25Params
from ..retrieval.chunking import (
    DEFAULT_MAX_CHARS,
    DEFAULT_OVERLAP_CHARS,
    chunk_corpus,
)
from .base import RetrievalScheme

# 与 kb-mcp 一致的精确 token 模式（十六进制在前）；grep 复核只认这类 token。
_EXACT_TOKEN = re.compile(r"0x[0-9A-Fa-f]+|[A-Za-z_][A-Za-z0-9_]*")


class SchemeCPrime(RetrievalScheme):
    """BM25 召回 + 精确 token 复核。"""

    key = "C_prime"
    display_name = "BM25 + grep"

    def __init__(
        self,
        *,
        corpus_root: str | Path,
        navigation_files: Iterable[str] = (),
        chunking: str = "section",
        tokenizer: str = "cjk_bigram",
        k1: float = 1.5,
        b: float = 0.75,
        top_k: int = 5,
        grep_review_top_n: int = 20,
        grep_bonus: float = 0.05,
        max_chars: int = DEFAULT_MAX_CHARS,
        overlap_chars: int = DEFAULT_OVERLAP_CHARS,
        enable_grep_review: bool = True,
    ) -> None:
        super().__init__(navigation_files=navigation_files)
        self._chunking = chunking
        self._tokenizer = tokenizer
        self._top_k = top_k
        self._review_top_n = grep_review_top_n
        self._grep_bonus = grep_bonus
        self._enable_grep_review = enable_grep_review

        # 导航文件不进索引：否则它们先占候选名额再被过滤，等于变相降低召回。
        chunks = chunk_corpus(
            corpus_root,
            mode=chunking,
            max_chars=max_chars,
            overlap=overlap_chars,
            exclude=tuple(navigation_files),
        )
        self._index = Bm25Index.build(
            chunks,
            params=Bm25Params(k1=k1, b=b),
            token_mode=tokenizer,
        )
        self._chunk_count = len(chunks)
        self._file_count = len({chunk.path for chunk in chunks})

    @property
    def stats(self) -> dict[str, int]:
        return {"chunks": self._chunk_count, "files": self._file_count}

    def warm_up(self) -> None:
        """C′ 的索引在构造时已建好；此方法存在只为与 C 的接口一致。"""

    @staticmethod
    def _exact_tokens(query: str) -> list[str]:
        seen: list[str] = []
        for match in _EXACT_TOKEN.finditer(query):
            token = match.group(0).lower()
            if len(token) < 2:
                continue
            if token not in seen:
                seen.append(token)
        return seen

    def _retrieve(
        self,
        query: Query,
        *,
        deadline_ms: float | None,
    ) -> tuple[str, list[Candidate], dict[str, float | int | bool]]:
        extra: dict[str, float | int | bool] = {
            "chunking": self._chunking,
            "tokenizer": self._tokenizer,
            "input_tokens": 0,
            "output_tokens": 0,
            "cost_estimated": False,
        }

        exact = self._exact_tokens(query.text)
        extra["grep_tokens"] = len(exact)

        # 取 top-20 chunk 用于复核；评分仍是文件级取最大 chunk 分。
        review_k = max(self._review_top_n, self._top_k) if self._enable_grep_review else self._top_k
        hits = self._index.search(query.text, top_k=max(review_k * 4, review_k))
        if not hits:
            extra["status_reason"] = "no_lexical_hit"
            return "no_match", [], extra

        best: dict[str, float] = {}
        for chunk, score in hits:
            if score > best.get(chunk.path, float("-inf")):
                best[chunk.path] = score

        if self._enable_grep_review and exact:
            # 复核只看 top-N chunk 内实际出现的精确 token 数，加固定小分。
            seen_chunks = 0
            for chunk, score in hits:
                if seen_chunks >= self._review_top_n:
                    break
                seen_chunks += 1
                lowered = chunk.text.lower()
                matched = sum(1 for token in exact if token in lowered)
                if not matched:
                    continue
                boosted = score + self._grep_bonus * matched
                if boosted > best.get(chunk.path, float("-inf")):
                    best[chunk.path] = boosted
            extra["grep_reviewed_chunks"] = seen_chunks

        ranked = sorted(best.items(), key=lambda pair: (-pair[1], pair[0]))
        candidates = [Candidate(path=path, score=score) for path, score in ranked[: self._top_k]]
        if not candidates:
            extra["status_reason"] = "no_candidate"
            return "no_match", [], extra
        return "ok", candidates, extra
