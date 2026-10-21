"""限流退避：必须服从网关自己给的 `retry_after`（2026-10-20 实测教训）。"""

from __future__ import annotations

import pytest

from raglab.chat_endpoint import ChatEndpoint, extract_retry_after
from raglab.config import ModelCandidate
from raglab.errors import LLMError
from raglab.llm import ChatResult, Usage

# 实测的 429 响应体（截断）
REAL_429 = (
    'LLMError: chat 重试 3 次仍失败：网关返回 429：{"error": {"message": '
    '"upstream rate limit reached for this model; retry in 56s - {\\"code\\":6020,'
    '\\"msg\\":\\"queue.waiting.title\\",\\"data\\":{\\"queue_position\\":6982,'
    '\\"queue_size\\":\\"999+\\",\\"retry_after\\":40,\\"estimated_wait\\":34910},'
    '\\"type\\":\\"rate_limit_error\\",\\"code\\": 429, \\"retry_after\\": 56}}'
)


def _candidate() -> ModelCandidate:
    return ModelCandidate(
        id="llm-1", kind="openai_compatible", base_url="http://x/v1", model="m"
    )


class _FlakyClient:
    """前 n 次调用失败，之后成功。"""

    def __init__(self, failures: int, message: str = "boom") -> None:
        self.failures = failures
        self.message = message
        self.calls = 0

    def chat(self, messages, **kwargs) -> ChatResult:
        self.calls += 1
        if self.calls <= self.failures:
            raise LLMError(self.message)
        return ChatResult(content="ok", usage=Usage(), raw={})


def test_extract_retry_after_from_real_429() -> None:
    assert extract_retry_after(REAL_429) == 56


def test_extract_retry_after_returns_none_when_absent() -> None:
    assert extract_retry_after("网关返回 500") is None
    assert extract_retry_after("") is None


def test_retry_uses_gateway_advised_delay(monkeypatch: pytest.MonkeyPatch) -> None:
    """退避必须用网关给的 56 秒，而不是自定的 20/40/60。"""

    slept: list[float] = []
    monkeypatch.setattr("time.sleep", lambda seconds: slept.append(seconds))
    client = _FlakyClient(failures=1, message=REAL_429)
    endpoint = ChatEndpoint(candidate=_candidate(), client=client)  # type: ignore[arg-type]

    result = endpoint.chat([{"role": "user", "content": "x"}])
    assert result.content == "ok"
    assert slept == [56.0], f"应等网关要求的 56s，实际 {slept}"


def test_falls_back_to_backoff_without_advice(monkeypatch: pytest.MonkeyPatch) -> None:
    slept: list[float] = []
    monkeypatch.setattr("time.sleep", lambda seconds: slept.append(seconds))
    client = _FlakyClient(failures=1, message="网关返回 500")
    endpoint = ChatEndpoint(candidate=_candidate(), client=client)  # type: ignore[arg-type]

    endpoint.chat([{"role": "user", "content": "x"}])
    assert slept == [20.0]


def test_gives_up_when_advised_delay_exceeds_cap(monkeypatch: pytest.MonkeyPatch) -> None:
    """网关要等很久时不能傻等——直接失败并把原因带出去。

    实测里 `estimated_wait` 折算过来接近 10 小时；`retry_after` 字段本身可能
    只有几十秒，但排队位置说明远不止。这里用一个超长的 `retry_after` 触发分支。
    """

    slept: list[float] = []
    monkeypatch.setattr("time.sleep", lambda seconds: slept.append(seconds))
    long_wait = '网关返回 429：{"retry_after": 34910}'
    client = _FlakyClient(failures=5, message=long_wait)
    endpoint = ChatEndpoint(
        candidate=_candidate(), client=client, max_backoff_seconds=300.0
    )  # type: ignore[arg-type]

    with pytest.raises(LLMError, match="超过退避上限"):
        endpoint.chat([{"role": "user", "content": "x"}])
    assert slept == [], "超过上限时不应再睡"


def test_exhausted_retries_raise_with_context(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("time.sleep", lambda seconds: None)
    client = _FlakyClient(failures=99, message="网关返回 500")
    endpoint = ChatEndpoint(candidate=_candidate(), client=client)  # type: ignore[arg-type]

    with pytest.raises(LLMError, match="重试 3 次仍失败"):
        endpoint.chat([{"role": "user", "content": "x"}])
    assert client.calls == 4  # 首次 + 3 次重试
