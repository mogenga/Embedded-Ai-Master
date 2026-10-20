"""跑批骨架（spec §9.1 G2、§9.4）。

骨架期只保证：结果记录形状统一、单查询失败按 ITT 记为 error 并继续、
连续网关错误中止整批。真正的方案实现接入后无需改动本文件。
"""

from __future__ import annotations

import json
from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from pathlib import Path

from .assets import Query, QueryResult
from .errors import LLMError
from .schemes.base import RetrievalScheme

# §9.4：连续 5 次网关错误中止整批。
MAX_CONSECUTIVE_GATEWAY_ERRORS = 5


@dataclass
class RunSummary:
    run_id: str
    results: list[QueryResult] = field(default_factory=list)
    aborted: bool = False
    abort_reason: str | None = None

    @property
    def total(self) -> int:
        return len(self.results)

    @property
    def ok_count(self) -> int:
        return sum(1 for result in self.results if result.status == "ok")


def _is_gateway_error(result: QueryResult) -> bool:
    if result.error is None:
        return False
    return result.error.startswith(LLMError.__name__)


def run_queries(
    scheme: RetrievalScheme,
    queries: Iterable[Query],
    *,
    run_id: str,
    deadline_ms: float | None = None,
    is_gateway_error: Callable[[QueryResult], bool] | None = None,
) -> RunSummary:
    """按统一契约跑一批查询。

    - 单查询失败不中止整批（写入 error，ITT 分母不变）。
    - 连续 ``MAX_CONSECUTIVE_GATEWAY_ERRORS`` 次网关错误中止并保留已完成结果。
    """

    check_gateway = is_gateway_error or _is_gateway_error
    summary = RunSummary(run_id=run_id)
    consecutive = 0

    for query in queries:
        result = scheme.run(query, deadline_ms=deadline_ms)
        summary.results.append(result)
        consecutive = consecutive + 1 if check_gateway(result) else 0
        if consecutive >= MAX_CONSECUTIVE_GATEWAY_ERRORS:
            summary.aborted = True
            summary.abort_reason = (
                f"连续 {consecutive} 次网关错误，按 §9.4 中止整批"
            )
            break

    return summary


def write_results_jsonl(summary: RunSummary, path: str | Path) -> Path:
    """把逐查询结果写成 JSONL（骨架期的最小落盘格式）。"""

    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("w", encoding="utf-8", newline="\n") as handle:
        for result in summary.results:
            record = {
                "query_id": result.query_id,
                "scheme": result.scheme,
                "status": result.status,
                "candidates": [
                    {"path": candidate.path, "score": candidate.score}
                    for candidate in result.candidates
                ],
                "latency_ms": result.latency_ms,
                "cost": {
                    "input_tokens": result.input_tokens,
                    "output_tokens": result.output_tokens,
                    "estimated": result.cost_estimated,
                },
                "trace_path": result.trace_path,
                "repetition": result.repetition,
                "error": result.error,
                "extra": result.extra,
            }
            handle.write(json.dumps(record, ensure_ascii=False) + "\n")
    return target


def summarize_status(summary: RunSummary) -> dict[str, int]:
    """按状态计数；ITT 分母是 total，不做剔除。"""

    counts: dict[str, int] = {}
    for result in summary.results:
        counts[result.status] = counts.get(result.status, 0) + 1
    counts["total"] = summary.total
    return counts
