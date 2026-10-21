"""M4 端点探针：连通性、鉴权、能力与限流（人工运行，不属于产品代码）。

为什么单独成脚本：
- 连通性是**人工确认**，不是跑批的一部分；放进 ``src/`` 会把端点探测与退避重试
  带进产品路径，而 ``raglab`` 的 ``index``/``run`` 只该关心"候选能不能跑"。
- 结论要可复现：``STATUS.md`` 里那些数字必须能被别人重跑出来。

约束：
- 网络调用仍受 ``RAGLAB_LIVE=1`` 门禁约束，本脚本不绕过。
- 密钥只进请求头，输出里只有 ``api_key_set``，不打印密钥值。
- 默认节奏按实测限流（串行、≥15s 间隔）走，避免探针自己撞 429 后被误读成故障。
- 并发与突发已实测不可用，不在本脚本里重测。

用法::

    $env:RAGLAB_LIVE = "1"          # PowerShell
    ./.venv/Scripts/python.exe scripts/probe_endpoints.py

    # 全量（含确定性与限流探测，较慢）
    ./.venv/Scripts/python.exe scripts/probe_endpoints.py --determinism --rate --json
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

EXPERIMENT_ROOT = Path(__file__).resolve().parents[1]

sys.path.insert(0, str(EXPERIMENT_ROOT / "src"))

import httpx  # noqa: E402

from raglab.config import ModelCandidate, load_models  # noqa: E402
from raglab.errors import LLMError, LiveGateError  # noqa: E402
from raglab.llm import OpenAIClient, require_live  # noqa: E402

PING_MESSAGES = [
    {"role": "system", "content": "Reply with the single word: pong"},
    {"role": "user", "content": "ping"},
]

KB_TOOL = {
    "type": "function",
    "function": {
        "name": "kb_lookup",
        "description": "在嵌入式调试知识库中按关键词检索，返回文件路径列表",
        "parameters": {
            "type": "object",
            "properties": {"query": {"type": "string"}},
            "required": ["query"],
        },
    },
}

TOOL_RESULT = json.dumps(
    {"hits": ["protocols/uart-no-rx.md", "cases/uart-silent.md"]}, ensure_ascii=False
)

EMBED_SAMPLES = [
    "UART 无输出：先查 TX/RX 是否接反",
    "MCU 复位后卡在 HardFault_Handler",
    "I2C 总线被从设备拉低不释放",
    "SPI 时钟极性配置错误导致数据错位",
    "JTAG 无法识别芯片，检查 SWDIO 上拉",
    "看门狗提前复位，检查喂狗周期",
    "Flash 擦除超时，检查电压与时钟",
    "Heap 与 Stack 重叠导致随机崩溃",
]

MARKS = {"ok": "PASS", "warn": "WARN", "fail": "FAIL", "skip": "SKIP"}


class Report:
    """收集检查结果；``status`` 取 ok / warn / fail / skip。"""

    def __init__(self) -> None:
        self.rows: list[dict[str, object]] = []

    def add(self, name: str, status: str, detail: str, **extra: object) -> None:
        row: dict[str, object] = {"check": name, "status": status, "detail": detail}
        row.update(extra)
        self.rows.append(row)

    def prefix_since(self, start: int, prefix: str) -> None:
        """给本次候选新增的行加前缀，避免多个候选的同名检查混在一起。"""

        for row in self.rows[start:]:
            row["check"] = f"{prefix}.{row['check']}"

    def failed(self) -> bool:
        return any(row["status"] == "fail" for row in self.rows)


def _error_text(exc: Exception) -> str:
    return str(exc)[:300]


def _status_of(exc: Exception) -> int | None:
    """从 LLMError 的消息里取出 HTTP 状态码；取不到返回 None。"""

    text = str(exc)
    marker = "网关返回 "
    if marker not in text:
        return None
    try:
        return int(text.split(marker, 1)[1][:3])
    except (IndexError, ValueError):
        return None


def _client(candidate: ModelCandidate, timeout: float, *, use_key: bool) -> OpenAIClient:
    return OpenAIClient(
        candidate.base_url or "",
        api_key=candidate.api_key if use_key else None,
        timeout=timeout,
    )


def probe_auth(candidate: ModelCandidate, timeout: float, report: Report, label: str) -> None:
    """不带密钥时必须被拒；端点不校验密钥时记 warn，不当作通过。"""

    name = f"{label}.auth"
    if candidate.api_key is None:
        report.add(name, "skip", "候选未配置 api_key，无法验证鉴权")
        return
    try:
        with _client(candidate, timeout, use_key=False) as client:
            if label == "embedding":
                client.embed(["鉴权测试"], model=candidate.model or "")
            else:
                client.chat(PING_MESSAGES, model=candidate.model or "")
    except LLMError as exc:
        status = _status_of(exc)
        if status in (401, 403):
            report.add(name, "ok", f"不带密钥返回 {status}")
        else:
            report.add(name, "warn", f"不带密钥未返回 401/403：{_error_text(exc)}")
    except httpx.HTTPError as exc:
        report.add(name, "warn", f"网络错误：{_error_text(exc)}")
    else:
        report.add(name, "warn", "不带密钥仍成功：端点不校验密钥")


def probe_llm_connect(candidate: ModelCandidate, timeout: float, report: Report) -> None:
    started = time.perf_counter()
    try:
        with _client(candidate, timeout, use_key=True) as client:
            result = client.chat(PING_MESSAGES, model=candidate.model or "")
    except (LLMError, httpx.HTTPError) as exc:
        report.add("llm.connect", "fail", _error_text(exc))
        return
    elapsed = time.perf_counter() - started
    message = (result.raw.get("choices") or [{}])[0].get("message", {}) or {}
    report.add(
        "llm.connect",
        "ok",
        f"回复 {result.content.strip()[:40]!r}，耗时 {elapsed:.1f}s",
        latency_s=round(elapsed, 2),
        reported_model=result.raw.get("model"),
        message_keys=sorted(message.keys()),
        reasoning_len=len(message.get("reasoning_content") or ""),
    )


def probe_llm_tool_calling(
    candidate: ModelCandidate, timeout: float, report: Report
) -> dict:
    """方案 B 的前提：模型必须能产出 tool_calls。返回首轮 message 供多轮复用。"""

    try:
        with _client(candidate, timeout, use_key=True) as client:
            result = client.chat(
                [
                    {
                        "role": "user",
                        "content": (
                            "UART 没有输出，先查知识库。请调用 kb_lookup 工具，"
                            "query 写 'UART 无输出'。"
                        ),
                    }
                ],
                model=candidate.model or "",
                tools=[KB_TOOL],
            )
    except (LLMError, httpx.HTTPError) as exc:
        report.add("llm.tool_calling", "fail", _error_text(exc))
        return {}

    choice = (result.raw.get("choices") or [{}])[0]
    message = choice.get("message", {}) or {}
    calls = message.get("tool_calls") or []
    if not calls:
        report.add(
            "llm.tool_calling",
            "fail",
            f"finish_reason={choice.get('finish_reason')!r}，未产生 tool_calls；方案 B 不可用",
        )
        return message

    names = [(call.get("function") or {}).get("name") for call in calls]
    report.add(
        "llm.tool_calling",
        "ok",
        f"finish_reason={choice.get('finish_reason')!r}，调用 {names}",
        tool_calls=[
            {
                "name": (call.get("function") or {}).get("name"),
                "arguments": (call.get("function") or {}).get("arguments"),
            }
            for call in calls
        ],
    )
    return message


def probe_llm_multiturn(
    candidate: ModelCandidate, timeout: float, first_message: dict, report: Report
) -> None:
    """把工具结果回灌，确认多轮循环能收敛到最终答案（方案 B 的核心路径）。"""

    calls = first_message.get("tool_calls") or []
    if not calls:
        report.add("llm.multiturn", "skip", "首轮无 tool_calls，无法验证多轮")
        return
    call = calls[0]
    assistant_message: dict = {
        "role": "assistant",
        "content": first_message.get("content") or "",
        "tool_calls": [
            {
                "id": call.get("id"),
                "type": "function",
                "function": call.get("function"),
            }
        ],
    }
    # 推理模型的 reasoning_content 可原样回传；不回传也可跑通，回传能保留推理上下文。
    if first_message.get("reasoning_content"):
        assistant_message["reasoning_content"] = first_message["reasoning_content"]

    messages = [
        {"role": "system", "content": "你是嵌入式调试助手。需要查知识库时调用 kb_lookup。"},
        {"role": "user", "content": "UART 没有输出，帮我查一下。只调用一次工具。"},
        assistant_message,
        {"role": "tool", "tool_call_id": call.get("id"), "content": TOOL_RESULT},
    ]
    try:
        with _client(candidate, timeout, use_key=True) as client:
            result = client.chat(messages, model=candidate.model or "", tools=[KB_TOOL])
    except (LLMError, httpx.HTTPError) as exc:
        report.add("llm.multiturn", "fail", _error_text(exc))
        return

    choice = (result.raw.get("choices") or [{}])[0]
    content = result.content.strip()
    if not content:
        report.add(
            "llm.multiturn",
            "fail",
            f"工具结果回灌后无最终答案（finish_reason={choice.get('finish_reason')!r}）",
        )
        return
    report.add(
        "llm.multiturn",
        "ok",
        f"finish_reason={choice.get('finish_reason')!r}，最终答案 {len(content)} 字",
        output_tokens=result.usage.output_tokens,
    )


def probe_llm_determinism(candidate: ModelCandidate, timeout: float, report: Report) -> None:
    """同 prompt 重复：判断能否靠 temperature=0 复现。"""

    replies: list[str] = []
    try:
        with _client(candidate, timeout, use_key=True) as client:
            for _ in range(3):
                replies.append(
                    client.chat(
                        [
                            {
                                "role": "user",
                                "content": "用一句话说明 UART 无输出的首要排查方向。",
                            }
                        ],
                        model=candidate.model or "",
                    ).content.strip()
                )
    except (LLMError, httpx.HTTPError) as exc:
        report.add("llm.determinism", "fail", _error_text(exc))
        return
    identical = len(set(replies)) == 1
    report.add(
        "llm.determinism",
        "ok" if identical else "warn",
        "三次完全相同" if identical else f"三次有 {len(set(replies))} 种答案：不能靠 seed/温度复现",
        replies=replies,
    )


def probe_embedding_connect(
    candidate: ModelCandidate, timeout: float, report: Report
) -> None:
    try:
        with _client(candidate, timeout, use_key=True) as client:
            vectors = client.embed(["连通性测试：UART 无输出"], model=candidate.model or "")
    except (LLMError, httpx.HTTPError) as exc:
        report.add("embedding.connect", "fail", _error_text(exc))
        return
    vector = vectors[0] if vectors else []
    norm = sum(value * value for value in vector) ** 0.5
    normalized = abs(norm - 1.0) < 1e-3
    detail = f"{len(vector)} 维，L2 范数 {norm:.4f}"
    # 归一化与否决定余弦与点积是否等价；记下来而不是悄悄假设。
    report.add(
        "embedding.connect",
        "ok" if normalized else "warn",
        detail if normalized else detail + "（未归一化，余弦需显式计算）",
        dim=len(vector),
        norm=round(norm, 6),
    )


def probe_embedding_batch(
    candidate: ModelCandidate, timeout: float, report: Report, count: int
) -> None:
    """批量上限决定索引 100+ 篇文档要发几次请求。"""

    if count <= 0:
        report.add("embedding.batch", "skip", "已按参数跳过")
        return
    texts = [
        f"{EMBED_SAMPLES[index % len(EMBED_SAMPLES)]} #{index}" for index in range(count)
    ]
    started = time.perf_counter()
    try:
        with _client(candidate, timeout, use_key=True) as client:
            vectors = client.embed(texts, model=candidate.model or "")
    except (LLMError, httpx.HTTPError) as exc:
        report.add("embedding.batch", "fail", f"{count} 条失败：{_error_text(exc)}")
        return
    report.add(
        "embedding.batch",
        "ok",
        f"{len(vectors)} 条一次通过，耗时 {time.perf_counter() - started:.2f}s",
    )


def probe_rate(
    candidate: ModelCandidate, timeout: float, report: Report, spacing: float, calls: int
) -> None:
    """串行间隔探测：决定跑批的可行节奏。"""

    if calls <= 0:
        report.add("llm.rate", "skip", "已按参数跳过")
        return
    results: list[dict[str, object]] = []
    with _client(candidate, timeout, use_key=True) as client:
        for index in range(calls):
            if index:
                time.sleep(spacing)
            started = time.perf_counter()
            try:
                client.chat(
                    [{"role": "user", "content": f"回答一个字：{index}"}],
                    model=candidate.model or "",
                )
            except (LLMError, httpx.HTTPError) as exc:
                results.append(
                    {
                        "i": index,
                        "ok": False,
                        "latency_s": round(time.perf_counter() - started, 2),
                        "error": _error_text(exc),
                    }
                )
            else:
                results.append(
                    {"i": index, "ok": True, "latency_s": round(time.perf_counter() - started, 2)}
                )

    ok_count = sum(1 for item in results if item["ok"])
    if ok_count == calls:
        status = "ok"
        detail = f"{spacing:.0f}s 间隔 {calls} 次全通过（≈{60 / max(spacing, 1e-6):.1f} 次/分钟）"
    elif ok_count:
        status = "warn"
        detail = f"{spacing:.0f}s 间隔仅 {ok_count}/{calls} 通过：需加大间隔或加退避"
    else:
        status = "fail"
        detail = f"{spacing:.0f}s 间隔全部失败：先确认端点可用再调节奏"
    report.add("llm.rate", status, detail, results=results)


def _print_human(report: Report, skipped: list[dict[str, object]]) -> None:
    width = max((len(str(row["check"])) for row in report.rows), default=0)
    for row in report.rows:
        mark = MARKS.get(str(row["status"]), str(row["status"]).upper())
        print(f"[{mark}] {str(row['check']).ljust(width)}  {row['detail']}")
    if skipped:
        print("\n不可用候选（未探测）：")
        for row in skipped:
            print(f"  - {row['id']}（{row['section']}）：{row['block_reason']}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="M4 端点探针（发真实请求；需 RAGLAB_LIVE=1）",
    )
    parser.add_argument("--models", default=str(EXPERIMENT_ROOT / "config" / "models.yaml"))
    parser.add_argument("--timeout", type=float, default=60.0)
    parser.add_argument(
        "--spacing",
        type=float,
        default=15.0,
        help="相邻 LLM 调用的间隔秒数（默认 15，按实测限流设定）",
    )
    parser.add_argument("--skip-auth", action="store_true", help="跳过不带密钥的鉴权探测")
    parser.add_argument("--determinism", action="store_true", help="重复 3 次验证确定性（较慢）")
    parser.add_argument(
        "--embedding-batch", type=int, default=8, help="批量 embedding 条数；0 表示跳过"
    )
    parser.add_argument("--rate", action="store_true", help="追加串行间隔探测（较慢）")
    parser.add_argument("--rate-spacing", type=float, default=15.0)
    parser.add_argument("--rate-calls", type=int, default=5)
    parser.add_argument("--json", action="store_true", help="输出 JSON")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)

    try:
        require_live()
    except LiveGateError as exc:
        print(f"错误：{exc}", file=sys.stderr)
        print('PowerShell：$env:RAGLAB_LIVE = "1"', file=sys.stderr)
        return 2

    models = load_models(args.models)
    llm_candidates = models.usable_llm()
    embed_candidates = models.usable_embedding()
    if not llm_candidates and not embed_candidates:
        print(
            "没有可用候选：先填 config/models.yaml，再运行 raglab models 查看状态",
            file=sys.stderr,
        )
        return 2

    report = Report()
    skipped: list[dict[str, object]] = [
        {"id": row["id"], "section": row["section"], "block_reason": row["block_reason"]}
        for row in models.summary()
        if not row["usable"]
    ]

    for candidate in llm_candidates:
        start = len(report.rows)
        if not args.skip_auth:
            probe_auth(candidate, args.timeout, report, "llm")
            time.sleep(args.spacing)
        probe_llm_connect(candidate, args.timeout, report)
        time.sleep(args.spacing)
        first_message = probe_llm_tool_calling(candidate, args.timeout, report)
        time.sleep(args.spacing)
        probe_llm_multiturn(candidate, args.timeout, first_message, report)
        if args.determinism:
            time.sleep(args.spacing)
            probe_llm_determinism(candidate, args.timeout, report)
        if args.rate:
            time.sleep(args.spacing)
            probe_rate(candidate, args.timeout, report, args.rate_spacing, args.rate_calls)
        if len(llm_candidates) > 1:
            report.prefix_since(start, candidate.id)

    for candidate in embed_candidates:
        start = len(report.rows)
        if not args.skip_auth:
            probe_auth(candidate, args.timeout, report, "embedding")
        probe_embedding_connect(candidate, args.timeout, report)
        probe_embedding_batch(candidate, args.timeout, report, args.embedding_batch)
        if len(embed_candidates) > 1:
            report.prefix_since(start, candidate.id)

    payload = {
        "llm_candidates": [candidate.redacted() for candidate in llm_candidates],
        "embedding_candidates": [candidate.redacted() for candidate in embed_candidates],
        "skipped": skipped,
        "checks": report.rows,
    }
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        _print_human(report, skipped)
    return 1 if report.failed() else 0


if __name__ == "__main__":
    raise SystemExit(main())
