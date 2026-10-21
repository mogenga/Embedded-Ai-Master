"""分析结果的可读版渲染（从 JSON 生成，不手写）。"""

from __future__ import annotations

import json
from pathlib import Path

from raglab.report.analysis_md import render_from_json, render_markdown, write_markdown


def _payload() -> dict:
    return {
        "run_id": "main",
        "schemes_loaded": ["A", "B"],
        "alignment": {"misaligned": False, "problems": [], "n": 80},
        "latency": [
            {
                "scheme": "B",
                "n": 80,
                "p50_latency_ms": 65032.8,
                "p95_latency_ms": 101515.1,
                "failure_rate": 0.025,
                "status_counts": {"ok": 78, "timeout": 2},
            }
        ],
        "significance": {
            "family_size": 4,
            "compared": 1,
            "comparisons": [
                {
                    "name": "A vs B",
                    "n": 80,
                    "diff_pp": -12.5,
                    "mcnemar": {"only_a": 2, "only_b": 12},
                    "p_value": 1.29e-2,
                    "p_adjusted": 3.88e-2,
                    "ci_low_pp": -21.2,
                    "ci_high_pp": -3.8,
                    "significant": True,
                    "skipped_reason": None,
                },
                {
                    "name": "D vs 最优单一方案",
                    "n": 0,
                    "diff_pp": 0.0,
                    "mcnemar": {"only_a": 0, "only_b": 0},
                    "p_value": 1.0,
                    "p_adjusted": None,
                    "ci_low_pp": 0.0,
                    "ci_high_pp": 0.0,
                    "significant": False,
                    "skipped_reason": "D 无全量数据（未跑批）",
                },
            ],
            "notes": ["缺席的族内比较按 p = 1 计入族大小"],
        },
        "h7": [
            {
                "scheme": "A",
                "skipped": False,
                "false_candidate_rate": 0.0,
                "correct_refusal_rate": 1.0,
                "auroc": 1.0,
                "threshold": None,
            },
            {
                "scheme": "B",
                "skipped": True,
                "skipped_reason": "B 没有负样本跑批实现，无法评估拒答能力",
            },
        ],
        "h7_note": "A 的 H7 沿用上一轮实算结果",
    }


def test_markdown_contains_all_three_blocks() -> None:
    text = render_markdown(_payload())
    assert "H4 延迟与失败率" in text
    assert "显著性" in text
    assert "H7 拒答能力" in text


def test_markdown_reports_skipped_scheme_without_numbers() -> None:
    """被跳过的方案不能出现数字——「不报」与「0%」在表里长得像。"""

    text = render_markdown(_payload())
    assert "⚠️ 不报" in text
    assert "B 没有负样本跑批实现" in text


def test_markdown_shows_skipped_comparison_reason() -> None:
    text = render_markdown(_payload())
    assert "跳过（D 无全量数据（未跑批））" in text


def test_markdown_reports_alignment_state() -> None:
    text = render_markdown(_payload())
    assert "配对检查" in text
    assert "可逐条配对" in text


def test_markdown_shows_family_size() -> None:
    """族大小必须显式写出——它是「族不因缺数据而缩小」这条的证据。"""

    text = render_markdown(_payload())
    assert "族大小 **4**" in text


def test_write_markdown_roundtrips_from_json(tmp_path: Path) -> None:
    target = tmp_path / "main.json"
    target.write_text(
        json.dumps(_payload(), ensure_ascii=False), encoding="utf-8"
    )
    text = render_from_json(target)
    assert "A vs B" in text
    out = write_markdown(_payload(), tmp_path / "main.md")
    assert out.is_file()
    assert out.read_text(encoding="utf-8") == text


def test_markdown_has_no_stale_conclusion_text() -> None:
    """可读版不得含上一轮的旧结论——它是从 JSON 渲染的，不带任何手写结论。"""

    text = render_markdown(_payload())
    assert "未做全量跑批" not in text
    assert "偏易" not in text
