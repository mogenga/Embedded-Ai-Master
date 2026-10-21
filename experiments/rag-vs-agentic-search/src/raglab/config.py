"""配置加载（§9.2）。

配置文件缺失或字段非法时抛 ``ConfigurationError``，不静默回退到默认值——
回退会掩盖"用哪套参数跑了实验"这一关键事实。

两套配置，职责不重叠：
- ``experiment.yaml``：实验设计（种子、语料/数据目录、导航文件、方案开关）。
- ``models.yaml``：M4 端点与密钥，只存在于本地（已 gitignore）。缺失是合法状态，
  此时 ``load_models`` 返回空配置；live 调用仍会被 ``llm`` 层的 ``LiveGateError`` 拒绝。
"""

from __future__ import annotations

import importlib.util
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from .errors import ConfigurationError

SCHEMES = ("A", "B", "C", "C_prime", "D")

# 方案名 → config/schemes/ 下的文件名。新增方案必须同时在此登记，
# 否则 `raglab run` 会因为找不到参数文件而静默用默认值——那会让"用了哪套参数"不可判定。
SCHEME_FILES: dict[str, str] = {
    "A": "vector.yaml",
    "B": "agentic.yaml",
    "C": "index_grep.yaml",
    "C_prime": "bm25_grep.yaml",
    "D": "hybrid.yaml",
}

# 已有实现的方案。**这份清单必须与 schemes 包里的实际类同步**：
# 写在这里而不靠"能不能构造出实例"来判断，是因为后者会让未实现方案先报
# 参数错误，提示信息是假的。测试断言两者一致。
IMPLEMENTED_SCHEMES: frozenset[str] = frozenset({"A", "B", "C", "C_prime", "D"})

# 本轮不参与结论的方案。实现保留（D 的 H5 门槛与种子接线都是有效工作），
# 但**不跑全量**——D1 冒烟显示其种子召回等于 C′ 全量水平，增益空间有限。
#
# 这个清单会写进报告，避免"跑批结果里出现了 D"被误读成"D 参与了结论"。
# **B 已于 2026-10-20 补跑全量**（用户要求），故不在此列。
SKIPPED_THIS_ROUND: frozenset[str] = frozenset({"D"})

# 可选依赖组 → 用于探测的模块名。用于判断本地候选是否真的能跑。
# 当前没有本地候选在用（见 models.yaml 说明），但 spec §6.3 的 embedder 网格
# 保留了"本地候选"这一档，能力留在代码里，删掉会让该档无法恢复。
OPTIONAL_GROUP_MODULES: dict[str, str] = {
    "local-embed": "sentence_transformers",
}


def _optional_available(group: str) -> bool:
    """可选依赖组是否已安装；组名未知时按不可用处理（不猜）。"""

    module = OPTIONAL_GROUP_MODULES.get(group)
    if module is None:
        return False
    return importlib.util.find_spec(module) is not None


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
class ExperimentConfig:
    """实验总配置。字段与 spec §8/§9 对应，不在此处扩展口径。

    M4 的端点与密钥一律来自本地 ``config/models.yaml``（见 ``load_models``），
    本配置不含任何模型字段——两套配置并存会让"实际用了哪个端点"变得不可判定。
    """

    seed: int = 20261019
    corpus_dir: str = "corpus/kb"
    data_dir: str = "data"
    results_dir: str = "results"
    navigation_files: tuple[str, ...] = ()
    schemes: dict[str, dict[str, Any]] = field(default_factory=dict)

    @classmethod
    def from_yaml(cls, path: str | Path) -> "ExperimentConfig":
        data = _load_yaml(Path(path))
        if not isinstance(data, dict):
            raise ConfigurationError("experiment.yaml 顶层必须是映射")

        if "model" in data:
            raise ConfigurationError(
                "experiment.yaml 不再接受 model 字段：端点与密钥只在 config/models.yaml 中配置"
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
            schemes=schemes,
        )


