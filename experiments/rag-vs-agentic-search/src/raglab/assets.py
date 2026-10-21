"""评测资产的数据模型（spec §7.2）。

只做 schema 校验与解析，不做 IO 编排。任何字段缺失/非法都抛 ``AssetError``，
由导入层聚合为 ``intake_failures.json``（§5.2：导入失败即中止）。
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .paths import PathError, normalize_rel, resolve_inside

# todo §6.1 的七个主题域。
TOPICS = ("protocols", "system", "vendor", "reference", "debug", "rtos", "method")
TRACKS = ("index", "search")
PERTURBATION_KINDS = ("syn_rewrite", "typo", "colloquial")
NOT_APPLICABLE = "n/a"

_QUERY_ID_RE = re.compile(r"^[a-z]+-[0-9]{3,}$")


class AssetError(ValueError):
    """单个资产记录不合法。"""


def _require(record: dict[str, Any], key: str, where: str) -> Any:
    if key not in record:
        raise AssetError(f"{where} 缺少字段 {key!r}")
    return record[key]


def _expect(record: dict[str, Any], key: str, types: type | tuple[type, ...], where: str) -> Any:
    value = _require(record, key, where)
    if not isinstance(value, types):
        raise AssetError(f"{where} 字段 {key!r} 类型错误：{type(value).__name__}")
    return value


def _posix_paths(value: Any, where: str) -> list[str]:
    if not isinstance(value, list) or not value:
        raise AssetError(f"{where} 必须是非空路径数组")
    paths: list[str] = []
    for item in value:
        if not isinstance(item, str):
            raise AssetError(f"{where} 含非字符串路径：{item!r}")
        try:
            paths.append(normalize_rel(item))
        except PathError as exc:
            raise AssetError(f"{where} 路径非法：{exc}") from exc
    if len(set(paths)) != len(paths):
        raise AssetError(f"{where} 含重复路径")
    return paths


@dataclass(frozen=True)
class Query:
    """queries.jsonl 的一行。"""

    id: str
    track: str
    text: str
    gold: tuple[str, ...]
    topic: str
    lang: str = "zh"
    source: str = "regression.py"

    @property
    def n_gold(self) -> int:
        return len(self.gold)


@dataclass(frozen=True)
class Perturbation:
    """perturbations.jsonl 的一行。"""

    id: str
    base_id: str
    kind: str
    text: str
    generator: str
    reviewed: bool


@dataclass(frozen=True)
class Negative:
    """negatives.jsonl 的一行。"""

    id: str
    text: str
    reason: str
    near_domain: bool


@dataclass(frozen=True)
class MultiGold:
    """annotation_multi_gold.jsonl 的一行（增强项，不阻塞主实验）。"""

    query_id: str
    gold: tuple[str, ...]
    annotator: str
    annotated_at: str
    blind: bool


@dataclass(frozen=True)
class Split:
    """splits.json。"""

    seed: int
    stratify_by: tuple[str, ...]
    dev: tuple[str, ...]
    test: tuple[str, ...]

    def side_of(self, query_id: str) -> str | None:
        if query_id in self.dev:
            return "dev"
        if query_id in self.test:
            return "test"
        return None


@dataclass(frozen=True)
class Candidate:
    """统一输出契约中的候选（§8.1）。"""

    path: str
    score: float = 0.0


@dataclass(frozen=True)
class QueryResult:
    """统一输出契约中的一条逐查询记录（§8.1）。"""

    query_id: str
    scheme: str
    status: str
    candidates: tuple[Candidate, ...] = ()
    latency_ms: float = 0.0
    input_tokens: int = 0
    output_tokens: int = 0
    cost_estimated: bool = False
    trace_path: str | None = None
    repetition: int = 0
    error: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def paths(self) -> tuple[str, ...]:
        return tuple(candidate.path for candidate in self.candidates)


def parse_query(record: dict[str, Any], *, where: str = "query") -> Query:
    query_id = _expect(record, "id", str, where)
    if not _QUERY_ID_RE.match(query_id):
        raise AssetError(f"{where} id 不合规：{query_id!r}")
    track = _expect(record, "track", str, where)
    if track not in TRACKS:
        raise AssetError(f"{where} track 非法：{track!r}")
    topic = _expect(record, "topic", str, where)
    text = _expect(record, "text", str, where)
    if not text.strip():
        raise AssetError(f"{where} text 为空")
    if topic not in TOPICS:
        raise AssetError(f"{where} topic 未知：{topic!r}")
    gold = tuple(_posix_paths(_require(record, "gold", where), f"{where}.gold"))
    lang = record.get("lang", "zh")
    source = record.get("source", "regression.py")
    if not isinstance(lang, str) or not isinstance(source, str):
        raise AssetError(f"{where} lang/source 必须是字符串")
    if source not in ("regression.py", "manual"):
        raise AssetError(f"{where} source 非法：{source!r}")
    return Query(
        id=query_id,
        track=track,
        text=text,
        gold=gold,
        topic=topic,
        lang=lang,
        source=source,
    )


def parse_perturbation(record: dict[str, Any], *, where: str = "perturbation") -> Perturbation:
    pert_id = _expect(record, "id", str, where)
    base_id = _expect(record, "base_id", str, where)
    kind = _expect(record, "kind", str, where)
    if kind not in PERTURBATION_KINDS:
        raise AssetError(f"{where} kind 非法：{kind!r}")
    text = _expect(record, "text", str, where)
    if not text.strip():
        raise AssetError(f"{where} text 为空")
    generator = _expect(record, "generator", str, where)
    reviewed = _expect(record, "reviewed", bool, where)
    return Perturbation(
        id=pert_id,
        base_id=base_id,
        kind=kind,
        text=text,
        generator=generator,
        reviewed=reviewed,
    )


def parse_negative(record: dict[str, Any], *, where: str = "negative") -> Negative:
    neg_id = _expect(record, "id", str, where)
    text = _expect(record, "text", str, where)
    if not text.strip():
        raise AssetError(f"{where} text 为空")
    reason = _expect(record, "reason", str, where)
    near_domain = _expect(record, "near_domain", bool, where)
    return Negative(id=neg_id, text=text, reason=reason, near_domain=near_domain)


def parse_multi_gold(record: dict[str, Any], *, where: str = "multi_gold") -> MultiGold:
    query_id = _expect(record, "query_id", str, where)
    gold = tuple(_posix_paths(_require(record, "gold", where), f"{where}.gold"))
    annotator = _expect(record, "annotator", str, where)
    annotated_at = _expect(record, "annotated_at", str, where)
    blind = _expect(record, "blind", bool, where)
    return MultiGold(
        query_id=query_id,
        gold=gold,
        annotator=annotator,
        annotated_at=annotated_at,
        blind=blind,
    )


def parse_split(record: dict[str, Any], *, where: str = "split") -> Split:
    seed = _expect(record, "seed", int, where)
    stratify_by = _expect(record, "stratify_by", list, where)
    if not all(isinstance(item, str) for item in stratify_by):
        raise AssetError(f"{where} stratify_by 必须为字符串数组")
    dev = tuple(_expect(record, "dev", list, where))
    test = tuple(_expect(record, "test", list, where))
    overlap = set(dev) & set(test)
    if overlap:
        raise AssetError(f"{where} dev/test 重叠：{sorted(overlap)[:5]}")
    duplicates = [value for value in dev + test if (dev + test).count(value) > 1]
    if duplicates:
        raise AssetError(f"{where} 分区内重复：{sorted(set(duplicates))[:5]}")
    return Split(
        seed=seed,
        stratify_by=tuple(stratify_by),
        dev=dev,
        test=test,
    )


# ---- 交叉校验（G0 门禁的纯函数部分，§7.3） --------------------------------


def duplicate_query_texts(queries: Sequence[Query]) -> list[tuple[str, str]]:
    """归一化空白后的重复查询文本，返回 (id_a, id_b) 对。"""

    seen: dict[str, str] = {}
    duplicates: list[tuple[str, str]] = []
    for query in queries:
        key = " ".join(query.text.split())
        if key in seen:
            duplicates.append((seen[key], query.id))
        else:
            seen[key] = query.id
    return duplicates


def missing_gold_paths(queries: Sequence[Query], corpus_root: Path) -> list[str]:
    """列出语料中不存在的 gold 路径（POSIX 相对 ``corpus/kb/``）。"""

    missing: list[str] = []
    for path in sorted({gold for query in queries for gold in query.gold}):
        try:
            target = resolve_inside(corpus_root, path)
        except PathError:
            missing.append(path)
            continue
        if not target.is_file():
            missing.append(path)
    return missing


def query_leaks_path(text: str, paths: Sequence[str]) -> list[str]:
    """查询文本里直接出现 gold 路径或文件名（§7.3 第 8 项）。"""

    haystack = text.replace("\\", "/").lower()
    leaked: list[str] = []
    for path in paths:
        normalized = path.lower()
        name = normalized.rsplit("/", 1)[-1]
        if normalized in haystack or (name and name in haystack):
            leaked.append(path)
    return leaked


def split_violations(split: Split, queries: Sequence[Query]) -> list[str]:
    """splits.json 必须恰好覆盖全部查询、且不含未知 id。"""

    known = {query.id for query in queries}
    assigned = list(split.dev) + list(split.test)
    problems: list[str] = []
    unknown = sorted(set(assigned) - known)
    if unknown:
        problems.append(f"分区含未知查询 id：{unknown[:5]}")
    missing = sorted(known - set(assigned))
    if missing:
        problems.append(f"分区遗漏查询 id：{missing[:5]}")
    empty_side = [side for side, ids in (("dev", split.dev), ("test", split.test)) if not ids]
    if empty_side:
        problems.append(f"分区为空：{empty_side}")
    return problems


def perturbation_base_violations(
    perturbations: Sequence[Perturbation],
    split: Split,
) -> list[str]:
    """扰动必须与其 base 查询同侧（§7.3 第 4 项）。"""

    problems: list[str] = []
    for perturbation in perturbations:
        base_side = split.side_of(perturbation.base_id)
        if base_side is None:
            problems.append(f"{perturbation.id} 的 base {perturbation.base_id} 不在分区内")
    return problems


def negative_gold_conflicts(
    negatives: Sequence[Negative],
    queries: Sequence[Query],
) -> list[str]:
    """负样本文本不得与既有查询重复（防止把正例当负例，§7.3 第 6 项）。"""

    query_texts = {" ".join(query.text.split()) for query in queries}
    return [
        negative.id
        for negative in negatives
        if " ".join(negative.text.split()) in query_texts
    ]


def sha256_text(value: str) -> str:
    """向量缓存与配置哈希用的稳定摘要。"""

    return hashlib.sha256(value.encode("utf-8")).hexdigest()
