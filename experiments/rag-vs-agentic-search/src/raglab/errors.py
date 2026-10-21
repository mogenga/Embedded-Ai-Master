"""实验内可预期错误。CLI 依据 ``exit_code`` 退出，不把失败伪装成成功。"""

from __future__ import annotations


class RaglabError(Exception):
    """实验内所有可预期错误的基类。"""

    exit_code = 1


class ConfigurationError(RaglabError):
    """配置缺失或非法（例如 M4 模型端点未填写）。"""

    exit_code = 2


class IntakeError(RaglabError):
    """资产导入/校验失败。按 spec §5.2，导入失败即中止。"""

    exit_code = 2


class BlockedError(RaglabError):
    """前置素材或前置阶段未就绪。"""

    exit_code = 3


class FeatureNotImplemented(BlockedError):
    """骨架阶段的显式占位：该能力尚未实现。"""

    exit_code = 3


class LiveGateError(RaglabError):
    """未显式开启 live 模式却试图访问网络。"""

    exit_code = 4


class LLMError(RaglabError):
    """模型网关请求或响应异常。"""

    exit_code = 5
