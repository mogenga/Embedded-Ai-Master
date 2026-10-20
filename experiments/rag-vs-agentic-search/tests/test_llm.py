"""模型客户端（离线）：live 门禁与 MockTransport（§9.2）。"""

from __future__ import annotations

import httpx
import pytest

from raglab.errors import LiveGateError, LLMError
from raglab.llm import OpenAIClient, live_enabled, require_live


def test_live_gate_defaults_off(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("RAGLAB_LIVE", raising=False)
    assert live_enabled() is False
    with pytest.raises(LiveGateError):
        require_live()


def test_live_gate_only_accepts_exact_one(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RAGLAB_LIVE", "true")
    assert live_enabled() is False
    monkeypatch.setenv("RAGLAB_LIVE", "1")
    assert live_enabled() is True


def _mock_client(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_chat_parses_content_and_usage() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path.endswith("/chat/completions")
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": "hello"}}],
                "usage": {"prompt_tokens": 11, "completion_tokens": 5},
            },
        )

    client = OpenAIClient(
        "http://gateway.local/v1",
        client=_mock_client(handler),
        require_live_gate=False,
    )
    result = client.chat([{"role": "user", "content": "hi"}], model="m")
    assert result.content == "hello"
    assert result.usage.input_tokens == 11
    assert result.usage.output_tokens == 5
    assert result.usage.estimated is False


def test_chat_blocks_when_live_gate_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("RAGLAB_LIVE", raising=False)

    def handler(request: httpx.Request) -> httpx.Response:  # pragma: no cover
        raise AssertionError("门禁关闭时不应发起请求")

    client = OpenAIClient("http://gateway.local/v1", client=_mock_client(handler))
    with pytest.raises(LiveGateError):
        client.chat([{"role": "user", "content": "hi"}], model="m")


def test_chat_surfaces_gateway_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="boom")

    client = OpenAIClient(
        "http://gateway.local/v1", client=_mock_client(handler), require_live_gate=False
    )
    with pytest.raises(LLMError):
        client.chat([{"role": "user", "content": "hi"}], model="m")


def test_chat_rejects_malformed_response() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"choices": []})

    client = OpenAIClient(
        "http://gateway.local/v1", client=_mock_client(handler), require_live_gate=False
    )
    with pytest.raises(LLMError):
        client.chat([{"role": "user", "content": "hi"}], model="m")


def test_embed_orders_by_index_and_checks_count() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={
                "data": [
                    {"index": 1, "embedding": [0.0, 1.0]},
                    {"index": 0, "embedding": [1.0, 0.0]},
                ]
            },
        )

    client = OpenAIClient(
        "http://gateway.local/v1", client=_mock_client(handler), require_live_gate=False
    )
    vectors = client.embed(["a", "b"], model="e")
    assert vectors == [[1.0, 0.0], [0.0, 1.0]]


def test_embed_count_mismatch_is_error() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"data": [{"index": 0, "embedding": [1.0]}]})

    client = OpenAIClient(
        "http://gateway.local/v1", client=_mock_client(handler), require_live_gate=False
    )
    with pytest.raises(LLMError):
        client.embed(["a", "b"], model="e")
