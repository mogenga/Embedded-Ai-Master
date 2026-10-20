"""统计检验（spec §10.2）。

- 二值主指标用 McNemar 精确检验（scipy.stats.binomtest）。
- 指标差的 95% CI 用配对 bootstrap（默认 10,000 次，可按 track 分层）。
- 比较族固定，Holm 校正。
"""

from __future__ import annotations

from collections.abc import Sequence

import numpy as np
from scipy.stats import binomtest


def mcnemar_table(hits_a: Sequence[bool], hits_b: Sequence[bool]) -> tuple[int, int]:
    """返回 (仅 A 命中的查询数 b, 仅 B 命中的查询数 c)。

    两者都不一致的对（b、c）才是 McNemar 检验的信息来源。
    """

    if len(hits_a) != len(hits_b):
        raise ValueError("配对样本长度必须一致")
    b = sum(1 for a, b_ in zip(hits_a, hits_b, strict=True) if a and not b_)
    c = sum(1 for a, b_ in zip(hits_a, hits_b, strict=True) if not a and b_)
    return b, c


def exact_mcnemar(b: int, c: int) -> float:
    """McNemar 精确检验的双侧 p 值；无不一致对时 p=1。"""

    if b < 0 or c < 0:
        raise ValueError("不一致对计数不能为负")
    n = b + c
    if n == 0:
        return 1.0
    return float(binomtest(min(b, c), n, 0.5, alternative="two-sided").pvalue)


def paired_bootstrap_ci(
    values_a: Sequence[float],
    values_b: Sequence[float],
    *,
    strata: Sequence[str] | None = None,
    n_resamples: int = 10_000,
    confidence: float = 0.95,
    seed: int = 0,
) -> tuple[float, float]:
    """配对 bootstrap 估计 mean(a) − mean(b) 的置信区间（百分位法）。

    分层时在每层内按原样本量有放回重采样，再按固定层权重合成（§10.2 按 track 分层）。
    """

    a = np.asarray(values_a, dtype=float)
    b = np.asarray(values_b, dtype=float)
    if a.shape != b.shape:
        raise ValueError("配对样本长度必须一致")
    if a.size == 0:
        raise ValueError("样本为空")
    if not 0 < confidence < 1:
        raise ValueError("confidence 必须在 (0, 1) 区间")

    diffs = a - b
    rng = np.random.default_rng(seed)

    if strata is None:
        groups = [np.arange(diffs.size)]
    else:
        if len(strata) != diffs.size:
            raise ValueError("分层标签长度必须与样本一致")
        labels = np.asarray(strata)
        groups = [np.flatnonzero(labels == label) for label in dict.fromkeys(labels)]

    stats = np.empty(n_resamples, dtype=float)
    for i in range(n_resamples):
        total = 0.0
        for idx in groups:
            picked = rng.choice(idx, size=idx.size, replace=True)
            total += float(diffs[picked].sum())
        stats[i] = total / diffs.size

    alpha = (1 - confidence) / 2
    lower, upper = np.quantile(stats, [alpha, 1 - alpha])
    return float(lower), float(upper)


def holm_adjust(pvalues: Sequence[float]) -> list[float]:
    """Holm step-down 校正；返回与输入同序的校正后 p 值。"""

    m = len(pvalues)
    if m == 0:
        return []
    if any(not 0 <= p <= 1 for p in pvalues):
        raise ValueError("p 值必须在 [0, 1] 区间")
    order = sorted(range(m), key=lambda i: pvalues[i])
    adjusted = [0.0] * m
    running = 0.0
    for rank, idx in enumerate(order):
        candidate = min(1.0, pvalues[idx] * (m - rank))
        running = max(running, candidate)
        adjusted[idx] = running
    return adjusted
