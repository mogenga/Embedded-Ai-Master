"""CLI 行为：已实现命令必须真跑，未实现命令必须显式退出码 3（§9.1）。"""

from __future__ import annotations

import json
import shutil
import sys
from pathlib import Path

import pytest

from raglab.__main__ import build_parser, main

PROJECT_ROOT = Path(__file__).resolve().parents[1]


def _stage_project(tmp_path: Path) -> Path:
    """复制最小项目结构到临时目录，避免测试触碰真实 corpus/data/results。"""

    root = tmp_path / "project"
    (root / "src").mkdir(parents=True)
    shutil.copytree(PROJECT_ROOT / "src" / "raglab", root / "src" / "raglab")
    (root / "config").mkdir()
    shutil.copy(PROJECT_ROOT / "config" / "experiment.yaml", root / "config" / "experiment.yaml")
    return root


def _write_minimal_assets(root: Path, *, with_splits: bool = False) -> None:
    corpus = root / "corpus" / "kb"
    (corpus / "protocols").mkdir(parents=True)
    (corpus / "protocols" / "a.md").write_text("a", encoding="utf-8")
    sys.path.insert(0, str(root / "src"))
    from raglab.corpus import write_manifest

    write_manifest(corpus)

    data = root / "data"
    data.mkdir()
    records = [
        {
            "id": f"idx-{index:03d}",
            "track": "index",
            "topic": "protocols",
            "text": f"查询 {index}",
            "gold": ["protocols/a.md"],
        }
        for index in range(1, 5)
    ]
    (data / "queries.jsonl").write_text(
        "\n".join(json.dumps(record, ensure_ascii=False) for record in records) + "\n",
        encoding="utf-8",
    )
    (data / "negatives.jsonl").write_text("", encoding="utf-8")
    if with_splits:
        (data / "splits.json").write_text(
            json.dumps(
                {"seed": 1, "stratify_by": ["track"], "dev": ["idx-001"], "test": ["idx-002"]}
            ),
            encoding="utf-8",
        )


def test_stdout_is_forced_to_utf8() -> None:
    """Windows 默认 GBK 编不了 `−`、`′` 等符号。

    症状很隐蔽：命令已经算完、结果也已落盘，却因为最后一行 print 崩掉，
    退出码变成 1，看起来像"分析失败"。
    """

    from raglab.__main__ import _force_utf8_stdio

    _force_utf8_stdio()
    assert sys.stdout.encoding.lower().replace("-", "") in ("utf8", "utf_8")


def test_parser_has_all_commands() -> None:
    parser = build_parser()
    subparsers = next(
        action for action in parser._actions if hasattr(action, "choices") and action.choices
    )
    assert set(subparsers.choices) == {
        "import",
        "split",
        "index",
        "run",
        "grid",
        "h5",
        "analyze",
        "sensitivity",
        "diagnose",
        "score",
        "report",
        "env",
        "models",
    }


