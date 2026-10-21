"""检索零件：切块、分词、BM25（§8.2 / §8.5）。

全部用内联夹具，不依赖本地语料。
"""

from __future__ import annotations

import math
from pathlib import Path

import pytest

from raglab.retrieval.bm25 import Bm25Index, Bm25Params
from raglab.retrieval.chunking import Chunk, chunk_corpus, chunk_text
from raglab.retrieval.tokenize import TOKENIZERS, tokenize

# ---- 切块 ------------------------------------------------------------------


def test_whole_file_returns_single_chunk_when_short() -> None:
    assert chunk_text("短文本", mode="whole_file") == ["短文本"]


def test_whole_file_hard_splits_with_overlap() -> None:
    text = "a" * 2500
    pieces = chunk_text(text, mode="whole_file", max_chars=1200, overlap=100)
    assert len(pieces) == 3
    assert all(len(piece) <= 1200 for piece in pieces)
    # 相邻块重叠 100 字符。
    assert pieces[0][-100:] == pieces[1][:100]


def test_section_mode_splits_on_headings() -> None:
    text = "# 一\nalpha\n\n## 二\nbeta\n"
    pieces = chunk_text(text, mode="section")
    assert len(pieces) == 2
    assert "alpha" in pieces[0]
    assert "beta" in pieces[1]


def test_section_mode_ignores_headings_inside_fenced_code() -> None:
    """代码块里的 `#` 不是标题——嵌入式语料里 `#pragma`、`#define` 到处都是。"""

    text = "# 标题\n正文\n```c\n#pragma pack(1)\n# define X\n```\n结尾\n"
    pieces = chunk_text(text, mode="section")
    assert len(pieces) == 1
    assert "#pragma" in pieces[0]


def test_section_mode_keeps_preamble_before_first_heading() -> None:
    pieces = chunk_text("前言内容\n\n# 标题\n正文\n", mode="section")
    assert len(pieces) == 2
    assert "前言内容" in pieces[0]


def test_section_mode_splits_oversized_section() -> None:
    text = "# 标题\n" + "x" * 3000
    pieces = chunk_text(text, mode="section", max_chars=1200, overlap=100)
    assert len(pieces) >= 3
    assert all(len(piece) <= 1200 for piece in pieces)


def test_unknown_chunking_mode_rejected() -> None:
    with pytest.raises(ValueError, match="未知切块方式"):
        chunk_text("x", mode="nope")


def test_overlap_must_be_smaller_than_max() -> None:
    with pytest.raises(ValueError):
        chunk_text("x", mode="whole_file", max_chars=100, overlap=100)


def test_chunk_corpus_excludes_navigation_paths(tmp_path: Path) -> None:
    root = tmp_path / "kb"
    (root / "protocols").mkdir(parents=True)
    (root / "protocols" / "a.md").write_text("# A\nalpha\n", encoding="utf-8")
    (root / "_sources.md").write_text("# 来源\nbeta\n", encoding="utf-8")

    chunks = chunk_corpus(root, mode="section", exclude=["_sources.md"])
    paths = {chunk.path for chunk in chunks}
    assert paths == {"protocols/a.md"}


def test_chunk_corpus_records_order_per_file(tmp_path: Path) -> None:
    root = tmp_path / "kb"
    root.mkdir()
    (root / "a.md").write_text("# 一\nalpha\n# 二\nbeta\n", encoding="utf-8")
    chunks = chunk_corpus(root, mode="section")
    assert [chunk.order for chunk in chunks] == [0, 1]


# ---- 分词 ------------------------------------------------------------------


def test_cjk_bigram_produces_character_pairs() -> None:
    assert tokenize("串口没输出", mode="cjk_bigram") == [
        "串口",
        "口没",
        "没输",
        "输出",
    ]


def test_single_cjk_character_is_kept() -> None:
    assert tokenize("口", mode="cjk_bigram") == ["口"]


def test_ascii_tokens_are_lowercased_and_kept_whole() -> None:
    assert tokenize("USART BRR 0x271", mode="cjk_bigram") == ["usart", "brr", "0x271"]


def test_hex_prefix_wins_over_identifier() -> None:
    """`0x271` 必须整体成词，不能被切成 `0` + `x271`。"""

    assert "0x271" in tokenize("值 0x271", mode="cjk_bigram")
    assert "x271" not in tokenize("值 0x271", mode="cjk_bigram")


def test_mixed_text_keeps_both_sides() -> None:
    tokens = tokenize("串口 USART 没输出", mode="cjk_bigram")
    assert "usart" in tokens
    assert "串口" in tokens
    assert "输出" in tokens


def test_punctuation_produces_no_tokens() -> None:
    assert tokenize("，。、！？（）", mode="cjk_bigram") == []


