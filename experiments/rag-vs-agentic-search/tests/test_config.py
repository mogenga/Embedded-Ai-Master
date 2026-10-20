"""配置加载：缺失与非法必须显式报错（§9.2）。"""

from __future__ import annotations

from pathlib import Path

import pytest

from raglab.config import ExperimentConfig, load_scheme
from raglab.errors import ConfigurationError


def test_loads_repository_config() -> None:
    root = Path(__file__).resolve().parents[1]
    config = ExperimentConfig.from_yaml(root / "config" / "experiment.yaml")
    assert config.seed == 20261019
    assert config.corpus_dir == "corpus/kb"
    assert "index.yaml" in config.navigation_files
    assert config.model.llm_configured is False
    assert set(config.schemes) == {"A", "B", "C", "C_prime", "D"}


def test_missing_file_raises(tmp_path: Path) -> None:
    with pytest.raises(ConfigurationError):
        ExperimentConfig.from_yaml(tmp_path / "nope.yaml")


def test_empty_file_raises(tmp_path: Path) -> None:
    path = tmp_path / "e.yaml"
    path.write_text("", encoding="utf-8")
    with pytest.raises(ConfigurationError):
        ExperimentConfig.from_yaml(path)


def test_unknown_scheme_key_raises(tmp_path: Path) -> None:
    path = tmp_path / "e.yaml"
    path.write_text("schemes:\n  Z:\n    enabled: true\n", encoding="utf-8")
    with pytest.raises(ConfigurationError):
        ExperimentConfig.from_yaml(path)


def test_non_int_seed_raises(tmp_path: Path) -> None:
    path = tmp_path / "e.yaml"
    path.write_text("seed: abc\n", encoding="utf-8")
    with pytest.raises(ConfigurationError):
        ExperimentConfig.from_yaml(path)


def test_model_flags_reflect_presence(tmp_path: Path) -> None:
    path = tmp_path / "e.yaml"
    path.write_text(
        "model:\n  llm_base_url: http://localhost:8080/v1\n  llm_model: flash\n",
        encoding="utf-8",
    )
    config = ExperimentConfig.from_yaml(path)
    assert config.model.llm_configured is True
    assert config.model.embedding_configured is False


def test_load_scheme_reads_all_scheme_files() -> None:
    root = Path(__file__).resolve().parents[1] / "config" / "schemes"
    mapping = {
        "A": "vector.yaml",
        "B": "agentic.yaml",
        "C": "index_grep.yaml",
        "C_prime": "bm25_grep.yaml",
        "D": "hybrid.yaml",
    }
    for key, filename in mapping.items():
        scheme = load_scheme(key, root / filename)
        assert scheme.name == key


def test_load_scheme_rejects_unknown_name(tmp_path: Path) -> None:
    path = tmp_path / "s.yaml"
    path.write_text("params: {}\n", encoding="utf-8")
    with pytest.raises(ConfigurationError):
        load_scheme("Z", path)


def test_agentic_prompt_file_exists_and_avoids_leaks() -> None:
    root = Path(__file__).resolve().parents[1]
    prompt = (root / "config" / "prompts" / "agentic_system.txt").read_text(encoding="utf-8")
    assert "submit" in prompt
    # T10：提示词不得含索引结构、轨标签或 gold 路径。
    for forbidden in ("index.yaml", "track", "gold", "172", "102"):
        assert forbidden not in prompt
