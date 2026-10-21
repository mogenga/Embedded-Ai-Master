"""跑批骨架（spec §9.1 G2、§9.4）。

骨架期只保证：结果记录形状统一、单查询失败按 ITT 记为 error 并继续、
连续网关错误中止整批。真正的方案实现接入后无需改动本文件。

**逐条落盘**：方案 B 跑全量要 1.7–2.7 小时，途中任何一次网关排队都可能中断。
所以结果是**边跑边追加**的（``append_result``），中断时已完成的部分仍在盘上，
下次带 ``--resume`` 可从断点继续——不必从头再花两小时。
"""

from __future__ import annotations

import json
import time
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
    query_spacing_seconds: float = 0.0,
    sleep: Callable[[float], None] | None = None,
    on_result: Callable[[QueryResult], None] | None = None,
) -> RunSummary:
    """按统一契约跑一批查询。

    - 单查询失败不中止整批（写入 error，ITT 分母不变）。
    - 连续 ``MAX_CONSECUTIVE_GATEWAY_ERRORS`` 次网关错误中止并保留已完成结果。
    - ``query_spacing_seconds``：**查询之间**的间隔。方案 B 自己的
      ``spacing_seconds`` 只管一轮查询内部的轮次间隔，管不到查询之间——
      不加这一层，相邻两条查询会背靠背发出去，那正是实测成功率 0% 的突发模式。
    - ``on_result``：每条结果落地后的回调（用于逐条落盘）。
    """

    check_gateway = is_gateway_error or _is_gateway_error
    summary = RunSummary(run_id=run_id)
    consecutive = 0
    pause = sleep or time.sleep
    first = True

    for query in queries:
        if not first and query_spacing_seconds > 0:
            pause(query_spacing_seconds)
        first = False

        result = scheme.run(query, deadline_ms=deadline_ms)
        summary.results.append(result)
        if on_result is not None:
            on_result(result)
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
            handle.write(json.dumps(_result_record(result), ensure_ascii=False) + "\n")
    return target


def _result_record(result: QueryResult) -> dict[str, object]:
    """一条结果的落盘形状（§8.1 的输出契约）。"""

    return {
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


def append_result(result: QueryResult, path: str | Path) -> Path:
    """把一条结果**追加**到 JSONL 末尾并立即落盘。

    追加而不是等整批跑完再写：B 的全量跑批要 1.7–2.7 小时，中途可能因网关
    排队被中断。逐条落盘让已完成的部分不丢，断点续跑才可能。
    """

    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("a", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(_result_record(result), ensure_ascii=False) + "\n")
        handle.flush()
    return target


def read_completed_query_ids(path: str | Path) -> set[str]:
    """读已落盘的 query_id 集合（供 ``--resume`` 跳过已完成条目）。

    坏行直接失败，不跳过——坏行意味着文件被写坏了，继续追加只会让它更坏。
    """

    target = Path(path)
    if not target.is_file():
        return set()
    completed: set[str] = set()
    with target.open("r", encoding="utf-8") as handle:
        for lineno, raw in enumerate(handle, start=1):
            line = raw.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(
                    f"{target.name}:{lineno} 不是合法 JSON（续跑前须先修好该文件）：{exc}"
                ) from exc
            completed.add(str(record.get("query_id")))
    return completed


def summarize_status(summary: RunSummary) -> dict[str, int]:
    """按状态计数；ITT 分母是 total，不做剔除。"""

    counts: dict[str, int] = {}
    for result in summary.results:
        counts[result.status] = counts.get(result.status, 0) + 1
    counts["total"] = summary.total
    return counts
