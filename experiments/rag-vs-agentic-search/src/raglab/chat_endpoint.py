"""LLM 端点接线（M4）。

与 `embedding.py` 同构：从 `models.yaml` 取第一个可用候选，构造带退避的 chat 函数。

**限流退避是这里的核心**：网关实测串行单线程、间隔 ≥ 15s 才稳定，突发与并发
成功率均为 0。重试耗尽后抛 ``LLMError``——由 runner 按 §9.4 判定是否中止整批。
"""

from __future__ import annotations

import re
import time
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from .config import ModelCandidate
from .errors import BlockedError, ConfigurationError, LLMError
from .llm import ChatResult, OpenAIClient

DEFAULT_MAX_RETRIES = 3
DEFAULT_BACKOFF_SECONDS = 20.0
# 单次退避的上限。超过就不等了——网关说要等 9.7 小时，等下去没有意义。
DEFAULT_MAX_BACKOFF_SECONDS = 300.0

_RETRY_AFTER = re.compile(r'\\?"retry_after\\?"\s*:\s*(\d+)')


def extract_retry_after(message: str) -> int | None:
    """从网关错误里取 `retry_after` 秒数；取不到返回 None。

    实测该网关的 429 响应体同时带 `retry_after`（秒）与 `estimated_wait`（毫秒），
    前者才是应当遵守的等待时长。

    **取最后一个匹配**：实测响应里 `data` 内层还有一个 `"retry_after": 40`，
    而顶层是 `"retry_after": 56`。顶层那个才是网关要求等待的时长。
    还要兼容 JSON 内嵌时被转义成 `\\"retry_after\\"` 的情况。
    """

    matches = _RETRY_AFTER.findall(message)
    if not matches:
        return None
    try:
        return int(matches[-1])
    except ValueError:  # pragma: no cover —— 正则已保证是数字
        return None


@dataclass(frozen=True)
class ChatEndpoint:
    candidate: ModelCandidate
    client: OpenAIClient
    max_retries: int = DEFAULT_MAX_RETRIES
    backoff_seconds: float = DEFAULT_BACKOFF_SECONDS
    max_backoff_seconds: float = DEFAULT_MAX_BACKOFF_SECONDS

    @property
    def model_id(self) -> str:
        return str(self.candidate.model)

    def chat(
        self,
        messages: Sequence[dict[str, Any]],
        *,
        model: str | None = None,
        temperature: float = 0.0,
        tools: Sequence[dict[str, Any]] | None = None,
    ) -> ChatResult:
        last: LLMError | None = None
        for attempt in range(self.max_retries + 1):
            try:
                return self.client.chat(
                    messages,
                    model=model or self.model_id,
                    temperature=temperature,
                    tools=tools,
                )
            except LLMError as exc:
                last = exc
                if attempt >= self.max_retries:
                    break
                delay = self._retry_delay(exc, attempt)
                if delay > self.max_backoff_seconds:
                    # 网关要求等远超上限（如排队 9.7 小时）——再重试也是白等，
                    # 直接失败并把原因带出去，让上层决定是中止整批还是继续。
                    raise LLMError(
                        f"网关要求的等待时间 {delay}s 超过退避上限 "
                        f"{self.max_backoff_seconds}s，放弃重试：{exc}"
                    ) from exc
                time.sleep(delay)
        raise LLMError(f"chat 重试 {self.max_retries} 次仍失败：{last}")

    def _retry_delay(self, exc: LLMError, attempt: int) -> float:
        """退避时长。

        **优先用网关自己给的 `retry_after`**：2026-10-20 实测 429 响应里带
        `"retry_after": 56` 与 `estimated_wait: 34910`（约 9.7 小时排队）。
        固定退避（20/40/60 秒）远小于它要求的等待时间，重试必然全部失败。
        """

        advised = extract_retry_after(str(exc))
        if advised is not None:
            return float(advised)
        return self.backoff_seconds * (attempt + 1)


def chat_endpoint(models, *, client_factory=None) -> ChatEndpoint:
    usable = models.usable_llm()
    if not usable:
        reasons = "；".join(
            f"{candidate.id}: {candidate.block_reason}" for candidate in models.llm
        )
        raise BlockedError(
            f"没有可用的 LLM 候选（{reasons or '未配置'}）；见 config/models.yaml"
        )
    candidate = usable[0]
    if not candidate.base_url or not candidate.model:
        raise ConfigurationError(f"候选 {candidate.id} 缺少 base_url/model")
    factory = client_factory or OpenAIClient
    return ChatEndpoint(
        candidate=candidate,
        client=factory(candidate.base_url, api_key=candidate.api_key),
    )
