import { createHash, sign, verify } from "node:crypto";
import { createReadStream } from "node:fs";

/**
 * 语料清单（`latest.json`）的规范 JSON、结构校验与 Ed25519 验签——契约见
 * `docs/corpus-ota.md` §4/§6。
 *
 * 这一层解决的**唯一**问题：让「发布侧签的字节」与「客户端验的字节」逐字节相同。
 * 语料原文会直接进模型上下文，被篡改的语料不是解析错误而是提示注入（撞 R1/R2/R3），
 * 而 sha256 清单挡不住——能改文件的人也能改清单。签名挡得住，因为私钥不在桶里。
 *
 * 三条贯穿全文件的规则：
 *
 * 1. **签名侧与验签侧必须共用同一份代码**（`canonicalize` + `payloadOf`）。
 *    各写一份的后果不是「明显报错」，而是「签名能生成、验证永远失败」——两边都
 *    自洽，只有合起来才错，属于最难查的一类故障。所以这两个函数是私有的，
 *    对外只暴露成对的 `signManifestPayload` / `verifyManifestSignature`。
 *
 * 2. **失败要说清楚是哪一条、哪个字段、哪个 path**（R3）。清单校验失败会原样
 *    显示在设置页，只说「清单无效」等于什么都没说，用户没有任何修复线索。
 *
 * 3. **验签不抛错，只返回 false**。调用方要靠这个布尔值区分「验签失败」并如实
 *    上报 `verify_failed`；若它抛异常，一次坏的远端清单就能把检查流程变成崩溃，
 *    状态反而说不出口。
 */

/** 清单条目：语料文件相对路径 + 内容摘要。 */
export interface ManifestFile {
  /** POSIX 相对路径，如 `protocols/uart/no-output.md`。 */
  path: string;
  /** 文件内容的 sha256，64 位小写十六进制。 */
  sha256: string;
}

/** 契约 §4 的 `latest.json`，字段名与格式不得改动。 */
export interface CorpusManifest {
  /** 清单格式版本；目前只有 1。 */
  manifestVersion: 1;
  /** 内容版本（与 `index.yaml` 的 schema 版本无关），单调递增整数。 */
  corpusVersion: number;
  /** 发布时间，带时区的 ISO 8601 字符串。 */
  publishedAt: string;
  /** 全部受管语料文件；顺序参与签名，不得随意重排。 */
  files: ManifestFile[];
  /** base64(Ed25519(canonicalPayload))。 */
  signature: string;
}

export type CorpusManifestErrorCode = "corpus_manifest_invalid";

export class CorpusManifestError extends Error {
  readonly code: CorpusManifestErrorCode = "corpus_manifest_invalid";
  readonly detail?: unknown;

  constructor(message: string, detail?: unknown) {
    super(message);
    this.name = "CorpusManifestError";
    this.detail = detail;
  }
}

/** 版本比较结果，直接对应契约 §6 的三个分支。 */
export type VersionComparison = "up_to_date" | "update_available" | "rollback_rejected";

/** 顶层允许出现的字段。多一个都拒绝——签名覆盖范围必须是确定的。 */
const MANIFEST_FIELDS: ReadonlySet<string> = new Set([
  "manifestVersion",
  "corpusVersion",
  "publishedAt",
  "files",
  "signature",
]);

/** 文件条目允许出现的字段。 */
const FILE_FIELDS: ReadonlySet<string> = new Set(["path", "sha256"]);

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * 带时区的 ISO 8601。必须带 `Z` 或 `±HH:MM`：`2026-10-23T12:00:00` 这种写法
 * 会被 `Date.parse` 当成**本机时区**，同一份清单在不同机器上指向不同时刻。
 * 时刻本身不参与验签（签的是字符串），但清单是给人看的运维事实，含糊即失真。
 */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** 标准 base64（含正确的 `=` 补齐）；空串不匹配。 */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** 只允许这两种扩展名：语料只有 markdown 与 yaml 两种正文。 */
