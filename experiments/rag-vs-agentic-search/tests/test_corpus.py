"""语料 manifest（T1）。"""

from __future__ import annotations

from pathlib import Path

import pytest

from raglab.corpus import (
    MANIFEST_NAME,
    build_manifest,
    parse_manifest,
    read_corpus_file,
    render_manifest,
    verify_corpus,
    verify_manifest,
    write_manifest,
)
from raglab.paths import PathError


def _corpus(tmp_path: Path) -> Path:
    root = tmp_path / "kb"
    (root / "protocols").mkdir(parents=True)
    (root / "protocols" / "uart.md").write_text("uart", encoding="utf-8")
    (root / "system").mkdir()
    (root / "system" / "boot.md").write_text("boot", encoding="utf-8")
    return root


def test_build_manifest_sorted_by_posix_path(tmp_path: Path) -> None:
    root = _corpus(tmp_path)
    entries = build_manifest(root)
    assert [path for path, _ in entries] == ["protocols/uart.md", "system/boot.md"]
    assert all(len(digest) == 64 for _, digest in entries)


def test_write_manifest_excludes_manifest_itself(tmp_path: Path) -> None:
    root = _corpus(tmp_path)
    target = write_manifest(root)
    assert target.name == MANIFEST_NAME
    written = parse_manifest(target.read_text(encoding="utf-8"))
    assert MANIFEST_NAME not in written
    assert verify_corpus(root) == []


def test_verify_manifest_detects_changed_missing_and_unexpected(tmp_path: Path) -> None:
    root = _corpus(tmp_path)
    write_manifest(root)
    (root / "protocols" / "uart.md").write_text("changed", encoding="utf-8")
    (root / "system" / "boot.md").unlink()
    (root / "new.md").write_text("new", encoding="utf-8")

    kinds = {mismatch.kind for mismatch in verify_corpus(root)}
    assert kinds == {"changed", "missing", "unexpected"}


def test_parse_manifest_rejects_bad_lines() -> None:
    with pytest.raises(ValueError):
        parse_manifest("not-a-manifest-line\n")
    with pytest.raises(ValueError):
        parse_manifest("z" * 64 + "  a.md\n" + "z" * 64 + "  a.md\n")


def test_render_and_parse_roundtrip(tmp_path: Path) -> None:
    root = _corpus(tmp_path)
    entries = build_manifest(root)
    parsed = parse_manifest(render_manifest(entries))
    assert parsed == dict(entries)


def test_read_corpus_file_blocks_escape(tmp_path: Path) -> None:
    root = _corpus(tmp_path)
    assert read_corpus_file(root, "protocols/uart.md") == "uart"
    with pytest.raises(PathError):
        read_corpus_file(root, "../secret.md")


def test_verify_manifest_returns_empty_when_matching(tmp_path: Path) -> None:
    root = _corpus(tmp_path)
    manifest = dict(build_manifest(root))
    assert verify_manifest(root, manifest) == []
