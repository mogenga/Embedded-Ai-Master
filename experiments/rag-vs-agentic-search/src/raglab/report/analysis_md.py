"""把 `results/analysis/main.json` 渲染成可读的 `main.md`。

**为什么要这个模块**：上一轮留下的 `main.md` 是手写的，内容与数据脱节——
它还写着「B 与 D 未做全量跑批」，并带着一条后来被证伪的说法
（「该子样本偏易」）。手写的可读版必然会漂移，**从 JSON 生成**才不会。

所以本模块只做渲染，不含任何结论文字——数字全部来自 JSON。
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def render_markdown(payload: dict[str, Any]) -> str:
    """把分析结果渲染成 Markdown。"""

    lines: list[str] = []
    lines.append("# RAG vs Agentic Search 分析结果（可读版）")
    lines.append("")
    lines.append(
        "> **状态：探索性（exploratory）。预注册未冻结，不构成主判定依据**（spec T2）。"
    )
    lines.append(
        "> 本文件由 `results/analysis/main.json` 生成；**报告全文见 "
        "`docs/experiment-report.md`**。"
    )
    lines.append("")
    lines.append(f"run_id：`{payload.get('run_id')}`")
    lines.append(f"参与分析的方案：{', '.join(payload.get('schemes_loaded', []))}")
    lines.append("")

    alignment = payload.get("alignment") or {}
    if alignment:
        state = "✅ 可逐条配对" if not alignment.get("misaligned") else "❌ 无法配对"
        lines.append(f"**配对检查**：{state}（n = {alignment.get('n')}）")
        for problem in alignment.get("problems", []):
            lines.append(f"- ⚠️ {problem}")
        lines.append("")

    lines.extend(_render_latency(payload.get("latency", [])))
    lines.extend(_render_significance(payload.get("significance", {})))
    lines.extend(_render_h7(payload.get("h7", []), payload.get("h7_note")))

    lines.append("---")
    lines.append("")
    lines.append(
        "**结论全文见 `docs/experiment-report.md`**；产物位置与复现命令见该文件 §9。"
    )
    return "\n".join(lines) + "\n"


def _render_latency(latency: list[dict[str, Any]]) -> list[str]:
    lines = ["## H4 延迟与失败率", ""]
    lines.append("| 方案 | P50 | P95 | 失败率 | 状态分布 |")
    lines.append("|---|---|---|---|---|")
    for item in latency:
        counts = item.get("status_counts", {})
        dist = " / ".join(f"{key} {value}" for key, value in counts.items())
        lines.append(
            f"| {item['scheme']} | {item['p50_latency_ms'] / 1000:.2f} s | "
            f"{item['p95_latency_ms'] / 1000:.2f} s | "
            f"{item['failure_rate']:.1%} | {dist} |"
        )
    lines.append("")
    return lines


def _render_significance(significance: dict[str, Any]) -> list[str]:
    lines = ["## 显著性（预注册比较族 + Holm）", ""]
    lines.append(
        f"族大小 **{significance.get('family_size')}**（固定，不因缺数据而缩小）；"
        f"实际比较 {significance.get('compared')} 项。"
    )
    lines.append("")
    lines.append("| 比较 | n | 差值 | McNemar | p | p(Holm) | 95% CI | 显著 |")
    lines.append("|---|---|---|---|---|---|---|---|")
    for item in significance.get("comparisons", []):
        if item.get("skipped_reason"):
            lines.append(
                f"| {item['name']} | — | — | — | — | — | — | "
                f"跳过（{item['skipped_reason']}） |"
            )
            continue
        mcnemar = item.get("mcnemar", {})
        lines.append(
            f"| {item['name']} | {item['n']} | {item['diff_pp']:+.1f}pp | "
            f"{mcnemar.get('only_a')}/{mcnemar.get('only_b')} | "
            f"{item['p_value']:.2e} | {item['p_adjusted']:.2e} | "
            f"[{item['ci_low_pp']:+.1f}, {item['ci_high_pp']:+.1f}]pp | "
            f"{'**是**' if item['significant'] else '否'} |"
        )
    lines.append("")
    for note in significance.get("notes", []):
        lines.append(f"> {note}")
    lines.append("")
    return lines


def _render_h7(h7: list[dict[str, Any]], note: str | None) -> list[str]:
    lines = ["## H7 拒答能力", ""]
    lines.append("| 方案 | 假候选率 | 正确拒答率 | AUROC | 阈值 |")
    lines.append("|---|---|---|---|---|")
    for item in h7:
        if item.get("skipped"):
            lines.append(f"| {item['scheme']} | ⚠️ 不报 | ⚠️ 不报 | ⚠️ 不报 | — |")
            continue
        lines.append(
            f"| {item['scheme']} | {item['false_candidate_rate']:.0%} | "
            f"{item['correct_refusal_rate']:.0%} | {item['auroc']} | "
            f"{item['threshold']} |"
        )
    lines.append("")
    for item in h7:
        if item.get("skipped"):
            lines.append(f"- **{item['scheme']}**：{item['skipped_reason']}")
    if note:
        lines.append(f"- {note}")
    lines.append("")
    return lines


def write_markdown(payload: dict[str, Any], path: str | Path) -> Path:
    """渲染并落盘。"""

    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(render_markdown(payload), encoding="utf-8", newline="\n")
    return target


def render_from_json(json_path: str | Path) -> str:
    """从 `main.json` 读取并渲染。"""

    payload = json.loads(Path(json_path).read_text(encoding="utf-8"))
    return render_markdown(payload)
