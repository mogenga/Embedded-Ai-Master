"""切块（spec §8.2 / §8.5）。

两种策略，**必须是"整文件"或"按 section"二选一**，不做自动混合——混合会让
"切块方式"这个变量无法归因。

- ``whole_file``：一个文件一块。文件超过上限时按上限硬切，否则会超出 embedding 预算。
- ``section``：按 Markdown 标题（`#`~`######`）切；代码块内的 `#` 不算标题。

两者的共同约束（预注册）：chunk 上限 1200 字符、重叠 100 字符。
重叠只在硬切/相邻 section 合并时生效——**不制造跨文件的块**，否则候选路径会变多义。
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

DEFAULT_MAX_CHARS = 1200
DEFAULT_OVERLAP_CHARS = 100

CHUNKING_MODES = ("whole_file", "section")

# 标题行：行首 1-6 个 `#`，后跟空白与标题文本。
_HEADING = re.compile(r"^(#{1,6})\s+\S")
# 围栏代码块起止（``` 或 ~~~）；块内的 `#` 不是标题。
_FENCE = re.compile(r"^\s*(```|~~~)")


@dataclass(frozen=True)
class Chunk:
    """一个待检索单元。

    ``path`` 是相对语料根的 POSIX 路径；``order`` 是同一文件内的序号，
    用于稳定排序（同分时先出现的胜）。
    """

    path: str
    order: int
    text: str

    @property
    def key(self) -> tuple[str, int]:
        return (self.path, self.order)


def _hard_split(text: str, *, max_chars: int, overlap: int) -> list[str]:
    """按字符上限硬切，保留 ``overlap`` 字符重叠。"""

    if len(text) <= max_chars:
        return [text]
    pieces: list[str] = []
    start = 0
    step = max(1, max_chars - overlap)
    while start < len(text):
        pieces.append(text[start : start + max_chars])
        if start + max_chars >= len(text):
            break
        start += step
    return pieces


def _split_sections(text: str) -> list[tuple[str, str]]:
    """按 Markdown 标题切分成 ``(heading, body)``。代码块内的标题不算。

    第一个标题之前的内容若有实质文本，归入 ``("", preamble)``。
    """

    lines = text.splitlines()
    sections: list[tuple[str, list[str]]] = []
    current_heading = ""
    current_lines: list[str] = []
    in_fence = False

    for line in lines:
        if _FENCE.match(line):
            in_fence = not in_fence
            current_lines.append(line)
            continue
        if not in_fence and _HEADING.match(line):
            if current_lines and "".join(current_lines).strip():
                sections.append((current_heading, current_lines))
            current_heading = line.strip()
            current_lines = [line]
            continue
        current_lines.append(line)

    if current_lines and "".join(current_lines).strip():
        sections.append((current_heading, current_lines))

    return [(heading, "\n".join(body)) for heading, body in sections]


def chunk_text(
    text: str,
    *,
    mode: str = "section",
    max_chars: int = DEFAULT_MAX_CHARS,
    overlap: int = DEFAULT_OVERLAP_CHARS,
) -> list[str]:
    """把单个文件的正文切成若干块。

    超过 ``max_chars`` 的部分硬切；section 模式下只在块自身超长时才切，
    不做跨 section 的拼接——拼接会让"哪个候选路径"变得不明确。
    """

    if mode not in CHUNKING_MODES:
        raise ValueError(f"未知切块方式：{mode!r}，可选 {CHUNKING_MODES}")
    if max_chars <= 0:
        raise ValueError("max_chars 必须为正")
    if overlap < 0 or overlap >= max_chars:
        raise ValueError("overlap 必须在 [0, max_chars) 区间")

    if mode == "whole_file":
        return _hard_split(text, max_chars=max_chars, overlap=overlap)

    pieces: list[str] = []
    for _, body in _split_sections(text):
        pieces.extend(_hard_split(body, max_chars=max_chars, overlap=overlap))
    return pieces


def iter_markdown(root: str | Path) -> list[Path]:
    """按 POSIX 路径排序返回语料中的 markdown 文件。"""

    root_path = Path(root)
    if not root_path.is_dir():
        return []
    files = [path for path in root_path.rglob("*.md") if path.is_file()]
    return sorted(
        files, key=lambda path: path.relative_to(root_path).as_posix()
    )


def chunk_corpus(
    root: str | Path,
    *,
    mode: str = "section",
    max_chars: int = DEFAULT_MAX_CHARS,
    overlap: int = DEFAULT_OVERLAP_CHARS,
    exclude: Iterable[str] = (),
) -> list[Chunk]:
    """把整个语料切成块。

    ``exclude`` 是**相对路径**集合：导航文件不应进入索引（T11 的前置，
    否则它们会先占满候选名额再被过滤掉，等于变相降低召回）。
    """

    root_path = Path(root)
    blocked = set(exclude)
    chunks: list[Chunk] = []
    for path in iter_markdown(root_path):
        relative = path.relative_to(root_path).as_posix()
        if relative in blocked:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            # 读不出来就跳过该文件；调用方可通过 chunk 数变化察觉，不静默吞掉统计。
            continue
        for order, piece in enumerate(
            chunk_text(text, mode=mode, max_chars=max_chars, overlap=overlap)
        ):
            chunks.append(Chunk(path=relative, order=order, text=piece))
    return chunks
