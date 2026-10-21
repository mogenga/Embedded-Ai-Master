"""方案 D：混合（spec §8.6）。

两个预注册变体：

- **D1**：C′ top-3 文件 → B 精读（工具轮数预算减半）→ `submit`；
- **D2**：A 与 C′ 各取 top-5 → 合并去重 → B 按同预算重排 → `submit`。

**只在 H5 有信号时运行**。本实现的构造器要求显式传入 `h5_signal`，
未传即抛 ``BlockedError``——这不是形式主义：spec 明写"不得事后凑判据"，
把门槛做成代码里的一道闸，比写在文档里等人遵守可靠。

**种子与精读分开计时**：种子是纯本地检索（毫秒级），精读是 B 的工具循环
（分钟级）。混在一起会让"混合方案慢"这个结论无法归因。
"""

from __future__ import annotations

import time
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ..assets import Candidate, Query
from ..errors import BlockedError
from ..llm import ChatResult, ToolCall
from ..tools import TOOL_SCHEMAS, SubmitCall, ToolBox
from .base import RetrievalScheme


@dataclass
class DTrace:
    """一次 D 查询的轨迹：种子命中 + 精读过程。"""

    variant: str = ""
    seed_paths: tuple[str, ...] = ()
    seed_scores: tuple[float, ...] = ()
    rounds: int = 0
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    submitted: bool = False
    final_paths: tuple[str, ...] = ()
    input_tokens: int = 0
    output_tokens: int = 0
    stop_reason: str = ""


