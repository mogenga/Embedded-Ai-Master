"""方案 C：现状基线（spec §8.4，忠实复现 kb-mcp）。

**实现方式是移植，不是重写。** 检索语义全部来自 `schemes/kb_mcp.py`，后者逐行对齐
主仓库 `mcp-servers/kb/service.ts`（`feat/m2-stage3` @ `c529dcd`），并已用 105 条
查询（80 正 + 25 负）与 kb-mcp 原件逐条比对：lookup / token 提取 / search 三项
**零差异**。

本文件只负责三件事：
1. 统一 dispatch（三种读法，由 `dispatch_rule` 选择，冻结前须在预注册钉死）；
2. 把 kb-mcp 的输出转成实验的统一契约 `Candidate`；
3. 记录 `extended` 口径所需的额外信息（T12）。
"""

from __future__ import annotations

from collections.abc import Iterable
from pathlib import Path

from ..assets import Candidate, Query
from ..errors import ConfigurationError
from .base import RetrievalScheme
from .kb_mcp import DEFAULT_LOOKUP_LIMIT, KbMcpService

# 预注册可选的三种 dispatch 读法（见 PREREGISTRATION.md §6bis）。
DISPATCH_RULES = ("deployed", "lexical", "lookup_only")
DEFAULT_DISPATCH_RULE = "deployed"


class SchemeC(RetrievalScheme):
    """`kb_lookup` 命中则取 top-2，否则回退 `kb_search`（精确 token grep）。

    ``dispatch_rule`` 决定"命中"的判据：

    - ``deployed``（默认）：以 ``lookup.found`` 为准，即 kb-mcp 实际部署行为。
      隐含假设：agent 见 ``found=false`` 会改调 ``kb_search``——工具描述并未强制这点。
    - ``lexical``：只要有任何条目关键词得分 > 0 就不回退（spec §8.4 的散文读法，
      忽略置信度阈值与覆盖度闸门）。**不是为了"更准"，是为了量化散文与实现的差距。**
    - ``lookup_only``：永不回退，作为消融对照。
    """

    key = "C"
    display_name = "现状基线（index + grep）"

    def __init__(
        self,
        *,
        corpus_root: str | Path,
        navigation_files: Iterable[str] = (),
        dispatch_rule: str = DEFAULT_DISPATCH_RULE,
        lookup_top_k: int = DEFAULT_LOOKUP_LIMIT,
        extended_recall_k: int = 5,
        search_limit: int = 20,
        token_pattern: object | None = None,
    ) -> None:
        super().__init__(navigation_files=navigation_files)
        if dispatch_rule not in DISPATCH_RULES:
            raise ConfigurationError(
                f"方案 C 的 dispatch_rule 非法：{dispatch_rule!r}，可选 {DISPATCH_RULES}"
            )
        self._service = KbMcpService(corpus_root)
        self._dispatch_rule = dispatch_rule
        self._lookup_top_k = lookup_top_k
        self._extended_recall_k = extended_recall_k
        self._search_limit = search_limit
        if token_pattern is not None:
            # 参数存在但由 kb_mcp 的内置常量决定；显式写下的值若与实现不符即报错，
            # 避免配置文件与实际行为悄悄分叉。
            import re

            probe = re.compile(str(token_pattern))
            if probe.findall("BRR 0x271") != ["BRR", "0x271"]:
                raise ConfigurationError(
                    "token_pattern 必须单条交替且十六进制在前，否则 0x271 会被切成 x271"
                )

    def warm_up(self) -> None:
        """预加载 `index.yaml`。

        解析成本约 300 ms，只在进程启动时付一次。若不预热，**第一个跑的场景会独自
        承担这笔成本**，延迟数字随调用顺序变化——那与读法本身无关，却会被误读成
        "这个读法更慢"。诊断与跑批都应在计时前调用。
        """

        self._service.load_index()

    def _lexical_lookup(self, query: Query) -> object:
        """spec §8.4 散文的读法：有关键词得分 > 0 的条目则取 top-k。"""

        return self._service.lexical_rank(query.text, self._lookup_top_k)

    def _retrieve(
        self,
        query: Query,
        *,
        deadline_ms: float | None,
    ) -> tuple[str, list[Candidate], dict[str, float | int | bool]]:
        rule = self._dispatch_rule
        if rule == "lexical":
            lookup = self._lexical_lookup(query)
            use_search = not lookup.found
        else:
            lookup = self._service.lookup(query.text, self._lookup_top_k)
            use_search = False if rule == "lookup_only" else not lookup.found

        extra: dict[str, float | int | bool] = {
            "branch": "search" if use_search else "lookup",
            "dispatch_rule": rule,
            "lookup_found": lookup.found,
            "input_tokens": 0,
            "output_tokens": 0,
            "cost_estimated": False,
        }

        if not use_search:
            if not lookup.found:
                extra["lookup_reason"] = lookup.reason or "no_match"
                return "no_match", [], extra
            candidates = [
                Candidate(path=item.path, score=item.score) for item in lookup.candidates
            ]
            return "ok", candidates, extra

        # 回退 search：token 提取与 kb-mcp 一致（不做最小长度过滤）。
        from .kb_mcp import QUERY_TOKEN_PATTERN

        tokens: list[str] = []
        seen: set[str] = set()
        for match in QUERY_TOKEN_PATTERN.finditer(query.text):
            key = match.group(0).lower()
            if key in seen:
                continue
            seen.add(key)
            tokens.append(match.group(0))
        extra["search_tokens"] = len(tokens)
        if not tokens:
            extra["search_skipped"] = "no_tokens"
            return "no_match", [], extra

        result = self._service.search(tokens, self._search_limit)
        # search 的"分数"在 kb-mcp 里不存在；用负名次当分，保证排序稳定且不伪造量纲。
        ranked: list[Candidate] = []
        seen_paths: list[str] = []
        for hit in result.hits:
            if hit.path in seen_paths:
                continue
            seen_paths.append(hit.path)
            ranked.append(Candidate(path=hit.path, score=-float(len(seen_paths))))

        # T12：部署形态只给 top-2。extended top-5 从同一排序截取，单独标注。
        extra["extended_paths"] = tuple(
            candidate.path for candidate in ranked[: self._extended_recall_k]
        )
        if not ranked:
            return "no_match", [], extra
        return "ok", ranked[: self._lookup_top_k], extra
