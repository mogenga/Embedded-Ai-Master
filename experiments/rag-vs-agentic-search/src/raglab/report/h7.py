"""H7：负样本的拒答能力分析（spec §7.7、§10.1）。

三个指标：

- **假候选率**：负样本里返回了候选（且无一为 gold）的占比。**越低越好**。
- **正确拒答率**：负样本里显式 `no_match` 或分数低于阈值的占比。**越高越好**。
- **AUROC**：用"正查询的最高分"与"负查询的最高分"区分内外的���力。

**两处容易出错的**：

1. **阈值只在 dev 负样本上选**（§7.7）：固定规则"使 dev 正确拒答率 ≥ 80% 的最低阈值"。
   本模块的 `select_threshold` 就是这个规则的实现。**没有阈值时，正确拒答率只认
   显式 `no_match`**——不拿"分数低"当拒绝，否则等于用数据凑门槛。
2. **AUROC 的正样本分数来自全部查询**（不只是命中的）。负查询记 0 分（§10.1），
   这样"负样本返回低分候选"与"负样本拒答"就区分开了。
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field

from ..assets import Negative, Query
from ..metrics import auroc, is_correct_refusal, is_false_candidate

# §7.7：阈值选择规则固定为"使 dev 正确拒答率 ≥ 80% 的最低阈值"。
TARGET_REFUSAL_RATE = 0.80


@dataclass
class NegativeOutcome:
    """一条负样本的结果。"""

    negative_id: str
    status: str
    candidate_count: int
    top_score: float
    false_candidate: bool
    correct_refusal: bool
    near_domain: bool = False


@dataclass
class H7Result:
    """一个方案在负样本上的表现。"""

    scheme: str
    total: int
    false_candidates: int
    correct_refusals: int
    threshold: float | None = None
    positives: list[float] = field(default_factory=list)
    negatives: list[float] = field(default_factory=list)
    outcomes: list[NegativeOutcome] = field(default_factory=list)

    @property
    def false_candidate_rate(self) -> float:
        return self.false_candidates / self.total if self.total else 0.0

    @property
    def correct_refusal_rate(self) -> float:
        return self.correct_refusals / self.total if self.total else 0.0

    @property
    def auroc_value(self) -> float | None:
        return auroc(self.positives, self.negatives)

    def as_dict(self) -> dict[str, object]:
        return {
            "scheme": self.scheme,
            "total": self.total,
            "false_candidates": self.false_candidates,
            "false_candidate_rate": round(self.false_candidate_rate, 4),
            "correct_refusals": self.correct_refusals,
            "correct_refusal_rate": round(self.correct_refusal_rate, 4),
            "threshold": self.threshold,
            "auroc": None if self.auroc_value is None else round(self.auroc_value, 4),
        }


def collect_negative_outcomes(
    *,
    scheme: str,
    negatives: Sequence[Negative],
    run_negative,
    threshold: float | None = None,
) -> H7Result:
    """跑负样本并统计。

    ``run_negative(negative) -> (status, scores, candidate_count)`` 由调用方注入，
    便于离线测试。
    """

    outcomes: list[NegativeOutcome] = []
    for negative in negatives:
        status, scores, candidate_count = run_negative(negative)
        false_candidate = is_false_candidate(status, candidate_count)
        correct = is_correct_refusal(status, list(scores), threshold)
        outcomes.append(
            NegativeOutcome(
                negative_id=negative.id,
                status=status,
                candidate_count=candidate_count,
                top_score=max(scores) if scores else 0.0,
                false_candidate=false_candidate,
                correct_refusal=correct,
                near_domain=negative.near_domain,
            )
        )
    return H7Result(
        scheme=scheme,
        total=len(outcomes),
        false_candidates=sum(1 for item in outcomes if item.false_candidate),
        correct_refusals=sum(1 for item in outcomes if item.correct_refusal),
        threshold=threshold,
        negatives=[item.top_score for item in outcomes],
        outcomes=outcomes,
    )


def collect_positive_scores(
    *,
    scheme: str,
    queries: Sequence[Query],
    run_query,
) -> list[float]:
    """正查询的最高候选分数（用于 AUROC）。没有候选记 0。"""

    scores: list[float] = []
    for query in queries:
        _, candidate_scores, _ = run_query(query)
        scores.append(max(candidate_scores) if candidate_scores else 0.0)
    return scores


def select_threshold(
    scores: Sequence[float],
    *,
    target_rate: float = TARGET_REFUSAL_RATE,
) -> float | None:
    """选出使正确拒答率 ≥ 目标的**最低**阈值（§7.7）。

    规则是"最低阈值"——它让拒答尽可能少发生，只在必要时拒答。实现上：
    把候选阈值从低到高试，取第一个满足目标率的。

    分数都低于任何合理阈值时返回 None（表示"只能靠显式 no_match 拒答"）。
    """

    if not scores:
        return None
    unique = sorted(set(scores))
    for candidate in unique:
        # 阈值取 candidate 时，分数 < candidate 的算拒答。
        refusal = sum(1 for score in scores if score < candidate) / len(scores)
        if refusal >= target_rate:
            return candidate
    # 最高阈值之上没有分数，达不到目标。
    return None


def evaluate_h7(
    *,
    scheme: str,
    queries: Sequence[Query],
    negatives: Sequence[Negative],
    run_query,
    run_negative,
    dev_negative_ids: Sequence[str] | None = None,
    threshold: float | None = None,
) -> tuple[H7Result, list[float]]:
    """完整的 H7 评估：可选在 dev 负样本上选阈值，再在全部负样本上评估。

    ``dev_negative_ids`` 给出 dev 负样本的 id；阈值只在它们上选（§7.7），
    然后应用到全部负样本。``threshold`` 显式给出时跳过选择。
    """

    positives = collect_positive_scores(
        scheme=scheme, queries=queries, run_query=run_query
    )

    if threshold is None and dev_negative_ids:
        dev_scores: list[float] = []
        wanted = set(dev_negative_ids)
        for negative in negatives:
            if negative.id not in wanted:
                continue
            _, scores, _ = run_negative(negative)
            dev_scores.append(max(scores) if scores else 0.0)
        threshold = select_threshold(dev_scores)

    result = collect_negative_outcomes(
        scheme=scheme,
        negatives=negatives,
        run_negative=run_negative,
        threshold=threshold,
    )
    result.positives = positives
    return result, positives