class SchemeD(RetrievalScheme):
    """混合方案：稀疏/向量召回做种子，agentic 精读重排。"""

    key = "D"
    display_name = "混合（条件启用）"

    def __init__(
        self,
        *,
        corpus_root: str | Path,
        system_prompt: str,
        navigation_files: Iterable[str] = (),
        chat_fn: Callable[..., ChatResult] | None = None,
        model: str = "",
        variant: str = "D1",
        seed_fn: Callable[[Query], Sequence[tuple[str, float]]] | None = None,
        seed_paths: Sequence[str] = (),
        tool_rounds: int = 3,
        max_candidates: int = 5,
        temperature: float = 0.0,
        spacing_seconds: float = 0.0,
        sleep: Callable[[float], None] | None = None,
        h5_signal: bool | None = None,
        trace_sink: Callable[[str, DTrace], None] | None = None,
    ) -> None:
        super().__init__(navigation_files=navigation_files)
        if variant not in ("D1", "D2"):
            raise BlockedError(f"未知 D 变体：{variant!r}，可选 D1 / D2")
        if h5_signal is None:
            raise BlockedError(
                "方案 D 需要显式传入 h5_signal：spec §8.6 规定只在 H5 有信号时运行，"
                "不得事后凑判据"
            )
        if not h5_signal:
            raise BlockedError(
                "H5 无信号，方案 D 不应运行（spec §8.6）：报告中写明「H5 无信号，D 未运行」"
            )
        self._box = ToolBox(corpus_root, navigation_files=tuple(navigation_files))
        self._system_prompt = system_prompt
        self._chat_fn = chat_fn
        self._model = model
        self._variant = variant
        self._seed_fn = seed_fn
        self._seed_paths = tuple(seed_paths)
        self._tool_rounds = tool_rounds
        self._max_candidates = max_candidates
        self._temperature = temperature
        self._spacing = spacing_seconds
        self._sleep = sleep or time.sleep
        self._trace_sink = trace_sink

    @property
    def variant(self) -> str:
        return self._variant

    def _seeds(self, query: Query) -> list[tuple[str, float]]:
        """种子候选：D1 用 C′，D2 用 A 与 C′ 的合并去重。"""

        if self._seed_fn is not None:
            return list(self._seed_fn(query))
        return list(self._seed_paths)

    def _run_tool(self, call: ToolCall) -> tuple[str, SubmitCall | None, dict[str, Any]]:
        args = call.arguments or {}
        record: dict[str, Any] = {"name": call.name, "arguments": args}

        if call.name == "submit":
            paths = args.get("paths")
            if not isinstance(paths, list):
                record["error"] = "invalid_argument"
                return (
                    '{"error": "invalid_argument", "message": "paths 必须是数组"}',
                    None,
                    record,
                )
            submitted = self._box.submit(
                [str(item) for item in paths],
                confidence=float(args.get("confidence") or 0.0),
                reason=str(args.get("reason") or ""),
            )
            record["submitted"] = list(submitted.paths)
            return (
                '{"ok": true, "accepted": %d}' % len(submitted.paths),
                submitted,
                record,
            )

        if call.name == "glob":
            result = self._box.glob(str(args.get("pattern") or ""))
        elif call.name == "grep":
            glob_pattern = args.get("glob")
            result = self._box.grep(
                str(args.get("pattern") or ""),
                str(glob_pattern) if glob_pattern else None,
            )
        elif call.name == "read":
            result = self._box.read(
                str(args.get("path") or ""),
                offset=int(args.get("offset") or 0),
                limit=args.get("limit"),
            )
        else:
            record["error"] = "unknown_tool"
            return (
                '{"error": "unknown_tool", "message": "可用工具：glob / grep / read / submit"}',
                None,
                record,
            )
        record["ok"] = result.ok
        return result.as_json(), None, record

    def _retrieve(
        self,
        query: Query,
        *,
        deadline_ms: float | None,
    ) -> tuple[str, list[Candidate], dict[str, float | int | bool]]:
        if self._chat_fn is None:
            raise BlockedError("方案 D 缺少模型客户端（精读阶段需要）")

        # ---- 阶段一：种子（纯本地） ----
        seed_started = time.perf_counter()
        seeds = self._seeds(query)
        seed_ms = (time.perf_counter() - seed_started) * 1000

        trace = DTrace(variant=self._variant)
        trace.seed_paths = tuple(path for path, _ in seeds)
        trace.seed_scores = tuple(score for _, score in seeds)

        extra: dict[str, float | int | bool] = {
            "variant": self._variant,
            "seed_ms": seed_ms,
            "seed_count": len(seeds),
            "input_tokens": 0,
            "output_tokens": 0,
            "cost_estimated": False,
        }

        if not seeds:
            extra["status_reason"] = "no_seed"
            return "no_match", [], extra

        # ---- 阶段二：精读（B 的工具循环） ----
        seed_block = "\n".join(
            f"{index + 1}. {path}" for index, path in enumerate(trace.seed_paths)
        )
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": self._system_prompt},
            {
                "role": "user",
                "content": (
                    f"用户问题：{query.text}\n\n"
                    f"以下是初步检索到的候选文件，请核实并重新排序，"
                    f"然后用 submit 提交最多 {self._max_candidates} 个最相关的：\n"
                    f"{seed_block}"
                ),
            },
        ]

        for round_index in range(self._tool_rounds):
            if round_index and self._spacing:
                self._sleep(self._spacing)

            result = self._chat_fn(
                messages,
                model=self._model,
                temperature=self._temperature,
                tools=TOOL_SCHEMAS,
            )
            trace.rounds += 1
            trace.input_tokens += result.usage.input_tokens
            trace.output_tokens += result.usage.output_tokens

            if not result.tool_calls:
                trace.stop_reason = f"no_tool_call:{result.finish_reason or 'unknown'}"
                break

            messages.append(
                {
                    "role": "assistant",
                    "content": result.content or "",
                    "tool_calls": [
                        {
                            "id": call.id,
                            "type": "function",
                            "function": {
                                "name": call.name,
                                "arguments": _dump_args(call.arguments),
                            },
                        }
                        for call in result.tool_calls
                    ],
                }
            )

            submitted: SubmitCall | None = None
            for call in result.tool_calls:
                text, maybe_submit, record = self._run_tool(call)
                trace.tool_calls.append(record)
                messages.append({"role": "tool", "tool_call_id": call.id, "content": text})
                if maybe_submit is not None and submitted is None:
                    submitted = maybe_submit

            if submitted is not None:
                trace.submitted = True
                trace.final_paths = submitted.paths
                trace.stop_reason = "submitted"
                extra.update(
                    {
                        "rounds": trace.rounds,
                        "input_tokens": trace.input_tokens,
                        "output_tokens": trace.output_tokens,
                    }
                )
                candidates = [
                    Candidate(path=path, score=1.0 - index * 0.01)
                    for index, path in enumerate(submitted.paths[: self._max_candidates])
                ]
                if self._trace_sink is not None:
                    self._trace_sink(query.id, trace)
                if not candidates:
                    extra["status_reason"] = "submitted_empty"
                    return "no_match", [], extra
                return "ok", candidates, extra

        if not trace.stop_reason:
            trace.stop_reason = "max_rounds_exhausted"
        extra.update(
            {
                "rounds": trace.rounds,
                "input_tokens": trace.input_tokens,
                "output_tokens": trace.output_tokens,
                "status_reason": trace.stop_reason,
            }
        )
        if self._trace_sink is not None:
            self._trace_sink(query.id, trace)
        return "timeout", [], extra


def _dump_args(arguments: dict[str, Any]) -> str:
    import json

    return json.dumps(arguments, ensure_ascii=False)
