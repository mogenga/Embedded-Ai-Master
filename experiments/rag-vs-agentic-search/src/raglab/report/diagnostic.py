"""单方案诊断报告（探索性）。

**用途**：在只有一个方案能跑时，产出一份自查用的诊断报告——指标、延迟、负样本行为、
以及 dispatch 三种读法的对照。

**边界**（写死在这里，也写进报告正文）：

- 这是**探索性**产物，不构成任何主判定（spec T2）；
- 只有一个方案，**不得**被读成方案对比，也不得据此声称谁胜出；
- 三种 dispatch 读法的对照是**稳健性检查**，不是选型依据（预注册 §6bis）。

设计上刻意不复用 `score` 的分区逻辑：诊断跑固定用全量 80 条，既不分 dev/test，
也不参与调参——它回答的是"这套实现到底在做什么"，不是"哪个配置更好"。
"""

from __future__ import annotations

import json
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..assets import Query
from ..metrics import is_correct_refusal, is_false_candidate
from ..scoring import ScoredQuery, score_one, summarize
from ..schemes.index_grep import SchemeC

# 预注册 §6bis 的三种读法；顺序固定，`deployed` 是主口径。
DISPATCH_ORDER = ("deployed", "lexical", "lookup_only")
PRIMARY_RULE = "deployed"


@dataclass
class VariantResult:
    """一种 dispatch 读法在一批查询上的结果。"""

    rule: str
    scored: list[ScoredQuery] = field(default_factory=list)
    records: list[dict[str, Any]] = field(default_factory=list)

    @property
    def primary(self) -> bool:
        return self.rule == PRIMARY_RULE

    def aggregate(self) -> dict[str, object]:
        return summarize(self.scored)[0]


@dataclass
class NegativeResult:
    """负样本行为；口径随 dispatch 读法变化，必须分开报。"""

    rule: str
    total: int
    correct_refusal: int
    false_candidates: int

    @property
    def correct_refusal_rate(self) -> float:
        return self.correct_refusal / self.total if self.total else 0.0

    @property
    def false_candidate_rate(self) -> float:
        return self.false_candidates / self.total if self.total else 0.0


@dataclass
class DiagnosticBundle:
    run_id: str
    queries: int
    negatives: int
    variants: list[VariantResult] = field(default_factory=list)
    negative_results: list[NegativeResult] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def _run_variant(
    *,
    rule: str,
    queries: Sequence[Query],
    negatives: Sequence[Any],
    corpus_root: Path,
    navigation_files: Sequence[str],
) -> tuple[VariantResult, NegativeResult]:
    scheme = SchemeC(
        corpus_root=corpus_root,
        navigation_files=navigation_files,
        dispatch_rule=rule,
    )
    # 计时前预热：否则第一个场景独自付索引解析成本，延迟会随读法顺序漂移。
    scheme.warm_up()

    variant = VariantResult(rule=rule)
    for query in queries:
        result = scheme.run(query)
        variant.records.append(
            {
                "query_id": result.query_id,
                "scheme": result.scheme,
                "status": result.status,
                "paths": list(result.paths),
                "branch": result.extra.get("branch"),
                "latency_ms": result.latency_ms,
                "extra": {
                    key: value
                    for key, value in result.extra.items()
                    if key in ("lookup_reason", "search_tokens", "extended_paths")
                },
            }
        )
        variant.scored.append(
            score_one(
                query=query,
                scheme=result.scheme,
                status=result.status,
                paths=result.paths,
                latency_ms=result.latency_ms,
            )
        )

    correct = 0
    false_candidates = 0
    for negative in negatives:
        # 负样本没有 gold；用同样的检索路径跑，只看有没有返回候选。
        probe = Query(
            id=str(negative.id),
            track="index",
            text=str(negative.text),
            gold=("__negative__",),
            topic="protocols",
        )
        result = scheme.run(probe)
        scores = [
            float(str(candidate.score))
            for candidate in result.candidates
        ]
        if is_false_candidate(result.status, len(result.candidates)):
            false_candidates += 1
        # 阈值为 None：拒绝只认显式 no_match / 空候选（阈值需 dev 选定，见 §7）。
        if is_correct_refusal(result.status, scores, None):
            correct += 1

    return variant, NegativeResult(
        rule=rule,
        total=len(negatives),
        correct_refusal=correct,
        false_candidates=false_candidates,
    )


def run_diagnostic(
    *,
    run_id: str,
    queries: Sequence[Query],
    negatives: Sequence[Any],
    corpus_root: str | Path,
    navigation_files: Sequence[str],
) -> DiagnosticBundle:
    """对三种 dispatch 读法各跑一遍，收集指标与负样本行为。"""

    bundle = DiagnosticBundle(run_id=run_id, queries=len(queries), negatives=len(negatives))
    corpus = Path(corpus_root)

    if not queries:
        bundle.warnings.append("查询集为空，诊断未执行")
        return bundle

    bundle.warnings.append(
        "延迟在索引预加载后测量；不含 `index.yaml` 解析成本（该成本每进程只付一次）"
    )

    for rule in DISPATCH_ORDER:
        variant, negative_result = _run_variant(
            rule=rule,
            queries=queries,
            negatives=negatives,
            corpus_root=corpus,
            navigation_files=navigation_files,
        )
        bundle.variants.append(variant)
        bundle.negative_results.append(negative_result)

    # 主口径相关的两条硬披露，直接随 bundle 带出去，避免报告里漏写。
    primary = next((v for v in bundle.variants if v.primary), None)
    if primary is not None:
        fallback = sum(1 for record in primary.records if record["branch"] == "search")
        if fallback:
            bundle.warnings.append(
                f"deployed 读法下 {fallback}/{len(primary.records)} 条查询回退到 search；"
                "该读法隐含「agent 见 found=false 就换工具」的假设（预注册 §6bis）"
            )
    return bundle


def write_diagnostic(bundle: DiagnosticBundle, target_dir: str | Path) -> Path:
    """把逐条记录与汇总写成 JSON/CSV 形态，供图表与报告复用。"""

    target = Path(target_dir)
    target.mkdir(parents=True, exist_ok=True)

    for variant in bundle.variants:
        (target / f"C_{variant.rule}.jsonl").write_text(
            "\n".join(
                json.dumps(record, ensure_ascii=False) for record in variant.records
            )
            + "\n",
            encoding="utf-8",
            newline="\n",
        )

    payload = {
        "run_id": bundle.run_id,
        "mode": "exploratory",
        "schemes_available": 1,
        "queries": bundle.queries,
        "negatives": bundle.negatives,
        "primary_rule": PRIMARY_RULE,
        "variants": [
            {"rule": variant.rule, "primary": variant.primary, **variant.aggregate()}
            for variant in bundle.variants
        ],
        "negatives_by_rule": [
            {
                "rule": result.rule,
                "total": result.total,
                "correct_refusal_rate": result.correct_refusal_rate,
                "false_candidate_rate": result.false_candidate_rate,
            }
            for result in bundle.negative_results
        ],
        "warnings": bundle.warnings,
    }
    summary_path = target / "diagnostic.json"
    summary_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    return summary_path
