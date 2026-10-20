"""评分与汇总（spec §10）。

输入是 ``runner`` 产出的逐查询记录，输出是逐查询得分与分组汇总。
导航文件过滤已在方案出口做过（T11），这里不重复过滤，避免两处规则漂移。
"""

from __future__ import annotations

import json
from collections import defaultdict
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

from .assets import Query
from .metrics import mean, ndcg_at_k, percentile, score_query

SCORE_KS = (1, 2, 5)


@dataclass(frozen=True)
class ScoredQuery:
    """一条逐查询得分。"""

    query_id: str
    scheme: str
    track: str
    topic: str
    n_gold: int
    status: str
    recall2: bool
    recall5: bool
    hit1: bool
    mrr: float
    ndcg5: float
    latency_ms: float

    def as_row(self) -> dict[str, object]:
        return {
            "query_id": self.query_id,
            "scheme": self.scheme,
            "track": self.track,
            "topic": self.topic,
            "n_gold": self.n_gold,
            "status": self.status,
            "recall@2": self.recall2,
            "recall@5": self.recall5,
            "hit@1": self.hit1,
            "mrr": self.mrr,
            "ndcg@5": self.ndcg5,
            "latency_ms": self.latency_ms,
        }


def score_one(
    *,
    query: Query,
    scheme: str,
    status: str,
    paths: Sequence[str],
    latency_ms: float,
) -> ScoredQuery:
    """单查询评分；``status != ok`` 由 metrics 层统一记为 miss（ITT）。"""

    scores = score_query(status=status, paths=paths, gold=query.gold, ks=(2, 5))
    return ScoredQuery(
        query_id=query.id,
        scheme=scheme,
        track=query.track,
        topic=query.topic,
        n_gold=query.n_gold,
        status=status,
        recall2=bool(scores["recall@2"]),
        recall5=bool(scores["recall@5"]),
        hit1=bool(scores["hit@1"]),
        mrr=float(scores["mrr"]),
        ndcg5=ndcg_at_k(status, paths, query.gold, 5),
        latency_ms=latency_ms,
    )


def _aggregate(rows: Sequence[ScoredQuery]) -> dict[str, object]:
    if not rows:
        return {"n": 0}
    return {
        "n": len(rows),
        "recall@2": mean([1.0 if row.recall2 else 0.0 for row in rows]),
        "recall@5": mean([1.0 if row.recall5 else 0.0 for row in rows]),
        "hit@1": mean([1.0 if row.hit1 else 0.0 for row in rows]),
        "mrr": mean([row.mrr for row in rows]),
        "ndcg@5": mean([row.ndcg5 for row in rows]),
        "p50_latency_ms": percentile([row.latency_ms for row in rows], 50),
        "p95_latency_ms": percentile([row.latency_ms for row in rows], 95),
        "failure_rate": mean([0.0 if row.status == "ok" else 1.0 for row in rows]),
    }


def summarize(
    rows: Sequence[ScoredQuery],
    *,
    group_by: Sequence[str] = ("scheme",),
) -> list[dict[str, object]]:
    """按指定维度分组汇总；分组键原样回填到每一行。"""

    allowed = {"scheme", "track", "topic", "n_gold"}
    unknown = sorted(set(group_by) - allowed)
    if unknown:
        raise ValueError(f"不支持的分组维度：{unknown}")

    buckets: dict[tuple[object, ...], list[ScoredQuery]] = defaultdict(list)
    for row in rows:
        key = tuple(getattr(row, field) for field in group_by)
        buckets[key].append(row)

    summary: list[dict[str, object]] = []
    for key in sorted(buckets, key=repr):
        entry: dict[str, object] = dict(zip(group_by, key, strict=True))
        entry.update(_aggregate(buckets[key]))
        summary.append(entry)
    return summary


def read_results_jsonl(path: str | Path) -> list[dict[str, object]]:
    """读取 runner 写出的逐查询 JSONL；坏行直接失败，不跳过。"""

    records: list[dict[str, object]] = []
    with Path(path).open("r", encoding="utf-8") as handle:
        for lineno, raw in enumerate(handle, start=1):
            line = raw.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"{Path(path).name}:{lineno} 不是合法 JSON：{exc}") from exc
            if not isinstance(record, Mapping):
                raise ValueError(f"{Path(path).name}:{lineno} 顶层不是对象")
            records.append(dict(record))
    return records


def score_records(
    records: Iterable[Mapping[str, object]],
    queries: Mapping[str, Query],
) -> list[ScoredQuery]:
    """把逐查询记录评分；未知 query_id 直接失败（防止漏导入）。"""

    scored: list[ScoredQuery] = []
    for record in records:
        query_id = str(record.get("query_id"))
        query = queries.get(query_id)
        if query is None:
            raise ValueError(f"结果中的 query_id 不在查询集内：{query_id!r}")
        candidates = record.get("candidates") or []
        if not isinstance(candidates, list):
            raise ValueError(f"{query_id} 的 candidates 不是数组")
        paths = [
            str(item.get("path"))
            for item in candidates
            if isinstance(item, Mapping) and item.get("path") is not None
        ]
        scored.append(
            score_one(
                query=query,
                scheme=str(record.get("scheme", "?")),
                status=str(record.get("status", "error")),
                paths=paths,
                latency_ms=float(record.get("latency_ms", 0.0) or 0.0),
            )
        )
    return scored
