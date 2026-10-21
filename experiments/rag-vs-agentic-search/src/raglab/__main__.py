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
from .config import (
    IMPLEMENTED_SCHEMES,
    SCHEME_FILES,
    ExperimentConfig,
    load_models,
    load_scheme,
)
from .embedding import embedding_endpoint
from .env import capture_env, write_env
from .errors import BlockedError, ConfigurationError, IntakeError, RaglabError
from .intake import load_queries, run_intake
from .prereg import require_confirmatory_ready
from .report.tables import write_csv, write_markdown_table
from .runner import (
    append_result,
    read_completed_query_ids,
    run_queries,
    summarize_status,
    write_results_jsonl,
)
from .schemes.base import get_scheme
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


def _config_payload_sha256(resolved: dict[str, object]) -> str:
    """已冻结配置的哈希（spec §6.2 第 2 条）。

    **实现在 `prereg` 模块**——那里才是门禁的所在地，两处各写一份
    迟早会算出不同的值，校验就会莫名其妙地失败。
    """

    from .prereg import config_payload_sha256

    return config_payload_sha256(resolved)


def _relative_posix(path: str | Path) -> str:
    """把绝对路径变成**相对项目根**的 POSIX 路径。

    产物里写绝对路径有两个坏处：把本机目录结构写进版本库，
    以及换个机器/换个 checkout 路径就失效。相对路径两样都避开。
    """

    from .paths import relative_posix

    try:
        return relative_posix(PROJECT_ROOT, path)
    except Exception:
        # 不在项目根下（如临时目录）时退回原样——总比报错好。
        return Path(path).as_posix()


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

    # 多 gold 补标（增强项）：**只影响 nDCG@5**，主判定指标不受影响
    # （spec §7.3 第 5 条）。没有这个文件时映射为空，行为与接线前完全一致。
    from .intake import multi_gold_map

    multi_gold, multi_gold_report = multi_gold_map(data_dir)
    for warning in multi_gold_report.warnings:
        print(f"警告：{warning}", file=sys.stderr)

    run_dir = Path(args.run_dir) if args.run_dir else results_dir / "runs" / args.run_id
    files = sorted(run_dir.glob(f"{args.scheme}.jsonl")) if args.scheme else sorted(
        run_dir.glob("*.jsonl")
    )
    if not files:
        raise BlockedError(f"{run_dir} 下没有逐查询结果，无法评分")

    rows = []
    for path in files:
        rows.extend(
            score_records(read_results_jsonl(path), query_map, multi_gold=multi_gold)
        )

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
        # nDCG@5 的口径来源，必须可审计：用了多 gold 还是退化成单 gold。
        "ndcg_source": {
            "multi_gold_entries": len(multi_gold),
            "rows_using_multi_gold": sum(
                1 for row in rows if row.ndcg5_from_multi_gold
            ),
            "note": (
                "多 gold 只影响 nDCG@5；Recall/Hit/MRR 一律用 queries.jsonl 的原始单 gold"
                "（spec §7.3 第 5 条）"
            ),
        },
    }
    if not multi_gold:
        payload["ndcg_source"]["low_confidence"] = True
        payload["ndcg_source"]["low_confidence_reason"] = (
            "未提供 annotation_multi_gold.jsonl：nDCG@5 以单 gold 计，低置信"
        )
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


