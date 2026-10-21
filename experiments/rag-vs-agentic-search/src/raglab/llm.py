"""模型接入（§8.2、§8.3、§9.2）。

约束：
- 走裸 HTTP（OpenAI 兼容），不引入厂商 SDK。
- 默认离线：未设置 ``RAGLAB_LIVE=1`` 时任何网络调用都抛 ``LiveGateError``；
  测试通过注入 ``httpx.MockTransport`` 覆盖。
- 本模块只负责"如何发请求"，方案要实现什么由 ``schemes`` 决定。
"""

from __future__ import annotations

import json
import os
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

import httpx

from .errors import LiveGateError, LLMError

LIVE_ENV = "RAGLAB_LIVE"
DEFAULT_TIMEOUT = 60.0


def live_enabled(env: Mapping[str, str] | None = None) -> bool:
    source = os.environ if env is None else env
    return source.get(LIVE_ENV) == "1"


def require_live(env: Mapping[str, str] | None = None) -> None:
    if not live_enabled(env):
        raise LiveGateError(
            f"live 调用被拒绝：设置 {LIVE_ENV}=1 后才允许访问模型网关"
        )


@dataclass(frozen=True)
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0
    estimated: bool = False


@dataclass(frozen=True)
class ToolCall:
    """模型发起的一次工具调用。``arguments`` 已解析为 dict（解析失败时为空 dict）。"""

    id: str
    name: str
    arguments: dict[str, Any]


@dataclass(frozen=True)
class ChatResult:
    content: str
    usage: Usage
    raw: dict[str, Any]
    tool_calls: tuple[ToolCall, ...] = ()
    finish_reason: str | None = None
    # 实测该网关会返回 reasoning_content；它不是答案，不进 content，但保留以便排查。
    reasoning: str | None = None

    @property
    def wants_tools(self) -> bool:
        return bool(self.tool_calls)


def _as_str(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _parse_tool_calls(message: dict[str, Any]) -> tuple[ToolCall, ...]:
    """解析 ``choices[0].message.tool_calls``。

    **参数 JSON 解析失败不抛错**：把它当作空参数交给调用方，由工具层返回结构化错误，
    让模型有机会自我纠正。抛异常会直接中断整轮循环。
    """

    raw_calls = message.get("tool_calls")
    if not isinstance(raw_calls, list):
        return ()

    parsed: list[ToolCall] = []
    for index, item in enumerate(raw_calls):
        if not isinstance(item, dict):
            continue
        function = item.get("function")
        if not isinstance(function, dict):
            continue
        name = function.get("name")
        if not isinstance(name, str) or not name:
            continue
        arguments_raw = function.get("arguments")
        arguments: dict[str, Any] = {}
        if isinstance(arguments_raw, dict):
            arguments = arguments_raw
        elif isinstance(arguments_raw, str) and arguments_raw.strip():
            try:
                loaded = json.loads(arguments_raw)
            except json.JSONDecodeError:
                loaded = None
            if isinstance(loaded, dict):
                arguments = loaded
        parsed.append(
            ToolCall(
                id=str(item.get("id") or f"call_{index}"),
                name=name,
                arguments=arguments,
            )
        )
    return tuple(parsed)


class OpenAIClient:
    """极简 OpenAI 兼容客户端：chat completions + embeddings。"""

    def __init__(
        self,
        base_url: str,
        *,
        api_key: str | None = None,
        client: httpx.Client | None = None,
        timeout: float = DEFAULT_TIMEOUT,
        env: Mapping[str, str] | None = None,
        require_live_gate: bool = True,
    ) -> None:
        if not base_url:
            raise LLMError("base_url 为空")
        self._env = env
        self._gate = require_live_gate
        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._client = client or httpx.Client(timeout=timeout)
        self._owns_client = client is None

    def __enter__(self) -> "OpenAIClient":
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"
        return headers

    def _check_gate(self) -> None:
        if self._gate:
            require_live(self._env)

    def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        self._check_gate()
        url = f"{self._base_url}{path}"
        try:
            response = self._client.post(url, json=payload, headers=self._headers())
        except httpx.HTTPError as exc:
            raise LLMError(f"请求失败：{url}：{exc}") from exc
        if response.status_code >= 400:
            raise LLMError(f"网关返回 {response.status_code}：{response.text[:500]}")
        try:
            data = response.json()
        except ValueError as exc:
            raise LLMError("网关响应不是合法 JSON") from exc
        if not isinstance(data, dict):
            raise LLMError("网关响应顶层不是对象")
        return data

    def chat(
        self,
        messages: Sequence[dict[str, Any]],
        *,
        model: str,
        temperature: float = 0.0,
        seed: int | None = None,
        tools: Sequence[dict[str, Any]] | None = None,
    ) -> ChatResult:
        payload: dict[str, Any] = {
            "model": model,
            "messages": list(messages),
            "temperature": temperature,
        }
        if seed is not None:
            payload["seed"] = seed
        if tools is not None:
            payload["tools"] = list(tools)

        data = self._post("/chat/completions", payload)
        try:
            message = data["choices"][0]["message"]
            content = message.get("content") or ""
        except (KeyError, IndexError, TypeError, AttributeError) as exc:
            raise LLMError("chat 响应缺少 choices[0].message.content") from exc

        usage_raw = data.get("usage") or {}
        usage = Usage(
            input_tokens=int(usage_raw.get("prompt_tokens", 0) or 0),
            output_tokens=int(usage_raw.get("completion_tokens", 0) or 0),
            estimated=False,
        )

        finish_reason = None
        try:
            finish_reason = data["choices"][0].get("finish_reason")
        except (KeyError, IndexError, TypeError):
            pass

        return ChatResult(
            content=content,
            usage=usage,
            raw=data,
            tool_calls=_parse_tool_calls(message),
            finish_reason=finish_reason if isinstance(finish_reason, str) else None,
            reasoning=_as_str(message.get("reasoning_content")),
        )

    def embed(self, texts: Sequence[str], *, model: str) -> list[list[float]]:
        payload = {"model": model, "input": list(texts)}
        data = self._post("/embeddings", payload)
        try:
            items = sorted(data["data"], key=lambda item: item.get("index", 0))
            vectors = [list(map(float, item["embedding"])) for item in items]
        except (KeyError, TypeError, ValueError) as exc:
            raise LLMError("embeddings 响应缺少 data[].embedding") from exc
        if len(vectors) != len(texts):
            raise LLMError(f"embeddings 返回数量不符：{len(vectors)} != {len(texts)}")
        return vectors
