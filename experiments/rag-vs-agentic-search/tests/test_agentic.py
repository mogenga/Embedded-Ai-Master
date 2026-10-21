"""方案 B 与工具面（§8.3）。

全部离线：`chat_fn` 一律用脚本化假实现，绝不触网。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from raglab.assets import Query
from raglab.errors import BlockedError
from raglab.llm import ChatResult, ToolCall, Usage
from raglab.schemes.agentic import AgentTrace, SchemeB, load_system_prompt
from raglab.tools import MAX_SUBMIT_PATHS, ToolBox

PROMPT = "你是知识库检索助手。"


def _corpus(tmp_path: Path) -> Path:
    root = tmp_path / "kb"
    (root / "protocols").mkdir(parents=True)
    (root / "reference").mkdir()
    (root / "protocols" / "uart.md").write_text(
        "# 串口无输出\n接线共地很关键。\n", encoding="utf-8"
    )
    (root / "reference" / "regs.md").write_text(
        "# 寄存器\nUSART_BRR 0x271\n", encoding="utf-8"
    )
    (root / "_sources.md").write_text("# 来源\n串口资料\n", encoding="utf-8")
    return root


def _query() -> Query:
    return Query(
        id="idx-001", track="index", text="串口没输出", gold=("protocols/uart.md",),
        topic="protocols",
    )


def _result(content: str = "", calls: tuple[ToolCall, ...] = (), finish: str | None = None) -> ChatResult:
    return ChatResult(
        content=content,
        usage=Usage(input_tokens=10, output_tokens=5),
        raw={},
        tool_calls=calls,
        finish_reason=finish,
    )


class _ScriptedChat:
    """按预置脚本返回；同时记录每次收到的 messages 以便断言回灌。"""

    def __init__(self, script: list[ChatResult]) -> None:
        self._script = list(script)
        self.calls: list[list[dict[str, Any]]] = []

    def __call__(self, messages, **kwargs: Any) -> ChatResult:
        self.calls.append([dict(message) for message in messages])
        if not self._script:
            return _result("done", finish="stop")
        return self._script.pop(0)


# ---- 工具面 ----------------------------------------------------------------


def test_glob_lists_markdown(tmp_path: Path) -> None:
    box = ToolBox(_corpus(tmp_path))
    result = box.glob("**/*.md")
    assert result.ok
    assert "protocols/uart.md" in result.payload["matches"]


def test_glob_never_exposes_navigation_files(tmp_path: Path) -> None:
    box = ToolBox(_corpus(tmp_path), navigation_files=("_sources.md",))
    matches = box.glob("*.md").payload["matches"]
    assert "_sources.md" not in matches


def test_grep_finds_line_and_path(tmp_path: Path) -> None:
    box = ToolBox(_corpus(tmp_path))
    payload = box.grep("USART_BRR").payload
    assert payload["found"] is True
    assert payload["hits"][0]["path"] == "reference/regs.md"


def test_grep_skips_navigation_files(tmp_path: Path) -> None:
    box = ToolBox(_corpus(tmp_path), navigation_files=("_sources.md",))
    payload = box.grep("串口").payload
    assert all(hit["path"] != "_sources.md" for hit in payload["hits"])


def test_grep_rejects_invalid_regex(tmp_path: Path) -> None:
    box = ToolBox(_corpus(tmp_path))
    result = box.grep("[unclosed")
    assert result.ok is False
    assert result.payload["error"] == "invalid_regex"


def test_grep_truncates_at_limit(tmp_path: Path) -> None:
    root = _corpus(tmp_path)
    for index in range(200):
        (root / "reference" / f"f{index}.md").write_text("needle\n", encoding="utf-8")
    box = ToolBox(root)
    payload = box.grep("needle").payload
    assert payload["truncated"] is True
    assert payload["count"] == 100


def test_read_returns_window(tmp_path: Path) -> None:
    box = ToolBox(_corpus(tmp_path))
    payload = box.read("protocols/uart.md", offset=0, limit=1).payload
    assert payload["lines"] == 1
    assert "串口无输出" in payload["content"]


def test_read_reports_truncation(tmp_path: Path) -> None:
    root = _corpus(tmp_path)
    (root / "reference" / "long.md").write_text("\n".join(f"line{i}" for i in range(3000)), encoding="utf-8")
    payload = ToolBox(root).read("reference/long.md").payload
    assert payload["truncated"] is True
    assert payload["lines"] <= 2000


def test_read_denies_escape(tmp_path: Path) -> None:
    box = ToolBox(_corpus(tmp_path))
    for bad in ("../secret.md", "/etc/passwd", "C:/x.md", ""):
        result = box.read(bad)
        assert result.ok is False
        assert result.payload["error"] == "path_denied"


def test_read_missing_file_is_error_not_empty(tmp_path: Path) -> None:
    """R3：读失败必须显式报错，不能返回空内容冒充"读到了"。"""

    result = ToolBox(_corpus(tmp_path)).read("protocols/nope.md")
    assert result.ok is False


def test_submit_drops_invalid_and_navigation_paths(tmp_path: Path) -> None:
    box = ToolBox(_corpus(tmp_path), navigation_files=("_sources.md",))
    call = box.submit(
        ["protocols/uart.md", "_sources.md", "missing.md", "protocols/uart.md"], reason="ok"
    )
    assert call.paths == ("protocols/uart.md",)
    assert "已丢弃无效路径" in call.reason


def test_submit_caps_candidate_count(tmp_path: Path) -> None:
    root = _corpus(tmp_path)
    for index in range(10):
        (root / "reference" / f"g{index}.md").write_text("x", encoding="utf-8")
    paths = [f"reference/g{index}.md" for index in range(10)]
    call = ToolBox(root).submit(paths)
    assert len(call.paths) == MAX_SUBMIT_PATHS


def test_submit_clamps_confidence(tmp_path: Path) -> None:
    box = ToolBox(_corpus(tmp_path))
    assert box.submit(["protocols/uart.md"], confidence=5.0).confidence == 1.0
    assert box.submit(["protocols/uart.md"], confidence=-1.0).confidence == 0.0


# ---- 主循环 ----------------------------------------------------------------


def _scheme(tmp_path: Path, script: list[ChatResult], **kwargs: Any) -> tuple[SchemeB, _ScriptedChat]:
    chat = _ScriptedChat(script)
    scheme = SchemeB(
        corpus_root=_corpus(tmp_path),
        system_prompt=PROMPT,
        navigation_files=("_sources.md",),
        chat_fn=chat,
        model="m",
        **kwargs,
    )
    return scheme, chat


def test_submit_produces_ok_result(tmp_path: Path) -> None:
    scheme, _ = _scheme(
        tmp_path,
        [_result(calls=(ToolCall("c1", "submit", {"paths": ["protocols/uart.md"]}),), finish="tool_calls")],
    )
    result = scheme.run(_query())
    assert result.status == "ok"
    assert result.paths == ("protocols/uart.md",)


def test_no_submit_is_timeout_not_ok(tmp_path: Path) -> None:
    """没调用 submit 就是未完成，按 ITT 计 miss——不能把"说了点什么"当成找到了。"""

    scheme, _ = _scheme(tmp_path, [_result("我觉得是 protocols/uart.md", finish="stop")])
    result = scheme.run(_query())
    assert result.status == "timeout"
    assert result.paths == ()


def test_max_rounds_exhausted_is_timeout(tmp_path: Path) -> None:
    endless = [
        _result(calls=(ToolCall(f"c{i}", "glob", {"pattern": "**/*.md"}),), finish="tool_calls")
        for i in range(10)
    ]
    scheme, chat = _scheme(tmp_path, endless, max_tool_rounds=3)
    result = scheme.run(_query())
    assert result.status == "timeout"
    assert result.extra["status_reason"] == "max_rounds_exhausted"
    assert len(chat.calls) == 3


def test_tool_results_are_fed_back(tmp_path: Path) -> None:
    """每一步的 tool 结果必须按 tool_call_id 回灌，否则模型会重复调同一个工具。"""

    scheme, chat = _scheme(
        tmp_path,
        [
            _result(calls=(ToolCall("c1", "grep", {"pattern": "串口"}),), finish="tool_calls"),
            _result(calls=(ToolCall("c2", "submit", {"paths": ["protocols/uart.md"]}),), finish="tool_calls"),
        ],
    )
    scheme.run(_query())

    second_round = chat.calls[1]
    tool_messages = [message for message in second_round if message.get("role") == "tool"]
    assert tool_messages, "第二轮必须包含 tool 结果消息"
    assert tool_messages[0]["tool_call_id"] == "c1"
    assert "hits" in tool_messages[0]["content"]


def test_assistant_tool_calls_are_echoed_back(tmp_path: Path) -> None:
    scheme, chat = _scheme(
        tmp_path,
        [
            _result(calls=(ToolCall("c1", "glob", {"pattern": "**/*.md"}),), finish="tool_calls"),
            _result(calls=(ToolCall("c2", "submit", {"paths": ["protocols/uart.md"]}),), finish="tool_calls"),
        ],
    )
    scheme.run(_query())

    assistant_messages = [
        message for message in chat.calls[1] if message.get("role") == "assistant"
    ]
    assert assistant_messages
    echoed = assistant_messages[0]["tool_calls"][0]
    assert echoed["id"] == "c1"
    assert echoed["function"]["name"] == "glob"


def test_unknown_tool_reports_error_and_continues(tmp_path: Path) -> None:
    scheme, _ = _scheme(
        tmp_path,
        [
            _result(calls=(ToolCall("c1", "explode", {}),), finish="tool_calls"),
            _result(calls=(ToolCall("c2", "submit", {"paths": ["protocols/uart.md"]}),), finish="tool_calls"),
        ],
    )
    result = scheme.run(_query())
    assert result.status == "ok"
    assert result.extra["rounds"] == 2


def test_submit_with_no_valid_paths_is_no_match(tmp_path: Path) -> None:
    scheme, _ = _scheme(
        tmp_path,
        [_result(calls=(ToolCall("c1", "submit", {"paths": ["missing.md"]}),), finish="tool_calls")],
    )
    result = scheme.run(_query())
    assert result.status == "no_match"
    assert result.extra["status_reason"] == "submitted_empty"


def test_submit_with_non_list_paths_is_rejected(tmp_path: Path) -> None:
    scheme, _ = _scheme(
        tmp_path,
        [
            _result(calls=(ToolCall("c1", "submit", {"paths": "protocols/uart.md"}),), finish="tool_calls"),
            _result(calls=(ToolCall("c2", "submit", {"paths": ["protocols/uart.md"]}),), finish="tool_calls"),
        ],
    )
    result = scheme.run(_query())
    assert result.status == "ok", "模型应有机会在下一轮纠正"


def test_tokens_are_accumulated(tmp_path: Path) -> None:
    scheme, _ = _scheme(
        tmp_path,
        [
            _result(calls=(ToolCall("c1", "glob", {"pattern": "**/*.md"}),), finish="tool_calls"),
            _result(calls=(ToolCall("c2", "submit", {"paths": ["protocols/uart.md"]}),), finish="tool_calls"),
        ],
    )
    result = scheme.run(_query())
    assert result.input_tokens == 20
    assert result.output_tokens == 10


def test_spacing_sleeps_between_rounds_only(tmp_path: Path) -> None:
    slept: list[float] = []
    scheme, _ = _scheme(
        tmp_path,
        [
            _result(calls=(ToolCall("c1", "glob", {"pattern": "**/*.md"}),), finish="tool_calls"),
            _result(calls=(ToolCall("c2", "submit", {"paths": ["protocols/uart.md"]}),), finish="tool_calls"),
        ],
        spacing_seconds=15.0,
        sleep=slept.append,
    )
    scheme.run(_query())
    assert slept == [15.0], "第一轮之前不睡，第二轮之前睡一次"


def test_trace_is_emitted(tmp_path: Path) -> None:
    traces: list[tuple[str, AgentTrace]] = []
    scheme, _ = _scheme(
        tmp_path,
        [_result(calls=(ToolCall("c1", "submit", {"paths": ["protocols/uart.md"], "confidence": 0.8}),), finish="tool_calls")],
        trace_sink=lambda query_id, trace: traces.append((query_id, trace)),
    )
    scheme.run(_query())
    assert traces
    query_id, trace = traces[0]
    assert query_id == "idx-001"
    assert trace.submitted is True
    assert trace.confidence == 0.8


def test_missing_chat_client_raises(tmp_path: Path) -> None:
    scheme = SchemeB(corpus_root=_corpus(tmp_path), system_prompt=PROMPT)
    with pytest.raises(BlockedError, match="模型客户端"):
        scheme.run(_query())


# ---- prompt ----------------------------------------------------------------


def test_load_system_prompt_missing_file_raises(tmp_path: Path) -> None:
    """缺失即报错，不用内置文案兜底——T10 要求提示词逐字冻结。"""

    with pytest.raises(BlockedError, match="system prompt"):
        load_system_prompt(tmp_path / "nope.txt")
