"""分词（spec §8.5）。

两种方案，预注册二选一（dev 上选）：

- ``cjk_bigram``：中文按二元字符切，英文/标识符按正则取整词。**不依赖任何第三方**，
  行为完全可复现。
- ``jieba``：中文用 jieba 精确模式；英文/标识符仍走同一套正则。

两者共同点（必须一致，否则比较的是分词器以外的变量）：

- 大小写不敏感，统一转小写；**保留原词形不还原词干**（嵌入式术语 `INVSTATE` /
  `invstate` 要能互相命中，但不做 stemming，避免 `buses`/`bus` 这类误合）；
- 十六进制 `0x…`、标识符 `[A-Za-z_][A-Za-z0-9_]*`、数字串都作为整体 token；
- 纯标点与空白不产生 token。
"""

from __future__ import annotations

import re

TOKENIZERS = ("cjk_bigram", "jieba")

# 与 kb-mcp 保持一致的标识符/十六进制模式：十六进制在前。
_TECH_PATTERN = re.compile(r"0x[0-9A-Fa-f]+|[A-Za-z_][A-Za-z0-9_]*|\d+")
_CJK_RUN = re.compile(r"[一-鿿]+")

_JIEBA = None


def _jieba():
    global _JIEBA
    if _JIEBA is None:
        import jieba  # 延迟导入：不用 jieba 的配置不该付加载成本

        jieba.setLogLevel(60)  # 静默启动日志，避免污染 CLI 输出
        _JIEBA = jieba
    return _JIEBA


def _cjk_bigrams(run: str) -> list[str]:
    if len(run) == 1:
        return [run]
    return [run[i : i + 2] for i in range(len(run) - 1)]


def _cjk_jieba(run: str) -> list[str]:
    return [
        piece.strip().lower()
        for piece in _jieba().lcut(run)
        if piece.strip()
    ]


def tokenize(text: str, *, mode: str = "cjk_bigram") -> list[str]:
    """把一段文本切成检索用 token；顺序保留、允许重复（BM25 需要词频）。"""

    if mode not in TOKENIZERS:
        raise ValueError(f"未知分词方式：{mode!r}，可选 {TOKENIZERS}")

    tokens: list[str] = []
    position = 0
    for match in _TECH_PATTERN.finditer(text):
        # 先把技术 token 之前的中文段落切掉，再处理技术 token 本身。
        gap = text[position : match.start()]
        tokens.extend(_tokenize_cjk_only(gap, mode))
        tokens.append(match.group(0).lower())
        position = match.end()
    tokens.extend(_tokenize_cjk_only(text[position:], mode))
    return tokens


def _tokenize_cjk_only(text: str, mode: str) -> list[str]:
    """只处理中文串；技术 token 已在上层由正则单独截出。

    中文串之间的标点、空白不产生 token——它们没有区分度，进了词表只会稀释 BM25 的 IDF。
    """

    tokens: list[str] = []
    for run in _CJK_RUN.finditer(text):
        run_text = run.group(0)
        tokens.extend(
            _cjk_bigrams(run_text) if mode == "cjk_bigram" else _cjk_jieba(run_text)
        )
    return tokens
