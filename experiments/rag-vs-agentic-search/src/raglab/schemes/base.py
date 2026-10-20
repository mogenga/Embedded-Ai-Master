"""方案接口与统一输出契约（spec §8.1）的落点。

所有方案对同一查询产出同一形状的 ``QueryResult``：候选已按方案自身排序，
路径为相对 ``corpus/kb/`` 的 POSIX 形式，导航文件已由基类统一过滤（T11）。
"""

from __future__ import annotations

import time
from abc import ABC, abstractmethod
from collections.abc import Callable, Iterable

from ..assets import Candidate, Query, QueryResult
from ..errors import BlockedError, FeatureNotImplemented
from ..paths import PathError, normalize_rel

SCHEME_KEYS = ("A", "B", "C", "C_prime", "D")


def filter_navigation(
    candidates: Iterable[Candidate],
    navigation: Iterable[str],
) -> list[Candidate]:
    """从候选中剔除导航文件（T11）；保持原排序。"""

    blocked = set(navigation)
    return [candidate for candidate in candidates if candidate.path not in blocked]


def validate_candidates(candidates: Iterable[Candidate]) -> list[Candidate]:
    """规范化候选路径并校验；越界或非法路径直接失败（不得静默丢弃）。"""

    normalized: list[Candidate] = []
    for candidate in candidates:
        try:
            path = normalize_rel(candidate.path)
        except PathError as exc:
            raise ValueError(f"候选路径非法：{candidate.path!r}：{exc}") from exc
        normalized.append(Candidate(path=path, score=candidate.score))
    return normalized


class RetrievalScheme(ABC):
    """方案基类。

    子类只实现 ``_retrieve``；计时、导航过滤与契约校验由 ``run`` 统一完成，
    保证五个方案走同一条出口。
    """

    key: str = "?"
    display_name: str = "?"

    def __init__(self, *, navigation_files: Iterable[str] = ()) -> None:
        self._navigation = tuple(navigation_files)

    @abstractmethod
    def _retrieve(
        self,
        query: Query,
        *,
        deadline_ms: float | None,
    ) -> tuple[str, list[Candidate], dict[str, float | int | bool]]:
        """返回 (status, 候选, 附加指标)。子类负责状态诚实：失败就是失败。"""

        raise NotImplementedError

    def run(
        self,
        query: Query,
        *,
        deadline_ms: float | None = None,
        clock: Callable[[], float] = time.perf_counter,
    ) -> QueryResult:
        start = clock()
        try:
            status, raw_candidates, extra = self._retrieve(query, deadline_ms=deadline_ms)
        except BlockedError:
            # 未实现/未就绪属于流程错误，不能伪装成逐查询的 error 结果。
            raise
        except Exception as exc:  # noqa: BLE001 —— 单查询失败按 ITT 记为 error
            return QueryResult(
                query_id=query.id,
                scheme=self.key,
                status="error",
                latency_ms=(clock() - start) * 1000,
                error=f"{type(exc).__name__}: {exc}",
            )

        candidates = filter_navigation(validate_candidates(raw_candidates), self._navigation)
        cost_extra = extra or {}
        return QueryResult(
            query_id=query.id,
            scheme=self.key,
            status=status,
            candidates=tuple(candidates),
            latency_ms=(clock() - start) * 1000,
            input_tokens=int(cost_extra.get("input_tokens", 0) or 0),
            output_tokens=int(cost_extra.get("output_tokens", 0) or 0),
            cost_estimated=bool(cost_extra.get("cost_estimated", False)),
            extra={key: value for key, value in cost_extra.items() if key not in _COST_KEYS},
        )


_COST_KEYS = {"input_tokens", "output_tokens", "cost_estimated"}


class _Placeholder(RetrievalScheme):
    """骨架期占位：显式失败，绝不产出空候选冒充结果。"""

    def _retrieve(
        self,
        query: Query,
        *,
        deadline_ms: float | None,
    ) -> tuple[str, list[Candidate], dict[str, float | int | bool]]:
        raise FeatureNotImplemented(
            f"方案 {self.key} 尚未实现（需素材到位并另立实现计划）"
        )


class SchemeA(_Placeholder):
    key = "A"
    display_name = "向量 RAG"


class SchemeB(_Placeholder):
    key = "B"
    display_name = "Agentic search"


class SchemeC(_Placeholder):
    key = "C"
    display_name = "现状基线（index + grep）"


class SchemeCPrime(_Placeholder):
    key = "C_prime"
    display_name = "BM25 + grep"


class SchemeD(_Placeholder):
    key = "D"
    display_name = "混合（条件启用）"


_REGISTRY: dict[str, type[RetrievalScheme]] = {
    scheme.key: scheme
    for scheme in (SchemeA, SchemeB, SchemeC, SchemeCPrime, SchemeD)
}


def scheme_class(key: str) -> type[RetrievalScheme]:
    try:
        return _REGISTRY[key]
    except KeyError as exc:
        raise ValueError(f"未知方案：{key!r}，可选 {sorted(_REGISTRY)}") from exc


def get_scheme(key: str, *, navigation_files: Iterable[str] = ()) -> RetrievalScheme:
    return scheme_class(key)(navigation_files=navigation_files)
