"""统计口径（spec §10.2）。"""

from __future__ import annotations

import pytest

from raglab.stats import (
    exact_mcnemar,
    holm_adjust,
    mcnemar_table,
    paired_bootstrap_ci,
)


def test_mcnemar_table_counts_discordant_pairs() -> None:
    b, c = mcnemar_table([True, False, True, True], [False, False, True, False])
    assert (b, c) == (2, 0)


def test_mcnemar_requires_paired_lengths() -> None:
    with pytest.raises(ValueError):
        mcnemar_table([True], [True, False])


def test_exact_mcnemar_no_discordance_is_one() -> None:
    assert exact_mcnemar(0, 0) == 1.0


def test_exact_mcnemar_symmetric_and_small_p() -> None:
    assert exact_mcnemar(2, 0) == pytest.approx(exact_mcnemar(0, 2))
    # 9:0 的不一致对，双侧精确 p = 2 * 0.5^9。
    assert exact_mcnemar(9, 0) == pytest.approx(2 * 0.5**9)


def test_bootstrap_ci_brackets_true_difference() -> None:
    a = [1.0] * 40 + [0.0] * 10
    b = [0.0] * 40 + [1.0] * 10
    lower, upper = paired_bootstrap_ci(a, b, n_resamples=2_000, seed=7)
    assert lower < 0.6 < upper
    assert lower <= upper


def test_bootstrap_ci_requires_equal_lengths() -> None:
    with pytest.raises(ValueError):
        paired_bootstrap_ci([1.0], [1.0, 0.0])


def test_bootstrap_ci_stratified_runs() -> None:
    a = [1.0, 1.0, 0.0, 0.0]
    b = [0.0, 1.0, 0.0, 1.0]
    strata = ["index", "index", "search", "search"]
    lower, upper = paired_bootstrap_ci(a, b, strata=strata, n_resamples=200, seed=1)
    assert lower <= upper


def test_holm_adjust_monotone_and_bounded() -> None:
    adjusted = holm_adjust([0.01, 0.04, 0.03])
    assert all(0.0 <= value <= 1.0 for value in adjusted)
    # 最小 p 的 Holm 校正为 p*m。
    assert adjusted[0] == pytest.approx(0.03)
    assert adjusted[2] == pytest.approx(0.06)


def test_holm_rejects_invalid_pvalues() -> None:
    with pytest.raises(ValueError):
        holm_adjust([1.5])
