"""环境记录（spec §9.2 / T9）。"""

from __future__ import annotations

import json
from pathlib import Path

from raglab.config import ModelCandidate, ModelsConfig
from raglab.env import capture_env, write_env


def _models() -> ModelsConfig:
    return ModelsConfig(
        llm=(
            ModelCandidate(
                id="remote-llm-1",
                kind="openai_compatible",
                base_url="http://gateway.local/v1",
                model="remote-model",
                api_key="sk-super-secret-value",
            ),
        ),
        embedding=(
            ModelCandidate(
                id="api-embed-1",
                kind="openai_compatible",
                base_url="https://api.example.com/v1",
                model="remote-embed",
                api_key="emb-secret-value",
            ),
        ),
    )


def test_capture_env_records_core_fields(tmp_path: Path) -> None:
    env = capture_env(tmp_path, seed=20261019)
    for key in ("captured_at", "os", "python", "seed", "model_candidates", "live"):
        assert key in env
    assert env["seed"] == 20261019
    assert env["live"] is False


def test_missing_artifacts_are_declared_not_faked(tmp_path: Path) -> None:
    env = capture_env(tmp_path, seed=1)
    missing = env.get("missing", [])
    assert "uv_lock_sha256" in missing
    assert "corpus_manifest_sha256" in missing
    assert env["uv_lock_sha256"] is None


def test_lock_and_manifest_hashes_are_recorded(tmp_path: Path) -> None:
    (tmp_path / "uv.lock").write_text("lock", encoding="utf-8")
    manifest = tmp_path / "manifest.sha256"
    manifest.write_text("deadbeef  a.md\n", encoding="utf-8")

    env = capture_env(tmp_path, seed=1, corpus_manifest=manifest)
    assert isinstance(env["uv_lock_sha256"], str)
    assert len(env["uv_lock_sha256"]) == 64
    assert isinstance(env["corpus_manifest_sha256"], str)


def test_model_candidates_are_recorded_without_secrets(tmp_path: Path) -> None:
    """T9：记录实际会用于跑批的候选端点，但不记录任何密钥值。"""

    env = capture_env(tmp_path, seed=1, models=_models())
    serialized = json.dumps(env)
    assert "sk-super-secret-value" not in serialized
    assert "emb-secret-value" not in serialized

    rows = env["model_candidates"]
    assert isinstance(rows, list)
    assert {row["id"] for row in rows} == {"remote-llm-1", "api-embed-1"}
    llm_row = next(row for row in rows if row["id"] == "remote-llm-1")
    assert llm_row["base_url"] == "http://gateway.local/v1"
    assert llm_row["model"] == "remote-model"
    assert llm_row["api_key_set"] is True
    assert llm_row["usable"] is True


def test_env_records_actual_endpoints_not_a_parallel_config(tmp_path: Path) -> None:
    """回归：env.json 必须描述 models.yaml 里真实的候选，而不是另一份空配置。"""

    env = capture_env(tmp_path, seed=1, models=_models())
    rows = env["model_candidates"]
    assert any(row["model"] == "remote-model" for row in rows)
    # 旧实现写死的字段已移除，避免与真实端点不一致。
    assert "model" not in env


def test_write_env_creates_parent_dirs(tmp_path: Path) -> None:
    target = write_env(tmp_path / "runs" / "r1" / "env.json", {"seed": 1})
    assert target.is_file()
    assert json.loads(target.read_text(encoding="utf-8")) == {"seed": 1}