@dataclass(frozen=True)
class ModelCandidate:
    """``models.yaml`` 中的一个候选端点。

    ``api_key`` 只可能来自本地 ``config/models.yaml``（已 gitignore）；模板文件里恒为 null。
    """

    id: str
    kind: str
    base_url: str | None = None
    model: str | None = None
    api_key: str | None = None
    temperature: float = 0.0
    repeat: int = 1
    supports_seed: bool = False
    requires: str | None = None

    @property
    def usable(self) -> bool:
        """候选是否真的能跑。

        - ``openai_compatible``：必须有 ``base_url`` 与 ``model``。
        - ``local``：必须有 ``model``，且声明在 ``requires`` 里的可选依赖已安装。
          只写 ``model`` 但依赖缺失的候选**不算可用**——否则会把跑不起来的候选
          选进实验，再在跑批时失败。
        """

        if self.kind == "local":
            if self.model is None:
                return False
            return self.requires is None or _optional_available(self.requires)
        return bool(self.base_url and self.model)

    @property
    def block_reason(self) -> str | None:
        """不可用的原因；可用时返回 None。"""

        if self.usable:
            return None
        if self.kind == "local":
            if self.model is None:
                return "缺少 model"
            return f"缺少可选依赖组 {self.requires}"
        missing = [
            name
            for name, value in (("base_url", self.base_url), ("model", self.model))
            if not value
        ]
        return f"缺少 {'/'.join(missing)}"

    def redacted(self) -> dict[str, Any]:
        """用于日志与 env.json：不暴露密钥。"""

        return {
            "id": self.id,
            "kind": self.kind,
            "base_url": self.base_url,
            "model": self.model,
            "api_key_set": self.api_key is not None,
            "temperature": self.temperature,
            "repeat": self.repeat,
            "supports_seed": self.supports_seed,
        }


@dataclass(frozen=True)
class ModelsConfig:
    llm: tuple[ModelCandidate, ...] = ()
    embedding: tuple[ModelCandidate, ...] = ()

    def usable_llm(self) -> list[ModelCandidate]:
        return [candidate for candidate in self.llm if candidate.usable]

    def usable_embedding(self) -> list[ModelCandidate]:
        return [candidate for candidate in self.embedding if candidate.usable]

    def summary(self) -> list[dict[str, Any]]:
        """每个候选的可运行状态；供 CLI 与 env.json 记录。"""

        rows: list[dict[str, Any]] = []
        for section, candidates in (("llm", self.llm), ("embedding", self.embedding)):
            for candidate in candidates:
                row = candidate.redacted()
                row["section"] = section
                row["usable"] = candidate.usable
                row["block_reason"] = candidate.block_reason
                rows.append(row)
        return rows


def _parse_candidates(raw: Any, *, where: str) -> tuple[ModelCandidate, ...]:
    if raw is None:
        return ()
    if not isinstance(raw, list):
        raise ConfigurationError(f"{where} 必须是数组")
    candidates: list[ModelCandidate] = []
    for index, item in enumerate(raw):
        if not isinstance(item, dict):
            raise ConfigurationError(f"{where}[{index}] 必须是映射")
        candidate_id = item.get("id")
        kind = item.get("kind")
        if not isinstance(candidate_id, str) or not candidate_id:
            raise ConfigurationError(f"{where}[{index}].id 必须是非空字符串")
        if not isinstance(kind, str) or not kind:
            raise ConfigurationError(f"{where}[{index}].kind 必须是非空字符串")
        api_key = item.get("api_key")
        if api_key is not None and not isinstance(api_key, str):
            raise ConfigurationError(f"{where}[{index}].api_key 必须是字符串或 null")
        candidates.append(
            ModelCandidate(
                id=candidate_id,
                kind=kind,
                base_url=item.get("base_url"),
                model=item.get("model"),
                api_key=api_key or None,
                temperature=float(item.get("temperature", 0.0) or 0.0),
                repeat=int(item.get("repeat", 1) or 1),
                supports_seed=bool(item.get("supports_seed", False)),
                requires=item.get("requires"),
            )
        )
    return tuple(candidates)


def load_models(path: str | Path) -> ModelsConfig:
    """加载 ``config/models.yaml``；文件不存在时返回空配置（M4 未就绪的合法状态）。"""

    resolved = Path(path)
    if not resolved.is_file():
        return ModelsConfig()
    data = _load_yaml(resolved)
    if not isinstance(data, dict):
        raise ConfigurationError(f"{resolved.name} 顶层必须是映射")

    def candidates(section: str) -> tuple[ModelCandidate, ...]:
        block = data.get(section)
        if block is None:
            return ()
        if not isinstance(block, dict):
            raise ConfigurationError(f"{resolved.name} 的 {section} 必须是映射")
        return _parse_candidates(block.get("candidates"), where=f"{section}.candidates")

    return ModelsConfig(llm=candidates("llm"), embedding=candidates("embedding"))


@dataclass(frozen=True)
class SchemeConfig:
    """单个方案配置（config/schemes/*.yaml）。"""

    name: str
    params: dict[str, Any] = field(default_factory=dict)
    prompt_path: str | None = None
    # 顶层 `variants`（方案 D 的 D1/D2 定义）。它不是超参，是**互斥的变体**，
    # 所以单列而不是塞进 params——`params` 里的键会被 `_resolved_params`
    # 当成"仍需选择的网格"检查。
    variants: dict[str, Any] = field(default_factory=dict)


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
    variants = data.get("variants") or {}
    if not isinstance(variants, dict):
        raise ConfigurationError(f"{path} variants 必须是映射")
    return SchemeConfig(
        name=name, params=params, prompt_path=prompt_path, variants=variants
    )
