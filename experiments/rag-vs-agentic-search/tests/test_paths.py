"""路径归一化与越界防护（§9.2：Windows 为一等公民）。"""

from __future__ import annotations

from pathlib import Path

import pytest

from raglab.paths import PathError, normalize_rel, relative_posix, resolve_inside, to_posix


def test_normalize_accepts_posix_and_windows_spellings() -> None:
    assert normalize_rel("protocols/uart.md") == "protocols/uart.md"
    assert normalize_rel("protocols\\uart.md") == "protocols/uart.md"
    assert normalize_rel("./protocols//uart.md") == "protocols/uart.md"


@pytest.mark.parametrize(
    "value",
    ["", "  ", "/etc/passwd", "C:/Windows/system32", "C:\\Windows", "../secret.md", "a/../../b.md", "."],
)
def test_normalize_rejects_absolute_or_escaping(value: str) -> None:
    with pytest.raises(PathError):
        normalize_rel(value)


def test_resolve_inside_stays_under_root(tmp_path: Path) -> None:
    target = resolve_inside(tmp_path, "kb/a.md")
    assert target.is_relative_to(tmp_path.resolve())


def test_resolve_inside_rejects_escape(tmp_path: Path) -> None:
    with pytest.raises(PathError):
        resolve_inside(tmp_path, "../outside.md")


def test_relative_posix_roundtrip(tmp_path: Path) -> None:
    nested = tmp_path / "kb" / "protocols" / "uart.md"
    nested.parent.mkdir(parents=True)
    nested.write_text("x", encoding="utf-8")
    assert relative_posix(tmp_path / "kb", nested) == "protocols/uart.md"


def test_to_posix_normalizes_windows_separators() -> None:
    assert to_posix("a\\b\\c.md") == "a/b/c.md"
