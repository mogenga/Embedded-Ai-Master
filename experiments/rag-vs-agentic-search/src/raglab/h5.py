"""H5 判据的判定（spec §8.6）。

D 只在 H5 有信号时运行。**判据必须可复算**，所以判定逻辑放在代码里，
而不是每次靠人回忆。三条判据任意一条成立即有信号。

- 判据 1：A 与 B 在两类查询上的 Recall@2 差距方向相反，且两侧差距均 ≥ 5pp。
  **需要 B 的分轨数据**；B 没跑全量时返回"数据不足"，不是"不满足"——
  这两种结论性质不同，混为一谈就是事后凑判据。
- 判据 2：某方案在某类查询上比该类最优方案低 ≥ 10pp，且其 95% CI 上界
  仍低于最优方案的点估计。
- 判据 3：任一方案在某类查询上 `status != ok` 比例 ≥ 10%，而另一方案 < 3%。
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .assets import Query
from .metrics import hit_at_k
from .stats import paired_bootstrap_ci

# 项目根（config/ 与 corpus/ 的父目录）。与 __main__.py 的定义同源。
PROJECT_ROOT = Path(__file__).resolve().parents[2]

TRACKS = ("index", "search")
CRITERION1_MIN_GAP_PP = 5.0
CRITERION2_MIN_GAP_PP = 10.0
CRITERION3_MIN_NOT_OK = 0.10
CRITERION3_OTHER_MAX = 0.03


@dataclass
class CriterionResult:
    """一条判据的判定结果。"""

    name: str
    satisfied: bool
    detail: str
    insufficient_data: bool = False


@dataclass
class H5Result:
    criteria: list[CriterionResult] = field(default_factory=list)

    @property
    def signal(self) -> bool:
        """有信号 = 至少一条判据成立；数据不足的判据不算成立。"""

        return any(item.satisfied for item in self.criteria)

    def as_dict(self) -> dict[str, Any]:
        return {
            "signal": self.signal,
            "criteria": [
                {
                    "name": item.name,
                    "satisfied": item.satisfied,
                    "insufficient_data": item.insufficient_data,
                    "detail": item.detail,
                }
                for item in self.criteria
            ],
        }


def _per_query_hits(
    scheme, queries: Sequence[Query]
) -> tuple[list[float], float]:
    """返回 (逐查询命中 0/1 列表, status != ok 的比例)。"""

    hits: list[float] = []
    not_ok = 0
    for query in queries:
        result = scheme.run(query)
        if result.status != "ok":
            not_ok += 1
        hits.append(1.0 if hit_at_k(result.status, result.paths, query.gold, 2) else 0.0)
    return hits, not_ok / len(hits) if hits else 0.0


def evaluate_criterion3(
    *, schemes: dict[str, Any], queries: Sequence[Query]
) -> CriterionResult:
    """判据 3：任一方案在某类查询上 not_ok ≥ 10%，而另一方案 < 3%。"""

    for track in TRACKS:
        rows = [query for query in queries if query.track == track]
        if not rows:
            continue
        rates: dict[str, float] = {}
        for name, scheme in schemes.items():
            _, not_ok = _per_query_hits(scheme, rows)
            rates[name] = not_ok
        for name, rate in rates.items():
            if rate < CRITERION3_MIN_NOT_OK:
                continue
            others = [
                other for other, other_rate in rates.items()
                if other != name and other_rate < CRITERION3_OTHER_MAX
            ]
            if others:
                return CriterionResult(
                    name="判据 3",
                    satisfied=True,
                    detail=(
                        f"{track} 轨：{name} 的 status!=ok 比例 {rate:.1%} ≥ 10%，"
                        f"而 {', '.join(others)} < 3%"
                    ),
                )
    return CriterionResult(
        name="判据 3",
        satisfied=False,
        detail="各轨各方案均未出现「某方案 not_ok ≥ 10% 而另一方案 < 3%」的组合",
    )


def evaluate_criterion2(
    *, schemes: dict[str, Any], queries: Sequence[Query]
) -> CriterionResult:
    """判据 2：某方案比该类最优低 ≥ 10pp，且其 95% CI 上界仍低于最优的点估计。"""

    for track in TRACKS:
        rows = [query for query in queries if query.track == track]
        if len(rows) < 2:
            continue
        hits: dict[str, list[float]] = {}
        for name, scheme in schemes.items():
            values, _ = _per_query_hits(scheme, rows)
            hits[name] = values
        best = max(hits, key=lambda key: sum(hits[key]))
        best_point = sum(hits[best]) / len(rows)
        for name, values in hits.items():
            if name == best:
                continue
            point = sum(values) / len(rows)
            gap_pp = 100 * (point - best_point)
            if gap_pp > -CRITERION2_MIN_GAP_PP:
                continue
            # 该方案 vs 最优方案的配对 bootstrap：看差值的 CI 上界是否仍低于 0。
            low, high = paired_bootstrap_ci(
                values, hits[best], n_resamples=10000
            )
            diff_high_pp = 100 * high
            if diff_high_pp < 0:
                return CriterionResult(
                    name="判据 2",
                    satisfied=True,
                    detail=(
                        f"{track} 轨：{name} 比最优 {best} 低 {abs(gap_pp):.1f}pp，"
                        f"且差值 95% CI 上界 {diff_high_pp:+.1f}pp 仍低于 0"
                    ),
                )
    return CriterionResult(
        name="判据 2",
        satisfied=False,
        detail="各轨各方案均未出现「低于最优 ≥ 10pp 且 CI 上界仍为负」的组合",
    )


def evaluate_criterion1(
    *, a_hits_by_track: dict[str, list[float]] | None,
    b_hits_by_track: dict[str, list[float]] | None,
) -> CriterionResult:
    """判据 1：A 与 B 的差距方向相反，且两侧差距均 ≥ 5pp。

    A 或 B 的分轨数据缺失时返回"数据不足"——**不是"不满足"**。
    """

    if not a_hits_by_track or not b_hits_by_track:
        missing = []
        if not a_hits_by_track:
            missing.append("A")
        if not b_hits_by_track:
            missing.append("B")
        return CriterionResult(
            name="判据 1",
            satisfied=False,
            insufficient_data=True,
            detail=f"{'、'.join(missing)} 的分轨数据缺失，无法判定（≠ 不满足）",
        )

    gaps: dict[str, float] = {}
    for track in TRACKS:
        a_values = a_hits_by_track.get(track)
        b_values = b_hits_by_track.get(track)
        if not a_values or not b_values:
            return CriterionResult(
                name="判据 1",
                satisfied=False,
                insufficient_data=True,
                detail=f"{track} 轨数据缺失，无法判定（≠ 不满足）",
            )
        gaps[track] = 100 * (sum(a_values) / len(a_values) - sum(b_values) / len(b_values))

    if len(gaps) < 2:
        return CriterionResult(
            name="判据 1", satisfied=False, insufficient_data=True, detail="轨数不足，无法判定"
        )
    values = list(gaps.values())
    opposite = (values[0] > 0) != (values[1] > 0)
    big_enough = all(abs(value) >= CRITERION1_MIN_GAP_PP for value in values)
    if opposite and big_enough:
        return CriterionResult(
            name="判据 1",
            satisfied=True,
            detail=(
                "、".join(f"{track} 轨 A−B {gaps[track]:+.1f}pp" for track in TRACKS)
                + "：方向相反且两侧差距均 ≥ 5pp"
            ),
        )
    return CriterionResult(
        name="判据 1",
        satisfied=False,
        detail=(
            "、".join(f"{track} 轨 A−B {gaps[track]:+.1f}pp" for track in TRACKS)
            + "：未同时满足「方向相反」与「两侧 ≥ 5pp」"
        ),
    )


def evaluate_h5(
    *,
    schemes: dict[str, Any],
    queries: Sequence[Query],
    a_hits_by_track: dict[str, list[float]] | None = None,
    b_hits_by_track: dict[str, list[float]] | None = None,
) -> H5Result:
    """判定 H5 是否有信号。"""

    return H5Result(
        criteria=[
            evaluate_criterion1(a_hits_by_track=a_hits_by_track, b_hits_by_track=b_hits_by_track),
            evaluate_criterion2(schemes=schemes, queries=queries),
            evaluate_criterion3(schemes=schemes, queries=queries),
        ]
    )


def h5_signal(config, corpus_dir: Path) -> bool:
    """CLI 用的便捷入口：构造可用的方案并判定 H5。"""

    from .intake import load_queries
    from .schemes.bm25_grep import SchemeCPrime
    from .schemes.index_grep import SchemeC

    queries, report = load_queries(PROJECT_ROOT / config.data_dir)
    if not report.ok:
        raise BlockedError("查询集导入失败，无法判定 H5")

    navigation = config.navigation_files
    schemes = {
        "C": SchemeC(corpus_root=corpus_dir, navigation_files=navigation, dispatch_rule="deployed"),
        "C′": SchemeCPrime(
            corpus_root=corpus_dir,
            navigation_files=navigation,
            chunking="whole_file",
            tokenizer="jieba",
            k1=0.9,
            b=0.75,
        ),
    }
    result = evaluate_h5(schemes=schemes, queries=queries)
    return result.signal
