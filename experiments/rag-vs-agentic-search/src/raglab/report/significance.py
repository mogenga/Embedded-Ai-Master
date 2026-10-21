"""方案间的显著性检验（spec §10.2）。

比较族是预注册固定的：**A vs C′、A vs B、C′ vs C、D vs 最优单一方案**。
Holm 校正按这个族做——族外比较不进校正，但也要说明。

**B/D 缺席的处理**：比较族里的项如果因缺数据而无法计算，**不得**把它当成"无差异"
从校正里悄悄去掉——那会改变族的大小，让别的比较显得更显著。这里把缺席项
显式列出，并说明校正仍按完整族计算。
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

from ..stats import exact_mcnemar, holm_adjust, mcnemar_table, paired_bootstrap_ci

# 预注册的比较族（§10.2）。**族大小固定，不因缺数据而缩小。**
#
# 每一项是 (方案A, 方案B)。``("D", "best_single")`` 是「D vs 最优单一方案」，
# D 需要和族内最好的单一方案比——但 D 本轮不跑，所以这一项缺席。
COMPARISON_FAMILY = (
    ("A", "C_prime"),
    ("A", "B"),
    ("C_prime", "C"),
    ("D", "best_single"),
)

# 预注册族 → (显示名, 方案A, 方案B)。``best_single`` 是占位：实际比较对象
# 由运行时数据决定（族内除 D 外召回最高的那个），所以这里只登记名字。
COMPARISON_LABELS = {
    ("A", "C_prime"): "A vs C′",
    ("A", "B"): "A vs B",
    ("C_prime", "C"): "C′ vs C",
    ("D", "best_single"): "D vs 最优单一方案",
}


@dataclass
class Comparison:
    """一次方案对比的结果。"""

    name: str
    scheme_a: str
    scheme_b: str
    n: int
    a_rate: float
    b_rate: float
    diff_pp: float
    mcnemar_b: int
    mcnemar_c: int
    p_value: float
    ci_low_pp: float
    ci_high_pp: float
    strata: tuple[str, ...] = ()
    p_adjusted: float | None = None
    skipped_reason: str | None = None

    @property
    def significant(self) -> bool:
        """CI 上界仍为负 → a 显著劣于 b；CI 下界仍为正 → a 显著优于 b。"""

        if self.skipped_reason:
            return False
        return self.ci_high_pp < 0 or self.ci_low_pp > 0

    def as_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "scheme_a": self.scheme_a,
            "scheme_b": self.scheme_b,
            "n": self.n,
            "recall@2_a": round(self.a_rate, 4),
            "recall@2_b": round(self.b_rate, 4),
            "diff_pp": round(self.diff_pp, 1),
            "mcnemar": {"only_a": self.mcnemar_b, "only_b": self.mcnemar_c},
            "p_value": self.p_value,
            "p_adjusted": self.p_adjusted,
            "ci_low_pp": round(self.ci_low_pp, 1),
            "ci_high_pp": round(self.ci_high_pp, 1),
            "significant": self.significant,
            "strata": list(self.strata),
            "skipped_reason": self.skipped_reason,
        }


@dataclass
class SignificanceReport:
    comparisons: list[Comparison] = field(default_factory=list)
    family_size: int = 0
    notes: list[str] = field(default_factory=list)

    def as_dict(self) -> dict[str, Any]:
        return {
            "family_size": self.family_size,
            "compared": len([c for c in self.comparisons if not c.skipped_reason]),
            "comparisons": [item.as_dict() for item in self.comparisons],
            "notes": list(self.notes),
        }


def compare(
    *,
    name: str,
    hits_a: Sequence[bool],
    hits_b: Sequence[bool],
    strata: Sequence[str] | None = None,
    n_resamples: int = 10_000,
    seed: int = 0,
) -> Comparison:
    """一次配对对比：McNemar 精确检验 + 配对 bootstrap CI。"""

    if len(hits_a) != len(hits_b):
        raise ValueError("配对样本长度必须一致")
    n = len(hits_a)
    if n == 0:
        raise ValueError("样本为空")

    values_a = [1.0 if hit else 0.0 for hit in hits_a]
    values_b = [1.0 if hit else 0.0 for hit in hits_b]
    a_rate = sum(values_a) / n
    b_rate = sum(values_b) / n

    b_count, c_count = mcnemar_table(hits_a, hits_b)
    p_value = exact_mcnemar(b_count, c_count)
    low, high = paired_bootstrap_ci(
        values_a, values_b, strata=strata, n_resamples=n_resamples, seed=seed
    )
    return Comparison(
        name=name,
        scheme_a="A",
        scheme_b="B",
        n=n,
        a_rate=a_rate,
        b_rate=b_rate,
        diff_pp=100 * (a_rate - b_rate),
        mcnemar_b=b_count,
        mcnemar_c=c_count,
        p_value=p_value,
        ci_low_pp=100 * low,
        ci_high_pp=100 * high,
        strata=tuple(dict.fromkeys(strata)) if strata else (),
    )


def _best_single_scheme(
    per_scheme_hits: dict[str, list[bool]], *, exclude: str
) -> str | None:
    """召回最高的单一方案（``best_single`` 的实际比较对象）。

    **按 Recall@2 的点估计选，不做多重比较校正**——它是族内一项比较的
    对手方，不是族外的新比较。若并列，取字典序第一个（保证可复算）。
    """

    candidates = [
        (name, sum(hits) / len(hits))
        for name, hits in per_scheme_hits.items()
        if name != exclude and hits
    ]
    if not candidates:
        return None
    best_rate = max(rate for _, rate in candidates)
    tied = sorted(name for name, rate in candidates if rate == best_rate)
    return tied[0]


def build_report(
    *,
    per_scheme_hits: dict[str, list[bool]],
    per_scheme_strata: dict[str, list[str]],
    comparisons: Sequence[tuple[str, str, str]] | None = None,
    n_resamples: int = 10_000,
    seed: int = 0,
) -> SignificanceReport:
    """按预注册的比较族做检验并做 Holm 校正。

    ``comparisons`` 是 (显示名, 方案A, 方案B) 三元组；不给就用预注册族
    （``COMPARISON_FAMILY``）。缺席的方案会记为 ``skipped``，并**按 p = 1
    计入族大小**（§10.2 的族是预注册的，不因缺数据而缩小）。
    """

    if comparisons is None:
        comparisons = [
            (COMPARISON_LABELS[key], key[0], key[1]) for key in COMPARISON_FAMILY
        ]

    report = SignificanceReport(family_size=len(comparisons))
    results: list[Comparison] = []
    for name, key_a, key_b in comparisons:
        if key_b == "best_single":
            # 「D vs 最优单一方案」：比较对象由数据决定（族内召回最高的单一方案）。
            # D 本轮不跑，这一项必然缺席——但它仍占族里的一个位置。
            best = _best_single_scheme(per_scheme_hits, exclude=key_a)
            if best is None:
                results.append(
                    Comparison(
                        name=name,
                        scheme_a=key_a,
                        scheme_b="best_single",
                        n=0,
                        a_rate=0.0,
                        b_rate=0.0,
                        diff_pp=0.0,
                        mcnemar_b=0,
                        mcnemar_c=0,
                        p_value=1.0,
                        ci_low_pp=0.0,
                        ci_high_pp=0.0,
                        skipped_reason=f"{key_a} 无全量数据（未跑批）",
                    )
                )
                continue
            key_b = best
            name = f"{key_a} vs 最优单一方案（{best}）"

        if key_a not in per_scheme_hits or key_b not in per_scheme_hits:
            missing = key_a if key_a not in per_scheme_hits else key_b
            results.append(
                Comparison(
                    name=name,
                    scheme_a=key_a,
                    scheme_b=key_b,
                    n=0,
                    a_rate=0.0,
                    b_rate=0.0,
                    diff_pp=0.0,
                    mcnemar_b=0,
                    mcnemar_c=0,
                    p_value=1.0,
                    ci_low_pp=0.0,
                    ci_high_pp=0.0,
                    skipped_reason=f"{missing} 无全量数据（未跑批）",
                )
            )
            continue
        result = compare(
            name=name,
            hits_a=per_scheme_hits[key_a],
            hits_b=per_scheme_hits[key_b],
            strata=per_scheme_strata.get(key_a),
            n_resamples=n_resamples,
            seed=seed,
        )
        result.scheme_a = key_a
        result.scheme_b = key_b
        results.append(result)

    # Holm 校正只对实际算了的比较做，但**族大小按预注册的完整族算**。
    #
    # 缺席的族内比较按 p = 1 计入族大小（§10.2）。这一步不是形式主义：
    # 2026-10-20 实测发现，缺席项被直接剔除会让族从 3 项缩到 2 项，
    # Holm 的乘数随之从 3 掉到 2 —— 校正后的 p 值凭空小了一半
    # （C′ vs C 的 p_adj 从 4.9e−07 变成 2.5e−07）。
    # 族是预注册时定死的，缺数据不会让它变小；让族变小等于让数据缺失的
    # 那一项「白赚」一个校正系数。
    computed = [item for item in results if not item.skipped_reason]
    if computed:
        family_pvalues = [item.p_value for item in computed] + [
            1.0 for item in results if item.skipped_reason
        ]
        adjusted = holm_adjust(family_pvalues)
        for item, value in zip(computed, adjusted[: len(computed)], strict=True):
            item.p_adjusted = value

    skipped = [item for item in results if item.skipped_reason]
    if skipped:
        report.notes.append(
            "缺席的族内比较（"
            + "、".join(item.name for item in skipped)
            + "）按 p = 1 计入 Holm 族大小（族大小不因缺数据而缩小）；"
            "其缺失原因已列出，不得据此声称两者无差异"
        )
    report.comparisons = results
    return report