const ALLOWED_EXTENSIONS = [".md", ".yaml"] as const;

/** 本地沉淀，永不进快照、永不被覆盖（契约 §3/§4），因此也不得出现在清单里。 */
const INBOX_FILE_NAME = "_inbox.md";
const REVIEWED_FILE_NAME = "_reviewed.md";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invalid(message: string, detail?: unknown): CorpusManifestError {
  return new CorpusManifestError(message, detail);
}

function constructorNameOf(object: object): string {
  const name = (object as { constructor?: { name?: unknown } }).constructor?.name;
  return typeof name === "string" && name !== "" ? name : "未知类型";
}

// ---------------------------------------------------------------------------
// 规范 JSON
// ---------------------------------------------------------------------------

/**
 * 规范 JSON：对象键按字典序递归排序、无可选空白、UTF-8。
 *
 * 为什么不能直接用 `JSON.stringify`：键序取决于插入顺序，同一个对象由不同代码
 * 路径构造出来就是不同字节，签名与验签必然对不上。排序把「内容相同」变成
 * 「字节相同」，签名才有意义。
 *
 * 为什么无法序列化的值要抛错而不是跳过：`JSON.stringify({a: undefined})` 得到
 * `"{}"`——键被静默丢弃，签名字节覆盖的内容与调用方以为的内容不是一回事。
 * 那正是「验签通过但内容被改过」的温床，所以这里一律抛错，宁可发布脚本当场失败。
 * 同一类问题还有 `NaN`/`Infinity`（被写成 `null`）、数组空位（变成 `null`）。
 *
 * 只接受普通对象与数组：`Date`、`Map`、`Buffer` 的序列化结果依赖具体实现或
 * 调用方的 `toJSON`，把它们放进签名载荷等于把字节交给运气。需要时间的调用方
 * 应自己先转成 ISO 字符串。
 */
export function canonicalize(value: unknown): string {
  return encodeCanonical(value, "$", new Set<object>());
}

function describeLocation(where: string): string {
  return where === "$" ? "顶层" : `位置 ${where}`;
}

