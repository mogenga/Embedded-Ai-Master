"""方案 B 的工具面（spec §8.3）。

四个工具，语义与 kb-mcp 的风格一致（诚实失败、路径受限）：

- ``glob(pattern)``：按通配符列路径；
- ``grep(pattern, glob?, max_results=100)``：逐行正则检索；
- ``read(path, offset?, limit?)``：读文件（单次 2000 行 / 256 KiB）；
- ``submit(paths, confidence, reason)``：提交最终候选。

**路径安全**：所有工具只能访问 ``corpus/kb/`` 内部。越界返回结构化错误，
抛异常会让 agent 看到栈回溯，反而诱导它猜路径。

**诚实失败**：读不到就是错误，不返回空字符串冒充"读到了但是空"（R3）。
"""

from __future__ import annotations

import fnmatch
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

MAX_READ_LINES = 2000
MAX_READ_BYTES = 256 * 1024
MAX_GREP_RESULTS = 100
MAX_SUBMIT_PATHS = 5

# 工具名 → JSON Schema（OpenAI 兼容的 tools 参数格式）。
TOOL_SCHEMAS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "glob",
            "description": "按通配符列出知识库中的文件路径，例如 protocols/**/*.md。",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {
                        "type": "string",
                        "description": "相对知识库根的通配符模式",
                    }
                },
                "required": ["pattern"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "grep",
            "description": (
                "在文件内容中按正则检索，返回匹配行与文件路径。"
                f"最多返回 {MAX_GREP_RESULTS} 条，超出时标注截断。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "description": "正则表达式"},
                    "glob": {
                        "type": "string",
                        "description": "可选：只在这些文件里检索，例如 **/*.md",
                    },
                },
                "required": ["pattern"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read",
            "description": (
                "读取知识库中的文件。"
                f"单次上限 {MAX_READ_LINES} 行或 {MAX_READ_BYTES // 1024} KiB。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "相对知识库根的路径"},
                    "offset": {
                        "type": "integer",
                        "description": "从第几行开始（0-based，默认 0）",
                    },
                    "limit": {
                        "type": "integer",
                        "description": f"最多读多少行（默认且上限 {MAX_READ_LINES}）",
                    },
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "submit",
            "description": (
                f"提交最终候选文件列表（最多 {MAX_SUBMIT_PATHS} 个，按相关性从高到低）。"
                "必须调用本工具才算完成任务。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "paths": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "候选文件路径，最多 5 个",
                    },
                    "confidence": {
                        "type": "number",
                        "description": "0 到 1 的置信度",
                    },
                    "reason": {"type": "string", "description": "简短理由"},
                },
                "required": ["paths"],
            },
        },
    },
]


@dataclass(frozen=True)
class ToolResult:
    """工具返回给模型的结构化结果。"""

    ok: bool
    payload: dict[str, Any]

    def as_json(self) -> str:
        import json

        return json.dumps(self.payload, ensure_ascii=False)


@dataclass(frozen=True)
class SubmitCall:
    """一次成功的 submit 调用。"""

    paths: tuple[str, ...]
    confidence: float
    reason: str


