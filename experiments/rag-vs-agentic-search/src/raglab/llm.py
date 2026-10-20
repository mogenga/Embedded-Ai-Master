"""模型接入（§8.2、§8.3、§9.2）。

约束：
- 走裸 HTTP（OpenAI 兼容），不引入厂商 SDK。
- 默认离线：未设置 ``RAGLAB_LIVE=1`` 时任何网络调用都抛 ``LiveGateError``；
  测试通过注入 ``httpx.MockTransport`` 覆盖。
- 本模块只负责"如何发请求"，方案要实现什么由 ``schemes`` 决定。
"""

from __future__ import annotations

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
class ChatResult:
    content: str
    usage: Usage
    raw: dict[str, Any]


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
        return ChatResult(content=content, usage=usage, raw=data)

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
