"""方案 D 的种子检索（§8.6）。

D1 的种子是 C′ top-3，D2 的种子是 A 与 C′ 各 top-5 合并去重。

**种子与精读是两个方案，不是一次检索**——这正是 D 的定义。
合并去重时保留**第一次出现的顺序**（按 A、C′ 的次序），
这样同一个文件不会因去重而改变相对位置。
"""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path

from ..assets import Query
from ..errors import ConfigurationError
from .bm25_grep import SchemeCPrime
from .index_grep import SchemeC
from .vector_rag import SchemeA

D_VARIANTS = ("D1", "D2")


def _cprime_ranker(corpus_root: Path, navigation_files: Sequence[str]):
    scheme = SchemeCPrime(
        corpus_root=corpus_root,
        navigation_files=navigation_files,
        chunking="whole_file",
        tokenizer="jieba",
        k1=0.9,
        b=0.75,
    )
    return scheme


def _c_ranker(corpus_root: Path, navigation_files: Sequence[str]):
    return SchemeC(
        corpus_root=corpus_root,
        navigation_files=navigation_files,
        dispatch_rule="deployed",
    )


def _a_ranker(corpus_root: Path, navigation_files: Sequence[str], index_path: Path):
    from ..retrieval.vector_index import load_index

    index = load_index(index_path)
    if index is None:
        raise ConfigurationError(
            f"方案 D 的 D2 变体需要 A 的向量索引：{index_path} 不存在，"
            "先运行 `raglab index --scheme A`"
        )
    return index


def make_seed_fn(
    *,
    variant: str,
    corpus_root: str | Path,
    navigation_files: Sequence[str],
    index_path: Path,
    embed_query,
    seed_top_k: int = 3,
):
    """构造 D 的种子函数。

    返回的函数输入查询，输出 ``[(path, score), ...]``，按种子方案的排序。
    """

    if variant not in D_VARIANTS:
        raise ConfigurationError(f"未知 D 变体：{variant!r}，可选 {D_VARIANTS}")

    root = Path(corpus_root)
    cprime = _cprime_ranker(root, navigation_files)

    if variant == "D1":
        def seed(query: Query) -> list[tuple[str, float]]:
            result = cprime.run(query)
            return [(c.path, c.score) for c in result.candidates[:seed_top_k]]

        return seed

    # D2：A 与 C′ 各取 top-5，合并去重，保留首次出现顺序。
    a_index = _a_ranker(root, navigation_files, index_path)
    a_scheme = SchemeA(
        index=a_index, navigation_files=navigation_files, embed_query=embed_query, top_k=5
    )

    def seed(query: Query) -> list[tuple[str, float]]:
        merged: list[tuple[str, float]] = []
        seen: set[str] = set()
        for scheme in (a_scheme, cprime):
            result = scheme.run(query)
            for candidate in result.candidates[:seed_top_k]:
                if candidate.path in seen:
                    continue
                seen.add(candidate.path)
                merged.append((candidate.path, candidate.score))
        return merged

    return seed
