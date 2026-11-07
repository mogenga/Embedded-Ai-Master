import { createHash } from "node:crypto";

const MAX_KEYS = 32;
const MAX_KEY_CODE_POINTS = 100;
const MAX_STRING_CODE_POINTS = 120;
const MAX_PREVIEW_BYTES = 4096;
// 保留键不能叫 "truncated":模型可以提交同名参数,否则标记会覆盖真实值(D-119)。
const TRUNCATED_ENTRY = ',"previewTruncated":true';

// 参数对象的键由模型控制:含自有 __proto__ 时,普通赋值会命中原型 setter,
// 导致该键从摘要与哈希中消失(D-118)。defineProperty 保证写入自有属性。
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function truncateCodePoints(value: string, limit: number): string {
  const codePoints = Array.from(value);
  if (codePoints.length <= limit) return value;
  return codePoints.slice(0, limit).join("");
}

function normalize(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null) return null;

  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : `[non-finite:${String(value)}]`;
    case "bigint":
      return `[bigint:${value.toString()}]`;
    case "undefined":
      return undefined;
    case "function":
      return "[function]";
    case "symbol":
      return `[symbol:${String(value)}]`;
  }

  const object = value as object;
  if (seen.has(object)) return "[circular]";
  seen.add(object);
  try {
    if (Array.isArray(object)) {
      return object.map((item) => normalize(item, seen));
    }
    if (object instanceof Date) {
      return Number.isNaN(object.getTime()) ? "[date:Invalid]" : object.toISOString();
    }
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(object).sort()) {
      const item = normalize((object as Record<string, unknown>)[key], seen);
      if (item !== undefined) setOwn(sorted, key, item);
    }
    return sorted;
  } finally {
    seen.delete(object);
  }
}

export function stableStringify(value: unknown): string {
  const normalized = normalize(value, new WeakSet<object>());
  return JSON.stringify(normalized) ?? "undefined";
}

export function digestParams(args: unknown): string {
  return createHash("sha256").update(stableStringify(args), "utf8").digest("hex").slice(0, 16);
}

/**
 * 敏感键词表:命中就把**值**换成脱敏标记(键名保留)。
 *
 * 判据是「键名按分隔符与大小写边界切词后整词命中」,不是 `includes`:
 * `monkey` / `keyboard` 切出的是一整个词,命中不了 `key`;`author` 也不是
 * `auth`。键名保留的理由:`paramsKeys` 本来就列全名,脱敏键名不增加任何
 * 保护,却会让审计失去「这条决策对应哪个参数」的对照。
 *
 * 分两档是因为这两类词做**前缀**时的含义不同:
 *
 * - `SENSITIVE_ANY_WORD` 出现在任意位置都脱敏。它们做修饰语时仍是凭据本身:
 *   `passwordHash`、`clientSecret`、`authHeader`、`sessionToken`。
 * - `SENSITIVE_EDGE_WORD` 只作为**最后一个词**(或整个键名)时脱敏。
 *   `session` / `key` / `token` 做前缀时多是标识或计数——`sessionId`、
 *   `keyCount`、`tokenLimit`——遮掉它们只会让审批卡看不出「操作哪个会话、
 *   要写多少」;做后缀时(`apiKey`、`access-token`、`session`)才是凭据。
 *
 * 复数不是无脑收录的:`keys` / `secrets` / `credentials` / `passwords` /
 * `cookies` 仍指凭据本身;`tokens` 在本仓库是正当参数
 * (`mcp-servers/kb/tools.ts` 的 `kb_search(tokens, limit?)`:要检索的词表),
 * 刻意**不**在表内——命中它会把一次正常检索的参数遮掉。
 */
const SENSITIVE_ANY_WORD: ReadonlySet<string> = new Set([
  "secret",
  "secrets",
  "password",
  "passwords",
  "passwd",
  "credential",
  "credentials",
  "authorization",
  "auth",
  "authentication",
  "apikey",
  "private",
  "cookie",
  "cookies",
]);

const SENSITIVE_EDGE_WORD: ReadonlySet<string> = new Set(["key", "keys", "token", "session"]);

/**
 * 计数名词:键名的**最后一个词**是它时一律不脱敏。
 *
 * `tokenCount` / `maxTokens` / `keyCount` / `passwordLength` 这类参数是规模,
 * 不是凭据;遮掉它们泄露不了任何内容,却让审批卡看不出「这一批要写多少、
 * 检索多少」。
 */
const COUNT_WORDS: ReadonlySet<string> = new Set([
  "count",
  "counts",
  "limit",
  "limits",
  "length",
  "size",
  "num",
  "number",
  "total",
  "max",
  "min",
]);

