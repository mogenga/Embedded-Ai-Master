"""配置加载（§9.2）。

配置文件缺失或字段非法时抛 ``ConfigurationError``，不静默回退到默认值——
回退会掩盖"用哪套参数跑了实验"这一关键事实。模型端点（M4）留空时允许加载，
但任何 live 调用都会被 ``llm`` 层以 ``LiveGateError`` 拒绝。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from .errors import ConfigurationError

SCHEMES = ("A", "B", "C", "C_prime", "D")


def _load_yaml(path: Path) -> Any:
    if not path.is_file():
        raise ConfigurationError(f"缺少配置文件：{path}")
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        raise ConfigurationError(f"配置文件 YAML 非法：{path}：{exc}") from exc
    if data is None:
        raise ConfigurationError(f"配置文件为空：{path}")
    return data


@dataclass(frozen=True)
class ModelConfig:
    """LLM 与 embedding 端点（M4）。"""

    llm_base_url: str | None = None
    llm_model: str | None = None
    embedding_base_url: str | None = None
    embedding_model: str | None = None

    @property
    def llm_configured(self) -> bool:
        return bool(self.llm_base_url and self.llm_model)

    @property
    def embedding_configured(self) -> bool:
        return bool(self.embedding_base_url and self.embedding_model)


@dataclass(frozen=True)
class ExperimentConfig:
    """实验总配置。字段与 spec §8/§9 对应，不在此处扩展口径。"""

    seed: int = 20261019
    corpus_dir: str = "corpus/kb"
    data_dir: str = "data"
    results_dir: str = "results"
    navigation_files: tuple[str, ...] = ()
    model: ModelConfig = field(default_factory=ModelConfig)
    schemes: dict[str, dict[str, Any]] = field(default_factory=dict)

    @classmethod
    def from_yaml(cls, path: str | Path) -> "ExperimentConfig":
        data = _load_yaml(Path(path))
        if not isinstance(data, dict):
            raise ConfigurationError("experiment.yaml 顶层必须是映射")

        model_raw = data.get("model") or {}
        if not isinstance(model_raw, dict):
            raise ConfigurationError("experiment.yaml model 必须是映射")
        model = ModelConfig(
            llm_base_url=model_raw.get("llm_base_url"),
            llm_model=model_raw.get("llm_model"),
            embedding_base_url=model_raw.get("embedding_base_url"),
            embedding_model=model_raw.get("embedding_model"),
        )

        navigation = data.get("navigation_files") or []
        if not isinstance(navigation, list) or not all(
            isinstance(item, str) for item in navigation
        ):
            raise ConfigurationError("experiment.yaml navigation_files 必须是字符串数组")

        schemes = data.get("schemes") or {}
        if not isinstance(schemes, dict):
            raise ConfigurationError("experiment.yaml schemes 必须是映射")
        unknown = sorted(set(schemes) - set(SCHEMES))
        if unknown:
            raise ConfigurationError(f"未知方案名：{unknown}")

        seed = data.get("seed", 20261019)
        if not isinstance(seed, int):
            raise ConfigurationError("experiment.yaml seed 必须是整数")

        return cls(
            seed=seed,
            corpus_dir=data.get("corpus_dir", "corpus/kb"),
            data_dir=data.get("data_dir", "data"),
            results_dir=data.get("results_dir", "results"),
            navigation_files=tuple(navigation),
            model=model,
            schemes=schemes,
        )


@dataclass(frozen=True)
class SchemeConfig:
    """单个方案配置（config/schemes/*.yaml）。"""

    name: str
    params: dict[str, Any] = field(default_factory=dict)
    prompt_path: str | None = None


def load_scheme(name: str, path: str | Path) -> SchemeConfig:
    if name not in SCHEMES:
        raise ConfigurationError(f"未知方案名：{name}")
    data = _load_yaml(Path(path))
    if not isinstance(data, dict):
        raise ConfigurationError(f"{path} 顶层必须是映射")
    params = data.get("params") or {}
    if not isinstance(params, dict):
        raise ConfigurationError(f"{path} params 必须是映射")
    prompt_path = data.get("prompt_path")
    if prompt_path is not None and not isinstance(prompt_path, str):
        raise ConfigurationError(f"{path} prompt_path 必须是字符串")
    return SchemeConfig(name=name, params=params, prompt_path=prompt_path)
