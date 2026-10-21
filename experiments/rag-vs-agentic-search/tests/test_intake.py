"""G0 导入门禁：坏资产必须失败，不得跳过（§5.2、§7.3）。"""

from __future__ import annotations

import json
from pathlib import Path

from raglab.corpus import write_manifest
from raglab.errors import IntakeError
from raglab.intake import intake_or_raise, run_intake


def _write_jsonl(path: Path, records: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    lines = [json.dumps(record, ensure_ascii=False) for record in records]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _query_record(query_id: str = "idx-001", text: str = "串口收不到数据") -> dict:
    return {
        "id": query_id,
        "track": "index",
        "text": text,
        "gold": ["protocols/uart.md"],
        "topic": "protocols",
        "lang": "zh",
        "source": "regression.py",
    }


def _build_assets(tmp_path: Path, *, queries: list[dict] | None = None) -> tuple[Path, Path]:
    corpus = tmp_path / "corpus" / "kb"
    (corpus / "protocols").mkdir(parents=True)
    (corpus / "protocols" / "uart.md").write_text("uart", encoding="utf-8")
    write_manifest(corpus)

    data = tmp_path / "data"
    data.mkdir()
    _write_jsonl(data / "queries.jsonl", queries or [_query_record()])
    (data / "splits.json").write_text(
        json.dumps({"seed": 1, "stratify_by": ["track"], "dev": ["idx-001"], "test": ["idx-002"]}),
        encoding="utf-8",
    )
    _write_jsonl(
        data / "perturbations.jsonl",
        [
            {
                "id": "syn-001",
                "base_id": "idx-001",
                "kind": "syn_rewrite",
                "text": "串口没有收到数据",
                "generator": "human",
                "reviewed": True,
            }
        ],
    )
    _write_jsonl(
        data / "negatives.jsonl",
        [{"id": "neg-001", "text": "RT1170 MU 中断丢消息", "reason": "未覆盖", "near_domain": True}],
    )
    return corpus, data


def test_intake_passes_on_consistent_assets(tmp_path: Path) -> None:
    queries = [_query_record(), _query_record("idx-002", "启动卡在 DDR 初始化")]
    corpus, data = _build_assets(tmp_path, queries=queries)
    report = run_intake(corpus_dir=corpus, data_dir=data)
    assert report.ok, report.errors
    assert report.counts["queries"] == 2
    assert report.counts["dev"] == 1 and report.counts["test"] == 1
    # 多 gold 缺失只是 warning，不阻塞主实验。
    assert any("annotation_multi_gold" in warning for warning in report.warnings)


def _two_query_assets(tmp_path: Path) -> tuple[Path, Path]:
    """两条查询 + 匹配的切分，避免 fixture 自身触发分区校验。"""

    return _build_assets(
        tmp_path,
        queries=[_query_record(), _query_record("idx-002", "启动卡在 DDR 初始化")],
    )


def test_missing_perturbations_only_blocks_h6(tmp_path: Path) -> None:
    """扰动集缺失只标记 H6 BLOCKED，不阻断主实验（spec §5.2）。"""

    corpus, data = _two_query_assets(tmp_path)
    (data / "perturbations.jsonl").unlink()
    report = run_intake(corpus_dir=corpus, data_dir=data)
    assert report.ok, report.errors
    assert any("perturbations" in w and "H6" in w for w in report.warnings)


def test_missing_negatives_only_blocks_h7(tmp_path: Path) -> None:
    corpus, data = _two_query_assets(tmp_path)
    (data / "negatives.jsonl").unlink()
    report = run_intake(corpus_dir=corpus, data_dir=data)
    assert report.ok, report.errors
    assert any("negatives" in w and "H7" in w for w in report.warnings)


def test_unindexed_gold_is_reported_not_fatal(tmp_path: Path) -> None:
    """gold 不在 index.yaml 中属于口径事实，必须报告但不阻断导入（T12/T13）。"""

    corpus, data = _two_query_assets(tmp_path)
    # 索引指向另一个真实文件，因此两条查询的 gold 都不在索引里。
    # 新增文件后必须重算 manifest，否则会先触发 T1 的语料漂移校验。
    (corpus / "protocols" / "other.md").write_text("other", encoding="utf-8")
    write_manifest(corpus)
    (corpus / "index.yaml").write_text(
        "version: 1\nentries:\n  - id: other\n    path: protocols/other.md\n",
        encoding="utf-8",
    )
    report = run_intake(corpus_dir=corpus, data_dir=data)
    assert report.ok, report.errors
    assert report.counts["queries_with_unindexed_gold"] == 2
    assert any("index.yaml" in w and "结构性无法命中" in w for w in report.warnings)


def test_missing_queries_still_fatal(tmp_path: Path) -> None:
    """主实验必需的查询集缺失必须中止，不能降级成警告。"""

    corpus, data = _build_assets(tmp_path)
    (data / "queries.jsonl").unlink()
    report = run_intake(corpus_dir=corpus, data_dir=data)
    assert not report.ok


def test_missing_splits_still_fatal(tmp_path: Path) -> None:
    corpus, data = _build_assets(tmp_path)
    (data / "splits.json").unlink()
    report = run_intake(corpus_dir=corpus, data_dir=data)
    assert not report.ok


def test_intake_fails_on_missing_gold_file(tmp_path: Path) -> None:
    corpus, data = _build_assets(tmp_path)
    (corpus / "protocols" / "uart.md").unlink()
    report = run_intake(corpus_dir=corpus, data_dir=data)
    assert not report.ok
    assert any("gold 路径不存在" in error for error in report.errors)


def test_intake_fails_on_manifest_drift(tmp_path: Path) -> None:
    corpus, data = _build_assets(tmp_path)
    (corpus / "protocols" / "uart.md").write_text("tampered", encoding="utf-8")
    report = run_intake(corpus_dir=corpus, data_dir=data)
    assert not report.ok
    assert any("语料不一致" in error for error in report.errors)


def test_intake_fails_on_bad_json_line(tmp_path: Path) -> None:
    corpus, data = _build_assets(tmp_path)
    (data / "queries.jsonl").write_text("{not json}\n", encoding="utf-8")
    report = run_intake(corpus_dir=corpus, data_dir=data)
    assert not report.ok
    assert any("不是合法 JSON" in error for error in report.errors)


def test_intake_fails_when_split_misses_queries(tmp_path: Path) -> None:
    queries = [_query_record(), _query_record("idx-002", "启动卡在 DDR 初始化")]
    corpus, data = _build_assets(tmp_path, queries=queries)
    (data / "splits.json").write_text(
        json.dumps({"seed": 1, "stratify_by": [], "dev": ["idx-001"], "test": []}),
        encoding="utf-8",
    )
    report = run_intake(corpus_dir=corpus, data_dir=data)
    assert not report.ok
    assert any("遗漏" in error or "分区为空" in error for error in report.errors)


def test_intake_or_raise_reports_first_failures(tmp_path: Path) -> None:
    corpus, data = _build_assets(tmp_path)
    (corpus / "protocols" / "uart.md").unlink()
    report = run_intake(corpus_dir=corpus, data_dir=data)
    try:
        intake_or_raise(report)
    except IntakeError as exc:
        assert "G0" in str(exc)
    else:  # pragma: no cover
        raise AssertionError("不合格的导入必须抛 IntakeError")
