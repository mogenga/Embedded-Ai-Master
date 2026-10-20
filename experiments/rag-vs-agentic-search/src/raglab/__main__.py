"""CLI：import / split / index / run / score / report（spec §9.1）。

诚实边界：
- ``import``、``split``、``score``、``report`` 已实现（纯逻辑，不触网）。
- ``index``、``run`` 需要方案实现与模型端点，骨架期一律退出码 3。
- ``score`` 默认只允许 dev/探索模式；``--confirmatory`` 走预注册与配置冻结校验。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .assets import Query
from .config import ExperimentConfig
from .env import capture_env, write_env
from .errors import BlockedError, ConfigurationError, IntakeError, RaglabError
from .intake import intake_or_raise, load_queries, run_intake
from .prereg import require_confirmatory_ready
from .report.tables import write_csv, write_markdown_table
from .scoring import read_results_jsonl, score_records, summarize
from .splitting import split_to_record, stratified_split

PROJECT_ROOT = Path(__file__).resolve().parents[2]


def _load_config(path: Path) -> ExperimentConfig:
    if not path.is_file():
        raise ConfigurationError(f"缺少配置文件：{path}")
    return ExperimentConfig.from_yaml(path)


def _project_paths(config: ExperimentConfig) -> tuple[Path, Path, Path]:
    return (
        PROJECT_ROOT / config.corpus_dir,
        PROJECT_ROOT / config.data_dir,
        PROJECT_ROOT / config.results_dir,
    )


def _write_json(path: Path, payload: object) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    return path


def cmd_import(args: argparse.Namespace) -> int:
    config = _load_config(Path(args.config))
    corpus_dir, data_dir, results_dir = _project_paths(config)

    report = run_intake(corpus_dir=corpus_dir, data_dir=data_dir)
    output = Path(args.out) if args.out else results_dir / "intake_report.json"
    _write_json(output, report.to_dict())

    print(json.dumps(report.to_dict(), ensure_ascii=False, indent=2))
    if not report.ok:
        raise IntakeError(f"G0 资产导入失败：{len(report.errors)} 项错误，见 {output}")
    return 0


def cmd_split(args: argparse.Namespace) -> int:
    config = _load_config(Path(args.config))
    _, data_dir, _ = _project_paths(config)

    queries, report = load_queries(data_dir)
    if not report.ok:
        raise IntakeError("查询集导入失败，无法切分：" + "；".join(report.errors[:3]))
    if not queries:
        raise BlockedError("查询集为空：需先导入 M2 评测集")

    split = stratified_split(
        queries, seed=config.seed, dev_ratio=args.dev_ratio
    )
    payload = split_to_record(split)
    payload["dev_ratio"] = args.dev_ratio

    if args.dry_run:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0

    target = Path(args.out) if args.out else data_dir / "splits.json"
    _write_json(target, payload)
    print(
        f"已写入 {target}：dev={len(split.dev)} test={len(split.test)} seed={split.seed}"
    )
    return 0


def _load_query_map(data_dir: Path) -> dict[str, Query]:
    queries, report = load_queries(data_dir)
    if not report.ok:
        raise IntakeError("查询集导入失败：" + "；".join(report.errors[:3]))
    return {query.id: query for query in queries}


def _split_lookup(data_dir: Path) -> dict[str, str]:
    path = data_dir / "splits.json"
    if not path.is_file():
        return {}
    data = json.loads(path.read_text(encoding="utf-8"))
    lookup: dict[str, str] = {}
    for side in ("dev", "test"):
        for query_id in data.get(side) or []:
            lookup[str(query_id)] = side
    return lookup


def cmd_score(args: argparse.Namespace) -> int:
    config = _load_config(Path(args.config))
    _, data_dir, results_dir = _project_paths(config)

    if args.confirmatory:
        scheme_names = [args.scheme] if args.scheme else ["A", "B", "C", "C_prime", "D"]
        require_confirmatory_ready(
            PROJECT_ROOT, schemes=scheme_names, partition=args.partition
        )

    query_map = _load_query_map(data_dir)
    run_dir = Path(args.run_dir) if args.run_dir else results_dir / "runs" / args.run_id
    files = sorted(run_dir.glob(f"{args.scheme}.jsonl")) if args.scheme else sorted(
        run_dir.glob("*.jsonl")
    )
    if not files:
        raise BlockedError(f"{run_dir} 下没有逐查询结果，无法评分")

    rows = []
    for path in files:
        rows.extend(score_records(read_results_jsonl(path), query_map))

    side_lookup = _split_lookup(data_dir)
    if args.partition != "all":
        if not side_lookup:
            raise BlockedError("缺少 splits.json，无法按分区评分；先运行 raglab split")
        rows = [
            row
            for row in rows
            if side_lookup.get(row.query_id) == args.partition
        ]
    if not rows:
        raise BlockedError(f"分区 {args.partition!r} 下没有可评分结果")

    overall = summarize(rows)
    by_track = summarize(rows, group_by=("scheme", "track"))
    by_topic = summarize(rows, group_by=("scheme", "topic"))
    by_gold = summarize(rows, group_by=("scheme", "n_gold"))

    out_dir = Path(args.out_dir) if args.out_dir else results_dir / "scored" / args.run_id
    per_query_rows = [row.as_row() for row in rows]
    write_csv(out_dir / "per_query.csv", per_query_rows)
    write_markdown_table(out_dir / "overall.md", overall)
    write_csv(out_dir / "overall.csv", overall)
    write_csv(out_dir / "by_track.csv", by_track)
    write_csv(out_dir / "by_topic.csv", by_topic)
    write_csv(out_dir / "by_gold_count.csv", by_gold)

    payload = {
        "run_id": args.run_id,
        "partition": args.partition,
        "mode": "confirmatory" if args.confirmatory else "exploratory",
        "overall": overall,
        "by_track": by_track,
    }
    if not args.confirmatory:
        payload["warning"] = "探索性结果：不得作为主判定（spec T2）"
    _write_json(out_dir / "summary.json", payload)

    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


def cmd_report(args: argparse.Namespace) -> int:
    config = _load_config(Path(args.config))
    _, _, results_dir = _project_paths(config)

    scored_dir = (
        Path(args.scored_dir) if args.scored_dir else results_dir / "scored" / args.run_id
    )
    overall_path = scored_dir / "overall.csv"
    if not overall_path.is_file():
        raise BlockedError(f"缺少评分结果：{overall_path}；先运行 raglab score")

    import csv

    with overall_path.open("r", encoding="utf-8", newline="") as handle:
        overall = list(csv.DictReader(handle))

    tables_dir = results_dir / "tables"
    tables_dir.mkdir(parents=True, exist_ok=True)
    write_csv(tables_dir / "overall.csv", overall)
    write_markdown_table(tables_dir / "overall.md", overall)

    payload = {
        "run_id": args.run_id,
        "tables": ["overall.csv", "overall.md"],
        "figures": [],
        "note": "图表需在方案实现与跑批后补（report/charts.py 为显式占位）",
    }
    _write_json(results_dir / "report_manifest.json", payload)
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


def cmd_env(args: argparse.Namespace) -> int:
    config = _load_config(Path(args.config))
    corpus_dir, _, _ = _project_paths(config)
    manifest = corpus_dir / "manifest.sha256"
    env = capture_env(
        PROJECT_ROOT,
        seed=config.seed,
        corpus_manifest=manifest if manifest.is_file() else None,
        model=config.model,
    )
    target = Path(args.out) if args.out else PROJECT_ROOT / "env.json"
    write_env(target, env)
    print(json.dumps(env, ensure_ascii=False, indent=2))
    return 0


def _not_ready(step: str, reason: str) -> int:
    print(f"[{step}] 未就绪：{reason}", file=sys.stderr)
    return BlockedError.exit_code


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="raglab", description="RAG vs Agentic Search 实验工具")
    parser.add_argument(
        "--config",
        default=str(PROJECT_ROOT / "config" / "experiment.yaml"),
        help="实验配置路径",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    import_parser = sub.add_parser("import", help="导入并校验资产（G0）")
    import_parser.add_argument("--out", help="intake_report.json 输出路径")
    import_parser.set_defaults(func=cmd_import)

    split_parser = sub.add_parser("split", help="按预注册规则切分 dev/test（§7.4）")
    split_parser.add_argument("--dev-ratio", type=float, default=0.7)
    split_parser.add_argument("--out", help="splits.json 输出路径")
    split_parser.add_argument("--dry-run", action="store_true", help="只打印不写盘")
    split_parser.set_defaults(func=cmd_split)

    score_parser = sub.add_parser("score", help="对逐查询结果评分（§10）")
    score_parser.add_argument("--run-id", required=True)
    score_parser.add_argument("--scheme", help="只评某个方案（默认全部）")
    score_parser.add_argument(
        "--partition", choices=("dev", "test", "all"), default="all"
    )
    score_parser.add_argument(
        "--confirmatory",
        action="store_true",
        help="确认性评分：校验预注册与配置冻结，禁止在 dev 上使用",
    )
    score_parser.add_argument("--run-dir", help="自定义 run 目录")
    score_parser.add_argument("--out-dir", help="自定义输出目录")
    score_parser.set_defaults(func=cmd_score)

    report_parser = sub.add_parser("report", help="由评分结果生成表格（§11）")
    report_parser.add_argument("--run-id", required=True)
    report_parser.add_argument("--scored-dir", help="自定义评分结果目录")
    report_parser.set_defaults(func=cmd_report)

    env_parser = sub.add_parser("env", help="记录运行环境（§9.2 / T9）")
    env_parser.add_argument("--out", help="env.json 输出路径")
    env_parser.set_defaults(func=cmd_env)

    for name, reason in (
        ("index", "需要 M1 语料与 embedding 端点"),
        ("run", "需要方案实现（骨架期全部为显式占位）"),
    ):
        step = sub.add_parser(name, help=f"（骨架期未实现）{reason}")
        step.set_defaults(func=lambda _args, step=name, reason=reason: _not_ready(step, reason))

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.func(args))
    except RaglabError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return exc.exit_code


if __name__ == "__main__":
    raise SystemExit(main())
