"""方案 C：kb-mcp 语义移植 + 统一 dispatch（§8.4、T12）。

两件事分别测：
1. **移植保真度**——用内联夹具对着 kb-mcp 的行为断言，不依赖本地语料；
2. **dispatch 三种读法**——同一份夹具上验证回退条件，确保读法可分辨。

与 kb-mcp 原件的 105 条逐条比对是人工跑的一次性核验（见 dev-notes），
不进单测：那需要 Node 侧构建产物，会让 `pytest` 依赖主仓库环境。
"""

from __future__ import annotations

from pathlib import Path

import pytest

from raglab.assets import Query
from raglab.errors import ConfigurationError
from raglab.schemes.index_grep import SchemeC
from raglab.schemes.kb_mcp import (
    KbMcpService,
    parse_index_yaml,
    score_entry,
)

INDEX = """# 夹具索引
version: 1

entries:
  - id: uart-no-output
    title: 串口无输出
    path: protocols/uart/no-output.md
    tags: [uart, serial, rs232]
    keywords: [没输出, 无输出, 收不到, 没反应]
    summary: 完全无输出或对端收不到

  - id: uart-garbled
    title: 串口乱码
    path: protocols/uart/garbled-data.md
    tags: [uart, baud]
    keywords: [乱码, garbled]
    summary: 有数据但内容是乱码

  - id: toolchain-c
    title: C 工具链
    path: system/toolchain.md
    tags: [c, toolchain]
    keywords: [c, 优化, 对齐]
    summary: C 编译器与链接脚本
"""

NO_OUTPUT = """---
name: evidence-no-output
tags: [serial]
description: '串口无输出'
---
# 串口无输出
第一行正文
UART 接线要共地
第三行正文
"""

GARBLED = "# 串口乱码\nuart 参数不一致\n"


def _build(tmp_path: Path, *, index: str = INDEX) -> Path:
    root = tmp_path / "kb"
    (root / "protocols" / "uart").mkdir(parents=True)
    (root / "system").mkdir(parents=True)
    (root / "index.yaml").write_text(index, encoding="utf-8")
    (root / "protocols" / "uart" / "no-output.md").write_text(NO_OUTPUT, encoding="utf-8")
    (root / "protocols" / "uart" / "garbled-data.md").write_text(GARBLED, encoding="utf-8")
    (root / "system" / "toolchain.md").write_text("# C 工具链\n链接脚本与优化\n", encoding="utf-8")
    return root


def _query(text: str, *, query_id: str = "idx-001", track: str = "index") -> Query:
    return Query(
        id=query_id,
        track=track,
        text=text,
        gold=("protocols/uart/no-output.md",),
        topic="protocols",
    )


# ---- index.yaml 解析：与 yaml.ts 对齐，而非 PyYAML ------------------------


def test_parse_index_reads_inline_arrays_and_summary() -> None:
    entries = parse_index_yaml(INDEX)
    assert [entry.id for entry in entries] == [
        "uart-no-output",
        "uart-garbled",
        "toolchain-c",
    ]
    assert entries[0].tags == ("uart", "serial", "rs232")
    assert entries[0].keywords[0] == "没输出"
    assert entries[0].summary == "完全无输出或对端收不到"


def test_parse_index_keeps_hash_inside_value() -> None:
    """PyYAML 会把 ` #` 当注释截断；yaml.ts 不会。summary 参与覆盖度计算，必须保留。"""

    text = (
        "entries:\n"
        "  - id: a\n"
        "    title: A\n"
        "    path: a.md\n"
        "    tags: [x]\n"
        "    keywords: [k]\n"
        "    summary: 前置 bic/and #1 之后的内容\n"
    )
    entries = parse_index_yaml(text)
    assert entries[0].summary == "前置 bic/and #1 之后的内容"

    import yaml as pyyaml

    assert pyyaml.safe_load(text)["entries"][0]["summary"] == "前置 bic/and"


def test_parse_index_rejects_missing_required_field() -> None:
    from raglab.schemes.kb_mcp import KbFormatError

    with pytest.raises(KbFormatError, match="缺少必填字段"):
        parse_index_yaml("entries:\n  - id: a\n    title: A\n")


