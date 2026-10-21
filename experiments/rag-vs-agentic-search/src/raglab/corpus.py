"""语料快照与 manifest（spec §7.1、T1）。

语料不进版本库；导入后生成 ``manifest.sha256``，每行 ``"<sha256>  <posix相对路径>"``，
按路径排序。任何运行前都要校验，不符即中止。
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path

from .paths import PathError, normalize_rel, resolve_inside, to_posix

MANIFEST_NAME = "manifest.sha256"
CHUNK_SIZE = 1024 * 1024


@dataclass(frozen=True)
class ManifestMismatch:
    path: str
    expected: str | None
    actual: str | None

    @property
    def kind(self) -> str:
        if self.expected is None:
            return "unexpected"
        if self.actual is None:
            return "missing"
        return "changed"


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while True:
            block = handle.read(CHUNK_SIZE)
            if not block:
                break
            digest.update(block)
    return digest.hexdigest()


def iter_corpus_files(root: str | Path, *, pattern: str = "*.md") -> list[Path]:
    """按 POSIX 路径排序返回语料文件，忽略 manifest 自身。"""

    root_path = Path(root)
    files = [
        path
        for path in root_path.rglob(pattern)
        if path.is_file() and path.name != MANIFEST_NAME
    ]
    return sorted(files, key=lambda path: to_posix(path.relative_to(root_path)))


def build_manifest(root: str | Path, *, pattern: str = "*.md") -> list[tuple[str, str]]:
    """生成 ``(相对路径, sha256)`` 列表，按路径升序。"""

    root_path = Path(root)
    entries: list[tuple[str, str]] = []
    for path in iter_corpus_files(root_path, pattern=pattern):
        relative = path.relative_to(root_path).as_posix()
        entries.append((relative, file_sha256(path)))
    return sorted(entries)


def render_manifest(entries: list[tuple[str, str]]) -> str:
    """渲染为可写盘的 manifest 文本（末尾换行）。"""

    return "".join(f"{digest}  {path}\n" for path, digest in entries)


def write_manifest(root: str | Path, *, pattern: str = "*.md") -> Path:
    """在语料根目录写 ``manifest.sha256``；返回写入路径。"""

    root_path = Path(root)
    entries = build_manifest(root_path, pattern=pattern)
    target = root_path / MANIFEST_NAME
    target.write_text(render_manifest(entries), encoding="utf-8", newline="\n")
    return target


def parse_manifest(text: str) -> dict[str, str]:
    """解析 manifest 文本为 ``{path: sha256}``；格式错误即抛 ValueError。"""

    entries: dict[str, str] = {}
    for lineno, raw in enumerate(text.splitlines(), start=1):
        line = raw.rstrip()
        if not line or line.startswith("#"):
            continue
        parts = line.split("  ", 1)
        if len(parts) != 2:
            raise ValueError(f"manifest 第 {lineno} 行格式错误：{raw!r}")
        digest, path = parts
        if len(digest) != 64 or any(ch not in "0123456789abcdef" for ch in digest):
            raise ValueError(f"manifest 第 {lineno} 行摘要非法：{digest!r}")
        try:
            normalized = normalize_rel(path)
        except PathError as exc:
            raise ValueError(f"manifest 第 {lineno} 行路径非法：{exc}") from exc
        if normalized in entries:
            raise ValueError(f"manifest 第 {lineno} 行路径重复：{normalized}")
        entries[normalized] = digest
    return entries


def verify_manifest(root: str | Path, expected: dict[str, str]) -> list[ManifestMismatch]:
    """逐文件校验；返回差异列表（空表示一致）。"""

    actual = dict(build_manifest(root))
    problems: list[ManifestMismatch] = []
    for path in sorted(set(expected) | set(actual)):
        want = expected.get(path)
        got = actual.get(path)
        if want != got:
            problems.append(ManifestMismatch(path=path, expected=want, actual=got))
    return problems


def read_manifest(path: str | Path) -> dict[str, str]:
    return parse_manifest(Path(path).read_text(encoding="utf-8"))


def verify_corpus(root: str | Path) -> list[ManifestMismatch]:
    """读取语料根目录下已存在的 manifest 并校验；manifest 缺失即报错。"""

    root_path = Path(root)
    manifest_path = root_path / MANIFEST_NAME
    if not manifest_path.is_file():
        raise FileNotFoundError(f"缺少语料 manifest：{to_posix(manifest_path)}")
    return verify_manifest(root_path, read_manifest(manifest_path))


def read_corpus_file(root: str | Path, rel: str) -> str:
    """按 POSIX 相对路径读取语料文本（UTF-8）；越界抛 PathError。"""

    target = resolve_inside(root, rel)
    return target.read_text(encoding="utf-8")
