"""方案 B：Agentic search（spec §8.3）。

一个 LLM 在多轮里用 glob/grep/read 找文件，最后用 submit 提交候选。

三条硬约束，都有测试守着：

1. **必须 submit**。没提交就是 ``timeout``，按 ITT 计 miss——不能把"模型说了点什么"
   当成找到了答案。
2. **轮数上限**来自预注册网格。达到上限仍在调工具 → ``timeout``。
3. **工具调用的消息必须回灌**。每一步都要把 assistant 的 tool_calls 与对应的
   tool 结果按顺序放回 messages，否则模型会反复调同一个工具。

限流是这个方案的决定性约束（约 4 次/分钟），所以调用间隔由外部注入的
``sleep`` 控制，默认不睡——真实跑批时才设 ``spacing_seconds``。
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

# 提交之外的工具名；submit 单独处理（它终结循环）。
_ACTION_TOOLS = ("glob", "grep", "read")


@dataclass
class AgentTrace:
    """一次查询的完整轨迹，用于事后审计与失败归因。"""

    rounds: int = 0
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    submitted: bool = False
    submit_paths: tuple[str, ...] = ()
    confidence: float = 0.0
    reason: str = ""
    input_tokens: int = 0
    output_tokens: int = 0
    stop_reason: str = ""
    final_content: str = ""


class SchemeB(RetrievalScheme):
    """Agentic 检索：多轮工具调用 → submit。"""

    key = "B"
    display_name = "Agentic search"

    def __init__(
        self,
        *,
        corpus_root: str | Path,
        system_prompt: str,
        navigation_files: Iterable[str] = (),
        chat_fn: Callable[..., ChatResult] | None = None,
        model: str = "",
        max_tool_rounds: int = 12,
        max_candidates: int = 5,
        temperature: float = 0.0,
        spacing_seconds: float = 0.0,
        sleep: Callable[[float], None] | None = None,
        trace_sink: Callable[[str, AgentTrace], None] | None = None,
    ) -> None:
        super().__init__(navigation_files=navigation_files)
        self._box = ToolBox(corpus_root, navigation_files=tuple(navigation_files))
        self._system_prompt = system_prompt
        self._chat_fn = chat_fn
        self._model = model
        self._max_rounds = max_tool_rounds
        self._max_candidates = max_candidates
        self._temperature = temperature
        self._spacing = spacing_seconds
        self._sleep = sleep or time.sleep
        self._trace_sink = trace_sink

    # ---- 工具执行 ---------------------------------------------------------

    def _run_tool(self, call: ToolCall) -> tuple[str, SubmitCall | None, dict[str, Any]]:
        """执行一次工具调用，返回 (给模型看的文本, submit 结果或 None, 轨迹记录)。"""

        args = call.arguments or {}
        record: dict[str, Any] = {"name": call.name, "arguments": args}

        if call.name == "submit":
            paths = args.get("paths")
            if not isinstance(paths, list):
                result_text = '{"error": "invalid_argument", "message": "paths 必须是数组"}'
                record["error"] = "invalid_argument"
                return result_text, None, record
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
            result_text = (
                '{"error": "unknown_tool", "message": "可用工具：glob / grep / read / submit"}'
            )
            record["error"] = "unknown_tool"
            return result_text, None, record

        record["ok"] = result.ok
        return result.as_json(), None, record

    # ---- 主循环 -----------------------------------------------------------

    def _retrieve(
        self,
        query: Query,
        *,
        deadline_ms: float | None,
    ) -> tuple[str, list[Candidate], dict[str, float | int | bool]]:
        if self._chat_fn is None:
            raise BlockedError(
                "方案 B 缺少模型客户端：需配置 models.yaml 的 LLM 候选并设置 RAGLAB_LIVE=1"
            )

        trace = AgentTrace()
        messages: list[dict[str, Any]] = [
            {"role": "system", "content": self._system_prompt},
            {"role": "user", "content": query.text},
        ]

        extra: dict[str, float | int | bool] = {
            "max_tool_rounds": self._max_rounds,
            "input_tokens": 0,
            "output_tokens": 0,
            "cost_estimated": False,
        }

        for round_index in range(self._max_rounds):
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
            trace.final_content = result.content

            if not result.tool_calls:
                # 模型不调工具了。若此前已 submit，循环早已 return；到这里就是没提交。
                trace.stop_reason = f"no_tool_call:{result.finish_reason or 'unknown'}"
                break

            # 把 assistant 的 tool_calls 原样回灌——少了这一步模型会重复调同一个工具。
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
                messages.append(
                    {"role": "tool", "tool_call_id": call.id, "content": text}
                )
                if maybe_submit is not None and submitted is None:
                    # 同一轮的多个 submit 只认第一个。
                    submitted = maybe_submit

            if submitted is not None:
                trace.submitted = True
                trace.submit_paths = submitted.paths
                trace.confidence = submitted.confidence
                trace.reason = submitted.reason
                trace.stop_reason = "submitted"
                extra.update(
                    {
                        "rounds": trace.rounds,
                        "input_tokens": trace.input_tokens,
                        "output_tokens": trace.output_tokens,
                        "confidence": submitted.confidence,
                        "reason": submitted.reason,
                    }
                )
                candidates = [
                    Candidate(path=path, score=1.0 - index * 0.01)
                    for index, path in enumerate(
                        submitted.paths[: self._max_candidates]
                    )
                ]
                self._emit(query, trace)
                if not candidates:
                    # 提交了但全部无效——如实报 no_match，不伪造候选。
                    extra["status_reason"] = "submitted_empty"
                    return "no_match", [], extra
                return "ok", candidates, extra

        # 轮数耗尽或模型停止调工具但没提交。
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
        self._emit(query, trace)
        return "timeout", [], extra

    def _emit(self, query: Query, trace: AgentTrace) -> None:
        if self._trace_sink is not None:
            self._trace_sink(query.id, trace)


def _dump_args(arguments: dict[str, Any]) -> str:
    import json

    return json.dumps(arguments, ensure_ascii=False)


def load_system_prompt(path: str | Path) -> str:
    """读 system prompt；缺失即报错，不用内置文案兜底（T10 要求逐字冻结）。"""

    target = Path(path)
    if not target.is_file():
        raise BlockedError(f"缺少 agentic system prompt：{target}")
    return target.read_text(encoding="utf-8")