# ---- 打分与闸门 -----------------------------------------------------------


def test_score_is_keyword_length_plus_weighted_tags() -> None:
    entries = parse_index_yaml(INDEX)
    no_output = entries[0]
    # 「串口没输出」命中「没输出」(3 字)；「uart」不在查询里。
    assert score_entry(no_output, "串口没输出") == 3


def test_single_char_ascii_token_never_matches() -> None:
    entries = parse_index_yaml(INDEX)
    toolchain = entries[2]
    # tag `c` 是单字符纯英文，按规则不参与匹配。
    assert score_entry(toolchain, "c 语言") == 0


def test_boundary_matching_rejects_substring() -> None:
    entries = parse_index_yaml(INDEX)
    garbled = entries[1]
    assert score_entry(garbled, "uartx 乱码") > 0  # 乱码命中
    assert score_entry(garbled, "uartx") == 0  # uart 不匹配 uartx


# ---- lookup：四道闸门 ------------------------------------------------------


def test_lookup_returns_top1_with_score(tmp_path: Path) -> None:
    service = KbMcpService(_build(tmp_path))
    result = service.lookup("串口没输出")
    assert result.found is True
    assert result.candidates[0].path == "protocols/uart/no-output.md"
    assert result.candidates[0].score == 3


def test_lookup_refuses_on_oov_tokens(tmp_path: Path) -> None:
    service = KbMcpService(_build(tmp_path))
    result = service.lookup("乱码 xyz")
    assert result.found is False
    assert result.reason == "low_confidence"


def test_lookup_reports_no_match_when_no_lexical_hit(tmp_path: Path) -> None:
    service = KbMcpService(_build(tmp_path))
    result = service.lookup("温度传感器漂移")
    assert result.found is False
    assert result.reason == "no_match"


def test_lookup_empty_query(tmp_path: Path) -> None:
    service = KbMcpService(_build(tmp_path))
    assert service.lookup("  ").reason == "empty_query"


def test_lookup_index_missing(tmp_path: Path) -> None:
    root = _build(tmp_path)
    (root / "index.yaml").unlink()
    assert KbMcpService(root).lookup("串口").reason == "index_missing"


# ---- search：不排除 _sources.md、不做最小长度过滤 -------------------------


def test_search_does_not_exclude_sources_file(tmp_path: Path) -> None:
    """kb-mcp 的 search 只排除 _inbox/_about/index.yaml；_sources.md 会被搜到。"""

    root = _build(tmp_path)
    (root / "_sources.md").write_text("# 来源\nUART 出处登记\n", encoding="utf-8")
    service = KbMcpService(root)
    paths = {hit.path for hit in service.search(["UART"]).hits}
    assert "_sources.md" in paths


def test_search_excludes_inbox_and_about_and_index(tmp_path: Path) -> None:
    root = _build(tmp_path)
    (root / "_inbox.md").write_text("# 收件箱\nUART 待归档\n", encoding="utf-8")
    (root / "cases").mkdir()
    (root / "cases" / "_about.md").write_text("# 关于\nUART 说明\n", encoding="utf-8")
    service = KbMcpService(root)
    paths = {hit.path for hit in service.search(["UART"]).hits}
    assert "_inbox.md" not in paths
    assert "cases/_about.md" not in paths
    assert "index.yaml" not in paths


def test_search_returns_one_based_line_with_context(tmp_path: Path) -> None:
    service = KbMcpService(_build(tmp_path))
    hits = service.search(["UART"]).hits
    hit = next(h for h in hits if h.path == "protocols/uart/no-output.md")
    assert hit.line == 8
    assert hit.text == "第一行正文\nUART 接线要共地\n第三行正文"


def test_search_single_char_token_is_kept(tmp_path: Path) -> None:
    """search 不做最小长度过滤：`i.MX` 里的 `i` 会作为搜索词（照实复现）。"""

    root = _build(tmp_path)
    (root / "reference").mkdir()
    (root / "reference" / "imx.md").write_text("i.MX RT 配置\n", encoding="utf-8")
    service = KbMcpService(root)
    hits = service.search(["i"]).hits
    assert any(hit.path == "reference/imx.md" for hit in hits)


