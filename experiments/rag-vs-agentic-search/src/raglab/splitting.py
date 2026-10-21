"""dev/test 分层切分（spec §7.4）。

纯函数、固定 seed、可复现。按 ``track × topic × n_gold`` 分层，
每层内按 seed 洗牌后按比例分配；单条层整层进 dev（避免产生空 test 侧的小样本噪声）。
"""

from __future__ import annotations

import random
from collections import defaultdict
from collections.abc import Iterable, Sequence

from .assets import Query, Split

DEFAULT_DEV_RATIO = 0.7
DEFAULT_STRATIFY_BY = ("track", "topic", "n_gold")


def _stratum_key(query: Query, stratify_by: Sequence[str]) -> tuple[object, ...]:
    values: list[object] = []
    for field in stratify_by:
        if field == "n_gold":
            values.append(query.n_gold)
        elif field == "track":
            values.append(query.track)
        elif field == "topic":
            values.append(query.topic)
        else:
            raise ValueError(f"不支持的分层字段：{field!r}")
    return tuple(values)


def stratified_split(
    queries: Iterable[Query],
    *,
    seed: int,
    dev_ratio: float = DEFAULT_DEV_RATIO,
    stratify_by: Sequence[str] = DEFAULT_STRATIFY_BY,
) -> Split:
    """按分层比例切分；同一 seed 与同一输入必然得到同一结果。"""

    if not 0 < dev_ratio < 1:
        raise ValueError("dev_ratio 必须在 (0, 1) 区间")

    ordered = sorted(queries, key=lambda query: query.id)
    if not ordered:
        raise ValueError("查询集为空，无法切分")
    if len({query.id for query in ordered}) != len(ordered):
        raise ValueError("查询 id 重复，拒绝切分")

    strata: dict[tuple[object, ...], list[str]] = defaultdict(list)
    for query in ordered:
        strata[_stratum_key(query, stratify_by)].append(query.id)

    rng = random.Random(seed)
    dev: list[str] = []
    test: list[str] = []
    for key in sorted(strata, key=repr):
        ids = strata[key]
        rng.shuffle(ids)
        if len(ids) == 1:
            dev.append(ids[0])
            continue
        n_dev = max(1, min(len(ids) - 1, round(len(ids) * dev_ratio)))
        dev.extend(ids[:n_dev])
        test.extend(ids[n_dev:])

    if not test:
        raise ValueError("切分后 test 为空：查询量或分层过细，无法形成有效偏差检查集")

    return Split(
        seed=seed,
        stratify_by=tuple(stratify_by),
        dev=tuple(sorted(dev)),
        test=tuple(sorted(test)),
    )


def split_to_record(split: Split) -> dict[str, object]:
    """序列化为 ``splits.json`` 的内容。"""

    return {
        "seed": split.seed,
        "stratify_by": list(split.stratify_by),
        "dev": list(split.dev),
        "test": list(split.test),
    }
