"""五个检索方案的骨架。

**当前全部为占位**：方案实现需要素材（语料、查询集、模型端点）与另行批准的
实现计划。占位类会显式抛 ``FeatureNotImplemented``，绝不返回空候选假装跑过。
"""

from __future__ import annotations

from .base import SCHEME_KEYS, RetrievalScheme, get_scheme

__all__ = ["SCHEME_KEYS", "RetrievalScheme", "get_scheme"]
