"""models.yaml 加载与密钥隔离。"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
import yaml

from raglab.config import load_models
from raglab.errors import ConfigurationError

PROJECT_ROOT = Path(__file__).resolve().parents[1]


def test_missing_models_file_is_empty_config(tmp_path: Path) -> None:
    config = load_models(tmp_path / "models.yaml")
    assert config.llm == ()
    assert config.embedding == ()
    assert config.usable_llm() == []


def test_example_template_parses_and_has_no_secret() -> None:
    """模板必须可加载，且不得含任何密钥。"""

    example = PROJECT_ROOT / "config" / "models.example.yaml"
    text = example.read_text(encoding="utf-8")
    config = load_models(example)
    assert len(config.llm) == 2
    assert len(config.embedding) == 2
    assert all(candidate.api_key is None for candidate in config.llm)
    assert all(candidate.api_key is None for candidate in config.embedding)
    assert "sk-" not in text


def test_local_models_file_is_gitignored() -> None:
    """config/models.yaml 必须被忽略，否则密钥会进版本库。"""

    import subprocess

    result = subprocess.run(
        ["git", "check-ignore", "-q", "config/models.yaml"],
        cwd=PROJECT_ROOT,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, "config/models.yaml 未被 gitignore，密钥有泄漏风险"


def test_local_models_file_is_not_tracked() -> None:
    import subprocess

    result = subprocess.run(
        ["git", "ls-files", "--error-unmatch", "config/models.yaml"],
        cwd=PROJECT_ROOT,
        capture_output=True,
        check=False,
    )
    assert result.returncode != 0, "config/models.yaml 仍被 git 跟踪"


def test_api_key_loaded_from_local_file(tmp_path: Path) -> None:
    path = tmp_path / "models.yaml"
    path.write_text(
        yaml.safe_dump(
            {
                "llm": {
                    "candidates": [
                        {
                            "id": "remote",
                            "kind": "openai_compatible",
                            "base_url": "https://api.example.com/v1",
                            "model": "m",
                            "api_key": "sk-local-secret",
                        }
                    ]
                }
            },
            allow_unicode=True,
        ),
        encoding="utf-8",
    )
    config = load_models(path)
    assert config.llm[0].api_key == "sk-local-secret"
    # 但 redacted() 不暴露密钥，供日志与 env.json 使用。
    assert "sk-local-secret" not in json.dumps(config.llm[0].redacted())
    assert config.llm[0].redacted()["api_key_set"] is True


def test_usable_requires_endpoint_and_model(tmp_path: Path) -> None:
    path = tmp_path / "models.yaml"
    path.write_text(
        yaml.safe_dump(
            {
                "llm": {
                    "candidates": [
                        {"id": "empty", "kind": "openai_compatible"},
                        {
                            "id": "ready",
                            "kind": "openai_compatible",
                            "base_url": "https://x/v1",
                            "model": "m",
                        },
                    ]
                }
            }
        ),
        encoding="utf-8",
    )
    config = load_models(path)
    assert [c.id for c in config.usable_llm()] == ["ready"]
    assert config.llm[0].block_reason == "缺少 base_url/model"


def test_local_candidate_without_optional_dep_is_unusable(tmp_path: Path) -> None:
    """本地候选只写 model 但缺 sentence-transformers 时不得算可用。"""

    path = tmp_path / "models.yaml"
    path.write_text(
        yaml.safe_dump(
            {
                "embedding": {
                    "candidates": [
                        {
                            "id": "local",
                            "kind": "local",
                            "model": "BAAI/bge-m3",
                            "requires": "local-embed",
                        },
                        {
                            "id": "local-no-req",
                            "kind": "local",
                            "model": "BAAI/bge-m3",
                        },
                    ]
                }
            }
        ),
        encoding="utf-8",
    )
    config = load_models(path)
    # 当前环境未安装 sentence-transformers：带 requires 的候选不可用。
    assert config.embedding[0].usable is False
    assert "local-embed" in (config.embedding[0].block_reason or "")
    # 未声明 requires 的本地候选不额外校验依赖。
    assert config.embedding[1].usable is True


def test_unknown_optional_group_is_unusable(tmp_path: Path) -> None:
    path = tmp_path / "models.yaml"
    path.write_text(
        yaml.safe_dump(
            {
                "embedding": {
                    "candidates": [
                        {
                            "id": "x",
                            "kind": "local",
                            "model": "m",
                            "requires": "nonexistent-group",
                        }
                    ]
                }
            }
        ),
        encoding="utf-8",
    )
    config = load_models(path)
    assert config.embedding[0].usable is False


def test_summary_reports_every_candidate(tmp_path: Path) -> None:
    path = tmp_path / "models.yaml"
    path.write_text(
        yaml.safe_dump(
            {
                "llm": {"candidates": [{"id": "a", "kind": "openai_compatible"}]},
                "embedding": {
                    "candidates": [
                        {"id": "b", "kind": "openai_compatible", "base_url": "u", "model": "m"}
                    ]
                },
            }
        ),
        encoding="utf-8",
    )
    summary = load_models(path).summary()
    assert {row["id"] for row in summary} == {"a", "b"}
    assert {row["section"] for row in summary} == {"llm", "embedding"}
    row_a = next(row for row in summary if row["id"] == "a")
    assert row_a["usable"] is False
    assert row_a["block_reason"]


@pytest.mark.parametrize(
    "payload",
    [
        {"llm": []},
        {"llm": {"candidates": [{"kind": "x"}]}},
        {"llm": {"candidates": [{"id": "x"}]}},
        {"llm": {"candidates": [{"id": "x", "kind": "y", "api_key": 123}]}},
    ],
)
def test_invalid_models_file_rejected(tmp_path: Path, payload: dict) -> None:
    path = tmp_path / "models.yaml"
    path.write_text(yaml.safe_dump(payload, allow_unicode=True), encoding="utf-8")
    with pytest.raises(ConfigurationError):
        load_models(path)
