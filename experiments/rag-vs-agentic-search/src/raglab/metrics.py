"""检索指标（spec §10.1）。

本模块只做纯计算：输入是状态、候选路径（已按方案自身排序）与 gold，输出指标值。
不做排序、不做过滤——导航文件过滤与并列打破由方案在产出候选前完成（T11 / §8.1）。
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Sequence

# 统一输出契约的状态（§8.1）。非 ok 一律按 ITT 计 miss。
VALID_STATUSES = ("ok", "no_match", "error", "timeout")


def _scoring_paths(status: str, paths: Sequence[str]) -> tuple[str, ...]:
    """ITT：非 ok 的查询不产生可计分候选。"""

    if status not in VALID_STATUSES:
        raise ValueError(f"未知状态：{status!r}")
    return tuple(paths) if status == "ok" else ()


def hit_at_k(status: str, paths: Sequence[str], gold: Iterable[str], k: int) -> bool:
    """Recall@k 的二值命中：top-k 与 gold 的交集数 ≥ min(k, |gold|)。"""

    if k <= 0:
        raise ValueError("k 必须为正整数")
    gold_set = set(gold)
    if not gold_set:
        raise ValueError("gold 不能为空")
    top = _scoring_paths(status, paths)[:k]
    return len(gold_set.intersection(top)) >= min(k, len(gold_set))


def recall_fraction(status: str, paths: Sequence[str], gold: Iterable[str], k: int) -> float:
    """分数型召回（辅助指标）：top-k 命中的 gold 数 / |gold|。"""

    gold_set = set(gold)
    if not gold_set:
        raise ValueError("gold 不能为空")
    top = _scoring_paths(status, paths)[:k]
    return len(gold_set.intersection(top)) / len(gold_set)


def reciprocal_rank(status: str, paths: Sequence[str], gold: Iterable[str]) -> float:
    """首个 gold 的名次倒数；未命中记 0。"""

    gold_set = set(gold)
    if not gold_set:
        raise ValueError("gold 不能为空")
    for rank, path in enumerate(_scoring_paths(status, paths), start=1):
        if path in gold_set:
            return 1.0 / rank
    return 0.0


def ndcg_at_k(status: str, paths: Sequence[str], gold: Iterable[str], k: int = 5) -> float:
    """二值相关 nDCG@k：DCG=Σ rel_i/log2(i+1)，IDCG 按 gold 数计算。"""

    if k <= 0:
        raise ValueError("k 必须为正整数")
    gold_set = set(gold)
    if not gold_set:
        raise ValueError("gold 不能为空")
    top = _scoring_paths(status, paths)[:k]
    dcg = sum(
        1.0 / math.log2(rank + 1)
        for rank, path in enumerate(top, start=1)
        if path in gold_set
    )
    ideal_hits = min(k, len(gold_set))
    idcg = sum(1.0 / math.log2(rank + 1) for rank in range(1, ideal_hits + 1))
    return dcg / idcg if idcg > 0 else 0.0


def score_query(
    *,
    status: str,
    paths: Sequence[str],
    gold: Iterable[str],
    ks: Sequence[int] = (2, 5),
) -> dict[str, float | bool]:
    """单查询的指标集合。键名固定，便于直接写入 scored CSV。"""

    scores: dict[str, float | bool] = {
        "hit@1": hit_at_k(status, paths, gold, 1),
        "mrr": reciprocal_rank(status, paths, gold),
        "ndcg@5": ndcg_at_k(status, paths, gold, 5),
        "ok": status == "ok",
    }
    for k in ks:
        scores[f"recall@{k}"] = hit_at_k(status, paths, gold, k)
        scores[f"recall_frac@{k}"] = recall_fraction(status, paths, gold, k)
    return scores


def mean(values: Sequence[float]) -> float:
    """算术平均；空序列返回 nan，由调用方决定是否允许。"""

    if not values:
        return float("nan")
    return sum(values) / len(values)


def percentile(values: Sequence[float], q: float) -> float:
    """线性插值分位数（q ∈ [0, 100]）；不引入 numpy 以保持纯函数。"""

    if not 0 <= q <= 100:
        raise ValueError("q 必须在 [0, 100] 区间")
    if not values:
        return float("nan")
    ordered = sorted(values)
    if len(ordered) == 1:
        return float(ordered[0])
    position = (len(ordered) - 1) * q / 100
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return float(ordered[lower])
    weight = position - lower
    return ordered[lower] * (1 - weight) + ordered[upper] * weight


# ---- 负样本（H7） ---------------------------------------------------------


def is_false_candidate(status: str, candidate_count: int) -> bool:
    """假候选：负样本查询返回了 ok 且候选非空。"""

    return status == "ok" and candidate_count > 0


def is_correct_refusal(
    status: str,
    scores: Sequence[float],
    threshold: float | None,
) -> bool:
    """正确拒答：显式 no_match、无候选，或最高分低于预注册阈值。

    阈值必须先在 dev 负样本上选定（§7.7）；阈值为 None 时只认 no_match / 无候选。
    """

    if status == "no_match":
        return True
    if status != "ok":
        return False
    if not scores:
        return True
    if threshold is None:
        return False
    return max(scores) < threshold


def auroc(positive_scores: Sequence[float], negative_scores: Sequence[float]) -> float | None:
    """以候选最高分区分正/负查询；并列按 0.5 计。任一侧为空返回 None。"""

    if not positive_scores or not negative_scores:
        return None
    wins = 0.0
    for pos in positive_scores:
        for neg in negative_scores:
            if pos > neg:
                wins += 1.0
            elif pos == neg:
                wins += 0.5
    return wins / (len(positive_scores) * len(negative_scores))


def perturbation_decay(clean_recall: float, perturbed_recall: float) -> float:
    """扰动衰减率：(干净 − 扰动) / 干净；干净为 0 时返回 nan。"""

    if clean_recall <= 0:
        return float("nan")
    return (clean_recall - perturbed_recall) / clean_recall
