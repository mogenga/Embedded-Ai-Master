"""报表骨架（spec §11）。

骨架期只提供表格写入与图表占位；图表在跑批产生 ``results/scored/*.csv`` 后再实现，
避免出现"有图无数据"的误导性产物。
"""

from __future__ import annotations

from .tables import write_csv, write_markdown_table

__all__ = ["write_csv", "write_markdown_table"]
