"""预注册与 confirmatory 门禁（spec §6.2、T2）。"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from raglab.errors import BlockedError, ConfigurationError
from raglab.prereg import (
    config_payload_sha256,
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
    """写入**哈希正确**的 resolved 配置。

    不能用假哈希（比如 "deadbeef"）：门禁现在校验的是哈希值本身，
    假值会被判成「配置在冻结后被改动」——那正是这道门该做的事。
    """

    targets = root / "config" / "resolved"
    targets.mkdir(parents=True, exist_ok=True)
    for scheme in schemes:
        payload = {"scheme": scheme}
        payload["sha256"] = config_payload_sha256(payload)
        (targets / f"{scheme}.json").write_text(
            json.dumps(payload), encoding="utf-8"
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


def test_numbered_freeze_section_is_detected(tmp_path: Path) -> None:
    """真实文件里的标题是「## 8. 冻结记录」——**带编号**。

    早先只认 "## 冻结记录"，于是真实文件**永远**判不出已冻结：
    占位符填得再全，`--confirmatory` 也永远被拒。
    这种 bug 不报错，只让门禁永远关着——必须钉住。
    """

    (tmp_path / "PREREGISTRATION.md").write_text(
        "# 预注册\n\n## 8. 冻结记录\n\n| 项 | SHA-256 |\n|---|---|\n"
        "| 本文件 | abc123 |\n",
        encoding="utf-8",
    )
    state = read_preregistration(tmp_path)
    assert state.frozen is True


def test_freeze_section_with_placeholder_is_not_frozen(tmp_path: Path) -> None:
    """「本文件」那行还是占位符 → 必须判未冻结。

    这一条挡住的是「resolved/splits 的哈希都填了，就差本文件自己，
    但本文件还在改」的状态——那种状态下放行 confirmatory 是错的。
    """

    (tmp_path / "PREREGISTRATION.md").write_text(
        "# 预注册\n\n## 8. 冻结记录\n\n| 项 | SHA-256 |\n|---|---|\n"
        "| 本文件 | 未生成 |\n",
        encoding="utf-8",
    )
    state = read_preregistration(tmp_path)
    assert state.frozen is False
    assert state.reason is not None


def test_verify_resolved_reports_missing_and_malformed(tmp_path: Path) -> None:
    _write_resolved(tmp_path, ["A"])
    (tmp_path / "config" / "resolved" / "B.json").write_text("{oops", encoding="utf-8")
    (tmp_path / "config" / "resolved" / "C.json").write_text("{}", encoding="utf-8")

    problems = verify_resolved_configs(tmp_path, ["A", "B", "C", "D"])
    assert any("B.json" in problem for problem in problems)
    assert any("C.json" in problem for problem in problems)
    assert any("D.json" in problem for problem in problems)
    assert not any("A.json" in problem for problem in problems)


def test_verify_resolved_rejects_config_tampered_after_freeze(
    tmp_path: Path,
) -> None:
    """冻结后改了参数，哈希必须对不上——否则这道门只是摆设。

    「只校验 sha256 字段存在」是不够的：字段在、值是手填的旧值，
    一样能过门禁。
    """

    _write_resolved(tmp_path, ["A"])
    path = tmp_path / "config" / "resolved" / "A.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    data["k1"] = 99.0  # 冻结后偷偷改了参数
    path.write_text(json.dumps(data), encoding="utf-8")

    problems = verify_resolved_configs(tmp_path, ["A"])
    assert problems
    assert "sha256" in problems[0]


def test_config_payload_sha256_ignores_key_order() -> None:
    """同样的参数，键顺序不同，哈希必须相同。"""

    left = {"chunking": "whole_file", "k1": 0.9}
    right = {"k1": 0.9, "chunking": "whole_file"}
    assert config_payload_sha256(left) == config_payload_sha256(right)


def test_config_payload_sha256_excludes_the_hash_field_itself() -> None:
    """哈希不能自指：算的时候必须排除 sha256 字段本身。"""

    payload = {"chunking": "whole_file"}
    expected = config_payload_sha256(payload)
    payload["sha256"] = expected
    assert config_payload_sha256(payload) == expected


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