/**
 * 把键名切成小写单词。
 *
 * 先在小写/数字与大写之间、全大写缩写与其后的驼峰词之间插空格,再按非字母数字
 * 切开——于是 `API_KEY`、`apiKey`、`x-api-key`、`APIKey` 都得到 `api` + `key`。
 */
function splitKeyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "");
}

function isSensitiveKey(key: string): boolean {
  const words = splitKeyWords(key);
  if (words.length === 0) return false;
  const last = words[words.length - 1]!;
  if (COUNT_WORDS.has(last)) return false;
  if (words.some((word) => SENSITIVE_ANY_WORD.has(word))) return true;
  return SENSITIVE_EDGE_WORD.has(last);
}

function codePointLength(value: string): number {
  let length = 0;
  for (const _ of value) length += 1;
  return length;
}

/**
 * 敏感键的取值标记。
 *
 * 格式选 `[redacted:<形状>]`:
 *
 * - 方括号是本文件既有的「这是摘要、不是数据」约定(`[non-finite:…]`、
 *   `[bigint:…]`、`[function]`),审阅者不必学第二套样式;
 * - `redacted` 明说内容被移除——不能换成 `undefined` 或空串,那读起来像
 *   「参数没传」,审计就会替一次调用谎报它的形状(R3);
 * - 后缀只保留类型与规模(字符串码点数、数组元素数、对象键数)。长度本身
 *   不泄露内容,却能让人判断「这里本来有个 42 字符的字符串」,从而确认
 *   卡片上这条调用是不是自己以为的那一条。刻意不保留前缀字符:前几位
 *   往往正是可辨识的密钥前缀(`sk-`、`ghp_`)。
 */
function redactedMarker(value: unknown): string {
  if (value === null) return "[redacted:null]";
  switch (typeof value) {
    case "string":
      return `[redacted:string:${String(codePointLength(value))}]`;
    case "number":
      return "[redacted:number]";
    case "boolean":
      return "[redacted:boolean]";
    case "undefined":
      return "[redacted:undefined]";
    case "bigint":
      return "[redacted:bigint]";
    case "function":
      return "[redacted:function]";
    case "symbol":
      return "[redacted:symbol]";
  }
  // 走到这里只剩对象:数组给元素数,其余(含 Date)给自有键数,都不含内容。
  if (Array.isArray(value)) return `[redacted:array:${String(value.length)}]`;
  return `[redacted:object:${String(Object.keys(value as object).length)}]`;
}

function summarizeValue(value: unknown): unknown {
  if (value === null) return null;

  switch (typeof value) {
    case "string":
      return truncateCodePoints(value, MAX_STRING_CODE_POINTS);
    case "number":
      return Number.isFinite(value) ? value : `[non-finite:${String(value)}]`;
    case "boolean":
      return value;
    case "undefined":
      return "[undefined]";
    case "bigint":
      return `[bigint:${value.toString()}]`;
    case "function":
      return "[function]";
    case "symbol":
      return `[symbol:${String(value)}]`;
  }

  if (Array.isArray(value)) return { type: "array", size: value.length };
  return { type: "object", size: Object.keys(value as object).length };
}

function utf8ByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function summarizeParams(args: unknown): {
  keys: string[];
  preview?: Record<string, unknown>;
} {
  if (!isPlainRecord(args)) return { keys: [] };

  const sourceKeys = Object.keys(args).sort();
  const entries = sourceKeys.slice(0, MAX_KEYS).map((sourceKey) => {
    const displayKey = truncateCodePoints(sourceKey, MAX_KEY_CODE_POINTS);
    // 脱敏在 summarizeValue 的产物上替换:标记照样计入 4096 字节预算,
    // previewTruncated 的语义与裁剪顺序都不变。
    const value = summarizeValue(args[sourceKey]);
    return [
      displayKey,
      isSensitiveKey(sourceKey) ? redactedMarker(args[sourceKey]) : value,
    ] as const;
  });
  const keys = entries.map(([key]) => key);

  const preview: Record<string, unknown> = {};
  for (const [key, value] of entries) setOwn(preview, key, value);

  if (sourceKeys.length <= MAX_KEYS && utf8ByteLength(preview) <= MAX_PREVIEW_BYTES) {
    return { keys, preview };
  }

  const reservedBudget = MAX_PREVIEW_BYTES - Buffer.byteLength(TRUNCATED_ENTRY, "utf8");
  const truncatedPreview: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    const candidate = { ...truncatedPreview };
    setOwn(candidate, key, value);
    if (utf8ByteLength(candidate) > reservedBudget) break;
    setOwn(truncatedPreview, key, value);
  }
  setOwn(truncatedPreview, "previewTruncated", true);

  return { keys, preview: truncatedPreview };
}