def test_unknown_tokenizer_rejected() -> None:
    with pytest.raises(ValueError, match="未知分词方式"):
        tokenize("x", mode="nope")


def test_jieba_mode_is_available() -> None:
    """jieba 是预注册的可选分词档；至少保证能跑且产出中文 token。"""

    tokens = tokenize("串口没有输出", mode="jieba")
    assert tokens
    assert any("串口" in token for token in tokens)


def test_tokenizers_listed() -> None:
    assert TOKENIZERS == ("cjk_bigram", "jieba")


# ---- BM25 ------------------------------------------------------------------


def _chunks(*texts: str) -> list[Chunk]:
    return [Chunk(path=f"doc{i}.md", order=0, text=text) for i, text in enumerate(texts, 1)]


def test_bm25_ranks_exact_match_first() -> None:
    index = Bm25Index.build(_chunks("串口 乱码 uart", "串口 无输出"), token_mode="cjk_bigram")
    ranked = index.rank_files("乱码", top_k=2)
    assert ranked[0][0] == "doc1.md"


def test_bm25_returns_empty_without_lexical_hit() -> None:
    index = Bm25Index.build(_chunks("串口 乱码"), token_mode="cjk_bigram")
    assert index.search("完全无关的词汇") == []


def test_bm25_idf_is_never_negative() -> None:
    """用 ln(1 + …) 而非经典 RSJ：后者对出现在过半文档里的词会给负 IDF。

    负 IDF 会让"常见词命中"变成扣分，在 108 个文件的小语料上很容易触发。
    """

    index = Bm25Index.build(_chunks("uart", "uart", "uart"), token_mode="cjk_bigram")
    assert index.idf("uart") > 0


def test_bm25_idf_decreases_with_document_frequency() -> None:
    index = Bm25Index.build(
        _chunks("uart 乱码", "uart", "uart", "nothing"), token_mode="cjk_bigram"
    )
    assert index.idf("乱码") > index.idf("uart")


def test_bm25_tie_broken_by_path() -> None:
    """同分时按路径字典序，不依赖插入顺序。"""

    index = Bm25Index.build(
        [Chunk("b.md", 0, "uart"), Chunk("a.md", 0, "uart")], token_mode="cjk_bigram"
    )
    assert [path for path, _ in index.rank_files("uart", top_k=2)] == ["a.md", "b.md"]


def test_bm25_file_score_is_max_chunk_score() -> None:
    chunks = [
        Chunk("a.md", 0, "uart"),
        Chunk("a.md", 1, "uart 乱码 乱码"),
        Chunk("b.md", 0, "uart"),
    ]
    index = Bm25Index.build(chunks, token_mode="cjk_bigram")
    ranked = dict(index.rank_files("乱码", top_k=2))
    assert ranked["a.md"] > 0


def test_bm25_b_zero_ignores_length_normalisation() -> None:
    """b=0 时不惩罚长文档；这是预注册网格里的一档，必须真的生效。

    长文档用**填充词**撑长、`uart` 只出现一次——与真实语料一致（一个长文件里
    提到某术语一次）。若用 `"uart " * 50`，词频也会变成 50，饱和效应会掩盖
    长度归一化的差异，测不出 b 的作用。
    """

    long_text = "uart " + "填充 内容 " * 60
    short_text = "uart"
    with_b = Bm25Index.build(
        [Chunk("long.md", 0, long_text), Chunk("short.md", 0, short_text)],
        params=Bm25Params(k1=1.5, b=1.0),
        token_mode="cjk_bigram",
    )
    without_b = Bm25Index.build(
        [Chunk("long.md", 0, long_text), Chunk("short.md", 0, short_text)],
        params=Bm25Params(k1=1.5, b=0.0),
        token_mode="cjk_bigram",
    )
    long_with = dict(with_b.rank_files("uart", top_k=2))["long.md"]
    short_with = dict(with_b.rank_files("uart", top_k=2))["short.md"]
    long_without = dict(without_b.rank_files("uart", top_k=2))["long.md"]
    short_without = dict(without_b.rank_files("uart", top_k=2))["short.md"]
    # b=1 时短文档明显占优；b=0 时两者分数相同（长度不再归一化）。
    assert short_with > long_with
    assert math.isclose(long_without, short_without, rel_tol=1e-9)


def test_bm25_params_validation() -> None:
    with pytest.raises(ValueError):
        Bm25Params(k1=-1)
    with pytest.raises(ValueError):
        Bm25Params(b=1.5)


def test_bm25_empty_index_is_safe() -> None:
    index = Bm25Index.build([], token_mode="cjk_bigram")
    assert index.idf("uart") == 0.0
    assert index.search("uart") == []


def test_bm25_avgdl_matches_mean_length() -> None:
    index = Bm25Index.build(_chunks("uart uart", "uart"), token_mode="cjk_bigram")
    assert math.isclose(index.avgdl, 1.5)