def _resolved_params(name: str, params: dict[str, object]) -> dict[str, object]:
    """优先读 `config/resolved/<name>.json` 的冻结值；否则要求网格已收敛为单值。

    网格文件里 `k1: [0.9, 1.5]` 是**搜索空间**，不是一份可跑的配置。跑批时拿列表
    当标量用会静默取到错误的档位，所以这里显式拒绝，并指向 `raglab grid`。
    """

    resolved_path = PROJECT_ROOT / "config" / "resolved" / f"{name}.json"
    if resolved_path.is_file():
        data = json.loads(resolved_path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ConfigurationError(f"{resolved_path.name} 顶层必须是映射")
        return {**params, **data}

    lists = sorted(key for key, value in params.items() if isinstance(value, list))
    # `ablations` 是开关清单，不是超参，允许留在列表里。
    lists = [key for key in lists if key != "ablations"]
    if lists:
        raise ConfigurationError(
            f"方案 {name} 的 {lists} 仍是网格（列表），跑批前必须先选值："
            f"运行 `raglab grid --scheme {name}` 并把选定值写入 "
            f"config/resolved/{name}.json"
        )
    return params


def _build_scheme(
    name: str,
    config: ExperimentConfig,
    corpus_dir: Path,
    *,
    spacing_seconds: float | None = None,
    variant: str | None = None,
):
    """按 `config/schemes/<name>.yaml` 构造方案实例。

    参数缺失即报错，不用默认值兜底——否则"这次跑批用了哪套参数"不可判定。
    ``spacing_seconds`` 覆盖配置文件里的值：限流是运行环境属性，不是方案配置。
    """

    scheme_file = SCHEME_FILES.get(name)
    if scheme_file is None:
        raise ConfigurationError(f"未知方案：{name!r}")

    # 先判"有没有实现"，再判"参数选没选"。反过来的话，未实现的方案会先报
    # "参数是网格"，让人误以为只差选值——那句提示对占位方案是假的。
    if name not in IMPLEMENTED_SCHEMES:
        raise ConfigurationError(
            f"方案 {name} 尚未实现（当前只有 {sorted(IMPLEMENTED_SCHEMES)} 可跑）"
        )

    scheme_config = load_scheme(name, PROJECT_ROOT / "config" / "schemes" / scheme_file)
    params = _resolved_params(name, scheme_config.params)

    if name == "A":
        # A 需要已建好的索引；这里**不自动构建**——那会隐式触发一次长时间网络调用。
        index = _load_vector_index(config, corpus_dir)
        if index is None:
            raise BlockedError(
                "方案 A 缺少向量索引：先运行 `raglab index --scheme A`（需 RAGLAB_LIVE=1）"
            )
        models = load_models(PROJECT_ROOT / "config" / "models.yaml")
        endpoint = embedding_endpoint(models)
        return get_scheme(
            name,
            navigation_files=config.navigation_files,
            index=index,
            embed_query=lambda text: endpoint.embed([text])[0],
            top_k=int(params.get("top_k", 5)),
        )
    if name == "C":
        return get_scheme(
            name,
            navigation_files=config.navigation_files,
            corpus_root=corpus_dir,
            dispatch_rule=str(params.get("dispatch_rule", "deployed")),
            lookup_top_k=int(params.get("lookup_top_k", 2)),
            extended_recall_k=int(params.get("extended_recall_k", 5)),
            search_limit=int(params.get("search_limit", 20)),
            token_pattern=params.get("token_pattern"),
        )
    if name == "B":
        from .chat_endpoint import chat_endpoint
        from .schemes.agentic import load_system_prompt

        prompt_path = scheme_config.prompt_path or "prompts/agentic_system.txt"
        prompt = load_system_prompt(PROJECT_ROOT / "config" / prompt_path)
        endpoint = chat_endpoint(load_models(PROJECT_ROOT / "config" / "models.yaml"))
        return get_scheme(
            name,
            navigation_files=config.navigation_files,
            corpus_root=corpus_dir,
            system_prompt=prompt,
            chat_fn=endpoint.chat,
            model=endpoint.model_id,
            max_tool_rounds=int(params.get("max_tool_rounds", 12)),
            max_candidates=int(params.get("max_candidates", 5)),
            temperature=float(params.get("temperature", 0.0)),
            spacing_seconds=float(
                spacing_seconds
                if spacing_seconds is not None
                else params.get("spacing_seconds", 0.0) or 0.0
            ),
        )
    if name == "D":
        from .chat_endpoint import chat_endpoint
        from .schemes.hybrid import SchemeD
        from .schemes.seeds import make_seed_fn

        variants = scheme_config.variants or {}
        variant = variant or "D1"
        if variant not in variants:
            raise ConfigurationError(
                f"未知 D 变体：{variant!r}，可选 {sorted(variants)}"
            )
        spec = variants[variant] or {}

        from .h5 import h5_signal

        if not h5_signal(config, corpus_dir):
            raise BlockedError(
                "H5 无信号，方案 D 不运行（spec §8.6）：报告中写明「H5 无信号，D 未运行」"
            )

        endpoint = chat_endpoint(load_models(PROJECT_ROOT / "config" / "models.yaml"))
        embed_query = None
        if variant == "D2":
            from .embedding import embedding_endpoint

            embed_endpoint_obj = embedding_endpoint(
                load_models(PROJECT_ROOT / "config" / "models.yaml")
            )
            embed_query = lambda text: embed_endpoint_obj.embed([text])[0]

        seed_fn = make_seed_fn(
            variant=variant,
            corpus_root=corpus_dir,
            navigation_files=config.navigation_files,
            index_path=_vector_index_path(),
            embed_query=embed_query,
            seed_top_k=int(spec.get("seed_top_k", 3)),
        )
        return get_scheme(
            name,
            navigation_files=config.navigation_files,
            corpus_root=corpus_dir,
            system_prompt=load_system_prompt(
                PROJECT_ROOT / "config" / "prompts" / "agentic_system.txt"
            ),
            chat_fn=endpoint.chat,
            model=endpoint.model_id,
            variant=variant,
            seed_fn=seed_fn,
            tool_rounds=int(spec.get("tool_rounds", 3)),
            max_candidates=int(params.get("max_candidates", 5)),
            temperature=float(params.get("temperature", 0.0)),
            spacing_seconds=(
                spacing_seconds
                if spacing_seconds is not None
                else params.get("spacing_seconds", 0.0) or 0.0
            ),
            h5_signal=True,
        )
    if name == "C_prime":
        return get_scheme(
            name,
            navigation_files=config.navigation_files,
            corpus_root=corpus_dir,
            chunking=str(params.get("chunking", "section")),
            tokenizer=str(params.get("tokenizer", "cjk_bigram")),
            k1=float(params.get("k1", 1.5)),
            b=float(params.get("b", 0.75)),
            top_k=int(params.get("top_k", 5)),
            grep_review_top_n=int(params.get("grep_review_top_n", 20)),
            grep_bonus=float(params.get("grep_bonus", 0.05)),
            max_chars=int(params.get("chunk_max_chars", 1200)),
            overlap_chars=int(params.get("chunk_overlap_chars", 100)),
        )
    raise ConfigurationError(f"方案 {name} 的参数接线尚未实现（当前 C 与 C′ 可跑）")


def cmd_run(args: argparse.Namespace) -> int:
    """按指定方案跑一批查询，写 `results/runs/<run_id>/<scheme>.jsonl`。

    **逐条落盘 + 可续跑**：结果边跑边追加到目标文件；带 ``--resume`` 时跳过
    已完成的 query_id。B 的全量要 1.7–2.7 小时且网关随时可能排队 9.7 小时，
    没有断点续跑就意味着一次中断要赔上两小时。
    """

    config = _load_config(Path(args.config))
    corpus_dir, data_dir, results_dir = _project_paths(config)

    queries, report = load_queries(data_dir)
    if not report.ok:
        raise IntakeError("查询集导入失败，无法跑批：" + "；".join(report.errors[:3]))

    side = _split_lookup(data_dir)
    if args.partition != "all":
        if not side:
            raise BlockedError("缺少 splits.json，无法按分区跑批；先运行 raglab split")
        queries = [q for q in queries if side.get(q.id) == args.partition]
        if not queries:
            raise BlockedError(f"分区 {args.partition!r} 下没有查询")

    output = results_dir / "runs" / args.run_id / f"{args.scheme}.jsonl"
    resume = bool(getattr(args, "resume", False))
    skipped: list[str] = []
    if resume:
        done = read_completed_query_ids(output)
        if done:
            skipped = [q.id for q in queries if q.id in done]
            queries = [q for q in queries if q.id not in done]
        if not queries:
            print(
                json.dumps(
                    {
                        "run_id": args.run_id,
                        "scheme": args.scheme,
                        "status": {"total": 0},
                        "resumed": True,
                        "skipped": len(skipped),
                        "output": str(output),
                        "note": "所有查询均已完成，未重跑",
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
            return 0
    elif output.is_file():
        # 不带 --resume 却已有旧结果：直接覆盖会丢掉上次的跑批痕迹，
        # 而留着又会和新结果混在一起。显式拒绝，逼使用者选一条路。
        raise BlockedError(
            f"{output} 已存在：加 --resume 续跑（跳过已完成的条目），"
            "或换一个 --run-id，或先删掉该文件"
        )

    scheme = _build_scheme(
        args.scheme,
        config,
        corpus_dir,
        spacing_seconds=getattr(args, "spacing", None),
        variant=getattr(args, "variant", None),
    )
    # 计时前预热：索引解析成本每进程只付一次，不该由第一个查询独自承担。
    warm_up = getattr(scheme, "warm_up", None)
    if callable(warm_up):
        warm_up()

    # 逐条落盘。方案自身不管这件事——写盘是跑批层的职责。
    def on_result(result) -> None:
        append_result(result, output)

    if not resume:
        # 新跑：先清空目标文件。旧结果与新结果混在一处会分不清哪条是哪次跑的。
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text("", encoding="utf-8", newline="\n")

    summary = run_queries(
        scheme,
        queries,
        run_id=args.run_id,
        deadline_ms=args.deadline_ms,
        query_spacing_seconds=float(getattr(args, "query_spacing", 0.0) or 0.0),
        on_result=on_result,
    )

    payload = {
        "run_id": args.run_id,
        "scheme": args.scheme,
        "partition": args.partition,
        "dispatch_rule": summary.results[0].extra.get("dispatch_rule")
        if summary.results
        else None,
        "status": summarize_status(summary),
        "aborted": summary.aborted,
        "abort_reason": summary.abort_reason,
        "resumed": resume,
        "skipped": len(skipped),
        "output": str(output),
        "mode": "exploratory"
        if not args.confirmatory
        else "confirmatory",
    }
    if not args.confirmatory:
        payload["warning"] = "探索性跑批：结果不得作为主判定（spec T2）"
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


def _dev_queries(data_dir: Path, queries: list[Query]) -> list[Query]:
    side = _split_lookup(data_dir)
    if not side:
        raise BlockedError("缺少 splits.json，无法在 dev 上搜索；先运行 raglab split")
    selected = [query for query in queries if side.get(query.id) == "dev"]
    if not selected:
        raise BlockedError("dev 分区为空，网格搜索无意义")
    return selected


def cmd_index(args: argparse.Namespace) -> int:
    """构建并落盘方案 A 的向量索引。

    **这是唯一会长时间触网的命令**：653 个 chunk、110 条一批约 6 次调用。
    向量按 `sha256(chunk_text) + model_id` 缓存，重复运行只补新增的 chunk。
    """

    import time

    from .embedding import embedding_endpoint
    from .retrieval.vector_index import save_index
    from .schemes.vector_rag import build_index

    config = _load_config(Path(args.config))
    corpus_dir, _, results_dir = _project_paths(config)

    if args.scheme != "A":
        raise BlockedError(f"索引构建当前只支持方案 A（{args.scheme} 未实现）")

    scheme_config = load_scheme("A", PROJECT_ROOT / "config" / "schemes" / "vector.yaml")
    params = scheme_config.params

    chunking = args.chunking or _resolved_value("A", "chunking", params)
    max_chars = int(params.get("chunk_max_chars", 1200))
    overlap_chars = int(params.get("chunk_overlap_chars", 100))

    models = load_models(PROJECT_ROOT / "config" / "models.yaml")
    endpoint = embedding_endpoint(models)

    cache_dir = PROJECT_ROOT / "results" / "cache" / "embeddings"
    print(
        f"构建索引：chunking={chunking} model={endpoint.model_id} "
        f"batch={args.batch_size} spacing={args.spacing}s",
        file=sys.stderr,
    )

    started = time.perf_counter()
    index = build_index(
        corpus_root=corpus_dir,
        navigation_files=config.navigation_files,
        chunking=chunking,
        max_chars=max_chars,
        overlap_chars=overlap_chars,
        embed_fn=endpoint.embed,
        model_id=endpoint.model_id,
        cache_dir=cache_dir,
        batch_size=args.batch_size,
        spacing_seconds=args.spacing,
    )
    elapsed = time.perf_counter() - started

    payload = {
        "scheme": "A",
        "chunking": chunking,
        "model_id": endpoint.model_id,
        "chunks": index.size,
        "files": index.files,
        "build_seconds": round(elapsed, 1),
        "index_cached": index.cached,
        # 路径写**相对项目根**的 POSIX 形式，不写绝对路径：
        # 绝对路径会把本机目录结构写进版本库（换个机器就失效），
        # 也会泄露本地路径。相对路径既能定位文件，又与机器无关。
        "cache_dir": _relative_posix(cache_dir),
    }
    index_path = _vector_index_path()
    save_index(index, index_path)
    payload["index_path"] = _relative_posix(index_path)

    out_dir = Path(args.out_dir) if getattr(args, "out_dir", None) else results_dir / "index"
    _write_json(out_dir / "A_index_stats.json", payload)
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


def _vector_index_path() -> Path:
    """向量索引的落盘位置。放 `results/cache/`——可重建，不算实验产物。"""

    return PROJECT_ROOT / "results" / "cache" / "A_index.json"


def _load_vector_index(config: ExperimentConfig, corpus_dir: Path):
    from .retrieval.vector_index import load_index

    index = load_index(_vector_index_path())
    if index is None:
        return None
    # 索引的 chunking 必须与当前配置一致；否则是在用另一套切块跑批。
    expected = _resolved_value("A", "chunking", load_scheme(
        "A", PROJECT_ROOT / "config" / "schemes" / "vector.yaml"
    ).params)
    if index.chunking and expected and index.chunking != expected:
        raise ConfigurationError(
            f"向量索引的切块方式（{index.chunking}）与配置（{expected}）不一致："
            "重新运行 `raglab index --scheme A`"
        )
    return index


def _resolved_value(name: str, key: str, params: dict[str, object]) -> object:
    """取已冻结的单值；仍是网格则报错（与 `_resolved_params` 同一口径）。"""

    resolved_path = PROJECT_ROOT / "config" / "resolved" / f"{name}.json"
    if resolved_path.is_file():
        data = json.loads(resolved_path.read_text(encoding="utf-8"))
        if isinstance(data, dict) and key in data:
            return data[key]
    value = params.get(key)
    if isinstance(value, list):
        raise ConfigurationError(
            f"方案 {name} 的 {key} 仍是网格 {value}：先跑 `raglab grid --scheme {name} --write-resolved`"
        )
    return value


def _grid_scheme_a(
    args: argparse.Namespace,
    config: ExperimentConfig,
    corpus_dir: Path,
    dev_queries: list[Query],
    params: dict[str, object],
) -> int:
    """A 的网格：切块方式二选一。

    与 C′ 不同，A 的每个网格点都要**重新建索引**（切块变了，chunk 就变了），
    所以这里逐个建、逐个评估，并把向量写进共享缓存以免跨网格点重复编码。
    """

    from .metrics import hit_at_k, reciprocal_rank
    from .retrieval.chunking import chunk_corpus
    from .retrieval.vector_index import VectorIndex, encode_chunks
    from .scoring import mean
    from .schemes.vector_rag import SchemeA

    models = load_models(PROJECT_ROOT / "config" / "models.yaml")
    endpoint = embedding_endpoint(models)
    cache_dir = PROJECT_ROOT / "results" / "cache" / "embeddings"
    max_chars = int(params.get("chunk_max_chars", 1200))
    overlap = int(params.get("chunk_overlap_chars", 100))

    rows: list[dict[str, object]] = []
    for chunking in params.get("chunking", ["section"]):
        chunks = chunk_corpus(
            corpus_dir,
            mode=str(chunking),
            max_chars=max_chars,
            overlap=overlap,
            exclude=tuple(config.navigation_files),
        )
        vectors, stats = encode_chunks(
            chunks,
            embed_fn=endpoint.embed,
            model_id=endpoint.model_id,
            cache_dir=cache_dir,
            batch_size=args.batch_size,
            spacing_seconds=args.spacing,
        )
        index = VectorIndex(
            chunks=chunks,
            vectors=vectors,
            model_id=endpoint.model_id,
            build_seconds=0.0,
            cached=int(stats["cache_misses"]) == 0,
            chunking=str(chunking),
        )
        scheme = SchemeA(
            index=index,
            navigation_files=config.navigation_files,
            embed_query=lambda text: endpoint.embed([text])[0],
            top_k=int(params.get("top_k", 5)),
        )

        recall2: list[float] = []
        recall5: list[float] = []
        hit1: list[float] = []
        mrr: list[float] = []
        for query in dev_queries:
            result = scheme.run(query)
            recall2.append(1.0 if hit_at_k(result.status, result.paths, query.gold, 2) else 0.0)
            recall5.append(1.0 if hit_at_k(result.status, result.paths, query.gold, 5) else 0.0)
            hit1.append(1.0 if hit_at_k(result.status, result.paths, query.gold, 1) else 0.0)
            mrr.append(reciprocal_rank(result.status, result.paths, query.gold))

        rows.append(
            {
                "scheme": "A",
                "chunking": chunking,
                "n": len(dev_queries),
                "recall@2": mean(recall2),
                "recall@5": mean(recall5),
                "hit@1": mean(hit1),
                "mrr": mean(mrr),
                "chunks": index.size,
                "cache_hits": stats["cache_hits"],
            }
        )

    out_dir = Path(args.out_dir) if args.out_dir else results_dir_for(config) / "tables"
    write_csv(out_dir / "grid_search_A.csv", rows)
    write_markdown_table(out_dir / "grid_search_A.md", rows)
    ranked = sorted(rows, key=lambda row: (-float(row["recall@2"]), -float(row["hit@1"])))  # type: ignore[arg-type]
    print(
        json.dumps(
            {
                "scheme": "A",
                "grid_size": len(rows),
                "dev_queries": len(dev_queries),
                "best": ranked[0],
                "output": str(out_dir / "grid_search_A.csv"),
            },
            ensure_ascii=False,
            indent=2,
            default=str,
        )
    )
    return 0


def results_dir_for(config: ExperimentConfig) -> Path:
    return PROJECT_ROOT / config.results_dir


def cmd_grid(args: argparse.Namespace) -> int:
    """在 dev 上跑预注册网格，**全部配置都记录**（§6.3 / T3）。

    只报最优是最常见的调参不对称来源：读者看不到搜索空间有多大，
    也不知道最优配置离其余配置有多远。
    """

    import itertools

    from .metrics import hit_at_k, reciprocal_rank
    from .scoring import mean

    config = _load_config(Path(args.config))
    corpus_dir, data_dir, results_dir = _project_paths(config)

    if args.scheme not in ("C_prime", "A"):
        raise BlockedError(f"网格搜索当前只支持 C_prime 与 A（{args.scheme} 尚未实现）")

    queries, report = load_queries(data_dir)
    if not report.ok:
        raise IntakeError("查询集导入失败：" + "；".join(report.errors[:3]))
    dev_queries = _dev_queries(data_dir, queries)

    scheme_config = load_scheme(args.scheme, PROJECT_ROOT / "config" / "schemes" / SCHEME_FILES[args.scheme])
    params = scheme_config.params

    if args.scheme == "A":
        return _grid_scheme_a(args, config, corpus_dir, dev_queries, params)

    grid = list(
        itertools.product(
            params.get("chunking", ["section"]),
            params.get("tokenizer", ["cjk_bigram"]),
            params.get("k1", [1.5]),
            params.get("b", [0.75]),
        )
    )

    from .schemes.bm25_grep import SchemeCPrime

    rows: list[dict[str, object]] = []
    for chunking, tokenizer, k1, b in grid:
        # 每个网格点都要新建一个实例：BM25 索引与切块方式绑定，复用会串味。
        scheme = SchemeCPrime(
            corpus_root=corpus_dir,
            navigation_files=config.navigation_files,
            chunking=str(chunking),
            tokenizer=str(tokenizer),
            k1=float(k1),
            b=float(b),
            top_k=int(params.get("top_k", 5)),
            grep_review_top_n=int(params.get("grep_review_top_n", 20)),
            grep_bonus=float(params.get("grep_bonus", 0.05)),
        )
        scheme.warm_up()

        recall2: list[float] = []
        recall5: list[float] = []
        hit1: list[float] = []
        mrr: list[float] = []
        for query in dev_queries:
            result = scheme.run(query)
            recall2.append(1.0 if hit_at_k(result.status, result.paths, query.gold, 2) else 0.0)
            recall5.append(1.0 if hit_at_k(result.status, result.paths, query.gold, 5) else 0.0)
            hit1.append(1.0 if hit_at_k(result.status, result.paths, query.gold, 1) else 0.0)
            mrr.append(reciprocal_rank(result.status, result.paths, query.gold))

        rows.append(
            {
                "scheme": "C_prime",
                "chunking": chunking,
                "tokenizer": tokenizer,
                "k1": k1,
                "b": b,
                "n": len(dev_queries),
                "recall@2": mean(recall2),
                "recall@5": mean(recall5),
                "hit@1": mean(hit1),
                "mrr": mean(mrr),
                "chunks": scheme.stats["chunks"],
            }
        )

    out_dir = Path(args.out_dir) if args.out_dir else results_dir / "tables"
    write_csv(out_dir / "grid_search.csv", rows)
    write_markdown_table(out_dir / "grid_search.md", rows)

    ranked = sorted(
        rows, key=lambda row: (-float(row["recall@2"]), -float(row["hit@1"]))  # type: ignore[arg-type]
    )
    best = ranked[0]
    payload = {
        "scheme": args.scheme,
        "run_id": args.run_id,
        "partition": "dev",
        "grid_size": len(rows),
        "dev_queries": len(dev_queries),
        "best": best,
        "output": str(out_dir / "grid_search.csv"),
        "note": "网格全部配置已记录，不只报最优（§6.3）",
    }

    if args.write_resolved:
        resolved = {
            key: best[key]
            for key in ("chunking", "tokenizer", "k1", "b")
            if key in best
        }
        resolved["selected_by"] = f"grid {args.run_id} on dev"
        resolved["dev_recall@2"] = best["recall@2"]
        resolved_path = PROJECT_ROOT / "config" / "resolved" / f"{args.scheme}.json"
        # sha256 必须**由代码写进文件**，而不是手改文件补上：
        # 手改的哈希会在下次 `raglab grid --write-resolved` 时被整个文件覆盖掉，
        # 门禁就会再次失效。哈希算的是**参数本身**（不含哈希自身），
        # 所以它随参数变化而变化，正是"这份配置没被偷偷改过"的凭据。
        resolved["sha256"] = _config_payload_sha256(resolved)
        _write_json(resolved_path, resolved)
        payload["resolved"] = str(resolved_path)
    else:
        payload["resolved"] = "未写入（加 --write-resolved 才会落盘）"

    print(json.dumps(payload, ensure_ascii=False, indent=2, default=str))
    return 0


def cmd_sensitivity(args: argparse.Namespace) -> int:
    """按覆盖率分层比较方案，检验「评测集来源偏差」这条威胁。

    这是**描述性分层，不是因果推断**——输出里带同样的声明。

    两种模式：

    - 默认（现跑 C vs C′）：本地纯计算，秒级。
    - ``--from-runs``（离线读跑批结果）：比较**任意多个**已跑完的方案，
      不重跑任何方案。用于检验「B 的优势是不是同源红利」——重跑 B 要 1.4 小时，
      而覆盖率分层只需要每条查询的命中与否，那个信息跑批时已经落盘了。
    """

    from .assets import parse_query
    from .report.sensitivity import corpus_vocabulary, run_sensitivity
    from .report.tables import write_csv
    from .schemes.index_grep import SchemeC

    config = _load_config(Path(args.config))
    corpus_dir, data_dir, results_dir = _project_paths(config)

    queries, report = load_queries(data_dir)
    if not report.ok:
        raise IntakeError("查询集导入失败：" + "；".join(report.errors[:3]))

    blind_path = data_dir / "queries_blind.jsonl"
    if blind_path.is_file():
        extra = []
        for index, line in enumerate(
            blind_path.read_text(encoding="utf-8").splitlines(), start=1
        ):
            if line.strip():
                extra.append(parse_query(json.loads(line), where=f"blind[{index}]"))
        queries = list(queries) + extra
    else:
        print(
            f"警告：未找到 {blind_path.name}，只用原查询集分析",
            file=sys.stderr,
        )

    # 只在 index 轨上比：C′ 与 C 在自然语言查询上才可比（search 轨二者机制差异过大）。
    queries = [query for query in queries if query.track == "index"]

    if args.from_runs:
        return _sensitivity_from_runs(
            args=args,
            config=config,
            corpus_dir=corpus_dir,
            queries=queries,
            results_dir=results_dir,
        )

    baseline = SchemeC(
        corpus_root=corpus_dir,
        navigation_files=config.navigation_files,
        dispatch_rule="deployed",
    )
    baseline.warm_up()
    candidate = _build_scheme("C_prime", config, corpus_dir)

    vocab = corpus_vocabulary(corpus_dir)
    result = run_sensitivity(
        queries=queries,
        baseline=baseline,
        candidate=candidate,
        vocab=vocab,
        k=2,
    )

    payload = {
        "baseline": "C (deployed)",
        "candidate": "C_prime",
        "partition": "all (index 轨)",
        "mode": "exploratory",
        **result.as_dict(),
    }
    out_dir = Path(args.out_dir) if args.out_dir else results_dir / "tables"
    write_csv(
        out_dir / "sensitivity_coverage.csv",
        [
            {
                "stratum": stratum.label,
                "n": stratum.n,
                "coverage_min": round(stratum.coverage_min, 3),
                "coverage_max": round(stratum.coverage_max, 3),
                "baseline_recall@2": round(stratum.baseline_rate, 4),
                "candidate_recall@2": round(stratum.candidate_rate, 4),
                "gap_pp": round(100 * stratum.gap, 1),
            }
            for stratum in result.strata
        ],
    )
    write_markdown_table(
        out_dir / "sensitivity_coverage.md",
        [
            {
                "stratum": stratum.label,
                "n": stratum.n,
                "coverage": f"{stratum.coverage_min:.2f}–{stratum.coverage_max:.2f}",
                "baseline_recall@2": round(stratum.baseline_rate, 4),
                "candidate_recall@2": round(stratum.candidate_rate, 4),
                "gap_pp": round(100 * stratum.gap, 1),
            }
            for stratum in result.strata
        ],
    )
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


def _sensitivity_from_runs(
    *,
    args: argparse.Namespace,
    config: ExperimentConfig,
    corpus_dir: Path,
    queries: list,
    results_dir: Path,
) -> int:
    """离线覆盖率分层：读已落盘的跑批结果，不重跑任何方案。"""

    from .metrics import hit_at_k
    from .report.sensitivity import (
        corpus_vocabulary,
        run_sensitivity_from_runs,
    )
    from .report.tables import write_csv, write_markdown_table
    from .scoring import read_results_jsonl

    run_dir = results_dir / "runs" / (args.run_id or "main")
    schemes = args.scheme or ["A", "B", "C", "C_prime"]
    by_id = {query.id: query for query in queries}

    hits_by_scheme: dict[str, dict[str, bool]] = {}
    for scheme in schemes:
        path = run_dir / f"{scheme}.jsonl"
        if not path.is_file():
            raise BlockedError(f"缺少跑批结果：{path}")
        hits: dict[str, bool] = {}
        for record in read_results_jsonl(path):
            query = by_id.get(record["query_id"])
            if query is None:
                continue
            paths = [c["path"] for c in record.get("candidates", [])]
            hits[record["query_id"]] = hit_at_k(
                record["status"], paths, query.gold, 2
            )
        hits_by_scheme[scheme] = hits

    vocab = corpus_vocabulary(corpus_dir)
    result = run_sensitivity_from_runs(
        queries=queries,
        hits_by_scheme=hits_by_scheme,
        vocab=vocab,
        k=2,
        reference=args.reference,
    )
    payload = {
        "mode": "exploratory",
        "source": f"runs/{args.run_id}（离线读跑批结果，未重跑）",
        **result.as_dict(),
    }

    out_dir = Path(args.out_dir) if args.out_dir else results_dir / "tables"
    rows = [
        {
            "stratum": stratum.label,
            "n": stratum.n,
            "coverage_min": round(stratum.coverage_min, 3),
            "coverage_max": round(stratum.coverage_max, 3),
            **{
                f"{scheme}_recall@2": round(rate, 4)
                for scheme, rate in stratum.rates.items()
            },
            **{
                f"{scheme}_gap_pp": round(
                    100 * (rate - stratum.rates[args.reference]), 1
                )
                for scheme, rate in stratum.rates.items()
                if scheme != args.reference
            },
        }
        for stratum in result.strata
    ]
    write_csv(out_dir / "sensitivity_coverage_all.csv", rows)
    write_markdown_table(out_dir / "sensitivity_coverage_all.md", rows)
    _write_json(out_dir / "sensitivity_coverage_all.json", payload)
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


def cmd_diagnose(args: argparse.Namespace) -> int:
    """单方案诊断：跑 C 的三种 dispatch 读法，出表格 + 图 + Markdown 报告。

    **不是跑批、不是评分、不参与任何选择。** 固定用全量查询，不分 dev/test，
    产物一律标 `exploratory`。
    """

    from .intake import load_negatives
    from .report.charts import render_all
    from .report.diagnostic import run_diagnostic, write_diagnostic
    from .report.diagnostic_md import render_markdown

    config = _load_config(Path(args.config))
    corpus_dir, data_dir, results_dir = _project_paths(config)

    if args.scheme != "C":
        raise BlockedError(
            f"诊断报告当前只支持方案 C（{args.scheme} 尚未实现）"
        )

    queries, query_report = load_queries(data_dir)
    if not query_report.ok:
        raise IntakeError("查询集导入失败：" + "；".join(query_report.errors[:3]))
    negatives, negative_report = load_negatives(data_dir, required=False)
    for warning in negative_report.warnings:
        print(f"警告：{warning}", file=sys.stderr)

    bundle = run_diagnostic(
        run_id=args.run_id,
        queries=queries,
        negatives=negatives,
        corpus_root=corpus_dir,
        navigation_files=config.navigation_files,
    )

    out_dir = Path(args.out_dir) if args.out_dir else results_dir / "diagnostic" / args.run_id
    write_diagnostic(bundle, out_dir)

    overall = [variant.aggregate() for variant in bundle.variants if variant.primary]
    latencies = [
        float(record["latency_ms"])
        for record in next(v for v in bundle.variants if v.primary).records
    ]
    rejection_rows = [
        {
            "scenario": result.rule,
            "correct_refusal_rate": result.correct_refusal_rate,
            "false_candidate_rate": result.false_candidate_rate,
        }
        for result in bundle.negative_results
    ]
    dispatch_rows = [
        {
            "rule": variant.rule,
            "recall@2": variant.aggregate().get("recall@2"),
            "primary": variant.primary,
        }
        for variant in bundle.variants
    ]

    figures = render_all(
        overall=overall,
        latencies=latencies,
        rejection_rows=rejection_rows,
        dispatch_variants=dispatch_rows,
        schemes_available=1,
        output_dir=out_dir / "figures",
    )

    corpus_files = len(list(corpus_dir.rglob("*.md"))) if corpus_dir.is_dir() else None
    report_text = render_markdown(
        bundle,
        figures=figures.written,
        skipped=figures.skipped,
        corpus_files=corpus_files,
    )
    report_path = out_dir / "report.md"
    report_path.write_text(report_text, encoding="utf-8", newline="\n")

    payload = {
        "run_id": args.run_id,
        "mode": "exploratory",
        "schemes_available": 1,
        "note": "单方案诊断，不构成方案对比，不得作主判定",
        "output_dir": str(out_dir),
        "report": str(report_path),
        "figures": figures.as_dict(),
        "warnings": bundle.warnings,
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


def cmd_h5(args: argparse.Namespace) -> int:
    """判定 H5 是否有信号——这是方案 D 的准入门槛（spec §8.6）。

    判据 1 需要 A 与 B 的分轨数据。B 的全量未跑时，该判据返回
    「数据不足」而不是「不满足」——这两者性质不同。
    """

    from .h5 import evaluate_h5
    from .intake import load_queries
    from .schemes.bm25_grep import SchemeCPrime
    from .schemes.index_grep import SchemeC

    config = _load_config(Path(args.config))
    corpus_dir, data_dir, results_dir = _project_paths(config)

    queries, report = load_queries(data_dir)
    if not report.ok:
        raise IntakeError("查询集导入失败：" + "；".join(report.errors[:3]))

    navigation = config.navigation_files
    schemes = {
        "C": SchemeC(corpus_root=corpus_dir, navigation_files=navigation, dispatch_rule="deployed"),
        "C′": SchemeCPrime(
            corpus_root=corpus_dir,
            navigation_files=navigation,
            chunking="whole_file",
            tokenizer="jieba",
            k1=0.9,
            b=0.75,
        ),
    }

    a_hits: dict[str, list[float]] | None = None
    a_path = results_dir / "runs" / (args.a_run_id or "") / "A.jsonl"
    if args.a_run_id and a_path.is_file():
        from .metrics import hit_at_k
        from .scoring import read_results_jsonl

        by_id = {query.id: query for query in queries}
        buckets: dict[str, list[float]] = {}
        for record in read_results_jsonl(a_path):
            query = by_id.get(record["query_id"])
            if query is None:
                continue
            paths = [c["path"] for c in record.get("candidates", [])]
            value = 1.0 if hit_at_k(record["status"], paths, query.gold, 2) else 0.0
            buckets.setdefault(query.track, []).append(value)
        a_hits = buckets

    b_hits: dict[str, list[float]] | None = None
    b_path = results_dir / "runs" / (args.b_run_id or "") / "B.jsonl"
    if args.b_run_id and b_path.is_file():
        from .metrics import hit_at_k
        from .scoring import read_results_jsonl

        by_id = {query.id: query for query in queries}
        buckets = {}
        for record in read_results_jsonl(b_path):
            query = by_id.get(record["query_id"])
            if query is None:
                continue
            paths = [c["path"] for c in record.get("candidates", [])]
            value = 1.0 if hit_at_k(record["status"], paths, query.gold, 2) else 0.0
            buckets.setdefault(query.track, []).append(value)
        b_hits = buckets

    result = evaluate_h5(
        schemes=schemes, queries=queries, a_hits_by_track=a_hits, b_hits_by_track=b_hits
    )
    payload = {
        **result.as_dict(),
        "a_run_id": args.a_run_id,
        "b_run_id": args.b_run_id,
        "note": "判据 1 的『数据不足』不等于『不满足』；不得据此声称 H5 无信号",
    }
    out_dir = Path(args.out_dir) if args.out_dir else results_dir / "tables"
    _write_json(out_dir / "h5_signal.json", payload)
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


def cmd_analyze(args: argparse.Namespace) -> int:
    """三块收尾分析：H7 拒答、H4 延迟、方案间显著性（全部离线）。"""

    from .intake import load_negatives
    from .report.analysis import analyze

    config = _load_config(Path(args.config))
    corpus_dir, data_dir, results_dir = _project_paths(config)

    queries, query_report = load_queries(data_dir)
    if not query_report.ok:
        raise IntakeError("查询集导入失败：" + "；".join(query_report.errors[:3]))
    negatives, negative_report = load_negatives(data_dir, required=False)
    for warning in negative_report.warnings:
        print(f"警告：{warning}", file=sys.stderr)

    # 负样本的 dev 划分：按 ids 前缀/顺序取前一半作为 dev（与查询集同源的小划分）。
    dev_negative_ids = [item.id for item in negatives[: len(negatives) // 2]]

    runners = _build_negative_runners(args, config, corpus_dir)

    payload = analyze(
        project_root=PROJECT_ROOT,
        config=config,
        run_id=args.run_id,
        queries=queries,
        negatives=negatives,
        schemes=args.scheme or ["A", "C", "C_prime"],
        run_negative_for=runners,
        dev_negative_ids=dev_negative_ids,
    )
    payload["mode"] = "exploratory"
    payload["warning"] = (
        "探索性结果：预注册未冻结，不得作主判定（spec T2）"
    )

    out_dir = Path(args.out_dir) if args.out_dir else results_dir / "analysis"
    _write_json(out_dir / f"{args.run_id}.json", payload)

    # 可读版由 JSON 生成，不手写——手写的可读版必然会与数据脱节。
    from .report.analysis_md import write_markdown

    markdown_path = write_markdown(payload, out_dir / f"{args.run_id}.md")
    payload["markdown"] = str(markdown_path)
    _write_json(out_dir / f"{args.run_id}.json", payload)

    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


def _build_negative_runners(args, config, corpus_dir: Path):
    """构造负样本跑批函数：每个方案一个。

    负样本不在跑批结果里（跑批只跑正查询），所以这里现跑。
    这些方案都是纯本地的（A 需要 embedding 端点）。
    """

    from .assets import Query as _Query
    from .schemes.bm25_grep import SchemeCPrime
    from .schemes.index_grep import SchemeC

    navigation = config.navigation_files
    schemes: dict[str, object] = {
        "C": SchemeC(
            corpus_root=corpus_dir, navigation_files=navigation, dispatch_rule="deployed"
        ),
        "C_prime": SchemeCPrime(
            corpus_root=corpus_dir,
            navigation_files=navigation,
            chunking="whole_file",
            tokenizer="jieba",
            k1=0.9,
            b=0.75,
        ),
    }

    if args.scheme and "A" in args.scheme:
        from .embedding import embedding_endpoint
        from .retrieval.vector_index import load_index
        from .schemes.vector_rag import SchemeA

        index = load_index(_vector_index_path())
        if index is not None:
            endpoint = embedding_endpoint(
                load_models(PROJECT_ROOT / "config" / "models.yaml")
            )
            schemes["A"] = SchemeA(
                index=index,
                navigation_files=navigation,
                embed_query=lambda text: endpoint.embed([text])[0],
                top_k=5,
            )

    def run_negative_for(scheme_name: str, negative):
        scheme = schemes.get(scheme_name)
        if scheme is None:
            # **显式失败**，不返回假的 ("no_match", [], 0)。
            # 那个假返回值会被算成「该方案正确拒答率 100%」——
            # 「没人跑过」和「跑出来满分」在报告里长得一样。
            raise BlockedError(
                f"方案 {scheme_name} 没有负样本跑批实现，不能评估它的拒答能力"
            )
        probe = _Query(
            id=str(negative.id),
            track="index",
            text=str(negative.text),
            gold=("__negative__",),
            topic="protocols",
        )
        result = scheme.run(probe)
        scores = [float(candidate.score) for candidate in result.candidates]
        return result.status, scores, len(result.candidates)

    return run_negative_for


def cmd_models(args: argparse.Namespace) -> int:
    """列出模型候选及其可运行状态；不发起任何网络请求。"""

    config = _load_config(Path(args.config))
    models = load_models(PROJECT_ROOT / "config" / "models.yaml")
    rows = models.summary()
    if not rows:
        print("未配置任何模型候选：请复制 config/models.example.yaml 为 models.yaml")
        payload = {"usable_llm": 0, "usable_embedding": 0, "candidates": []}
    else:
        payload = {
            "usable_llm": len(models.usable_llm()),
            "usable_embedding": len(models.usable_embedding()),
            "candidates": rows,
        }
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    # 有候选但一个都跑不了时，明确以非零码提示，不让调用方误以为就绪。
    if rows and payload["usable_llm"] == 0 and payload["usable_embedding"] == 0:
        raise BlockedError("所有模型候选都不可用，见上面的 block_reason")
    return 0


def cmd_env(args: argparse.Namespace) -> int:
    config = _load_config(Path(args.config))
    corpus_dir, _, _ = _project_paths(config)
    manifest = corpus_dir / "manifest.sha256"
    env = capture_env(
        PROJECT_ROOT,
        seed=config.seed,
        corpus_manifest=manifest if manifest.is_file() else None,
        models=load_models(PROJECT_ROOT / "config" / "models.yaml"),
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

    sensitivity_parser = sub.add_parser(
        "sensitivity", help="按覆盖率分层比较方案（检验评测集来源偏差）"
    )
    sensitivity_parser.add_argument("--out-dir", help="自定义输出目录")
    sensitivity_parser.add_argument(
        "--from-runs",
        action="store_true",
        help="离线模式：读已跑完的结果做多方案分层，不重跑任何方案",
    )
    sensitivity_parser.add_argument(
        "--run-id", help="--from-runs 模式读哪个 run_id（默认 main）"
    )
    sensitivity_parser.add_argument(
        "--scheme", nargs="*", help="--from-runs 模式比较哪些方案（默认 A B C C_prime）"
    )
    sensitivity_parser.add_argument(
        "--reference", default="A", help="--from-runs 模式的参照方案（默认 A）"
    )
    sensitivity_parser.set_defaults(func=cmd_sensitivity)

    diagnose_parser = sub.add_parser(
        "diagnose", help="单方案诊断报告（探索性；不出方案对比）"
    )
    diagnose_parser.add_argument("--run-id", required=True)
    diagnose_parser.add_argument("--scheme", default="C", help="当前仅支持 C")
    diagnose_parser.add_argument("--out-dir", help="自定义输出目录")
    diagnose_parser.set_defaults(func=cmd_diagnose)

    env_parser = sub.add_parser("env", help="记录运行环境（§9.2 / T9）")
    env_parser.add_argument("--out", help="env.json 输出路径")
    env_parser.set_defaults(func=cmd_env)

    h5_parser = sub.add_parser(
        "h5", help="判定 H5 是否有信号（方案 D 的准入门槛，§8.6）"
    )
    h5_parser.add_argument("--a-run-id", help="A 的 run_id（判据 1 需要）")
    h5_parser.add_argument("--b-run-id", help="B 的 run_id（判据 1 需要）")
    h5_parser.add_argument("--out-dir", help="自定义输出目录")
    h5_parser.set_defaults(func=cmd_h5)

    analyze_parser = sub.add_parser(
        "analyze", help="H7 拒答 + H4 延迟 + 方案间显著性（离线）"
    )
    analyze_parser.add_argument("--run-id", required=True)
    analyze_parser.add_argument(
        "--scheme", nargs="*", help="参与分析的方案（默认 A / C / C_prime）"
    )
    analyze_parser.add_argument("--out-dir", help="自定义输出目录")
    analyze_parser.set_defaults(func=cmd_analyze)

    models_parser = sub.add_parser("models", help="列出模型候选与可运行状态（不触网）")
    models_parser.set_defaults(func=cmd_models)

    run_parser = sub.add_parser("run", help="按方案跑一批查询（§8.1、§9.4）")
    run_parser.add_argument("--run-id", required=True)
    run_parser.add_argument("--scheme", required=True, help="A / B / C / C_prime / D")
    run_parser.add_argument(
        "--partition", choices=("dev", "test", "all"), default="all"
    )
    run_parser.add_argument(
        "--deadline-ms", type=float, default=None, help="单查询超时（§9.4）"
    )
    run_parser.add_argument(
        "--variant", default=None, help="D 的变体（D1 / D2）"
    )
    run_parser.add_argument(
        "--spacing",
        type=float,
        default=None,
        help="相邻模型调用的间隔秒数（B/D 需要 ≥ 15s，见 STATUS 的限流实测）",
    )
    run_parser.add_argument(
        "--query-spacing",
        type=float,
        default=0.0,
        help="相邻查询之间的间隔秒数（B 需要 ≥ 15s：方案自身的 --spacing 只管查询内部的轮次）",
    )
    run_parser.add_argument(
        "--resume",
        action="store_true",
        help="续跑：跳过目标文件里已完成的 query_id（结果逐条落盘，中断后可接着跑）",
    )
    run_parser.add_argument(
        "--confirmatory",
        action="store_true",
        help="标记为确认性跑批；默认 exploratory，结果不得作主判定",
    )
    run_parser.set_defaults(func=cmd_run)

    index_parser = sub.add_parser("index", help="构建方案 A 的向量索引（触网，需 RAGLAB_LIVE=1）")
    index_parser.add_argument("--scheme", default="A", help="当前仅支持 A")
    index_parser.add_argument("--chunking", choices=("whole_file", "section"), default=None)
    index_parser.add_argument("--batch-size", type=int, default=110)
    index_parser.add_argument(
        "--spacing", type=float, default=0.0, help="相邻 embedding 调用的间隔秒数"
    )
    index_parser.set_defaults(func=cmd_index)

    grid_parser = sub.add_parser(
        "grid", help="按预注册网格在 dev 上搜索配置（§6.3、T3）"
    )
    grid_parser.add_argument("--scheme", required=True, help="当前支持 C_prime 与 A")
    grid_parser.add_argument("--run-id", required=True)
    grid_parser.add_argument("--out-dir", help="自定义输出目录")
    grid_parser.add_argument("--batch-size", type=int, default=110, help="A 的 embedding 批大小")
    grid_parser.add_argument("--spacing", type=float, default=0.0, help="A 的调用间隔秒数")
    grid_parser.add_argument(
        "--write-resolved",
        action="store_true",
        help="把 dev 最优配置写入 config/resolved/<scheme>.json（冻结记录的一部分）",
    )
    grid_parser.set_defaults(func=cmd_grid)

    return parser


def _force_utf8_stdio() -> None:
    """把标准输出/错误切成 UTF-8。

    Windows 的默认编码是 GBK（cp936），而本工具的输出里全是中文与
    `−`（U+2212）、`′`（U+2032）这类符号——GBK 编不了它们，
    `print` 会抛 ``UnicodeEncodeError``。

    症状很隐蔽：**命令已经算完、结果也已落盘**，却因为最后一行 print
    崩掉，退出码变成 1，看起来像"分析失败"。2026-10-21 实测踩到：
    `raglab h5 --a-run-id main --b-run-id main` 算完却崩在打印上。

    用 ``errors="replace"`` 而不是 ``errors="strict"``：宁可输出一个
    替代字符，也不要在报告已经生成之后失败。
    """

    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue
        try:
            reconfigure(encoding="utf-8", errors="replace")
        except (ValueError, OSError):  # pragma: no cover —— 已被重定向等
            pass


def main(argv: list[str] | None = None) -> int:
    _force_utf8_stdio()
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return int(args.func(args))
    except RaglabError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return exc.exit_code


if __name__ == "__main__":
    raise SystemExit(main())
