"""预注册哈希与 confirmatory 门禁（spec §6.2、T2）。

评分分两种模式：
- 默认（探索）：允许对 dev 评分，输出必须标注 ``exploratory``。
- ``--confirmatory``：只允许对**全量**或 test 评分，且必须校验预注册哈希；
  哈希不符即中止，不产出任何结果。

这是"不许在 test 上调参"的程序化落实，不是提示性的。
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path

from .errors import BlockedError, ConfigurationError

PREREGISTRATION_FILE = "PREREGISTRATION.md"
HASH_PLACEHOLDER = "未生成"
RESOLVED_DIR = Path("config") / "resolved"


@dataclass(frozen=True)
class PreregistrationState:
    """预注册的当前状态；``frozen`` 为 False 时不得执行 confirmatory 评分。"""

    path: Path
    sha256: str
    frozen: bool
    reason: str | None = None


def file_sha256(path: str | Path) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def read_preregistration(project_root: str | Path) -> PreregistrationState:
    """读取预注册文件并判断是否已冻结。

    冻结的判据是**文件中不再出现占位符** ``未生成`` 且存在 "## 冻结记录" 一节。
    用内容判断而不是额外状态文件，避免两处真相冲突。
    """

    path = Path(project_root) / PREREGISTRATION_FILE
    if not path.is_file():
        raise ConfigurationError(f"缺少预注册文件：{PREREGISTRATION_FILE}")
    text = path.read_text(encoding="utf-8")
    sha = file_sha256(path)

    if "## 冻结记录" not in text:
        return PreregistrationState(path, sha, frozen=False, reason="缺少「## 冻结记录」一节")
    if HASH_PLACEHOLDER in text:
        return PreregistrationState(
            path, sha, frozen=False, reason=f"冻结记录仍含占位符「{HASH_PLACEHOLDER}」"
        )
    return PreregistrationState(path, sha, frozen=True)


def resolve_config_paths(project_root: str | Path, scheme: str) -> list[Path]:
    """resolved 配置路径；不存在即视为未冻结。"""

    return [Path(project_root) / RESOLVED_DIR / f"{scheme}.json"]


def verify_resolved_configs(project_root: str | Path, schemes: list[str]) -> list[str]:
    """返回缺失或非法的 resolved 配置文件说明；空列表表示齐备。"""

    problems: list[str] = []
    for scheme in schemes:
        for path in resolve_config_paths(project_root, scheme):
            if not path.is_file():
                problems.append(f"缺少已冻结配置：{path.relative_to(project_root).as_posix()}")
                continue
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                problems.append(f"已冻结配置不是合法 JSON：{path.name}")
                continue
            if not isinstance(data, dict) or "sha256" not in data:
                problems.append(f"已冻结配置缺少 sha256 字段：{path.name}")
    return problems


def require_confirmatory_ready(
    project_root: str | Path,
    *,
    schemes: list[str],
    partition: str,
) -> PreregistrationState:
    """confirmatory 评分的前置检查；任一不满足即抛 BlockedError。"""

    if partition == "dev":
        raise BlockedError(
            "confirmatory 评分不允许在 dev 上进行（dev 只用于调参，§6.1 T2）"
        )

    state = read_preregistration(project_root)
    if not state.frozen:
        raise BlockedError(f"预注册未冻结：{state.reason}；confirmatory 评分已中止")

    problems = verify_resolved_configs(project_root, schemes)
    if problems:
        detail = "；".join(problems[:3])
        raise BlockedError(f"配置未冻结：{detail}")

    return state