class ToolBox:
    """绑定到某个语料根的工具集合。"""

    def __init__(self, corpus_root: str | Path, *, navigation_files: tuple[str, ...] = ()) -> None:
        self._root = Path(corpus_root).resolve()
        self._navigation = set(navigation_files)

    @property
    def root(self) -> Path:
        return self._root

    def _safe_path(self, relative: str) -> Path | None:
        """解析到语料根内；越界或指到目录返回 None。"""

        raw = (relative or "").strip().replace("\\", "/")
        if not raw or raw.startswith("/") or re.match(r"^[A-Za-z]:", raw):
            return None
        parts = [part for part in raw.split("/") if part not in ("", ".")]
        if any(part == ".." for part in parts):
            return None
        target = (self._root / Path(*parts)).resolve()
        if not target.is_relative_to(self._root) or not target.is_file():
            return None
        return target

    def _relative(self, path: Path) -> str:
        return path.relative_to(self._root).as_posix()

    def glob(self, pattern: str) -> ToolResult:
        pattern = (pattern or "").strip()
        if not pattern:
            return ToolResult(False, {"error": "empty_pattern", "message": "pattern 不能为空"})

        matches: list[str] = []
        for path in sorted(self._root.rglob("*")):
            if not path.is_file():
                continue
            relative = self._relative(path)
            if fnmatch.fnmatch(relative, pattern) or fnmatch.fnmatch(path.name, pattern):
                matches.append(relative)
        # 导航文件不作为检索目标暴露给 agent（T11 的前置）。
        matches = [path for path in matches if path not in self._navigation]
        truncated = len(matches) > MAX_GREP_RESULTS
        return ToolResult(
            True,
            {
                "matches": matches[:MAX_GREP_RESULTS],
                "count": len(matches),
                "truncated": truncated,
            },
        )

    def grep(self, pattern: str, glob: str | None = None) -> ToolResult:
        pattern = (pattern or "").strip()
        if not pattern:
            return ToolResult(False, {"error": "empty_pattern", "message": "pattern 不能为空"})
        try:
            regex = re.compile(pattern, re.IGNORECASE)
        except re.error as exc:
            return ToolResult(
                False, {"error": "invalid_regex", "message": f"正则非法：{exc}"}
            )

        hits: list[dict[str, Any]] = []
        truncated = False
        for path in sorted(self._root.rglob("*")):
            if not path.is_file():
                continue
            relative = self._relative(path)
            if relative in self._navigation:
                continue
            if glob and not (
                fnmatch.fnmatch(relative, glob) or fnmatch.fnmatch(path.name, glob)
            ):
                continue
            try:
                text = path.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            for lineno, line in enumerate(text.splitlines(), start=1):
                if not regex.search(line):
                    continue
                hits.append({"path": relative, "line": lineno, "text": line.strip()[:300]})
                if len(hits) >= MAX_GREP_RESULTS:
                    truncated = True
                    break
            if truncated:
                break
        return ToolResult(
            True,
            {"hits": hits, "count": len(hits), "truncated": truncated, "found": bool(hits)},
        )

    def read(self, path: str, offset: int = 0, limit: int | None = None) -> ToolResult:
        target = self._safe_path(path)
        if target is None:
            return ToolResult(
                False,
                {"error": "path_denied", "message": f"路径不在知识库内或不存在：{path}"},
            )
        try:
            data = target.read_bytes()
        except OSError as exc:
            return ToolResult(False, {"error": "read_failed", "message": str(exc)})

        truncated_bytes = len(data) > MAX_READ_BYTES
        if truncated_bytes:
            data = data[:MAX_READ_BYTES]
        try:
            text = data.decode("utf-8", errors="replace")
        except Exception as exc:  # noqa: BLE001 —— 解码失败也要如实报
            return ToolResult(False, {"error": "decode_failed", "message": str(exc)})

        lines = text.splitlines()
        start = max(0, int(offset or 0))
        take = min(int(limit or MAX_READ_LINES), MAX_READ_LINES)
        window = lines[start : start + take]
        return ToolResult(
            True,
            {
                "path": path,
                "content": "\n".join(window),
                "offset": start,
                "lines": len(window),
                "total_lines": len(lines),
                "truncated": truncated_bytes or start + take < len(lines),
            },
        )

    def submit(self, paths: list[str], confidence: float = 0.0, reason: str = "") -> SubmitCall:
        """规范化提交结果；路径越界或指向导航文件的被**丢弃**并在 reason 里注明。"""

        cleaned: list[str] = []
        dropped: list[str] = []
        for item in paths or []:
            target = self._safe_path(str(item))
            if target is None:
                dropped.append(str(item))
                continue
            relative = self._relative(target)
            if relative in self._navigation:
                dropped.append(relative)
                continue
            if relative not in cleaned:
                cleaned.append(relative)

        note = reason
        if dropped:
            note = f"{reason}（已丢弃无效路径：{', '.join(dropped[:3])}）".strip()
        return SubmitCall(
            paths=tuple(cleaned[:MAX_SUBMIT_PATHS]),
            confidence=max(0.0, min(1.0, float(confidence or 0.0))),
            reason=note,
        )
