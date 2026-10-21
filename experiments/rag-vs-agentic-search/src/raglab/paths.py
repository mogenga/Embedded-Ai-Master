"""跨平台路径工具。

约定（spec §9.2）：内部一律使用 POSIX 相对路径；读写磁盘时才转换为本地路径。
所有来自查询、候选、manifest 的路径都必须经过 ``normalize_rel`` 与
``resolve_inside``，防止越界读取。
"""

from __future__ import annotations

import posixpath
import re
from pathlib import Path

_DRIVE_RE = re.compile(r"^[A-Za-z]:")


class PathError(ValueError):
    """路径不合法或越界。"""


def to_posix(value: str | Path) -> str:
    """把本地路径写法统一为 POSIX 风格字符串。"""

    return str(value).replace("\\", "/")


def normalize_rel(value: str | Path) -> str:
    """校验并归一化一个相对路径（POSIX 风格）。

    拒绝空值、绝对路径、盘符与 ``..`` 片段；允许重复斜杠并折叠。
    """

    raw = to_posix(value).strip()
    if not raw:
        raise PathError("路径为空")
    if raw.startswith("/") or _DRIVE_RE.match(raw):
        raise PathError(f"路径必须是相对路径：{value!r}")

    norm = posixpath.normpath(raw)
    if norm in ("", "."):
        raise PathError(f"路径为空：{value!r}")
    parts = norm.split("/")
    if any(part in ("", "..") for part in parts):
        raise PathError(f"路径包含越界片段：{value!r}")
    return norm


def resolve_inside(root: str | Path, rel: str | Path) -> Path:
    """把相对路径解析到 ``root`` 内，并确认解析结果未越出根目录。"""

    root_path = Path(root).resolve()
    target = (root_path / Path(normalize_rel(rel))).resolve()
    if not target.is_relative_to(root_path):
        raise PathError(f"路径越界：{rel!r}")
    return target


def relative_posix(root: str | Path, path: str | Path) -> str:
    """把磁盘上的路径转换为相对 ``root`` 的 POSIX 路径。"""

    root_path = Path(root).resolve()
    target = Path(path).resolve()
    if not target.is_relative_to(root_path):
        raise PathError(f"路径不在根目录内：{path!r}")
    return target.relative_to(root_path).as_posix()
