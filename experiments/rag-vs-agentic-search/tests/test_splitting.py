"""分层切分（spec §7.4）。"""

from __future__ import annotations

import pytest

from raglab.assets import Query
from raglab.splitting import split_to_record, stratified_split


def _query(index: int, *, track: str = "index", topic: str = "protocols", gold_count: int = 1) -> Query:
    return Query(
        id=f"idx-{index:03d}",
        track=track,
        text=f"查询 {index}",
        gold=tuple(f"protocols/f{offset}.md" for offset in range(gold_count)),
        topic=topic,
    )


def _many(count: int) -> list[Query]:
    return [_query(index) for index in range(1, count + 1)]


def test_split_is_deterministic_for_same_seed() -> None:
    first = stratified_split(_many(40), seed=20261019)
    second = stratified_split(_many(40), seed=20261019)
    assert first == second


def test_different_seed_changes_assignment() -> None:
    first = stratified_split(_many(40), seed=1)
    second = stratified_split(_many(40), seed=2)
    assert (first.dev, first.test) != (second.dev, second.test)


def test_split_covers_all_queries_without_overlap() -> None:
    split = stratified_split(_many(50), seed=7)
    assigned = list(split.dev) + list(split.test)
    assert len(assigned) == len(set(assigned)) == 50
    assert set(assigned) == {query.id for query in _many(50)}


def test_split_respects_ratio_roughly() -> None:
    split = stratified_split(_many(100), seed=3)
    ratio = len(split.dev) / (len(split.dev) + len(split.test))
    assert 0.6 < ratio < 0.8


def test_single_item_stratum_goes_to_dev() -> None:
    queries = [
        _query(1, topic="protocols"),
        _query(2, topic="protocols"),
        _query(3, topic="rtos"),
    ]
    split = stratified_split(queries, seed=5)
    assert "idx-003" in split.dev
    assert "idx-003" not in split.test


def test_split_rejects_empty_and_duplicates() -> None:
    with pytest.raises(ValueError):
        stratified_split([], seed=1)
    duplicate = _query(1)
    with pytest.raises(ValueError):
        stratified_split([duplicate, duplicate], seed=1)


def test_split_rejects_invalid_ratio_and_field() -> None:
    with pytest.raises(ValueError):
        stratified_split(_many(10), seed=1, dev_ratio=1.5)
    with pytest.raises(ValueError):
        stratified_split(_many(10), seed=1, stratify_by=("unknown",))


def test_split_fails_when_test_would_be_empty() -> None:
    with pytest.raises(ValueError):
        stratified_split([_query(1, topic="rtos")], seed=1)


def test_split_to_record_is_json_ready() -> None:
    record = split_to_record(stratified_split(_many(20), seed=9))
    assert set(record) == {"seed", "stratify_by", "dev", "test"}
    assert isinstance(record["dev"], list)
