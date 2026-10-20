"""预注册与 confirmatory 门禁（spec §6.2、T2）。"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from raglab.errors import BlockedError, ConfigurationError
from raglab.prereg import (
    file_sha256,
    read_preregistration,
    require_confirmatory_ready,
    verify_resolved_configs,
)


def _write_prereg(root: Path, *, frozen: bool) -> None:
    block = "1234abcd" if frozen else "未生成"
    text = (
        "# 预注册\n\n## 冻结记录\n\n"
        f"| 项 | SHA-256 | 冻结时间 |\n|---|---|---|\n| 本文件 | {block} | 2026-10-20 |\n"
    )
    (root / "PREREGISTRATION.md").write_text(text, encoding="utf-8")


def _write_resolved(root: Path, schemes: list[str]) -> None:
    targets = root / "config" / "resolved"
    targets.mkdir(parents=True, exist_ok=True)
    for scheme in schemes:
        (targets / f"{scheme}.json").write_text(
            json.dumps({"scheme": scheme, "sha256": "deadbeef"}), encoding="utf-8"
        )


def test_repository_preregistration_is_not_frozen() -> None:
    root = Path(__file__).resolve().parents[1]
    state = read_preregistration(root)
    assert state.frozen is False
    assert state.reason is not None
    assert len(state.sha256) == 64


def test_frozen_detection(tmp_path: Path) -> None:
    _write_prereg(tmp_path, frozen=True)
    state = read_preregistration(tmp_path)
    assert state.frozen is True
    assert state.sha256 == file_sha256(tmp_path / "PREREGISTRATION.md")


def test_missing_preregistration_raises(tmp_path: Path) -> None:
    with pytest.raises(ConfigurationError):
        read_preregistration(tmp_path)


def test_missing_freeze_section_is_not_frozen(tmp_path: Path) -> None:
    (tmp_path / "PREREGISTRATION.md").write_text("# 预注册\n", encoding="utf-8")
    assert read_preregistration(tmp_path).frozen is False


def test_verify_resolved_reports_missing_and_malformed(tmp_path: Path) -> None:
    _write_resolved(tmp_path, ["A"])
    (tmp_path / "config" / "resolved" / "B.json").write_text("{oops", encoding="utf-8")
    (tmp_path / "config" / "resolved" / "C.json").write_text("{}", encoding="utf-8")

    problems = verify_resolved_configs(tmp_path, ["A", "B", "C", "D"])
    assert any("B.json" in problem for problem in problems)
    assert any("C.json" in problem for problem in problems)
    assert any("D.json" in problem for problem in problems)
    assert not any("A.json" in problem for problem in problems)


def test_confirmatory_rejects_dev_partition(tmp_path: Path) -> None:
    with pytest.raises(BlockedError):
        require_confirmatory_ready(tmp_path, schemes=["A"], partition="dev")


def test_confirmatory_rejects_unfrozen_preregistration(tmp_path: Path) -> None:
    _write_prereg(tmp_path, frozen=False)
    _write_resolved(tmp_path, ["A"])
    with pytest.raises(BlockedError):
        require_confirmatory_ready(tmp_path, schemes=["A"], partition="test")


def test_confirmatory_rejects_missing_resolved_config(tmp_path: Path) -> None:
    _write_prereg(tmp_path, frozen=True)
    with pytest.raises(BlockedError):
        require_confirmatory_ready(tmp_path, schemes=["A"], partition="test")


def test_confirmatory_passes_when_everything_frozen(tmp_path: Path) -> None:
    _write_prereg(tmp_path, frozen=True)
    _write_resolved(tmp_path, ["A", "C_prime"])
    state = require_confirmatory_ready(
        tmp_path, schemes=["A", "C_prime"], partition="all"
    )
    assert state.frozen is True
