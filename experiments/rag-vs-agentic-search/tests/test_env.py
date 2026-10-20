"""环境记录（spec §9.2 / T9）。"""

from __future__ import annotations

import json
from pathlib import Path

from raglab.config import ModelConfig
from raglab.env import capture_env, write_env


def test_capture_env_records_core_fields(tmp_path: Path) -> None:
    env = capture_env(tmp_path, seed=20261019)
    for key in ("captured_at", "os", "python", "seed", "model", "live"):
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


def test_api_key_in_environment_is_never_recorded(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """即使设置了密钥环境变量，env.json 也不得包含其值（T9）。"""

    monkeypatch.setenv("RAGLAB_LLM_API_KEY", "sk-super-secret-value")
    monkeypatch.setenv("RAGLAB_EMBED_API_KEY", "emb-secret-value")
    model = ModelConfig(
        llm_base_url="https://api.example.com/v1",
        llm_model="remote-model",
        embedding_base_url="https://api.example.com/v1",
        embedding_model="remote-embed",
    )
    env = capture_env(tmp_path, seed=1, model=model)
    serialized = json.dumps(env)
    assert "sk-super-secret-value" not in serialized
    assert "emb-secret-value" not in serialized


def test_gateway_url_recorded_but_no_secret(tmp_path: Path) -> None:
    model = ModelConfig(
        llm_base_url="http://gateway.local/v1",
        llm_model="flash",
    )
    env = capture_env(tmp_path, seed=1, model=model)
    model_block = env["model"]
    assert isinstance(model_block, dict)
    assert model_block["llm_base_url"] == "http://gateway.local/v1"
    # 任何密钥字段都不应被记录。
    assert "api_key" not in json.dumps(env).lower()


def test_write_env_creates_parent_dirs(tmp_path: Path) -> None:
    target = write_env(tmp_path / "runs" / "r1" / "env.json", {"seed": 1})
    assert target.is_file()
    assert json.loads(target.read_text(encoding="utf-8")) == {"seed": 1}