def test_index_requires_chunking_choice_first(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """A 的切块方式仍是网格时必须先选值——否则不知道建哪个索引。

    这里必须用临时项目：真实仓库已有 `config/resolved/A.json`，直接跑会真的去建索引。
    """

    import raglab.__main__ as cli

    root = _stage_project(tmp_path)
    monkeypatch.setattr(cli, "PROJECT_ROOT", root)
    _write_minimal_assets(root, with_splits=True)
    (root / "config" / "schemes").mkdir()
    shutil.copy(
        PROJECT_ROOT / "config" / "schemes" / "vector.yaml",
        root / "config" / "schemes" / "vector.yaml",
    )

    code = main(["--config", str(root / "config" / "experiment.yaml"), "index"])
    assert code == 2
    err = capsys.readouterr().err
    assert "chunking" in err and "网格" in err


def test_run_writes_results_jsonl_and_marks_exploratory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """C 是当前唯一可跑方案；跑批结果必须落盘并标 exploratory。"""

    import raglab.__main__ as cli

    root = _stage_project(tmp_path)
    monkeypatch.setattr(cli, "PROJECT_ROOT", root)
    _write_minimal_assets(root, with_splits=True)
    (root / "config" / "schemes").mkdir()
    shutil.copy(
        PROJECT_ROOT / "config" / "schemes" / "index_grep.yaml",
        root / "config" / "schemes" / "index_grep.yaml",
    )
    (root / "corpus" / "kb" / "index.yaml").write_text(
        "entries:\n  - id: a\n    title: A\n    path: protocols/a.md\n"
        "    tags: [uart]\n    keywords: [查询]\n    summary: x\n",
        encoding="utf-8",
    )

    code = main(
        [
            "--config",
            str(root / "config" / "experiment.yaml"),
            "run",
            "--run-id",
            "r1",
            "--scheme",
            "C",
        ]
    )
    assert code == 0
    output = root / "results" / "runs" / "r1" / "C.jsonl"
    assert output.is_file()
    rows = [json.loads(line) for line in output.read_text(encoding="utf-8").splitlines() if line]
    assert len(rows) == 4
    assert {row["scheme"] for row in rows} == {"C"}


def _stage_c_project(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """临时项目 + 可跑的方案 C（B 的接线要模型端点，CLI 层用 C 验证续跑语义）。"""

    import raglab.__main__ as cli

    root = _stage_project(tmp_path)
    monkeypatch.setattr(cli, "PROJECT_ROOT", root)
    _write_minimal_assets(root, with_splits=True)
    (root / "config" / "schemes").mkdir()
    shutil.copy(
        PROJECT_ROOT / "config" / "schemes" / "index_grep.yaml",
        root / "config" / "schemes" / "index_grep.yaml",
    )
    (root / "corpus" / "kb" / "index.yaml").write_text(
        "entries:\n  - id: a\n    title: A\n    path: protocols/a.md\n"
        "    tags: [uart]\n    keywords: [查询]\n    summary: x\n",
        encoding="utf-8",
    )
    return root


def test_run_refuses_to_overwrite_existing_results(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """目标文件已存在又不带 --resume：必须显式拒绝，不能悄悄覆盖。

    覆盖掉旧结果会让"这次跑批到底包含哪些查询"变得不可判定。
    """

    root = _stage_c_project(tmp_path, monkeypatch)
    output = root / "results" / "runs" / "r1" / "C.jsonl"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text('{"query_id": "idx-001"}\n', encoding="utf-8")

    code = main(
        [
            "--config",
            str(root / "config" / "experiment.yaml"),
            "run",
            "--run-id",
            "r1",
            "--scheme",
            "C",
        ]
    )
    assert code == 3
    assert "resume" in capsys.readouterr().err
    # 原文件不能被动过。
    assert output.read_text(encoding="utf-8") == '{"query_id": "idx-001"}\n'


def test_run_resume_skips_completed_queries(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """--resume：已完成的 query_id 不重跑，结果文件也不被清空。"""

    root = _stage_c_project(tmp_path, monkeypatch)
    output = root / "results" / "runs" / "r1" / "C.jsonl"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(
            {
                "query_id": "idx-001",
                "scheme": "C",
                "status": "ok",
                "candidates": [{"path": "protocols/a.md", "score": 1.0}],
                "latency_ms": 1.0,
                "cost": {"input_tokens": 0, "output_tokens": 0, "estimated": False},
                "trace_path": None,
                "repetition": 0,
                "error": None,
                "extra": {},
            },
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )

    code = main(
        [
            "--config",
            str(root / "config" / "experiment.yaml"),
            "run",
            "--run-id",
            "r1",
            "--scheme",
            "C",
            "--resume",
        ]
    )
    assert code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["resumed"] is True
    assert payload["skipped"] == 1
    assert payload["status"]["total"] == 3, "只应跑剩下的 3 条"

    rows = [
        json.loads(line)
        for line in output.read_text(encoding="utf-8").splitlines()
        if line
    ]
    assert len(rows) == 4, "已完成的 1 条 + 新跑的 3 条"
    assert rows[0]["query_id"] == "idx-001", "已完成的条目必须仍在原位"


def test_run_resume_on_missing_file_runs_everything(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """--resume 但目标文件不存在：等价于全新跑，不报错。"""

    root = _stage_c_project(tmp_path, monkeypatch)
    code = main(
        [
            "--config",
            str(root / "config" / "experiment.yaml"),
            "run",
            "--run-id",
            "r1",
            "--scheme",
            "C",
            "--resume",
        ]
    )
    assert code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["skipped"] == 0
    assert payload["status"]["total"] == 4


def test_run_scheme_d_requires_h5_signal(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """D 已实现，但必须先过 H5 门槛——临时项目里查不到信号，应当被拦下。"""

    import raglab.__main__ as cli

    root = _stage_project(tmp_path)
    monkeypatch.setattr(cli, "PROJECT_ROOT", root)
    _write_minimal_assets(root, with_splits=True)
    (root / "config" / "schemes").mkdir()
    shutil.copy(
        PROJECT_ROOT / "config" / "schemes" / "hybrid.yaml",
        root / "config" / "schemes" / "hybrid.yaml",
    )

    code = main(
        ["--config", str(root / "config" / "experiment.yaml"), "run", "--run-id", "r1", "--scheme", "D"]
    )
    assert code == 3
    err = capsys.readouterr().err
    assert "H5" in err
    assert not (root / "results" / "runs").exists()


def test_run_scheme_a_without_index_is_blocked(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """A 没建索引时必须报"缺索引"，不得回退成空候选。"""

    import raglab.__main__ as cli

    root = _stage_project(tmp_path)
    monkeypatch.setattr(cli, "PROJECT_ROOT", root)
    _write_minimal_assets(root, with_splits=True)
    (root / "config" / "schemes").mkdir()
    shutil.copy(
        PROJECT_ROOT / "config" / "schemes" / "vector.yaml",
        root / "config" / "schemes" / "vector.yaml",
    )

    code = main(
        ["--config", str(root / "config" / "experiment.yaml"), "run", "--run-id", "r1", "--scheme", "A"]
    )
    # 切块方式仍是网格 → 先卡在参数选择；选定后才会卡在"缺索引"。
    assert code == 2
    assert "chunking" in capsys.readouterr().err
    assert not (root / "results" / "runs").exists()


def test_run_scheme_a_reports_missing_index_after_chunking_fixed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    """切块方式选定后，缺索引必须报"缺索引"，不得回退成空候选。"""

    import raglab.__main__ as cli

    root = _stage_project(tmp_path)
    monkeypatch.setattr(cli, "PROJECT_ROOT", root)
    _write_minimal_assets(root, with_splits=True)
    (root / "config" / "schemes").mkdir()
    shutil.copy(
        PROJECT_ROOT / "config" / "schemes" / "vector.yaml",
        root / "config" / "schemes" / "vector.yaml",
    )
    (root / "config" / "resolved").mkdir()
    (root / "config" / "resolved" / "A.json").write_text(
        json.dumps({"chunking": "section"}), encoding="utf-8"
    )

    code = main(
        ["--config", str(root / "config" / "experiment.yaml"), "run", "--run-id", "r1", "--scheme", "A"]
    )
    assert code == 3
    assert "向量索引" in capsys.readouterr().err
    assert not (root / "results" / "runs").exists()


def test_grid_records_every_config_not_just_best(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """§6.3：网格的**全部**配置都要落盘，只报最优是调参不对称的典型来源。"""

    import raglab.__main__ as cli

    root = _stage_project(tmp_path)
    monkeypatch.setattr(cli, "PROJECT_ROOT", root)
    _write_minimal_assets(root, with_splits=True)
    (root / "config" / "schemes").mkdir()
    shutil.copy(
        PROJECT_ROOT / "config" / "schemes" / "bm25_grep.yaml",
        root / "config" / "schemes" / "bm25_grep.yaml",
    )
    # 语料要能被 BM25 切块：给两条查询都能命中的内容。
    (root / "corpus" / "kb" / "protocols" / "a.md").write_text(
        "# 查询\n查询 内容\n", encoding="utf-8"
    )
    from raglab.corpus import write_manifest

    write_manifest(root / "corpus" / "kb")

    code = main(
        ["--config", str(root / "config" / "experiment.yaml"),
         "grid", "--scheme", "C_prime", "--run-id", "g1"]
    )
    assert code == 0
    csv_path = root / "results" / "tables" / "grid_search.csv"
    assert csv_path.is_file()
    lines = [line for line in csv_path.read_text(encoding="utf-8").splitlines() if line]
    # 表头 + 16 个网格点（2 切块 × 2 分词 × 2 k1 × 2 b）。
    assert len(lines) == 17
    assert "chunking" in lines[0] and "recall@2" in lines[0]


def test_grid_rejects_unimplemented_scheme(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    import raglab.__main__ as cli

    root = _stage_project(tmp_path)
    monkeypatch.setattr(cli, "PROJECT_ROOT", root)
    _write_minimal_assets(root, with_splits=True)

    code = main(
        ["--config", str(root / "config" / "experiment.yaml"),
         "grid", "--scheme", "B", "--run-id", "g1"]
    )
    assert code == 3
    err = capsys.readouterr().err
    assert "C_prime" in err or "尚未实现" in err


def test_import_reports_missing_assets_without_creating_runs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import raglab.__main__ as cli

    root = _stage_project(tmp_path)
    monkeypatch.setattr(cli, "PROJECT_ROOT", root)

    code = main(["--config", str(root / "config" / "experiment.yaml"), "import"])
    assert code == 2
    report = json.loads((root / "results" / "intake_report.json").read_text(encoding="utf-8"))
    assert report["ok"] is False
    assert not (root / "results" / "runs").exists()


def test_import_succeeds_on_consistent_assets(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import raglab.__main__ as cli

    root = _stage_project(tmp_path)
    monkeypatch.setattr(cli, "PROJECT_ROOT", root)
    _write_minimal_assets(root, with_splits=False)

    code = main(["--config", str(root / "config" / "experiment.yaml"), "import"])
    report = json.loads((root / "results" / "intake_report.json").read_text(encoding="utf-8"))
    assert code == 2  # splits.json 缺失仍是 G0 错误
    assert report["ok"] is False


def test_split_writes_splits_json(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import raglab.__main__ as cli

    root = _stage_project(tmp_path)
    monkeypatch.setattr(cli, "PROJECT_ROOT", root)
    _write_minimal_assets(root)

    code = main(["--config", str(root / "config" / "experiment.yaml"), "split"])
    assert code == 0
    payload = json.loads((root / "data" / "splits.json").read_text(encoding="utf-8"))
    assert set(payload) >= {"seed", "stratify_by", "dev", "test"}
    assert len(payload["dev"]) + len(payload["test"]) == 4


def test_split_dry_run_writes_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    import raglab.__main__ as cli

    root = _stage_project(tmp_path)
    monkeypatch.setattr(cli, "PROJECT_ROOT", root)
    _write_minimal_assets(root)

    code = main(["--config", str(root / "config" / "experiment.yaml"), "split", "--dry-run"])
    assert code == 0
    assert not (root / "data" / "splits.json").exists()
    assert "dev" in capsys.readouterr().out


def test_split_without_queries_is_blocked(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    import raglab.__main__ as cli

    root = _stage_project(tmp_path)
    monkeypatch.setattr(cli, "PROJECT_ROOT", root)

    code = main(["--config", str(root / "config" / "experiment.yaml"), "split"])
    assert code == 2
    assert "查询集" in capsys.readouterr().err


def test_score_without_results_is_blocked(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    import raglab.__main__ as cli

    root = _stage_project(tmp_path)
    monkeypatch.setattr(cli, "PROJECT_ROOT", root)
    _write_minimal_assets(root)
    main(["--config", str(root / "config" / "experiment.yaml"), "split"])

    code = main(
        ["--config", str(root / "config" / "experiment.yaml"), "score", "--run-id", "r1"]
    )
    assert code == 3
    assert "没有逐查询结果" in capsys.readouterr().err


def test_score_confirmatory_rejects_dev_partition(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    import raglab.__main__ as cli

    root = _stage_project(tmp_path)
    monkeypatch.setattr(cli, "PROJECT_ROOT", root)
    _write_minimal_assets(root)
    main(["--config", str(root / "config" / "experiment.yaml"), "split"])

    code = main(
        [
            "--config",
            str(root / "config" / "experiment.yaml"),
            "score",
            "--run-id",
            "r1",
            "--confirmatory",
            "--partition",
            "dev",
        ]
    )
    assert code == 3
    assert "dev" in capsys.readouterr().err


def test_score_produces_tables_and_flags_exploratory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import raglab.__main__ as cli

    root = _stage_project(tmp_path)
    monkeypatch.setattr(cli, "PROJECT_ROOT", root)
    _write_minimal_assets(root)
    main(["--config", str(root / "config" / "experiment.yaml"), "split"])

    run_dir = root / "results" / "runs" / "r1"
    run_dir.mkdir(parents=True)
    (run_dir / "A.jsonl").write_text(
        json.dumps(
            {
                "query_id": "idx-001",
                "scheme": "A",
                "status": "ok",
                "candidates": [{"path": "protocols/a.md", "score": 1.0}],
                "latency_ms": 5.0,
            },
            ensure_ascii=False,
        )
        + "\n",
        encoding="utf-8",
    )

    code = main(
        ["--config", str(root / "config" / "experiment.yaml"), "score", "--run-id", "r1"]
    )
    assert code == 0
    out_dir = root / "results" / "scored" / "r1"
    assert (out_dir / "per_query.csv").is_file()
    assert (out_dir / "overall.csv").is_file()
    summary = json.loads((out_dir / "summary.json").read_text(encoding="utf-8"))
    assert summary["mode"] == "exploratory"
    assert "warning" in summary
    assert summary["overall"][0]["recall@2"] == pytest.approx(1.0)


def test_report_requires_scored_output(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    import raglab.__main__ as cli

    root = _stage_project(tmp_path)
    monkeypatch.setattr(cli, "PROJECT_ROOT", root)
    _write_minimal_assets(root)

    code = main(
        ["--config", str(root / "config" / "experiment.yaml"), "report", "--run-id", "r1"]
    )
    assert code == 3
    assert "评分结果" in capsys.readouterr().err


def test_env_writes_json(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import raglab.__main__ as cli

    root = _stage_project(tmp_path)
    monkeypatch.setattr(cli, "PROJECT_ROOT", root)

    code = main(["--config", str(root / "config" / "experiment.yaml"), "env"])
    assert code == 0
    payload = json.loads((root / "env.json").read_text(encoding="utf-8"))
    assert payload["seed"] == 20261019
    assert "missing" in payload  # 未跑批时缺 manifest/lock 哈希是预期行为


def test_missing_config_exits_with_config_code(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    import raglab.__main__ as cli

    root = _stage_project(tmp_path)
    monkeypatch.setattr(cli, "PROJECT_ROOT", root)
    code = main(["--config", str(root / "config" / "missing.yaml"), "import"])
    assert code == 2
    assert "缺少配置文件" in capsys.readouterr().err
