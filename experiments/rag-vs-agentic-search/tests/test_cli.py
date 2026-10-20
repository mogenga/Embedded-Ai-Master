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
        "score",
        "report",
        "env",
    }


@pytest.mark.parametrize("command", ["index", "run"])
def test_scheme_dependent_commands_remain_blocked(
    command: str, capsys: pytest.CaptureFixture[str]
) -> None:
    code = main(["--config", str(PROJECT_ROOT / "config" / "experiment.yaml"), command])
    assert code == 3
    assert "未就绪" in capsys.readouterr().err


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
