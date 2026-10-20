"""资产导入（spec §7.3 的 G0 门禁）。

骨架期实现到"可校验，不可假装有数据"为止：
- 读 JSONL 并逐条做 schema 校验，坏行全部收集，不以第一个错误直接吞掉其余。
- 交叉校验（gold 存在、文本重复、分区覆盖、扰动同侧、查询名泄漏）。
- 任何 error 都返回非零结果，由 CLI 以非零码退出并写 ``intake_failures.json``。

**不生成占位语料、不生成占位 gold**（AGENTS.md 与 STATUS.md 的禁止项）。
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from .assets import (
    AssetError,
    Negative,
    Perturbation,
    Query,
    Split,
    duplicate_query_texts,
    missing_gold_paths,
    negative_gold_conflicts,
    parse_multi_gold,
    parse_negative,
    parse_perturbation,
    parse_query,
    parse_split,
    perturbation_base_violations,
    query_leaks_path,
    split_violations,
)
from .corpus import MANIFEST_NAME, verify_manifest
from .corpus import read_manifest as read_corpus_manifest
from .errors import IntakeError

QUERIES_FILE = "queries.jsonl"
PERTURBATIONS_FILE = "perturbations.jsonl"
NEGATIVES_FILE = "negatives.jsonl"
SPLITS_FILE = "splits.json"
MULTI_GOLD_FILE = "annotation_multi_gold.jsonl"


@dataclass
class IntakeReport:
    """G0 门禁的结构化结果；可直接序列化为 ``intake_report.json``。"""

    counts: dict[str, int] = field(default_factory=dict)
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "counts": self.counts,
            "errors": self.errors,
            "warnings": self.warnings,
        }


def _read_jsonl(
    path: Path,
    report: IntakeReport,
    *,
    required: bool = True,
    blocks: str = "",
) -> list[dict[str, Any]]:
    """读取 JSONL。``required=False`` 时缺失只记警告，并标注它阻塞哪个假设。

    按 spec §5.2：多 gold、扰动集、负样本缺失只阻塞各自对应的假设（nDCG/H6/H7），
    不阻塞主实验。查询集、切分与语料是主实验必需，缺失即 error。
    """

    records: list[dict[str, Any]] = []
    if not path.is_file():
        message = f"缺少文件：{path.name}" + (f"（{blocks} 将标记为 BLOCKED）" if blocks else "")
        if required:
            report.errors.append(message)
        else:
            report.warnings.append(message)
        return records
    with path.open("r", encoding="utf-8") as handle:
        for lineno, raw in enumerate(handle, start=1):
            line = raw.strip()
            if not line:
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError as exc:
                report.errors.append(f"{path.name}:{lineno} 不是合法 JSON：{exc}")
                continue
            if not isinstance(value, dict):
                report.errors.append(f"{path.name}:{lineno} 顶层不是对象")
                continue
            records.append(value)
    return records


def _parse_each(
    records: list[dict[str, Any]],
    parser: Any,
    *,
    label: str,
    report: IntakeReport,
) -> list[Any]:
    parsed: list[Any] = []
    for index, record in enumerate(records, start=1):
        try:
            parsed.append(parser(record, where=f"{label}[{index}]"))
        except AssetError as exc:
            report.errors.append(str(exc))
    return parsed


def load_queries(data_dir: str | Path) -> tuple[list[Query], IntakeReport]:
    report = IntakeReport()
    records = _read_jsonl(Path(data_dir) / QUERIES_FILE, report)
    queries = _parse_each(records, parse_query, label="query", report=report)
    return queries, report


def load_perturbations(
    data_dir: str | Path, *, required: bool = True
) -> tuple[list[Perturbation], IntakeReport]:
    report = IntakeReport()
    records = _read_jsonl(
        Path(data_dir) / PERTURBATIONS_FILE,
        report,
        required=required,
        blocks="H6 扰动鲁棒性",
    )
    perturbations = _parse_each(
        records, parse_perturbation, label="perturbation", report=report
    )
    return perturbations, report


def load_negatives(
    data_dir: str | Path, *, required: bool = True
) -> tuple[list[Negative], IntakeReport]:
    report = IntakeReport()
    records = _read_jsonl(
        Path(data_dir) / NEGATIVES_FILE,
        report,
        required=required,
        blocks="H7 拒答能力",
    )
    negatives = _parse_each(records, parse_negative, label="negative", report=report)
    return negatives, report


def load_split(data_dir: str | Path) -> tuple[Split | None, IntakeReport]:
    report = IntakeReport()
    path = Path(data_dir) / SPLITS_FILE
    if not path.is_file():
        report.errors.append(f"缺少文件：{SPLITS_FILE}")
        return None, report
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        report.errors.append(f"{SPLITS_FILE} 不是合法 JSON：{exc}")
        return None, report
    try:
        return parse_split(raw, where=SPLITS_FILE), report
    except AssetError as exc:
        report.errors.append(str(exc))
        return None, report


def load_multi_gold(data_dir: str | Path) -> tuple[list[Any], IntakeReport]:
    report = IntakeReport()
    path = Path(data_dir) / MULTI_GOLD_FILE
    if not path.is_file():
        # 增强项，缺失不算错误（§7.3 第 5 项）。
        report.warnings.append(f"未提供 {MULTI_GOLD_FILE}：nDCG@5 将以单 gold 计并标记低置信")
        return [], report
    records = _read_jsonl(path, report)
    return _parse_each(records, parse_multi_gold, label="multi_gold", report=report), report


def run_intake(
    *,
    corpus_dir: str | Path,
    data_dir: str | Path,
) -> IntakeReport:
    """执行 G0 的纯校验部分；不写盘、不生成任何占位资产。"""

    report = IntakeReport()
    corpus_root = Path(corpus_dir)
    data_root = Path(data_dir)

    queries, query_report = load_queries(data_root)
    report.errors.extend(query_report.errors)
    report.counts["queries"] = len(queries)

    # 语料 manifest 校验（T1）。
    manifest_path = corpus_root / MANIFEST_NAME
    if not manifest_path.is_file():
        report.errors.append(f"缺少语料 manifest：{MANIFEST_NAME}（先导入语料并生成）")
    else:
        try:
            mismatches = verify_manifest(corpus_root, read_corpus_manifest(manifest_path))
        except ValueError as exc:
            report.errors.append(f"manifest 解析失败：{exc}")
        else:
            for mismatch in mismatches:
                report.errors.append(
                    f"语料不一致（{mismatch.kind}）：{mismatch.path}"
                )

    if corpus_root.is_dir():
        missing = missing_gold_paths(queries, corpus_root)
        report.errors.extend(f"gold 路径不存在：{path}" for path in missing)

    duplicates = duplicate_query_texts(queries)
    report.errors.extend(
        f"查询文本重复：{first} 与 {second}" for first, second in duplicates
    )

    leaked = [
        (query.id, leaks)
        for query in queries
        if (leaks := query_leaks_path(query.text, query.gold))
    ]
    for query_id, leaks in leaked:
        report.errors.append(f"查询 {query_id} 文本包含 gold 路径/文件名：{leaks}")

    split, split_report = load_split(data_root)
    report.errors.extend(split_report.errors)
    if split is not None:
        report.errors.extend(split_violations(split, queries))
        report.counts["dev"] = len(split.dev)
        report.counts["test"] = len(split.test)

        # 扰动集是 H6 的专用资产；缺失只标记 H6 BLOCKED，不阻断主实验（§5.2）。
        perturbations, perturbation_report = load_perturbations(data_root, required=False)
        report.errors.extend(perturbation_report.errors)
        report.warnings.extend(perturbation_report.warnings)
        report.counts["perturbations"] = len(perturbations)
        report.errors.extend(perturbation_base_violations(perturbations, split))
        unreviewed = [item.id for item in perturbations if not item.reviewed]
        if unreviewed:
            report.warnings.append(f"未过目的扰动样本不计分：{unreviewed[:5]}")

    # 负样本是 H7 的专用资产；缺失只标记 H7 BLOCKED（§5.2）。
    negatives, negative_report = load_negatives(data_root, required=False)
    report.errors.extend(negative_report.errors)
    report.warnings.extend(negative_report.warnings)
    report.counts["negatives"] = len(negatives)
    report.errors.extend(
        f"负样本与查询文本冲突：{item}" for item in negative_gold_conflicts(negatives, queries)
    )

    multi_gold, multi_gold_report = load_multi_gold(data_root)
    report.warnings.extend(multi_gold_report.warnings)
    report.errors.extend(multi_gold_report.errors)
    report.counts["multi_gold"] = len(multi_gold)

    # 索引覆盖诊断（T12/T13）：gold 不在 index.yaml 中的查询，方案 C 结构性无法命中。
    # 这是**口径事实**而非资产错误，必须写进报告供分层判读，不能静默。
    unindexed = unindexed_gold_queries(corpus_root, queries)
    report.counts["queries_with_unindexed_gold"] = len(unindexed)
    if unindexed:
        sample = ", ".join(unindexed[:5])
        report.warnings.append(
            f"{len(unindexed)}/{len(queries)} 条查询的 gold 不在 index.yaml 中"
            f"（方案 C 结构性无法命中，须分层报告）：{sample}"
        )

    return report


def unindexed_gold_queries(
    corpus_root: str | Path,
    queries: list[Query],
) -> list[str]:
    """返回 gold 未出现在 ``index.yaml`` 条目里的查询 id（按 id 排序）。"""

    index_path = Path(corpus_root) / "index.yaml"
    if not index_path.is_file():
        return []
    try:
        data = yaml.safe_load(index_path.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError:
        return []
    entries = data.get("entries") if isinstance(data, dict) else None
    if not isinstance(entries, list):
        return []

    indexed = {
        str(entry.get("path"))
        for entry in entries
        if isinstance(entry, dict) and entry.get("path")
    }
    return sorted(
        query.id for query in queries if any(gold not in indexed for gold in query.gold)
    )


def intake_or_raise(report: IntakeReport) -> None:
    """把不合格的导入报告转成异常，供 CLI 统一以退出码 2 退出。"""

    if not report.ok:
        detail = "；".join(report.errors[:5])
        raise IntakeError(f"G0 资产导入失败（{len(report.errors)} 项）：{detail}")
