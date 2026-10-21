"""单方案诊断报告的 Markdown 生成。

报告的边界在**正文第一段**就写死，不放在脚注里——单方案数字最容易被误读成"结论"。
"""

from __future__ import annotations

from collections.abc import Sequence
from pathlib import Path
from typing import Any

from .diagnostic import DiagnosticBundle

_HEADER_WARNING = (
    "> **这不是实验结论。** 当前只有方案 C 可以运行，本报告是**探索性诊断**：\n"
    "> 它回答「这套 C 的实现到底在做什么」，不回答「哪个方案更好」。\n"
    "> 只有一个方案时，任何数字都不得被读成方案对比，也不得据此声称谁胜出（spec T2 / T3）。"
)

_KNOWN_DEVIATIONS = [
    "**单标注者**：80 条查询全部由项目所有者编写，无一致性系数（spec §6.5）。",
    "**样本量 80 < 原设计 274**：原回归集确认无法取得，已换自建集；功效下降，"
    "10pp 效应更可能被判「未决」。",
    "**11/80 条 gold 不在 `index.yaml` 中**：方案 C 的 `lookup` 分支在这些查询上无法命中；"
    "分层的实测 Recall@2 是 0.0909（1/11），不是 0——唯一命中来自 search 分支。",
    "**扰动集与多 gold 未建**：H6 已按 §5.2 降级为 warning，nDCG@5 按单 gold 计。",
]


def _fmt(value: Any, digits: int = 4) -> str:
    if isinstance(value, float):
        return f"{value:.{digits}f}"
    return "" if value is None else str(value)


def _table(rows: Sequence[dict[str, Any]], columns: Sequence[tuple[str, str]]) -> list[str]:
    lines = ["| " + " | ".join(label for _, label in columns) + " |"]
    lines.append("|" + "|".join("---" for _ in columns) + "|")
    for row in rows:
        lines.append(
            "| " + " | ".join(_fmt(row.get(key)) for key, _ in columns) + " |"
        )
    return lines


