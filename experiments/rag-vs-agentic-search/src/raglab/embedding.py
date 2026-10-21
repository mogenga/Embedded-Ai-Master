"""embedding 端点的接线（M4）。

把 `config/models.yaml` 的候选与 `OpenAIClient` 接起来，并处理两件实验特有的事：

1. **live 门禁不可绕过**：没有 ``RAGLAB_LIVE=1`` 时构造客户端会抛 ``LiveGateError``，
   与产品代码同一道门。
2. **限流退避**：网关实测约 4 次/分钟，突发与并发成功率均为 0。批量编码时宁可慢，
   不要撞 429——撞了会被误读成"端点故障"。

这里只做"把文本写成向量"，不关心切块与索引结构。
"""

from __future__ import annotations

import time
from collections.abc import Sequence
from dataclasses import dataclass

from .config import ModelCandidate
from .errors import BlockedError, ConfigurationError, LLMError
from .llm import OpenAIClient
from .chat_endpoint import extract_retry_after

# 429 / 5xx 的重试参数。实测 15s 间隔下 5/5 成功，这里留一倍余量。
DEFAULT_MAX_RETRIES = 4
DEFAULT_BACKOFF_SECONDS = 15.0
# 单次退避上限；超过就不等了。
DEFAULT_MAX_BACKOFF_SECONDS = 300.0


@dataclass(frozen=True)
class EmbeddingEndpoint:
    """一个可用的 embedding 候选。"""

    candidate: ModelCandidate
    client: OpenAIClient
    max_retries: int = DEFAULT_MAX_RETRIES
    backoff_seconds: float = DEFAULT_BACKOFF_SECONDS
    max_backoff_seconds: float = DEFAULT_MAX_BACKOFF_SECONDS

    @property
    def model_id(self) -> str:
        return str(self.candidate.model)

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        """带退避的 embedding；重试耗尽后抛 ``LLMError``，不返回部分结果。

        退避优先用网关自己给的 ``retry_after``（见 ``chat_endpoint.extract_retry_after``）：
        2026-10-20 实测 429 响应里带 ``"retry_after": 56``，固定退避远小于它。
        """

        last_error: LLMError | None = None
        for attempt in range(self.max_retries + 1):
            try:
                return self.client.embed(texts, model=self.model_id)
            except LLMError as exc:
                last_error = exc
                if attempt >= self.max_retries:
                    break
                advised = extract_retry_after(str(exc))
                delay = (
                    float(advised)
                    if advised is not None
                    else self.backoff_seconds * (attempt + 1)
                )
                if delay > self.max_backoff_seconds:
                    raise LLMError(
                        f"网关要求的等待时间 {delay}s 超过退避上限 "
                        f"{self.max_backoff_seconds}s，放弃重试：{exc}"
                    ) from exc
                time.sleep(delay)
        raise LLMError(
            f"embedding 重试 {self.max_retries} 次仍失败：{last_error}"
        )


def embedding_endpoint(models, *, client_factory=None) -> EmbeddingEndpoint:
    """从 `models.yaml` 取第一个可用的 embedding 候选并构造端点。

    “可用”由 `ModelCandidate.usable` 判定（要有 base_url / model / 可选依赖）。
    一个都不可用时抛 ``BlockedError``——这是素材未就绪，不是代码错误。
    """

    usable = models.usable_embedding()
    if not usable:
        reasons = "；".join(
            f"{candidate.id}: {candidate.block_reason}" for candidate in models.embedding
        )
        raise BlockedError(
            f"没有可用的 embedding 候选（{reasons or '未配置'}）；见 config/models.yaml"
        )
    candidate = usable[0]
    if not candidate.base_url or not candidate.model:
        raise ConfigurationError(f"候选 {candidate.id} 缺少 base_url/model")

    factory = client_factory or OpenAIClient
    client = factory(candidate.base_url, api_key=candidate.api_key)
    return EmbeddingEndpoint(candidate=candidate, client=client)
