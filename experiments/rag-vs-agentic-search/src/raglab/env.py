"""运行环境记录（spec §9.2 / T9）。

只记录，不校验。任何字段取不到时写 ``null`` 并在 ``missing`` 里列出，
不猜测、不用默认值冒充事实。
"""

from __future__ import annotations

import hashlib
import json
import os
import platform
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

from .config import ModelsConfig


def _sha256_file(path: Path) -> str | None:
    if not path.is_file():
        return None
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def git_sha(root: str | Path) -> str | None:
    """当前工作区提交；取不到（非仓库/无 git）返回 None，不伪造。"""

    try:
        completed = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=Path(root),
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if completed.returncode != 0:
        return None
    sha = completed.stdout.strip()
    return sha or None


def uv_version() -> str | None:
    try:
        completed = subprocess.run(
            ["uv", "--version"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if completed.returncode != 0:
        return None
    return completed.stdout.strip() or None


def capture_env(
    project_root: str | Path,
    *,
    seed: int,
    corpus_manifest: str | Path | None = None,
    models: ModelsConfig | None = None,
    extra: dict[str, object] | None = None,
) -> dict[str, object]:
    """生成可写入 ``env.json`` 的字典；缺失项进 ``missing``。

    ``models`` 传入**实际会用于跑批**的候选（``config/models.yaml``），而不是另一份
    平行配置——T9 要回答的是"这次跑批用了哪个端点"，不是"配置文件里写过什么"。
    """

    root = Path(project_root)
    models = models or ModelsConfig()

    lock_hash = _sha256_file(root / "uv.lock")
    manifest_hash = (
        _sha256_file(Path(corpus_manifest)) if corpus_manifest is not None else None
    )
    sha = git_sha(root)
    uv = uv_version()

    env: dict[str, object] = {
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "os": platform.platform(),
        "python": sys.version.split()[0],
        "python_executable": sys.executable,
        "cpu_count": os.cpu_count(),
        "uv_version": uv,
        "uv_lock_sha256": lock_hash,
        "corpus_manifest_sha256": manifest_hash,
        "git_sha": sha,
        "seed": seed,
        # 网关地址与候选 id 记录但不含密钥（T9）。
        "model_candidates": models.summary(),
        "live": os.environ.get("RAGLAB_LIVE") == "1",
    }
    if extra:
        env.update(extra)

    missing = [
        key
        for key in ("uv_version", "uv_lock_sha256", "corpus_manifest_sha256", "git_sha")
        if env.get(key) is None
    ]
    if missing:
        env["missing"] = missing
    return env


def write_env(path: str | Path, env: dict[str, object]) -> Path:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        json.dumps(env, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    return target