def render_markdown(
    bundle: DiagnosticBundle,
    *,
    figures: Sequence[str],
    skipped: Sequence[tuple[str, str]],
    corpus_files: int | None = None,
) -> str:
    """生成报告正文。所有口径与偏离都在正文里，不藏进附录。"""

    lines: list[str] = []
    lines.append(f"# 方案 C 诊断报告（探索性）：`{bundle.run_id}`")
    lines.append("")
    lines.append(_HEADER_WARNING)
    lines.append("")

    # ---- 一、这是什么 ----
    lines.append("## 1. 跑的是什么")
    lines.append("")
    lines.append(
        f"- **方案**：C（现状基线 = `kb_lookup` 索引路由 + `kb_search` 精确 token grep）"
    )
    lines.append(
        "- **实现方式**：对主仓库 `mcp-servers/kb/`（`feat/m2-stage3` @ `c529dcd`）"
        "做逐行移植，用 105 条查询（80 正 + 25 负）与 kb-mcp 原件逐条比对，"
        "lookup / token 提取 / search 三项**零差异**"
    )
    if corpus_files is not None:
        lines.append(f"- **语料**：`corpus/kb/` 共 {corpus_files} 个 markdown 文件，90 条索引条目")
    lines.append(f"- **查询**：全量 {bundle.queries} 条（不分 dev/test，不参与调参）")
    lines.append(f"- **负样本**：{bundle.negatives} 条")
    lines.append("- **运行模式**：`exploratory`")
    lines.append("")

    # ---- 二、主结果 ----
    lines.append("## 2. 主指标")
    lines.append("")
    lines.append(
        "三种 dispatch 读法的完整对照。**主口径是 `deployed`**（预注册 §6bis）："
        "它对应真实部署的系统；另两种要改写 kb-mcp 的闸门或删掉回退逻辑，"
        "是构想出来的变体。"
    )
    lines.append("")
    variant_rows = [
        {
            "rule": v.rule,
            "primary": "★ 主口径" if v.primary else "",
            "n": v.aggregate().get("n"),
            "recall2": v.aggregate().get("recall@2"),
            "recall5": v.aggregate().get("recall@5"),
            "hit1": v.aggregate().get("hit@1"),
            "mrr": v.aggregate().get("mrr"),
            "ndcg5": v.aggregate().get("ndcg@5"),
            "p50": v.aggregate().get("p50_latency_ms"),
            "p95": v.aggregate().get("p95_latency_ms"),
        }
        for v in bundle.variants
    ]
    lines.extend(
        _table(
            variant_rows,
            [
                ("rule", "dispatch 读法"),
                ("primary", "主口径"),
                ("n", "n"),
                ("recall2", "Recall@2"),
                ("recall5", "Recall@5"),
                ("hit1", "Hit@1"),
                ("mrr", "MRR"),
                ("ndcg5", "nDCG@5"),
                ("p50", "P50 (ms)"),
                ("p95", "P95 (ms)"),
            ],
        )
    )
    lines.append("")
    lines.append(
        "> `deployed` 与 `lexical` 差 8.75pp、与 `lookup_only` 差 5pp，**跨度超过本实验"
        "主判定用的 5pp 门槛**。这正是预注册 §6bis 要求「三种读法全部报告」的原因："
        "只看一种读法得出的结论，换一种读法可能反向。**若后续与 C′/A/B 的对照在三种读法下"
        "方向不一致，C 相关判定一律写「未决（口径敏感）」。**"
    )
    lines.append("")

    # ---- 三、负样本 ----
    lines.append("## 3. 负样本行为（H7）")
    lines.append("")
    lines.append(
        "**这一节最容易被误读**：kb-mcp 自报的 0.84 拒答率是**只调 `lookup`** 的数字。"
        "按 `deployed` 形态回退到 `kb_search` 后，正确拒答率降到 0.08。"
        "两个数字都对，但指的是不同的系统。"
    )
    lines.append("")
    lines.extend(
        _table(
            [
                {
                    "rule": result.rule,
                    "total": result.total,
                    "refusal": result.correct_refusal_rate,
                    "false": result.false_candidate_rate,
                }
                for result in bundle.negative_results
            ],
            [
                ("rule", "dispatch 读法"),
                ("total", "负样本数"),
                ("refusal", "正确拒答率"),
                ("false", "假候选率"),
            ],
        )
    )
    lines.append("")
    lines.append(
        "> 原因：`kb_search` 遍历全部 `.md` 文件，`_sources.md` 会命中几乎所有查询且"
        "按路径字典序恒排第一。这不是 kb-mcp 的回归缺陷（它自己的回归脚本只测 lookup），"
        "但意味着**部署形态的拒答能力远低于单独 lookup 的表观数字**。"
    )
    lines.append("")

    # ---- 四、图 ----
    lines.append("## 4. 图")
    lines.append("")
    if figures:
        for name in figures:
            lines.append(f"![{name}](figures/{name})")
            lines.append("")
    else:
        lines.append("（本次未生成任何图）")
        lines.append("")
    if skipped:
        lines.append("**跳过的图及原因**（不产出空图——空图会被读成「无差异」）：")
        lines.append("")
        lines.extend(
            _table(
                [{"file": name, "reason": reason} for name, reason in skipped],
                [("file", "文件"), ("reason", "原因")],
            )
        )
        lines.append("")

    # ---- 五、已知偏离 ----
    lines.append("## 5. 已知偏离（必须随本报告一起引用）")
    lines.append("")
    for item in _KNOWN_DEVIATIONS:
        lines.append(f"- {item}")
    lines.append("")

    if bundle.warnings:
        lines.append("## 6. 运行期告警")
        lines.append("")
        for warning in bundle.warnings:
            lines.append(f"- {warning}")
        lines.append("")

    # ---- 六、下一步 ----
    lines.append("## 7. 这份报告不能回答什么")
    lines.append("")
    lines.append(
        "- **不能**回答「C 好还是 C′/A/B 好」——只有 C 一个方案，没有任何对比。"
    )
    lines.append("- **不能**回答「要不要上 RAG」——那是决策点 #2，需要五个方案跑完。")
    lines.append(
        "- **不能**作为冻结配置的依据——预注册尚未冻结，本报告不参与任何选择。"
    )
    lines.append("")
    return "\n".join(lines) + "\n"
