"""端点探针脚本的离线守卫。

探针会发真实请求，因此这里**不跑网络**，只断言那些"跑错了会误导人"的边界：
1. 未设 RAGLAB_LIVE 时必须被门禁拒绝（退出码 2）；
2. 没有可用候选时必须拒绝运行，而不是静默返回 0；
3. 脚本不得把密钥打进输出。
"""

from __future__ import annotations

import importlib.util
import io
import json
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

import pytest
import yaml

from raglab.errors import LLMError

PROJECT_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = PROJECT_ROOT / "scripts" / "probe_endpoints.py"


def _load_module():
    spec = importlib.util.spec_from_file_location("probe_endpoints", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_script_exists() -> None:
    assert SCRIPT.is_file(), "scripts/probe_endpoints.py 缺失，STATUS.md 的实测数字将无法复现"


def test_live_gate_blocks_without_flag(monkeypatch: pytest.MonkeyPatch) -> None:
    module = _load_module()
    monkeypatch.delenv("RAGLAB_LIVE", raising=False)

    stderr = io.StringIO()
    with redirect_stderr(stderr):
        code = module.main([])

    assert code == 2
    assert "RAGLAB_LIVE" in stderr.getvalue()


def test_no_candidates_exits_non_zero(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    module = _load_module()
    monkeypatch.setenv("RAGLAB_LIVE", "1")

    empty = tmp_path / "models.yaml"
    empty.write_text(
        yaml.safe_dump({"llm": {"candidates": [{"id": "x", "kind": "openai_compatible"}]}}),
        encoding="utf-8",
    )

    stderr = io.StringIO()
    with redirect_stderr(stderr), redirect_stdout(io.StringIO()):
        code = module.main(["--models", str(empty)])

    assert code == 2
    assert "没有可用候选" in stderr.getvalue()


def test_failure_path_reports_fail_and_hides_key(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """端点调用失败时：报 fail、退出码非零、密钥不出现在输出里。

    用假客户端注入失败，不发起任何真实连接——单测必须离线。
    """

    module = _load_module()
    monkeypatch.setenv("RAGLAB_LIVE", "1")

    path = tmp_path / "models.yaml"
    path.write_text(
        yaml.safe_dump(
            {
                "llm": {
                    "candidates": [
                        {
                            "id": "candidate-with-secret",
                            "kind": "openai_compatible",
                            "base_url": "http://gateway.invalid/v1",
                            "model": "m",
                            "api_key": "sk-should-never-appear",
                        }
                    ]
                }
            }
        ),
        encoding="utf-8",
    )

    class _FailingClient:
        def __init__(self, *args: object, **kwargs: object) -> None:
            pass

        def __enter__(self) -> "_FailingClient":
            return self

        def __exit__(self, *exc_info: object) -> None:
            return None

        def chat(self, *args: object, **kwargs: object) -> object:
            raise LLMError("网关返回 500：boom")

        def embed(self, *args: object, **kwargs: object) -> object:
            raise LLMError("网关返回 500：boom")

    monkeypatch.setattr(module, "OpenAIClient", _FailingClient)

    stdout = io.StringIO()
    with redirect_stdout(stdout), redirect_stderr(io.StringIO()):
        code = module.main(
            [
                "--models",
                str(path),
                "--skip-auth",
                "--embedding-batch",
                "0",
                "--spacing",
                "0",
                "--json",
            ]
        )

    payload = json.loads(stdout.getvalue())
    assert "sk-should-never-appear" not in json.dumps(payload)
    assert payload["llm_candidates"][0]["api_key_set"] is True
    # 端点失败必须体现为 fail + 非零退出，不能假装成功。
    assert code == 1
    assert any(row["status"] == "fail" for row in payload["checks"])


def test_spacing_default_matches_measured_rate_limit() -> None:
    """默认间隔必须 ≥ 实测可用的 15s，否则探针自己会撞 429 并被误读成故障。"""

    module = _load_module()
    args = module.build_parser().parse_args([])
    assert args.spacing >= 15.0
    assert args.rate_spacing >= 15.0
