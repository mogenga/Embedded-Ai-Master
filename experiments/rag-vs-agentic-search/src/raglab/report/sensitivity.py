"""敏感性分析：评测集来源偏差会不会抬高 C′（全语料词频）？

**被检验的威胁**（`STATUS.md`「C′ 首轮实测」已登记）：

评测集与语料由同一人撰写，因此查询用词极可能与语料用词高度重合。C′ 依赖全语料
词频，C 依赖 `index.yaml` 的人工关键词表——前者天然吃到这层重合，后者不吃。
若威胁成立，C′ 的优势里有一部分来自"同一人的用词习惯"，而非检索机制本身。

**检验方式**：按「查询 token 在语料中的覆盖率」分层，比较各层上 C′ − C 的差距。

- 若差距**随覆盖率单调下降**且低覆盖率层上差距接近 0 → 威胁足以解释全部优势；
- 若差距在低覆盖率层**收缩但仍显著** → 威胁只解释一部分，C′ 的优势另有来源；
- 若相关系数接近 0 → 覆盖率不是驱动因素，威胁的因果机制不成立。

**这不是因果推断**，是描述性分层。覆盖率与别的因素（查询长度、术语密度）也相关，
所以结论只能写成"差距在低覆盖率层收缩到 Xpp"，不能写成"威胁解释了 Y%"。
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

from ..assets import Query
from ..metrics import hit_at_k
from ..retrieval.chunking import chunk_corpus
from ..retrieval.tokenize import tokenize
from ..schemes.base import RetrievalScheme


@dataclass(frozen=True)
class CoverageSample:
    query_id: str
    coverage: float
    baseline_hit: bool
    candidate_hit: bool

    @property
    def candidate_wins(self) -> int:
        """+1 = 候选方案命中而基线未命中；-1 反之；0 = 一致。"""

        if self.candidate_hit == self.baseline_hit:
            return 0
        return 1 if self.candidate_hit else -1


@dataclass(frozen=True)
class CoverageStratum:
    label: str
    n: int
    coverage_min: float
    coverage_max: float
    baseline_rate: float
    candidate_rate: float

    @property
    def gap(self) -> float:
        return self.candidate_rate - self.baseline_rate


@dataclass
class SensitivityReport:
    vocab_size: int
    total: int
    strata: list[CoverageStratum]
    correlation: float
    note: str = ""

    def as_dict(self) -> dict[str, object]:
        return {
            "vocab_size": self.vocab_size,
            "total": self.total,
            "strata": [
                {
                    "label": stratum.label,
                    "n": stratum.n,
                    "coverage": [stratum.coverage_min, stratum.coverage_max],
                    "baseline_recall@2": stratum.baseline_rate,
                    "candidate_recall@2": stratum.candidate_rate,
                    "gap_pp": round(100 * stratum.gap, 1),
                }
                for stratum in self.strata
            ],
            "coverage_vs_win_correlation": round(self.correlation, 3),
            "note": self.note,
        }


def corpus_vocabulary(corpus_root: str | Path, *, token_mode: str = "jieba") -> set[str]:
    """全语料词表：用来算"查询用词有多少是语料里出现过的"。"""

    vocab: set[str] = set()
    for chunk in chunk_corpus(corpus_root, mode="whole_file"):
        vocab.update(tokenize(chunk.text, mode=token_mode))
    return vocab


def query_coverage(text: str, vocab: set[str], *, token_mode: str = "jieba") -> float:
    """查询中长度 ≥ 2 的 token 落在语料词表里的比例。

    只算长度 ≥ 2 的 token：单字在中文里几乎没有区分度，会把覆盖率虚抬到接近 1。
    """

    tokens = [token for token in tokenize(text, mode=token_mode) if len(token) >= 2]
    if not tokens:
        return 0.0
    return sum(1 for token in tokens if token in vocab) / len(tokens)


def _pearson(xs: Sequence[float], ys: Sequence[float]) -> float:
    n = len(xs)
    if n < 2:
        return 0.0
    mean_x = sum(xs) / n
    mean_y = sum(ys) / n
    num = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys, strict=True))
    den_x = sum((x - mean_x) ** 2 for x in xs) ** 0.5
    den_y = sum((y - mean_y) ** 2 for y in ys) ** 0.5
    return num / (den_x * den_y) if den_x and den_y else 0.0


def run_sensitivity(
    *,
    queries: Sequence[Query],
    baseline: RetrievalScheme,
    candidate: RetrievalScheme,
    vocab: set[str],
    k: int = 2,
    strata: int = 3,
) -> SensitivityReport:
    """按覆盖率分层比较两个方案；``baseline`` 通常是 C，``candidate`` 是 C′。"""

    samples: list[CoverageSample] = []
    for query in queries:
        coverage = query_coverage(query.text, vocab)
        base_result = baseline.run(query)
        cand_result = candidate.run(query)
        samples.append(
            CoverageSample(
                query_id=query.id,
                coverage=coverage,
                baseline_hit=hit_at_k(base_result.status, base_result.paths, query.gold, k),
                candidate_hit=hit_at_k(cand_result.status, cand_result.paths, query.gold, k),
            )
        )

    samples.sort(key=lambda sample: sample.coverage)
    total = len(samples)
    if total == 0:
        return SensitivityReport(vocab_size=len(vocab), total=0, strata=[], correlation=0.0)

    # 均匀切 ``strata`` 桶：先用整除定桶大小，余数均摊到前几桶。
    # 若按 ``range(0, total, size)`` 切，除不尽时会多出一个尾桶（8 条 / 3 层 → 4 桶），
    # 那样"三分位"就名不副实了。
    #
    # 切法与 `run_sensitivity_from_runs` 共用 `_split_evenly`——两处必须一致，
    # 否则两次分层的「低覆盖率层」指的不是同一批查询，数字没法对照。
    buckets = _split_evenly(samples, strata)

    labels = ["低覆盖率", "中覆盖率", "高覆盖率", "极高覆盖率"]
    rows: list[CoverageStratum] = []
    for position, bucket in enumerate(buckets):
        n = len(bucket)
        rows.append(
            CoverageStratum(
                label=labels[position] if position < len(labels) else f"第 {position + 1} 层",
                n=n,
                coverage_min=min(sample.coverage for sample in bucket),
                coverage_max=max(sample.coverage for sample in bucket),
                baseline_rate=sum(1 for s in bucket if s.baseline_hit) / n,
                candidate_rate=sum(1 for s in bucket if s.candidate_hit) / n,
            )
        )

    correlation = _pearson(
        [sample.coverage for sample in samples],
        [float(sample.candidate_wins) for sample in samples],
    )
    return SensitivityReport(
        vocab_size=len(vocab),
        total=total,
        strata=rows,
        correlation=correlation,
        note=(
            "描述性分层，非因果推断：覆盖率与查询长度、术语密度也相关，"
            "结论只能写成「差距在低覆盖率层收缩到 Xpp」"
        ),
    )


def run_sensitivity_from_runs(
    *,
    queries: Sequence[Query],
    hits_by_scheme: dict[str, dict[str, bool]],
    vocab: set[str],
    k: int = 2,
    strata: int = 3,
    reference: str = "A",
) -> MultiSchemeSensitivity:
    """**从已落盘的跑批结果**做覆盖率分层（纯离线，不重跑方案）。

    为什么要有这个版本：``run_sensitivity`` 现跑两个方案，重跑方案 B 要 1.4 小时。
    但覆盖率分层只需要「每条查询在每个方案下命中没有」——这个信息跑批时
    已经算出来并落盘了，直接读即可。

    **多方案而非两个**：要检验「B 的优势是不是同源红利」，光看 B vs A 不够，
    还得看**对照组的形态**——C′ 走词频匹配，若它呈现出「低覆盖率层塌下来、
    高覆盖率层才转正」的形态，而 B 没有，就说明这个方法确实能测出这类偏差，
    B 的「不塌」才是有意义的证据。只报 B 自己的数会缺少这个对照。
    """

    schemes = sorted(hits_by_scheme)
    usable = [
        query
        for query in queries
        if all(query.id in hits_by_scheme[scheme] for scheme in schemes)
    ]
    if not usable:
        return MultiSchemeSensitivity(
            vocab_size=len(vocab), total=0, strata=[], correlations={}
        )

    samples: list[tuple[float, dict[str, bool]]] = []
    for query in usable:
        coverage = query_coverage(query.text, vocab)
        samples.append((coverage, {s: hits_by_scheme[s][query.id] for s in schemes}))

    samples.sort(key=lambda item: item[0])
    total = len(samples)
    buckets = _split_evenly(samples, strata)
    labels = ["低覆盖率", "中覆盖率", "高覆盖率", "极高覆盖率"]

    rows: list[MultiStratum] = []
    for position, bucket in enumerate(buckets):
        n = len(bucket)
        rates = {
            scheme: sum(1 for _, hits in bucket if hits[scheme]) / n
            for scheme in schemes
        }
        rows.append(
            MultiStratum(
                label=labels[position] if position < len(labels) else f"第 {position + 1} 层",
                n=n,
                coverage_min=bucket[0][0],
                coverage_max=bucket[-1][0],
                rates=rates,
            )
        )

    correlations: dict[str, float] = {}
    for scheme in schemes:
        if scheme == reference:
            continue
        ys = []
        for _, hits in samples:
            base, other = hits[reference], hits[scheme]
            ys.append(0.0 if base == other else (1.0 if other else -1.0))
        correlations[scheme] = _pearson([c for c, _ in samples], ys)

    return MultiSchemeSensitivity(
        vocab_size=len(vocab),
        total=total,
        strata=rows,
        correlations=correlations,
        reference=reference,
        schemes=schemes,
    )


def _split_evenly(samples: list, strata: int) -> list[list]:
    """把已排序的样本均匀切成 ``strata`` 桶，余数摊到前几桶。

    与 ``run_sensitivity`` 用同一套切法——两处必须一致，否则两次分层
    的「低覆盖率层」指的不是同一批查询，数字没法对照。
    """

    total = len(samples)
    buckets: list[list] = []
    start = 0
    for position in range(strata):
        if start >= total:
            break
        remaining = strata - position
        take = max(1, (total - start) // remaining)
        buckets.append(samples[start : start + take])
        start += take
    if start < total:
        buckets[-1].extend(samples[start:])
    return buckets


@dataclass(frozen=True)
class MultiStratum:
    """一个覆盖率层里各方案的 Recall@2。"""

    label: str
    n: int
    coverage_min: float
    coverage_max: float
    rates: dict[str, float]


@dataclass
class MultiSchemeSensitivity:
    """多方案的覆盖率分层结果。"""

    vocab_size: int
    total: int
    strata: list[MultiStratum]
    correlations: dict[str, float]
    reference: str = "A"
    schemes: tuple[str, ...] = ()
    note: str = (
        "描述性分层，非因果推断：覆盖率与查询长度、术语密度也相关。"
        "结论只能写成「差距在低覆盖率层收缩到 Xpp」，不能写成「威胁解释了 Y%」。"
    )

    def as_dict(self) -> dict[str, object]:
        return {
            "reference": self.reference,
            "schemes": list(self.schemes),
            "vocab_size": self.vocab_size,
            "total": self.total,
            "strata": [
                {
                    "label": stratum.label,
                    "n": stratum.n,
                    "coverage": [stratum.coverage_min, stratum.coverage_max],
                    "recall@2": {
                        scheme: round(rate, 4) for scheme, rate in stratum.rates.items()
                    },
                    "gap_vs_reference_pp": {
                        scheme: round(100 * (rate - stratum.rates[self.reference]), 1)
                        for scheme, rate in stratum.rates.items()
                        if scheme != self.reference
                    },
                }
                for stratum in self.strata
            ],
            "coverage_vs_win_correlation": {
                scheme: round(value, 3) for scheme, value in self.correlations.items()
            },
            "note": self.note,
        }
