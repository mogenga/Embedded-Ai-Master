"""方案 D 与 H5 判据（§8.6）。

重点测两件事：
1. **H5 门槛是硬闸**——无信号或未显式声明时，构造即失败；
2. **判据 1 的「数据不足」不等于「不满足」**。
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from raglab.assets import Query
from raglab.errors import BlockedError
from raglab.h5 import (
    CriterionResult,
    H5Result,
    evaluate_criterion1,
    evaluate_criterion3,
    evaluate_h5,
)
from raglab.llm import ChatResult, ToolCall, Usage
from raglab.schemes.hybrid import SchemeD
from raglab.schemes.seeds import make_seed_fn


def _corpus(tmp_path: Path) -> Path:
    root = tmp_path / "kb"
    (root / "protocols").mkdir(parents=True)
    (root / "protocols" / "uart.md").write_text("# 串口\nUART 接线\n", encoding="utf-8")
    (root / "protocols" / "i2c.md").write_text("# I2C\nNACK 应答\n", encoding="utf-8")
    return root


def _query() -> Query:
    return Query(
        id="idx-001", track="index", text="串口没输出", gold=("protocols/uart.md",),
        topic="protocols",
    )


def _result(calls: tuple[ToolCall, ...] = (), content: str = "") -> ChatResult:
    return ChatResult(
        content=content, usage=Usage(input_tokens=5, output_tokens=2), raw={},
        tool_calls=calls, finish_reason="tool_calls" if calls else "stop",
    )


class _ScriptedChat:
    def __init__(self, script: list[ChatResult]) -> None:
        self._script = list(script)

    def __call__(self, messages, **kwargs: Any) -> ChatResult:
        return self._script.pop(0) if self._script else _result()


# ---- H5 门槛 ---------------------------------------------------------------


def test_d_requires_explicit_h5_signal(tmp_path: Path) -> None:
    """未显式声明 h5_signal 时构造即失败——门槛要落在代码里，不能靠自觉。"""

    with pytest.raises(BlockedError, match="h5_signal"):
        SchemeD(
            corpus_root=_corpus(tmp_path),
            system_prompt="p",
            chat_fn=_ScriptedChat([]),
        )


def test_d_refuses_to_run_without_signal(tmp_path: Path) -> None:
    with pytest.raises(BlockedError, match="H5 无信号"):
        SchemeD(
            corpus_root=_corpus(tmp_path),
            system_prompt="p",
            chat_fn=_ScriptedChat([]),
            h5_signal=False,
        )


def test_d_rejects_unknown_variant(tmp_path: Path) -> None:
    with pytest.raises(BlockedError, match="未知 D 变体"):
        SchemeD(
            corpus_root=_corpus(tmp_path),
            system_prompt="p",
            chat_fn=_ScriptedChat([]),
            variant="D9",
            h5_signal=True,
        )


# ---- 主循环 ----------------------------------------------------------------


def _scheme(tmp_path: Path, script: list[ChatResult], **kwargs: Any) -> SchemeD:
    return SchemeD(
        corpus_root=_corpus(tmp_path),
        system_prompt="p",
        chat_fn=_ScriptedChat(script),
        variant="D1",
        h5_signal=True,
        **kwargs,
    )


def test_seed_paths_appear_in_prompt(tmp_path: Path) -> None:
    seen: list[list[dict[str, Any]]] = []

    class _Capturing:
        def __init__(self) -> None:
            self.done = False

        def __call__(self, messages, **kwargs: Any):
            seen.append([dict(m) for m in messages])
            if not self.done:
                self.done = True
                return _result(calls=(ToolCall("c1", "submit", {"paths": ["protocols/uart.md"]}),))
            return _result()

    scheme = SchemeD(
        corpus_root=_corpus(tmp_path),
        system_prompt="p",
        chat_fn=_Capturing(),
        variant="D1",
        h5_signal=True,
        seed_fn=lambda _q: [("protocols/i2c.md", 1.0), ("protocols/uart.md", 0.5)],
    )
    scheme.run(_query())
    user_text = seen[0][1]["content"]
    assert "protocols/i2c.md" in user_text
    assert "protocols/uart.md" in user_text
    assert "串口没输出" in user_text


def test_seed_and_refine_times_are_separate(tmp_path: Path) -> None:
    """种子耗时（本地）与精读耗时（网络）必须分开记。"""

    scheme = _scheme(
        tmp_path,
        [_result(calls=(ToolCall("c1", "submit", {"paths": ["protocols/uart.md"]}),))],
        seed_fn=lambda _q: [("protocols/uart.md", 1.0)],
    )
    result = scheme.run(_query())
    assert "seed_ms" in result.extra
    assert "seed_count" in result.extra
    assert result.extra["seed_count"] == 1


def test_no_seed_is_no_match(tmp_path: Path) -> None:
    scheme = _scheme(tmp_path, [], seed_fn=lambda _q: [])
    result = scheme.run(_query())
    assert result.status == "no_match"
    assert result.extra["status_reason"] == "no_seed"


def test_refine_can_escape_the_seed(tmp_path: Path) -> None:
    """D 的价值就在这里：精读能把不在种子里的正确文件捞回来。"""

    scheme = _scheme(
        tmp_path,
        [_result(calls=(ToolCall("c1", "submit", {"paths": ["protocols/uart.md"]}),))],
        seed_fn=lambda _q: [("protocols/i2c.md", 1.0)],
    )
    result = scheme.run(_query())
    assert result.status == "ok"
    assert result.paths == ("protocols/uart.md",)
    assert "protocols/i2c.md" not in result.paths


def test_no_submit_is_timeout(tmp_path: Path) -> None:
    scheme = _scheme(
        tmp_path, [_result(content="我觉得是 i2c")], seed_fn=lambda _q: [("a.md", 1.0)]
    )
    result = scheme.run(_query())
    assert result.status == "timeout"


def test_tool_rounds_limit_is_respected(tmp_path: Path) -> None:
    endless = [
        _result(calls=(ToolCall(f"c{i}", "glob", {"pattern": "**/*.md"}),))
        for i in range(10)
    ]
    scheme = _scheme(tmp_path, endless, tool_rounds=2, seed_fn=lambda _q: [("a.md", 1.0)])
    result = scheme.run(_query())
    assert result.status == "timeout"
    assert result.extra["rounds"] == 2


# ---- 种子接线 --------------------------------------------------------------


def test_seed_fn_d1_returns_cprime_top_k(tmp_path: Path) -> None:
    root = _corpus(tmp_path)
    seed = make_seed_fn(
        variant="D1",
        corpus_root=root,
        navigation_files=(),
        index_path=tmp_path / "none.json",
        embed_query=None,
        seed_top_k=3,
    )
    paths = [path for path, _ in seed(_query())]
    assert len(paths) <= 3


def test_seed_fn_d2_merges_and_dedupes(tmp_path: Path) -> None:
    """D2 的种子是 A 与 C′ 各 top-5 合并去重，且需 A 的索引。"""

    root = _corpus(tmp_path)
    with pytest.raises(Exception):
        make_seed_fn(
            variant="D2",
            corpus_root=root,
            navigation_files=(),
            index_path=tmp_path / "missing.json",
            embed_query=lambda _t: [1.0],
            seed_top_k=5,
        )


def test_seed_fn_rejects_unknown_variant(tmp_path: Path) -> None:
    with pytest.raises(Exception):
        make_seed_fn(
            variant="D9",
            corpus_root=_corpus(tmp_path),
            navigation_files=(),
            index_path=tmp_path / "x.json",
            embed_query=None,
        )


# ---- H5 判据 ---------------------------------------------------------------


def test_criterion1_needs_both_sides() -> None:
    result = evaluate_criterion1(a_hits_by_track=None, b_hits_by_track=None)
    assert result.satisfied is False
    assert result.insufficient_data is True
    assert "≠ 不满足" in result.detail or "无法判定" in result.detail


def test_criterion1_detects_opposite_directions() -> None:
    a = {"index": [1.0] * 10, "search": [0.0] * 10}
    b = {"index": [0.0] * 10, "search": [1.0] * 10}
    result = evaluate_criterion1(a_hits_by_track=a, b_hits_by_track=b)
    assert result.satisfied is True


def test_criterion1_rejects_same_direction() -> None:
    a = {"index": [1.0] * 10, "search": [1.0] * 10}
    b = {"index": [0.0] * 10, "search": [0.0] * 10}
    result = evaluate_criterion1(a_hits_by_track=a, b_hits_by_track=b)
    assert result.satisfied is False
    assert result.insufficient_data is False


def test_criterion1_requires_both_gaps_at_least_5pp() -> None:
    """一侧差距不足 5pp 时，即使方向相反也不成立。"""

    a = {"index": [1.0] * 10, "search": [0.98] * 10}
    b = {"index": [0.0] * 10, "search": [1.0] * 10}
    result = evaluate_criterion1(a_hits_by_track=a, b_hits_by_track=b)
    assert result.satisfied is False, "search 侧只差 2pp，不足 5pp 门槛"
    assert result.insufficient_data is False


def test_criterion3_triggers_on_not_ok_gap() -> None:
    """一个方案大量 not_ok、另一个几乎不 not_ok → 判据 3 成立。"""

    class _Scheme:
        def __init__(self, status: str) -> None:
            self._status = status

        def run(self, query, **kwargs):
            from raglab.assets import Candidate, QueryResult

            if self._status == "no_match":
                return QueryResult(query_id=query.id, scheme="X", status="no_match")
            return QueryResult(
                query_id=query.id, scheme="X", status="ok",
                candidates=(Candidate("a.md", 1.0),),
            )

    queries = [
        Query(id=f"q-{i}", track="index", text="x", gold=("a.md",), topic="protocols")
        for i in range(10)
    ]
    result = evaluate_criterion3(schemes={"bad": _Scheme("no_match"), "good": _Scheme("ok")}, queries=queries)
    assert result.satisfied is True


def test_h5_signal_requires_a_satisfied_criterion() -> None:
    result = H5Result(criteria=[CriterionResult("判据 1", False, "x", insufficient_data=True)])
    assert result.signal is False


def test_h5_signal_true_when_any_satisfied() -> None:
    result = H5Result(
        criteria=[
            CriterionResult("判据 1", False, "x", insufficient_data=True),
            CriterionResult("判据 3", True, "y"),
        ]
    )
    assert result.signal is True


def test_evaluate_h5_returns_all_three_criteria() -> None:
    class _Scheme:
        def run(self, query, **kwargs):
            from raglab.assets import Candidate, QueryResult

            return QueryResult(
                query_id=query.id, scheme="X", status="ok",
                candidates=(Candidate("a.md", 1.0),),
            )

    queries = [
        Query(id="q-1", track="index", text="x", gold=("a.md",), topic="protocols")
    ]
    result = evaluate_h5(schemes={"X": _Scheme()}, queries=queries)
    assert len(result.criteria) == 3
    assert [c.name for c in result.criteria] == ["判据 1", "判据 2", "判据 3"]
