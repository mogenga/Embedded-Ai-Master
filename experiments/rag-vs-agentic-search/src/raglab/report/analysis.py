"""三块收尾分析：H7 拒答、H4 延迟、方案间显著性。

一次跑完，产物写 `results/analysis/`。**全部离线**，不触网。
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..assets import Negative, Query
from ..config import ExperimentConfig
from ..errors import BlockedError
from ..metrics import hit_at_k, percentile
from ..report.h7 import collect_negative_outcomes, select_threshold
from ..report.significance import build_report
from ..scoring import read_results_jsonl

# 有负样本跑批实现的方案，**由跑批器自己说**——不是这里另抄一份名单。
#
# 2026-10-20 实测踩到过：负样本跑批器对未知方案返回 ("no_match", [], 0)，
# 而 B 不在实现列表里——于是 B 被算成「假候选率 0%、正确拒答率 100%」，
# 看起来像最强的拒答方案，实际只是**没人跑过 B 的负样本**。
# 「没跑」和「跑出来满分」在报告里长得一模一样，读者分辨不出来。
#
# 现在跑批器对未知方案**显式抛 BlockedError**，本模块据此把该方案的 H7
# 整块标为 skipped。这样「能不能跑」只有一个事实源（跑批器），
# 不会出现名单与实现不同步的情况。
#
# 判定用一次探针调用实现：跑批器对未实现的方案会立刻抛错，不会真去跑。


def _can_run_negatives(
    scheme: str,
    negatives: Sequence[Negative],
    run_negative_for,
) -> bool:
    """该方案能不能跑负样本——**问跑批器本身**，不查旁门的名单。

    跑批器对没有实现的方案会抛 ``BlockedError``。这里用第一条负样本试一次：
    抛错就是不能跑；不抛错就是能跑（哪怕返回 no_match）。
    """

    if not negatives:
        return False
    try:
        run_negative_for(scheme, negatives[0])
    except BlockedError:
        return False
    except Exception:  # noqa: BLE001 —— 别的异常是跑批本身的问题，交给上层报
        return True
    return True


@dataclass
class SchemeRuns:
    """一个方案在全量查询上的逐条结果。"""

    scheme: str
    hits: list[bool] = field(default_factory=list)
    strata: list[str] = field(default_factory=list)
    latencies: list[float] = field(default_factory=list)
    statuses: list[str] = field(default_factory=list)
    query_ids: list[str] = field(default_factory=list)
    # 每个查询的最高候选分数（AUROC 用）。
    top_scores: list[float] = field(default_factory=list)

    def rate(self) -> float:
        return sum(self.hits) / len(self.hits) if self.hits else 0.0


def load_scheme_runs(
    run_dir: Path, scheme: str, queries: dict[str, Query]
) -> SchemeRuns | None:
    """从 `results/runs/<id>/<scheme>.jsonl` 读一个方案的结果。"""

    path = run_dir / f"{scheme}.jsonl"
    if not path.is_file():
        return None
    runs = SchemeRuns(scheme=scheme)
    for record in read_results_jsonl(path):
        query = queries.get(record["query_id"])
        if query is None:
            continue
        candidates = record.get("candidates") or []
        paths = [c["path"] for c in candidates]
        scores = [float(c.get("score", 0.0) or 0.0) for c in candidates]
        runs.hits.append(hit_at_k(record["status"], paths, query.gold, 2))
        runs.strata.append(query.track)
        runs.latencies.append(float(record.get("latency_ms", 0.0) or 0.0))
        runs.statuses.append(record["status"])
        runs.query_ids.append(record["query_id"])
        runs.top_scores.append(max(scores) if scores else 0.0)
    return runs


def latency_summary(runs: SchemeRuns) -> dict[str, Any]:
    """延迟汇总（§10.1）：P50/P95 + 失败率。"""

    total = len(runs.latencies)
    return {
        "scheme": runs.scheme,
        "n": total,
        "p50_latency_ms": round(percentile(runs.latencies, 50), 2),
        "p95_latency_ms": round(percentile(runs.latencies, 95), 2),
        "failure_rate": round(
            sum(1 for status in runs.statuses if status != "ok") / total, 4
        )
        if total
        else 0.0,
        "status_counts": {
            status: runs.statuses.count(status) for status in dict.fromkeys(runs.statuses)
        },
    }


def check_alignment(loaded: dict[str, SchemeRuns]) -> dict[str, Any]:
    """检查各方案的逐查询结果能否逐条配对。

    配对检验（McNemar、配对 bootstrap）的前提是**同一批查询、同序**。
    集合不同 → 缺条目；顺序不同 → 逐条配错。两种情况都不会让检验报错，
    只会让结果变成错的，所以必须显式检查。
    """

    problems: list[str] = []
    if len(loaded) < 2:
        return {"misaligned": False, "problems": [], "n": None}

    reference_name, reference = next(iter(loaded.items()))
    reference_ids = list(reference.query_ids)
    for name, runs in loaded.items():
        if name == reference_name:
            continue
        if list(runs.query_ids) == reference_ids:
            continue
        if set(runs.query_ids) != set(reference_ids):
            missing = sorted(set(reference_ids) - set(runs.query_ids))
            extra = sorted(set(runs.query_ids) - set(reference_ids))
            detail = []
            if missing:
                detail.append(f"缺 {len(missing)} 条（如 {missing[:3]}）")
            if extra:
                detail.append(f"多 {len(extra)} 条（如 {extra[:3]}）")
            problems.append(f"{name} 与 {reference_name} 的 query_id 集合不同：" + "，".join(detail))
        else:
            problems.append(
                f"{name} 与 {reference_name} 的 query_id 集合相同但顺序不同（配对会错位）"
            )
    return {
        "misaligned": bool(problems),
        "problems": problems,
        "n": len(reference_ids),
    }


def analyze(
    *,
    project_root: Path,
    config: ExperimentConfig,
    run_id: str,
    queries: list[Query],
    negatives: list[Negative],
    schemes: list[str],
    run_negative_for,
    dev_negative_ids: list[str] | None = None,
) -> dict[str, Any]:
    """跑三块分析并返回可 JSON 化的结果。

    ``run_negative_for(scheme, negative) -> (status, scores, count)`` 由调用方注入，
    因为负样本不在跑批结果里（跑批只跑正查询）。
    """

    run_dir = project_root / config.results_dir / "runs" / run_id
    by_id = {query.id: query for query in queries}

    loaded: dict[str, SchemeRuns] = {}
    for scheme in schemes:
        runs = load_scheme_runs(run_dir, scheme, by_id)
        if runs is not None:
            loaded[scheme] = runs

    # ---- 配对对齐检查 ----
    # McNemar 与配对 bootstrap 都要求两个方案在**同一批查询**上逐条配对。
    # 跑批结果的文件顺序不保证一致（B 可能是续跑出来的、顺序不同），
    # 不检查就配对会得到「A 的第 3 条 vs B 的第 7 条」这种无意义的比较，
    # 而且算出来的 p 值看上去还挺正常——不会报错，只会是错的。
    alignment = check_alignment(loaded)
    if alignment["misaligned"]:
        raise ValueError(
            "方案间的逐查询结果无法配对（query_id 集合或顺序不一致）："
            + "；".join(alignment["problems"])
            + "。配对检验要求同一批查询的同序结果，请检查各方案的跑批是否完整。"
        )

    # ---- H4：延迟 ----
    latency = [latency_summary(runs) for runs in loaded.values()]

    # ---- 显著性（预注册比较族 + Holm 校正）----
    # 比较族用 `significance.COMPARISON_FAMILY`（预注册的 4 项，单一事实源）。
    # 族内某项因缺数据而算不出来时**不缩小族大小**（见 significance.py）。
    significance = build_report(
        per_scheme_hits={name: runs.hits for name, runs in loaded.items()},
        per_scheme_strata={name: runs.strata for name, runs in loaded.items()},
    )

    # ---- H7：负样本拒答 ----
    # 阈值**按方案各自在 dev 负样本上选**（§7.7）。不能跨方案共用：
    # 各方案的分数量纲不同（C 的 lookup 分是正数，C′ 的 search 分支用负名次），
    # 拿 C 的阈值去判 C′ 会得出「返回了候选、却又算正确拒答」的矛盾结果
    # （2026-10-20 实测踩到过）。
    h7: list[dict[str, Any]] = []
    for scheme, runs in loaded.items():
        # 该方案能不能跑负样本？不能的话**整块 H7 都不报**——
        # 报一个假的「正确拒答率 100%」比不报更糟（2026-10-20 实测踩到过：
        # 负样本跑批器对未知方案返回 no_match，B 不在其中，于是被算成
        # 「B 的拒答率满分」——那不是 B 的能力，是没人跑过 B 的负样本）。
        #
        # 判定靠跑批器自己抛错（未实现的方案会抛 BlockedError），
        # 不用另抄一份方案名单——名单与实现不同步正是那个 bug 的成因。
        if not _can_run_negatives(scheme, negatives, run_negative_for):
            h7.append(
                {
                    "scheme": scheme,
                    "skipped": True,
                    "skipped_reason": (
                        f"{scheme} 没有负样本跑批实现，无法评估拒答能力；"
                        "不报数（不得用「没人跑过」换来的 no_match 充当成绩）"
                    ),
                }
            )
            continue

        scheme_threshold: float | None = None
        if dev_negative_ids:
            wanted = set(dev_negative_ids)
            dev_scores: list[float] = []
            for negative in negatives:
                if negative.id not in wanted:
                    continue
                _, scores, _ = run_negative_for(scheme, negative)
                dev_scores.append(max(scores) if scores else 0.0)
            if dev_scores:
                scheme_threshold = select_threshold(dev_scores)

        result = collect_negative_outcomes(
            scheme=scheme,
            negatives=negatives,
            run_negative=lambda neg, _s=scheme: run_negative_for(_s, neg),
            threshold=scheme_threshold,
        )
        result.positives = list(runs.top_scores)
        payload = result.as_dict()
        payload["skipped"] = False
        payload["threshold_source"] = (
            "本方案在 dev 负样本上选（§7.7）"
            if scheme_threshold is not None
            else "未选阈值：只认显式 no_match"
        )
        h7.append(payload)

    return {
        "run_id": run_id,
        "schemes_loaded": sorted(loaded),
        "alignment": alignment,
        "latency": latency,
        "significance": significance.as_dict(),
        "h7": h7,
    }
