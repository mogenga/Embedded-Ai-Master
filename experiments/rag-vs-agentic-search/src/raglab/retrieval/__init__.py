"""检索基础设施：切块、分词、BM25。

与 `schemes/` 分开：这些是**可复用的零件**，A 与 C′ 都会用到切块，
C′ 与 D 都会用到 BM25。方案类只负责编排，不自己实现算法。
"""

from __future__ import annotations

from .chunking import Chunk, chunk_corpus, chunk_text
from .tokenize import tokenize

__all__ = ["Chunk", "chunk_corpus", "chunk_text", "tokenize"]