def test_search_empty_tokens(tmp_path: Path) -> None:
    service = KbMcpService(_build(tmp_path))
    assert service.search([]).found is False
    assert service.search(["   "]).found is False


# ---- dispatch 三种读法 -----------------------------------------------------


def test_deployed_falls_back_only_when_found_is_false(tmp_path: Path) -> None:
    root = _build(tmp_path)
    # "串口没输出" 命中 → lookup 分支，不回退。
    scheme = SchemeC(corpus_root=root, dispatch_rule="deployed")
    result = scheme.run(_query("串口没输出"))
    assert result.status == "ok"
    assert result.extra["branch"] == "lookup"


def test_deployed_falls_back_to_search_on_low_confidence(tmp_path: Path) -> None:
    root = _build(tmp_path)
    scheme = SchemeC(corpus_root=root, dispatch_rule="deployed")
    # "乱码 xyz" 有词面命中但低置信 → found=False → 回退 search。
    result = scheme.run(_query("乱码 xyz"))
    assert result.extra["branch"] == "search"


def test_lexical_does_not_fall_back_when_any_score_is_positive(tmp_path: Path) -> None:
    root = _build(tmp_path)
    scheme = SchemeC(corpus_root=root, dispatch_rule="lexical")
    # 与上一条同一查询：lexical 读法看到得分 > 0，因此不回退，且会返回候选。
    result = scheme.run(_query("乱码 xyz"))
    assert result.extra["branch"] == "lookup"
    assert result.status == "ok"
    assert result.paths[0] == "protocols/uart/garbled-data.md"


def test_lookup_only_never_falls_back(tmp_path: Path) -> None:
    root = _build(tmp_path)
    scheme = SchemeC(corpus_root=root, dispatch_rule="lookup_only")
    result = scheme.run(_query("乱码 xyz"))
    assert result.extra["branch"] == "lookup"
    assert result.status == "no_match"


def test_three_rules_are_distinguishable(tmp_path: Path) -> None:
    """同一查询在三种读法下至少出现两种分支，证明读法真的可控。"""

    root = _build(tmp_path)
    branches = {
        SchemeC(corpus_root=root, dispatch_rule=rule)
        .run(_query("乱码 xyz"))
        .extra["branch"]
        for rule in ("deployed", "lexical", "lookup_only")
    }
    assert branches == {"lookup", "search"}


def test_lexical_rank_ignores_confidence_gates(tmp_path: Path) -> None:
    """`lexical_rank` 是 spec 散文的字面读法：无 OOV 折减、无 1.75 阈值。

    它不是 kb-mcp 的行为，只用于量化散文与实现的差距。
    """

    service = KbMcpService(_build(tmp_path))
    # kb-mcp 会因 OOV 折减判 low_confidence；字面读法仍返回 top-2。
    assert service.lookup("乱码 xyz").found is False
    literal = service.lexical_rank("乱码 xyz", 2)
    assert literal.found is True
    assert literal.candidates[0].path == "protocols/uart/garbled-data.md"


def test_invalid_dispatch_rule_rejected(tmp_path: Path) -> None:
    with pytest.raises(ConfigurationError, match="dispatch_rule"):
        SchemeC(corpus_root=_build(tmp_path), dispatch_rule="nope")


def test_navigation_files_filtered_at_exit(tmp_path: Path) -> None:
    """T11 在基类出口统一过滤；这里确认 C 的候选也会经过它。"""

    root = _build(tmp_path)
    (root / "_sources.md").write_text("# 来源\nUART 出处\n", encoding="utf-8")
    scheme = SchemeC(corpus_root=root, navigation_files=("_sources.md",))
    result = scheme.run(_query("乱码 xyz"))
    assert "_sources.md" not in result.paths


def test_extended_paths_recorded_for_t12(tmp_path: Path) -> None:
    root = _build(tmp_path)
    scheme = SchemeC(corpus_root=root, dispatch_rule="deployed")
    result = scheme.run(_query("乱码 xyz"))
    # 部署口径只返回 top-2，但 extended top-5 需要能从同一排序截取。
    assert "extended_paths" in result.extra
    assert len(result.paths) <= 2