function encodeCanonical(value: unknown, where: string, stack: Set<object>): string {
  if (value === null) return "null";

  const kind = typeof value;
  if (kind === "string") return JSON.stringify(value);
  if (kind === "boolean") return value === true ? "true" : "false";
  if (kind === "number") {
    if (!Number.isFinite(value)) {
      // JSON.stringify 会把 NaN/Infinity 写成 null，属于静默改内容。
      throw invalid(
        `规范 JSON 不支持非有限数字 ${String(value)}（${describeLocation(where)}）：它会被序列化成 null，签名字节就与内容不符了`,
      );
    }
    return JSON.stringify(value);
  }
  if (kind !== "object") {
    throw invalid(
      `规范 JSON 不支持 ${kind} 类型的值（${describeLocation(where)}）：它会被序列化静默丢弃，签名字节就与内容不符了`,
    );
  }

  const object = value as object;
  if (stack.has(object)) {
    throw invalid(`规范 JSON 不支持循环引用（${describeLocation(where)}）`);
  }
  stack.add(object);
  try {
    if (Array.isArray(object)) {
      // 数组顺序是内容的一部分：调换 files 顺序必须改变字节（并有测试守着）。
      const parts: string[] = [];
      for (let index = 0; index < object.length; index += 1) {
        parts.push(encodeCanonical(object[index], `${where}[${index}]`, stack));
      }
      return `[${parts.join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(object) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw invalid(
        `规范 JSON 只接受普通对象与数组，收到 ${constructorNameOf(object)}（${describeLocation(where)}）`,
      );
    }

    const record = object as Record<string, unknown>;
    // 默认 sort 按 UTF-16 码元比较。键名由我们自己生成（ASCII），且签名与验签
    // 共用这一个函数，所以「字典序」的具体口径只要稳定即可。
    const keys = Object.keys(record).sort();
    const parts = keys.map(
      (key) => `${JSON.stringify(key)}:${encodeCanonical(record[key], `${where}.${key}`, stack)}`,
    );
    return `{${parts.join(",")}}`;
  } finally {
    // 只把「当前递归路径」上的对象视为循环；同一个对象出现在两个兄弟位置是合法的。
    stack.delete(object);
  }
}

// ---------------------------------------------------------------------------
// base64
// ---------------------------------------------------------------------------

/**
 * 严格解码 base64；不合法或非规范写法返回 null。
 *
 * `Buffer.from(text, "base64")` 极其宽松：非法字符被忽略、多余的尾部位被丢弃，
 * 于是 `"Y Q = ="` 与 `"YQ=="` 解出同一串字节。签名是可公开比对的值，同一份
 * 签名有多种字符串写法会让「清单是否被改过」的讨论失去意义，所以这里要求
 * 「重新编码后与原文完全相同」。
 */
function decodeBase64Strict(text: string): Buffer | null {
  // 空串由 BASE64 的 `*`/可选尾部放行，必须单独挡掉。
  if (text === "" || !BASE64.test(text)) return null;
  // 走到这里的字符串长度必为 4 的倍数且 ≥ 4（空串已被上面挡掉），
  // 至少解出 1 字节，所以不需要再判 `bytes.length === 0`。
  const bytes = Buffer.from(text, "base64");
  return bytes.toString("base64") === text ? bytes : null;
}

// ---------------------------------------------------------------------------
// 路径校验
// ---------------------------------------------------------------------------

/**
 * 校验语料相对路径，返回原字符串（不做任何归一化——归一化会让「清单里写的」
 * 与「磁盘上读的」出现两个名字）。
 *
 * 拒绝清单（每一条都对应一种真实事故）：
 * - 反斜杠：Windows 风格的路径在 POSIX 语义下是一个普通文件名字符，
 *   放过去就会在磁盘上造出 `a\b.md` 这种跨平台不可移植的文件；
 * - 绝对路径与 `C:` 盘符：拼接后会把下载写到 `snapshots/` 之外；
 * - 空段（`a//b.md`、`/x.md`、`a/b.md/`）：不指向确定的文件；
 * - `..`：路径穿越，`../etc/passwd` 会落到语料根之外；
 * - `.`：它不是文件，且会让 `./index.yaml` 与 `index.yaml` 成为两条不同条目，
 *   从而绕过「path 不得重复」的检查（同一文件两条记录、两个 sha256）；
 * - 扩展名不是 `.md`/`.yaml`：语料只有这两种正文，别的类型进上下文没有意义。
 *   大小写敏感是刻意的：Windows 上 `X.MD` 与 `x.md` 是同一个文件，
 *   容忍大写就等于允许同一文件出现两条互相矛盾的记录。
 */
function validateRelativePath(value: unknown, where: string): string {
  if (typeof value !== "string") {
    throw invalid(`清单 ${where} 必须是字符串（实际为 ${describeValue(value)}）`);
  }
  if (value === "") {
    throw invalid(`清单 ${where} 不能是空路径`);
  }
  if (value.includes("\\")) {
    throw invalid(`清单 ${where} 含反斜杠，必须用 POSIX 风格的 "/"：${value}`);
  }
  if (value.startsWith("/")) {
    throw invalid(`清单 ${where} 必须是相对路径，不能是绝对路径：${value}`);
  }
  if (/^[A-Za-z]:/.test(value)) {
    throw invalid(`清单 ${where} 必须是相对路径，不能带盘符：${value}`);
  }
  if (value.includes("\0")) {
    throw invalid(`清单 ${where} 含 NUL 字符：${JSON.stringify(value)}`);
  }

  const segments = value.split("/");
  for (const segment of segments) {
    if (segment === "") {
      throw invalid(`清单 ${where} 含空路径段（连续 "/"、开头或结尾的 "/"）：${value}`);
    }
    if (segment === ".") {
      throw invalid(`清单 ${where} 含 "." 路径段：${value}`);
    }
    if (segment === "..") {
      throw invalid(`清单 ${where} 含 ".." 路径段（路径穿越）：${value}`);
    }
  }

  const fileName = segments[segments.length - 1]!;
  const extension = ALLOWED_EXTENSIONS.find((candidate) => fileName.endsWith(candidate));
  if (extension === undefined) {
    throw invalid(`清单 ${where} 的扩展名只允许 .md 与 .yaml：${value}`);
  }
  if (fileName.length === extension.length) {
    // 形如 `.md` 的文件名去掉扩展名后为空，是手滑而不是语料。
    throw invalid(`清单 ${where} 缺少文件名（只有扩展名）：${value}`);
  }

  return value;
}

function baseNameOf(relativePath: string): string {
  const index = relativePath.lastIndexOf("/");
  return index === -1 ? relativePath : relativePath.slice(index + 1);
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

/**
 * 严格校验并返回一份**新的**清单对象，失败抛 `CorpusManifestError`。
 *
 * 返回值只含已知字段：即便调用方把原始 JSON 对象直接递进来，验签时用到的
 * 也只会是这份规范化后的对象，不可能有字段从旁边溜进或溜出签名覆盖范围。
 *
 * 顶层与文件条目都拒绝未知字段。理由同契约 §4 的「签名覆盖范围必须确定」：
 * 发布脚本（T9）与客户端（T6）对「哪些字段存在」必须有完全一致的理解，
 * 多出来的字段要么被一方忽略、要么被另一方纳入字节，两种都会变成对不上的清单。
 */
export function parseManifest(raw: unknown): CorpusManifest {
  if (!isRecord(raw)) {
    throw invalid(`清单顶层必须是 JSON 对象（实际为 ${describeValue(raw)}）`);
  }

  const unknownFields = Object.keys(raw).filter((field) => !MANIFEST_FIELDS.has(field));
  if (unknownFields.length > 0) {
    throw invalid(
      `清单出现未知顶层字段 ${unknownFields.join("、")}：签名覆盖范围必须确定，发布侧与验证侧不得各理解一套字段`,
    );
  }

  if (raw.manifestVersion !== 1) {
    throw invalid(
      `清单的 manifestVersion 必须是 1（实际为 ${describeValue(raw.manifestVersion)}）`,
    );
  }

  const corpusVersion = raw.corpusVersion;
  if (
    typeof corpusVersion !== "number"
    || !Number.isSafeInteger(corpusVersion)
    || corpusVersion < 1
  ) {
    throw invalid(
      `清单的 corpusVersion 必须是 ≥ 1 的整数（实际为 ${describeValue(corpusVersion)}）`,
    );
  }

  const publishedAt = raw.publishedAt;
  if (
    typeof publishedAt !== "string"
    || !ISO_TIME.test(publishedAt)
    || Number.isNaN(Date.parse(publishedAt))
  ) {
    throw invalid(
      `清单的 publishedAt 必须是带时区的 ISO 8601 时间（如 2026-10-23T12:00:00Z），实际为 ${describeValue(publishedAt)}`,
    );
  }

  const rawFiles = raw.files;
  if (!Array.isArray(rawFiles)) {
    throw invalid(`清单的 files 必须是数组（实际为 ${describeValue(rawFiles)}）`);
  }

  const files: ManifestFile[] = [];
  const seen = new Map<string, number>();
  for (let index = 0; index < rawFiles.length; index += 1) {
    const entry: unknown = rawFiles[index];
    const where = `files[${index}]`;
    if (!isRecord(entry)) {
      throw invalid(`清单 ${where} 必须是对象（实际为 ${describeValue(entry)}）`);
    }

    const unknownEntryFields = Object.keys(entry).filter((field) => !FILE_FIELDS.has(field));
    if (unknownEntryFields.length > 0) {
      throw invalid(`清单 ${where} 出现未知字段 ${unknownEntryFields.join("、")}`);
    }

    const filePath = validateRelativePath(entry.path, `${where}.path`);
    // 名单与 `mcp-servers/kb/inbox.ts` 的 `MANAGED_CORPUS_EXCLUDES` 必须一致。
    // 两份常量不能互相 import（MCP server 不能引内核，见 D-086），所以这里
    // 再写一遍——发布侧跳过什么，验证侧就得拒什么，否则「跳过但不拒」会让
    // 这些文件悄悄混进清单而不被任何人发现。
    const baseName = baseNameOf(filePath);
    if (baseName === INBOX_FILE_NAME || baseName === REVIEWED_FILE_NAME) {
      throw invalid(
        `清单 ${where} 指向 ${baseName}（${filePath}）：本地沉淀与审核记录永不进快照，也不得进清单`,
      );
    }

    const sha256 = entry.sha256;
    if (typeof sha256 !== "string" || !SHA256_HEX.test(sha256)) {
      throw invalid(
        `清单 ${where}（${filePath}）的 sha256 必须是 64 位小写十六进制（实际为 ${describeValue(sha256)}）`,
      );
    }

    const firstIndex = seen.get(filePath);
    if (firstIndex !== undefined) {
      throw invalid(`清单里 path 重复：${filePath}（files[${firstIndex}] 与 ${where}）`);
    }
    seen.set(filePath, index);

    files.push({ path: filePath, sha256 });
  }

  const signature = raw.signature;
  if (typeof signature !== "string" || decodeBase64Strict(signature) === null) {
    throw invalid(
      `清单的 signature 必须是非空的标准 base64 字符串（实际为 ${describeValue(signature)}）`,
    );
  }

  return {
    manifestVersion: 1,
    corpusVersion,
    publishedAt,
    files,
    signature,
  };
}

// ---------------------------------------------------------------------------
// 签名 / 验签
// ---------------------------------------------------------------------------

/**
 * 签名载荷：manifest 去掉 `signature` 键之后的全部字段。
 *
 * **不是** `{...manifest, signature: null}`——那会把 `"signature":null` 的字节
 * 也签进去，与「去掉签名再签」得到的字节完全不同。两种做法各写一半，
 * 症状就是签名永远验不过。
 *
 * 这里逐字段显式拷贝而不是 `const { signature, ...rest }`：载荷范围必须是
 * **写死的五个字段减一个**，而不是「调用方传进来的所有键」。两者在
 * `parseManifest` 的产物上等价（它已经拒绝了未知字段），但显式拷贝保证
 * 即便有人绕过 `parseManifest` 直接构造对象，多出来的键也不会悄悄进入
 * 签名覆盖范围。
 */
function payloadOf(manifest: CorpusManifest): Omit<CorpusManifest, "signature"> {
  return {
    manifestVersion: manifest.manifestVersion,
    corpusVersion: manifest.corpusVersion,
    publishedAt: manifest.publishedAt,
    files: manifest.files,
  };
}

/**
 * 对「除 signature 外所有字段」的规范 JSON 做 Ed25519 签名，返回 base64。
 *
 * 只在离线发布机上调用（契约 §8）：私钥绝不进仓库、不进 CI。
 * 密钥无法解析时直接抛错——发布侧需要的是当场失败，而不是一个空签名。
 */
export function signManifestPayload(manifest: CorpusManifest, privateKeyPem: string): string {
  const payload = canonicalize(payloadOf(manifest));
  // Ed25519 是「无预哈希」签名算法，第一个参数必须是 null，否则 Node 会按
  // 指定的摘要算法再算一层，与标准 Ed25519 互不兼容。
  const signature = sign(null, Buffer.from(payload, "utf8"), privateKeyPem);
  return signature.toString("base64");
}

/**
 * 验签。**任何异常都返回 false，绝不抛错**。
 *
 * 调用方（OTA 客户端、设置页）要根据这个布尔值区分「验签失败」并如实显示
 * `verify_failed` + 原因。若这里抛错，一份坏的远端清单就能把「检查更新」
 * 变成崩溃，状态反而报不出来（R3 要求的是如实上报，不是中断）。
 *
 * payload 与签名侧走同一个 `canonicalize(payloadOf(...))`，两边不可能各算一套。
 */
export function verifyManifestSignature(
  manifest: CorpusManifest,
  publicKeyPem: string,
): boolean {
  try {
    if (!isRecord(manifest)) return false;
    const signature = decodeBase64Strict(manifest.signature);
    if (signature === null) return false;
    const payload = canonicalize(payloadOf(manifest));
    return verify(null, Buffer.from(payload, "utf8"), publicKeyPem, signature);
  } catch {
    // 密钥格式错、签名长度错、payload 里有无法序列化的值……一律按「验不过」处理。
    return false;
  }
}

// ---------------------------------------------------------------------------
// 版本与差异
// ---------------------------------------------------------------------------

function assertVersion(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    // compareVersions 里若放过 NaN，两个比较都是 false，会静默落进
    // "up_to_date"——把「版本号坏了」显示成「已是最新」，正是 R3 禁止的。
    throw new Error(`${name} 必须是非负整数（实际为 ${String(value)}）`);
  }
}

/**
 * 防回滚：`remote < local` 一律拒绝。
 *
 * 攻击者即使拿不到私钥，也能把桶里的 `latest.json` 换成一个**旧的、签名合法**
 * 的版本，从而把语料退回到含已知提示注入的版本。版本单调递增是这条防线的全部依据。
 */
export function compareVersions(local: number, remote: number): VersionComparison {
  assertVersion("本地语料版本", local);
  assertVersion("远端语料版本", remote);
  if (remote < local) return "rollback_rejected";
  if (remote > local) return "update_available";
  return "up_to_date";
}

/**
 * 需要下载的文件：sha256 变化的 + 新增的，顺序沿用清单顺序（可复现）。
 *
 * **不返回被删除的文件**：快照是整目录替换，删除由「切 current 指针」一步完成
 * （契约 §3/§6），不需要也不应该逐个删文件——半成品目录里少一个文件是正常中间态。
 *
 * 返回新对象，调用方改动不会波及传入的清单。
 */
export function diffFiles(
  current: ManifestFile[] | null,
  target: CorpusManifest,
): ManifestFile[] {
  if (current === null) {
    return target.files.map((file) => ({ path: file.path, sha256: file.sha256 }));
  }

  const known = new Map<string, string>();
  for (const file of current) {
    known.set(file.path, file.sha256);
  }

  const changed: ManifestFile[] = [];
  for (const file of target.files) {
    if (known.get(file.path) === file.sha256) continue;
    changed.push({ path: file.path, sha256: file.sha256 });
  }
  return changed;
}

/**
 * 流式计算文件 sha256，返回小写 hex。
 *
 * 按流读而不是 `readFile`：接口一旦按「整个读进内存」写死，换成大语料时就会在
 * 用户的机器上 OOM，而那时改接口已经晚了。当前语料很小，但代价只是一个循环。
 *
 * 失败必须抛错（R3）：文件读不到就是读不到，不能返回空串或全 0——那会让上层
 * 把「校验没做成」当成「校验通过」。
 */
export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(filePath)) {
      hash.update(chunk as Buffer);
    }
  } catch (error) {
    throw new Error(`文件校验值计算失败：${filePath}（${messageOf(error)}）`, { cause: error });
  }
  return hash.digest("hex");
}
