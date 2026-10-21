"""方案 C′：BM25 + grep 复核（§8.5）。

重点测**grep 复核不越权**：它只能打破近分并列，不能把 top-5 之外的块拉进候选。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from raglab.assets import Query
from raglab.schemes.bm25_grep import SchemeCPrime

INDEX_NAV = ("_sources.md",)


def _corpus(tmp_path: Path) -> Path:
    root = tmp_path / "kb"
    (root / "protocols").mkdir(parents=True, exist_ok=True)
    (root / "protocols" / "uart.md").write_text(
        "# 串口无输出\n串口完全没输出，检查接线共地。\n", encoding="utf-8"
    )
    (root / "protocols" / "garbled.md").write_text(
        "# 串口乱码\n波特率不对时会出现乱码。\n", encoding="utf-8"
    )
    (root / "reference" / "regs.md").parent.mkdir(parents=True, exist_ok=True)
    (root / "reference" / "regs.md").write_text(
        "# 寄存器\nUSART_BRR 值 0x271 反推 PCLK2 时钟。\n", encoding="utf-8"
    )
    (root / "_sources.md").write_text("# 来源\n串口资料出处。\n", encoding="utf-8")
    return root


def _query(text: str, *, track: str = "index") -> Query:
    return Query(
        id="idx-001", track=track, text=text, gold=("protocols/uart.md",), topic="protocols"
    )


def test_retrieves_matching_file(tmp_path: Path) -> None:
    scheme = SchemeCPrime(corpus_root=_corpus(tmp_path), navigation_files=INDEX_NAV)
    result = scheme.run(_query("串口没输出"))
    assert result.status == "ok"
    assert "protocols/uart.md" in result.paths


def test_exact_token_query_hits_register_file(tmp_path: Path) -> None:
    scheme = SchemeCPrime(corpus_root=_corpus(tmp_path), navigation_files=INDEX_NAV)
    result = scheme.run(_query("USART_BRR 0x271 怎么反推 PCLK2", track="search"))
    assert "reference/regs.md" in result.paths


def test_no_lexical_hit_returns_no_match(tmp_path: Path) -> None:
    """没有任何 token 命中时必须是 no_match，不得返回空候选冒充成功。

    注意 bigram 分词下"部分字重合"就足以产生命中，所以这里用一组与夹具语料
    完全不共享二元组的词。
    """

    scheme = SchemeCPrime(corpus_root=_corpus(tmp_path), navigation_files=INDEX_NAV)
    result = scheme.run(_query("量子纠缠拓扑绝缘体"))
    assert result.status == "no_match"
    assert result.paths == ()


def test_navigation_files_never_retrieved(tmp_path: Path) -> None:
    """导航文件不进索引，因此不占候选名额（与 C 的"先返回再过滤"不同）。"""

    scheme = SchemeCPrime(corpus_root=_corpus(tmp_path), navigation_files=INDEX_NAV)
    result = scheme.run(_query("串口资料出处"))
    assert "_sources.md" not in result.paths
    assert scheme.stats["files"] == 3  # 4 个 md 减去 1 个导航文件


def test_top_k_limits_candidates(tmp_path: Path) -> None:
    root = _corpus(tmp_path)
    for index in range(8):
        (root / "protocols" / f"x{index}.md").write_text(
            "# 串口\n串口没输出\n", encoding="utf-8"
        )
    scheme = SchemeCPrime(corpus_root=root, navigation_files=INDEX_NAV, top_k=3)
    result = scheme.run(_query("串口没输出"))
    assert len(result.paths) <= 3


def test_chunking_and_tokenizer_recorded_in_extra(tmp_path: Path) -> None:
    scheme = SchemeCPrime(
        corpus_root=_corpus(tmp_path),
        navigation_files=INDEX_NAV,
        chunking="whole_file",
        tokenizer="jieba",
    )
    result = scheme.run(_query("串口没输出"))
    assert result.extra["chunking"] == "whole_file"
    assert result.extra["tokenizer"] == "jieba"


def test_grep_review_does_not_promote_beyond_top_k(tmp_path: Path) -> None:
    """grep 复核只调整分数，不得把前 top_k 之外的块拉进候选（预注册要求）。"""

    root = _corpus(tmp_path)
    # 造 6 个弱命中文件；top_k=2，则另外 4 个即便含精确 token 也不该出现。
    for index in range(6):
        (root / "weak").mkdir(exist_ok=True)
        (root / "weak" / f"w{index}.md").write_text(
            "# 弱\n串口 DELAY_MS 描述\n", encoding="utf-8"
        )
    scheme = SchemeCPrime(
        corpus_root=root, navigation_files=INDEX_NAV, top_k=2, grep_review_top_n=20
    )
    result = scheme.run(_query("串口 DELAY_MS", track="search"))
    assert len(result.paths) <= 2


def test_grep_review_can_be_disabled(tmp_path: Path) -> None:
    """消融档：关掉复核后仍能跑，只是不再加小分。"""

    scheme = SchemeCPrime(
        corpus_root=_corpus(tmp_path),
        navigation_files=INDEX_NAV,
        enable_grep_review=False,
    )
    result = scheme.run(_query("串口 USART_BRR 0x271", track="search"))
    assert result.extra["grep_tokens"] >= 1
    assert "grep_reviewed_chunks" not in result.extra


def test_single_char_tokens_ignored_by_grep(tmp_path: Path) -> None:
    """grep 复核只认长度 ≥ 2 的精确 token；`i.MX` 里的 `i` 不参与。

    这与方案 C 的 `kb_search` **刻意不同**：C 会在 search 分支保留单字符 token
    （`i` 真的成为搜索词），C′ 的复核只用来打破并列，不该被一个字母干扰。
    """

    scheme = SchemeCPrime(corpus_root=_corpus(tmp_path), navigation_files=INDEX_NAV)
    result = scheme.run(_query("i.MX 串口"))
    # 只剩 "mx"；`i` 被丢弃。
    assert result.extra["grep_tokens"] == 1


@pytest.mark.parametrize("chunking", ["whole_file", "section"])
def test_both_chunking_modes_run(tmp_path: Path, chunking: str) -> None:
    scheme = SchemeCPrime(
        corpus_root=_corpus(tmp_path), navigation_files=INDEX_NAV, chunking=chunking
    )
    assert scheme.run(_query("串口没输出")).status in {"ok", "no_match"}


def test_both_tokenizers_run(tmp_path: Path) -> None:
    for tokenizer in ("cjk_bigram", "jieba"):
        scheme = SchemeCPrime(
            corpus_root=_corpus(tmp_path), navigation_files=INDEX_NAV, tokenizer=tokenizer
        )
        assert scheme.run(_query("串口没输出")).paths


def test_result_scores_are_descending(tmp_path: Path) -> None:
    root = _corpus(tmp_path)
    for index in range(4):
        (root / "protocols" / f"y{index}.md").write_text("# 串口\n串口\n", encoding="utf-8")
    scheme = SchemeCPrime(corpus_root=root, navigation_files=INDEX_NAV, top_k=4)
    result = scheme.run(_query("串口没输出"))
    scores = [candidate.score for candidate in result.candidates]
    assert scores == sorted(scores, reverse=True)
