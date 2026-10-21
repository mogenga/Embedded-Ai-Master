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
    assert set(config.schemes) == {"A", "B", "C", "C_prime", "D"}


def test_navigation_files_match_corpus_relative_paths() -> None:
    """T11：导航清单必须是相对 corpus/kb/ 的真实路径。

    只写文件名时 `_vendor-index.md` / `_about.md` 匹配不到 `vendor/` 与 `cases/`
    下的同名文件，filter_navigation 会漏过滤（2026-10-20 实测 4 条查询受影响）。
    """

    root = Path(__file__).resolve().parents[1]
    config = ExperimentConfig.from_yaml(root / "config" / "experiment.yaml")
    corpus = root / config.corpus_dir
    # 语料不进版本库，缺失时只校验路径形态，不因语料不在而失败。
    if corpus.is_dir():
        for entry in config.navigation_files:
            assert (corpus / entry).is_file(), (
                f"导航清单里的 {entry!r} 在语料中找不到对应文件"
            )
    # 必须显式覆盖这两处曾漏掉的嵌套路径。
    assert "vendor/_vendor-index.md" in config.navigation_files
    assert "cases/_about.md" in config.navigation_files


def test_scheme_c_token_pattern_keeps_hex_intact() -> None:
    """C 的 token 提取必须是单条交替且十六进制在前，否则 `0x271` 会被切成 `x271`。"""

    import re

    root = Path(__file__).resolve().parents[1] / "config" / "schemes"
    params = load_scheme("C", root / "index_grep.yaml").params
    pattern = re.compile(params["token_pattern"])
    assert pattern.findall("USART BRR 0x271") == ["USART", "BRR", "0x271"]
    assert params["token_min_length"] == 1, "kb_search 不做最小长度过滤，配置须照实复现"
    assert params["dispatch_rule"] in {"deployed", "lexical", "lookup_only"}


def test_model_section_is_rejected(tmp_path: Path) -> None:
    """端点配置只在 models.yaml：experiment.yaml 出现 model 段必须报错，避免两套配置并存。"""

    path = tmp_path / "e.yaml"
    path.write_text(
        "model:\n  llm_base_url: http://localhost:8080/v1\n  llm_model: flash\n",
        encoding="utf-8",
    )
    with pytest.raises(ConfigurationError, match="models.yaml"):
        ExperimentConfig.from_yaml(path)


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


def test_load_scheme_reads_all_scheme_files() -> None:
    from raglab.config import SCHEME_FILES

    root = Path(__file__).resolve().parents[1] / "config" / "schemes"
    for key, filename in SCHEME_FILES.items():
        scheme = load_scheme(key, root / filename)
        assert scheme.name == key


def test_agentic_budget_matches_preregistration() -> None:
    """B 的预算已按网关限流修订（PREREGISTRATION §4bis）：网格 {6,12}、repeat 1。

    这两项与原预注册的 {6,12,20} / repeat 3 不同，是**有据可查的修订**；
    任何改回原值的操作都会让 B 跑不完（≈ 5–8 小时）。
    """

    root = Path(__file__).resolve().parents[1] / "config" / "schemes"
    params = load_scheme("B", root / "agentic.yaml").params
    assert params["max_tool_rounds"] == [6, 12]
    assert params["repeat"] == 1
    assert params["stability_repeats"] == 3, "稳定性测量仍需 3 次，只是样本缩到 10 条"
    assert params["stability_subsample_size"] == 10


def test_implemented_schemes_list_matches_registry() -> None:
    """`IMPLEMENTED_SCHEMES` 必须与 `_REGISTRY` 里非占位的方案一致。

    两者脱节会让 `raglab run` 报出假的"尚未实现"或放过一个占位方案。
    """

    from raglab.config import IMPLEMENTED_SCHEMES
    from raglab.schemes.base import _Placeholder, _scheme_registry

    registry = _scheme_registry()
    actual = {
        key for key, cls in registry.items() if not issubclass(cls, _Placeholder)
    }
    assert actual == set(IMPLEMENTED_SCHEMES), (
        f"注册表里已实现 {sorted(actual)}，配置里写的是 {sorted(IMPLEMENTED_SCHEMES)}"
    )

def test_scheme_c_dispatch_rule_is_preregistered() -> None:
    """主口径已在 PREREGISTRATION §6bis 选定为 deployed，配置不得悄悄漂移。"""

    root = Path(__file__).resolve().parents[1]
    params = load_scheme("C", root / "config" / "schemes" / "index_grep.yaml").params
    assert params["dispatch_rule"] == "deployed"
    prereg = (root / "PREREGISTRATION.md").read_text(encoding="utf-8")
    assert "已选定：`deployed`" in prereg


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
