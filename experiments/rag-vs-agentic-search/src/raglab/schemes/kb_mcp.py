"""kb-mcp 检索语义的忠实移植（M3）。

**这是一次逐行移植，不是重新设计**。事实源是主仓库 `mcp-servers/kb/service.ts` 与
`mcp-servers/kb/yaml.ts`（分支 `feat/m2-stage3` @ `c529dcd`）。改动语义就会让方案 C
不再是"现状基线"——那正是 T12/T13 要防的事。

两处刻意与项目其它部分不同：

1. **不用 PyYAML 解析 `index.yaml`**，而是移植 `yaml.ts` 的最小子集。PyYAML 会在
   ` #` 处把值当注释截断，实测有 2 个条目的 `summary` 因此不同（`bic/and #1 …` 与
   `#pragma …`）。`summary` 参与技术 token 覆盖度计算，用 PyYAML 就不是忠实复现。
2. **不做最小长度过滤的 search**。`lookup` 的 `extractQueryTokens` 会丢掉长度 < 2 的
   token，但 `search` 不会——`i.MX` 里的 `i` 真的会成为搜索词。照实复现。

`probe_endpoints` 那类"顺手改好"的冲动在这里一律不适用：任何偏离都要在预注册里写明。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

# ---- 常量（与 service.ts 一一对应） ---------------------------------------

MAX_FILE_BYTES = 1024 * 1024
# 注意这是 **basename** 集合，不是语料内相对路径。vendor/_vendor-index.md 的 basename
# 是 `_vendor-index.md`，不在这个集合里，因此它**可被 search 搜到**——这是实测事实。
NAVIGATION_BASENAMES = frozenset({"_inbox.md", "_about.md"})
INDEX_FILE = "index.yaml"
DEFAULT_LOOKUP_LIMIT = 2
DEFAULT_SEARCH_LIMIT = 20
TAG_WEIGHT = 2
CONFIDENCE_THRESHOLD = 1.75
OOV_PENALTY = 0.75
TECH_COVERAGE_RATIO = 0.5
MIN_CJK_HIT_CHARS = 4
MIN_CJK_CONTEXT_CHARS = 2

QUERY_TOKEN_PATTERN = re.compile(r"0x[0-9A-Fa-f]+|[A-Za-z_][A-Za-z0-9_]*")
# 单条交替且十六进制在前：`0x[0-9A-Fa-f]+` 必须优先匹配，否则 `0x271` 会先被
# 标识符模式吃掉开头的 `0`，产出 `x271`。
CJK_PATTERN = re.compile(r"[一-鿿]")
CJK_RUN_PATTERN = re.compile(r"[一-鿿]+")
PURE_ASCII_WORD = re.compile(r"[A-Za-z][A-Za-z0-9_]*")
ACRONYM = re.compile(r"[A-Z][A-Z0-9_]+")
KEY_PATTERN = re.compile(r"[A-Za-z_][A-Za-z0-9_-]*")

ENGLISH_STOPWORDS = frozenset(
    {
        "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "could",
        "did", "do", "does", "for", "from", "had", "has", "have", "how", "if",
        "in", "into", "is", "it", "its", "no", "not", "of", "on", "or", "our",
        "should", "so", "than", "that", "the", "their", "then", "there", "these",
        "they", "this", "to", "was", "we", "were", "what", "when", "where",
        "which", "who", "why", "will", "with", "would", "you", "your",
    }
)
GENERIC_TECH_TOKENS = frozenset({"cpu", "mcu", "soc"})


class KbFormatError(ValueError):
    """index.yaml 不符合 yaml.ts 支持的子集。"""


# ---- index.yaml 解析（移植 yaml.ts） --------------------------------------


@dataclass(frozen=True)
class IndexEntry:
    id: str
    title: str
    path: str
    tags: tuple[str, ...]
    keywords: tuple[str, ...]
    summary: str


def _split_key_value(line: str) -> tuple[str, str] | None:
    colon = line.find(":")
    if colon <= 0:
        return None
    # `key:value`（冒号后无空格）不算合法字段行。
    if colon + 1 < len(line) and line[colon + 1] != " ":
        return None
    key = line[:colon].strip()
    if not KEY_PATTERN.fullmatch(key):
        return None
    return key, line[colon + 1 :].strip()


def _unquote(value: str) -> str | None:
    """按 yaml.ts 的规则解引号；不合法返回 None。"""

    if not value:
        return value
    quote = value[0]
    if quote not in ("'", '"'):
        return value
    if len(value) < 2 or value[-1] != quote:
        return None
    inner = value[1:-1]
    out: list[str] = []
    i = 0
    while i < len(inner):
        ch = inner[i]
        if quote == "'":
            if ch == "'":
                if i + 1 < len(inner) and inner[i + 1] == "'":
                    out.append("'")
                    i += 2
                    continue
                return None
            out.append(ch)
            i += 1
            continue
        if ch == "\\":
            nxt = inner[i + 1] if i + 1 < len(inner) else ""
            if nxt in ('"', "\\"):
                out.append(nxt)
                i += 2
                continue
            out.append(ch)
            i += 1
            continue
        if ch == '"':
            return None
        out.append(ch)
        i += 1
    return "".join(out)


def _split_inline_list(body: str) -> list[str] | None:
    items: list[str] = []
    current: list[str] = []
    quote: str | None = None
    i = 0
    while i < len(body):
        ch = body[i]
        if quote == "'":
            if ch == "'":
                if i + 1 < len(body) and body[i + 1] == "'":
                    current.append("''")
                    i += 2
                    continue
                quote = None
            current.append(ch)
            i += 1
            continue
        if quote == '"':
            if ch == "\\":
                current.append(ch)
                if i + 1 < len(body):
                    current.append(body[i + 1])
                i += 2
                continue
            if ch == '"':
                quote = None
            current.append(ch)
            i += 1
            continue
        if ch in ("'", '"'):
            quote = ch
            current.append(ch)
            i += 1
            continue
        if ch == ",":
            items.append("".join(current))
            current = []
            i += 1
            continue
        current.append(ch)
        i += 1
    if quote is not None:
        return None
    items.append("".join(current))

    result: list[str] = []
    for item in items:
        trimmed = item.strip()
        if not trimmed:
            continue
        unquoted = _unquote(trimmed)
        if unquoted is None:
            return None
        result.append(unquoted)
    return result


def _parse_scalar(raw: str) -> str | tuple[str, ...]:
    value = raw.strip()
    if not value:
        return ""
    if value.startswith("["):
        if not value.endswith("]"):
            raise KbFormatError(f"index.yaml 无法解析的行内数组: {value}")
        items = _split_inline_list(value[1:-1])
        if items is None:
            raise KbFormatError(f"index.yaml 无法解析的行内数组: {value}")
        return tuple(items)
    unquoted = _unquote(value)
    if unquoted is None:
        raise KbFormatError(f"index.yaml 无法解析的引号值: {value}")
    return unquoted


def parse_index_yaml(text: str) -> list[IndexEntry]:
    """解析 `index.yaml`；语义对齐 `yaml.ts` 的 `parseIndexYaml`。

    与 PyYAML 的关键差异：值里的 ` #` **不**被当作注释，整段原样保留。
    """

    entries: list[IndexEntry] = []
    current: dict[str, object] | None = None
    in_entries = False
    item_count = 0

    def finish() -> None:
        nonlocal current, item_count
        if current is None:
            return
        item_count += 1
        for field in ("id", "title", "path"):
            if not current.get(field):
                raise KbFormatError(f"index.yaml 第 {item_count} 个条目缺少必填字段: {field}")
        for field in ("tags", "keywords"):
            if field not in current:
                raise KbFormatError(f"index.yaml 第 {item_count} 个条目缺少必填字段: {field}")
        entries.append(
            IndexEntry(
                id=str(current["id"]),
                title=str(current["title"]),
                path=str(current["path"]),
                tags=tuple(current["tags"]),  # type: ignore[arg-type]
                keywords=tuple(current["keywords"]),  # type: ignore[arg-type]
                summary=str(current.get("summary", "")),
            )
        )
        current = None

    def apply(line: str) -> None:
        nonlocal current
        assert current is not None
        pair = _split_key_value(line)
        if pair is None:
            raise KbFormatError(f"index.yaml 无法解析的字段行: {line}")
        key, raw = pair
        if key in ("id", "title", "path", "summary"):
            value = _parse_scalar(raw)
            if isinstance(value, tuple):
                raise KbFormatError(f"index.yaml 字段 {key} 必须是字符串")
            current[key] = value
        elif key in ("tags", "keywords"):
            value = _parse_scalar(raw)
            if not isinstance(value, tuple):
                raise KbFormatError(f"index.yaml 字段 {key} 必须是数组")
            current[key] = value

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if not in_entries:
            if line == "entries:":
                in_entries = True
            continue
        if line == "-" or line.startswith("- "):
            finish()
            current = {}
            rest = line[1:].strip()
            if rest:
                apply(rest)
            continue
        if current is None:
            raise KbFormatError(f"index.yaml 无法解析的条目行: {line}")
        apply(line)

    finish()
    return entries


# ---- 打分（移植 service.ts） ----------------------------------------------

_BOUNDARY_CACHE: dict[str, re.Pattern[str]] = {}


def _boundary_pattern(token: str) -> re.Pattern[str]:
    cached = _BOUNDARY_CACHE.get(token)
    if cached is not None:
        return cached
    pattern = re.compile(
        rf"(?<![A-Za-z0-9_]){re.escape(token)}(?![A-Za-z0-9_])", re.IGNORECASE
    )
    _BOUNDARY_CACHE[token] = pattern
    return pattern


def matches_token(needle: str, token: str) -> bool:
    normalized = token.strip().lower()
    if not normalized:
        return False
    if CJK_PATTERN.search(normalized):
        return normalized in needle
    # 单字符纯英文 token 不参与匹配（例如 tag `c`）。
    if PURE_ASCII_WORD.fullmatch(normalized) and len(normalized) < 2:
        return False
    return _boundary_pattern(normalized).search(needle) is not None


def score_entry(entry: IndexEntry, needle: str) -> float:
    score = 0.0
    for keyword in entry.keywords:
        if matches_token(needle, keyword):
            score += len(keyword.strip())
    for tag in entry.tags:
        if matches_token(needle, tag):
            score += TAG_WEIGHT
    return score


def extract_query_tokens(query: str) -> list[str]:
    seen: list[str] = []
    for match in QUERY_TOKEN_PATTERN.finditer(query):
        token = match.group(0).lower()
        if len(token) < 2:
            continue
        if token not in seen:
            seen.append(token)
    return seen


def extract_tech_tokens(query: str) -> list[str]:
    seen: list[str] = []
    for match in QUERY_TOKEN_PATTERN.finditer(query):
        raw = match.group(0)
        if len(raw) < 2:
            continue
        normalized = raw.lower()
        if normalized in seen:
            continue
        if normalized in GENERIC_TECH_TOKENS:
            continue
        is_acronym = ACRONYM.fullmatch(raw) is not None
        if not is_acronym and normalized in ENGLISH_STOPWORDS:
            continue
        seen.append(normalized)
    return seen


def entry_search_text(entry: IndexEntry) -> str:
    return "\n".join(
        [entry.title, entry.summary, entry.path, *entry.keywords, *entry.tags]
    ).lower()


def count_tech_coverage(entry: IndexEntry, tech_tokens: list[str]) -> int:
    if not tech_tokens:
        return 0
    text = entry_search_text(entry)
    return sum(1 for token in tech_tokens if matches_token(text, token))


def has_enough_tech_coverage(covered: int, total: int) -> bool:
    if total == 0:
        return True
    if covered == 0:
        return False
    if total == 1:
        return True
    return covered / total > TECH_COVERAGE_RATIO


def count_cjk_chars(text: str) -> int:
    return sum(len(run) for run in CJK_RUN_PATTERN.findall(text))


@dataclass(frozen=True)
class CjkStats:
    hit_chars: int
    keyword_count: int


def cjk_match_stats(entry: IndexEntry, needle: str) -> CjkStats:
    seen: set[str] = set()
    hit_chars = 0
    for keyword in entry.keywords:
        normalized = keyword.strip().lower()
        if not normalized or not CJK_PATTERN.search(normalized) or normalized in seen:
            continue
        if normalized not in needle:
            continue
        seen.add(normalized)
        hit_chars += count_cjk_chars(normalized)
    return CjkStats(hit_chars=hit_chars, keyword_count=len(seen))


def has_enough_chinese_confidence(stats: CjkStats, query_cjk_chars: int) -> bool:
    if stats.hit_chars >= MIN_CJK_HIT_CHARS:
        return True
    if stats.keyword_count >= 2:
        return True
    return query_cjk_chars - stats.hit_chars >= MIN_CJK_CONTEXT_CHARS


def build_vocabulary(entries: list[IndexEntry]) -> set[str]:
    vocabulary: set[str] = set()
    for entry in entries:
        for token in (*entry.keywords, *entry.tags):
            normalized = token.strip().lower()
            if normalized:
                vocabulary.add(normalized)
    return vocabulary


def confidence_factor(query: str, vocabulary: set[str]) -> float:
    tokens = extract_query_tokens(query)
    if not tokens:
        return 1.0
    known = sum(1 for token in tokens if token in vocabulary)
    oov_ratio = (len(tokens) - known) / len(tokens)
    return max(0.0, 1.0 - OOV_PENALTY * oov_ratio)


# ---- 服务（移植 KbService 的 lookup / search） -----------------------------


@dataclass(frozen=True)
class LookupCandidate:
    path: str
    title: str
    summary: str
    score: float


@dataclass(frozen=True)
class LookupResult:
    found: bool
    candidates: tuple[LookupCandidate, ...]
    reason: str | None = None


@dataclass(frozen=True)
class SearchHit:
    path: str
    line: int
    text: str
    token: str


@dataclass(frozen=True)
class SearchResult:
    found: bool
    hits: tuple[SearchHit, ...]


class KbMcpService:
    """kb-mcp 检索能力的只读移植。

    只实现方案 C 需要的 `lookup` 与 `search`。`read` 未移植——方案 C 不读正文。
    """

    def __init__(self, root: str | Path) -> None:
        self._root = Path(root).resolve()
        self._entries: list[IndexEntry] | None = None

    @property
    def root(self) -> Path:
        return self._root

    def _index_path(self) -> Path:
        return self._root / INDEX_FILE

    def load_index(self) -> list[IndexEntry] | None:
        """索引缺失返回 None（对齐 kb-mcp 的 `index_missing`）。"""

        if not self._root.is_dir():
            return None
        index_path = self._index_path()
        if not index_path.is_file():
            return None
        if self._entries is None:
            self._entries = parse_index_yaml(index_path.read_text(encoding="utf-8"))
        return self._entries

    def lookup(self, query: str, limit: int = DEFAULT_LOOKUP_LIMIT) -> LookupResult:
        trimmed = query.strip()
        if not trimmed:
            return LookupResult(found=False, candidates=(), reason="empty_query")

        entries = self.load_index()
        if entries is None:
            return LookupResult(found=False, candidates=(), reason="index_missing")

        needle = trimmed.lower()
        factor = confidence_factor(trimmed, build_vocabulary(entries))
        tech_tokens = extract_tech_tokens(trimmed)
        query_cjk_chars = count_cjk_chars(needle)

        lexical = []
        for entry in entries:
            score = score_entry(entry, needle) * factor
            if score <= 0:
                continue
            lexical.append(
                {
                    "entry": entry,
                    "score": score,
                    "tech_covered": count_tech_coverage(entry, tech_tokens),
                    "cjk": cjk_match_stats(entry, needle),
                }
            )

        scored = [
            row
            for row in lexical
            if has_enough_tech_coverage(row["tech_covered"], len(tech_tokens))  # type: ignore[arg-type]
            and (
                tech_tokens
                or has_enough_chinese_confidence(row["cjk"], query_cjk_chars)  # type: ignore[arg-type]
            )
        ]
        scored.sort(key=lambda row: (-row["score"], row["entry"].path))  # type: ignore[index]

        candidates = tuple(
            LookupCandidate(
                path=row["entry"].path,  # type: ignore[union-attr]
                title=row["entry"].title,  # type: ignore[union-attr]
                summary=row["entry"].summary,  # type: ignore[union-attr]
                score=float(row["score"]),  # type: ignore[arg-type]
            )
            for row in scored
            if row["score"] >= CONFIDENCE_THRESHOLD  # type: ignore[operator]
        )[: max(0, limit)]

        if not candidates:
            return LookupResult(
                found=False,
                candidates=(),
                reason="no_match" if not lexical else "low_confidence",
            )
        return LookupResult(found=True, candidates=candidates)

    def lexical_rank(
        self, query: str, limit: int = DEFAULT_LOOKUP_LIMIT
    ) -> LookupResult:
        """spec §8.4 散文的字面读法：只要关键词得分 > 0 就取 top-k。

        **kb-mcp 没有这个行为**——它还有 OOV 折减、技术 token 覆盖度、中文覆盖度
        与 `CONFIDENCE_THRESHOLD` 四道闸门。本方法只用于量化"散文与实现的差距"
        （预注册 dispatch 读法 (b)），不得当作 kb-mcp 的行为。

        折减也不施加：spec 写的是"关键词命中打分"，没有提 OOV。
        """

        trimmed = query.strip()
        if not trimmed:
            return LookupResult(found=False, candidates=(), reason="empty_query")

        entries = self.load_index()
        if entries is None:
            return LookupResult(found=False, candidates=(), reason="index_missing")

        needle = trimmed.lower()
        ranked = [
            (entry, score_entry(entry, needle))
            for entry in entries
            if score_entry(entry, needle) > 0
        ]
        ranked.sort(key=lambda pair: (-pair[1], pair[0].path))
        candidates = tuple(
            LookupCandidate(
                path=entry.path, title=entry.title, summary=entry.summary, score=score
            )
            for entry, score in ranked[: max(0, limit)]
        )
        if not candidates:
            return LookupResult(found=False, candidates=(), reason="no_match")
        return LookupResult(found=True, candidates=candidates)

    def _walk_markdown(self) -> list[Path]:
        files: list[Path] = []
        if not self._root.is_dir():
            return files

        def visit(directory: Path) -> None:
            try:
                children = sorted(directory.iterdir(), key=lambda p: p.name)
            except OSError:
                return
            for child in children:
                if child.is_dir():
                    visit(child)
                    continue
                if child.is_file() and child.name.lower().endswith(".md"):
                    files.append(child)

        visit(self._root)
        return files

    def search(self, tokens: list[str], limit: int = DEFAULT_SEARCH_LIMIT) -> SearchResult:
        needles = [token.strip() for token in tokens if token.strip()]
        if not self._root.is_dir() or not needles:
            return SearchResult(found=False, hits=())

        hits: list[SearchHit] = []
        for file_path in self._walk_markdown():
            base = file_path.name
            if base in NAVIGATION_BASENAMES or base == INDEX_FILE:
                continue
            try:
                if not file_path.is_file() or file_path.stat().st_size > MAX_FILE_BYTES:
                    continue
                content = file_path.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue

            relative = file_path.relative_to(self._root).as_posix()
            lines = re.split(r"\r?\n", content)
            for index, raw in enumerate(lines):
                lower = raw.lower()
                # 空行不参与命中（对齐 kb-mcp 的 `if (lower === '') continue`）。
                if not lower:
                    continue
                for needle in needles:
                    if needle.lower() not in lower:
                        continue
                    context = "\n".join(
                        lines[max(0, index - 1) : min(len(lines), index + 2)]
                    )
                    hits.append(
                        SearchHit(
                            path=relative, line=index + 1, text=context, token=needle
                        )
                    )

        hits.sort(key=lambda hit: (hit.path, hit.line, hit.token))
        return SearchResult(found=bool(hits), hits=tuple(hits[: max(0, limit)]))
