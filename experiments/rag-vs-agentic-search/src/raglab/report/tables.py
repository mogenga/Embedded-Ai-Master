"""表格输出（§11：CSV + Markdown 双份）。"""

from __future__ import annotations

import csv
import json
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any


def _cell(value: Any) -> str:
    if isinstance(value, float):
        return f"{value:.4f}"
    if isinstance(value, (dict, list, tuple)):
        return json.dumps(value, ensure_ascii=False, sort_keys=True)
    return "" if value is None else str(value)


def write_csv(
    path: str | Path,
    rows: Sequence[Mapping[str, Any]],
    *,
    columns: Sequence[str] | None = None,
    newline: str = "\n",
) -> Path:
    """写 CSV；列顺序默认取首行键序，缺失值写空串。"""

    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = list(columns) if columns is not None else list(rows[0].keys()) if rows else []
    with target.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames, lineterminator=newline)
        writer.writeheader()
        for row in rows:
            writer.writerow({key: _cell(row.get(key)) for key in fieldnames})
    return target


def write_markdown_table(
    path: str | Path,
    rows: Sequence[Mapping[str, Any]],
    *,
    columns: Sequence[str] | None = None,
) -> Path:
    """写 Markdown 表格；空数据只写表头分隔线之上的说明。"""

    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = list(columns) if columns is not None else list(rows[0].keys()) if rows else []
    lines: list[str] = []
    if fieldnames:
        lines.append("| " + " | ".join(fieldnames) + " |")
        lines.append("|" + "|".join("---" for _ in fieldnames) + "|")
        for row in rows:
            cells = [_cell(row.get(key)).replace("|", "\\|") for key in fieldnames]
            lines.append("| " + " | ".join(cells) + " |")
    else:
        lines.append("（无数据：尚未跑批）")
    target.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    return target
