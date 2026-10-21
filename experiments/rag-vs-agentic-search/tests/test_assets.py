"""资产 schema 与 G0 交叉校验（spec §7.2、§7.3）。"""

from __future__ import annotations

from pathlib import Path

import pytest

from raglab.assets import (
    AssetError,
    duplicate_query_texts,
    missing_gold_paths,
    negative_gold_conflicts,
    parse_negative,
    parse_perturbation,
    parse_query,
    parse_split,
    perturbation_base_violations,
    query_leaks_path,
    split_violations,
)


def _query(**overrides: object) -> dict[str, object]:
    record: dict[str, object] = {
        "id": "idx-001",
        "track": "index",
        "text": "串口收不到数据但发送正常",
        "gold": ["protocols/uart-no-rx.md"],
        "topic": "protocols",
        "lang": "zh",
        "source": "regression.py",
    }
    record.update(overrides)
    return record


def test_parse_query_accepts_valid_record() -> None:
    query = parse_query(_query())
    assert query.id == "idx-001"
    assert query.n_gold == 1


@pytest.mark.parametrize(
    "overrides",
    [
        {"id": "001"},
        {"track": "unknown"},
        {"topic": "ui"},
        {"text": "   "},
        {"gold": []},
        {"gold": ["../escape.md"]},
        {"gold": ["a.md", "a.md"]},
        {"source": "guess"},
    ],
)
def test_parse_query_rejects_invalid(overrides: dict[str, object]) -> None:
    with pytest.raises(AssetError):
        parse_query(_query(**overrides))


def test_parse_query_requires_min_three_digit_id() -> None:
    with pytest.raises(AssetError):
        parse_query(_query(id="idx-01"))


def test_parse_perturbation_rejects_unknown_kind() -> None:
    record = {
        "id": "syn-014",
        "base_id": "idx-014",
        "kind": "paraphrase",
        "text": "串口没有收到数据",
        "generator": "human",
        "reviewed": True,
    }
    with pytest.raises(AssetError):
        parse_perturbation(record)


def test_parse_negative_requires_bool_near_domain() -> None:
    with pytest.raises(AssetError):
        parse_negative(
            {"id": "neg-001", "text": "x", "reason": "y", "near_domain": "yes"}
        )


def test_parse_split_rejects_overlap_and_duplicates() -> None:
    with pytest.raises(AssetError):
        parse_split({"seed": 1, "stratify_by": [], "dev": ["a"], "test": ["a"]})
    with pytest.raises(AssetError):
        parse_split({"seed": 1, "stratify_by": [], "dev": ["a"], "test": ["b", "b"]})


def test_duplicate_query_texts_ignores_whitespace() -> None:
    first = parse_query(_query())
    second = parse_query(_query(id="idx-002", text="串口收不到数据但发送正常  "))
    assert duplicate_query_texts([first, second]) == [("idx-001", "idx-002")]


def test_missing_gold_paths_reports_absent_files(tmp_path: Path) -> None:
    (tmp_path / "protocols").mkdir()
    (tmp_path / "protocols" / "uart-no-rx.md").write_text("ok", encoding="utf-8")
    present = parse_query(_query())
    absent = parse_query(_query(id="idx-002", gold=["protocols/nope.md"]))
    assert missing_gold_paths([present, absent], tmp_path) == ["protocols/nope.md"]


def test_missing_gold_paths_returns_all_absent(tmp_path: Path) -> None:
    absent = parse_query(_query())
    assert missing_gold_paths([absent], tmp_path) == ["protocols/uart-no-rx.md"]


def test_missing_gold_paths_treats_escape_as_missing(tmp_path: Path) -> None:
    escaped = parse_query(_query(gold=["protocols/a.md"]))
    # parse 层已拒绝 ..，这里构造一个越界候选以验证第二道防线的行为。
    object.__setattr__(escaped, "gold", ("../outside.md",))
    assert missing_gold_paths([escaped], tmp_path) == ["../outside.md"]


def test_query_leaks_path_detects_name_substring() -> None:
    leaked = query_leaks_path("看看 uart-no-rx.md 有没有", ["protocols/uart-no-rx.md"])
    assert leaked == ["protocols/uart-no-rx.md"]
    assert query_leaks_path("串口收不到数据", ["protocols/uart-no-rx.md"]) == []


def test_split_violations_detects_missing_and_unknown() -> None:
    queries = [parse_query(_query()), parse_query(_query(id="idx-002"))]
    split = parse_split({"seed": 1, "stratify_by": [], "dev": ["idx-001"], "test": ["idx-999"]})
    problems = split_violations(split, queries)
    assert any("未知" in problem for problem in problems)
    assert any("遗漏" in problem for problem in problems)


def test_perturbation_base_must_be_in_split() -> None:
    split = parse_split({"seed": 1, "stratify_by": [], "dev": ["idx-001"], "test": ["idx-002"]})
    perturbation = parse_perturbation(
        {
            "id": "syn-001",
            "base_id": "idx-404",
            "kind": "typo",
            "text": "x",
            "generator": "human",
            "reviewed": True,
        }
    )
    assert perturbation_base_violations([perturbation], split)


def test_negative_conflicts_with_query_text() -> None:
    query = parse_query(_query())
    negative = parse_negative(
        {"id": "neg-001", "text": "串口收不到数据但发送正常", "reason": "x", "near_domain": True}
    )
    assert negative_gold_conflicts([negative], [query]) == ["neg-001"]
