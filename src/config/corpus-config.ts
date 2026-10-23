import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * 语料 OTA 的配置层：`corpus.json`（桶地址 + Ed25519 公钥）的读取与校验。
 *
 * **为什么要有配置而不是写死**：安装包公开分发，语料本身可以公开，但桶地址与
 * 公钥得能在不发版的前提下更换（运维改 `$HARNESS_HOME/corpus.json`），打包形态
 * 又要带一份构建时注入的默认值（`<resources>/corpus.json`）。
 *
 * **失败语义（契约 §2、R3）：不静默降级。** 文件存在但解析/校验失败时返回
 * `invalid` 并指出具体字段，**不**回落到下一级来源。否则用户改了 home 级配置，
 * 只因一个拼写错误就继续用打包时的旧地址，界面上还显示「已配置」——那正是
 * 被篡改/配置错误无从察觉的起点。只有「文件不存在」才轮到下一级。
 *
 * 这一层只读文件：不发网络请求、不建目录、不写文件。验签与下载属于 OTA
 * 客户端（契约 §6），不在这里。
 */

/** `corpus.json` 的 JSON 结构（契约 §2，字段名与格式不得改动）。 */
export interface CorpusConfig {
  /** 配置格式版本；目前只有 1。 */
  version: 1;
  /** 语料桶根地址，必须以 `/` 结尾：客户端直接拿它拼 `latest.json` 与相对路径。 */
  updateBaseUrl: string;
  /** Ed25519 公钥（SPKI PEM）。公钥不是秘密，可以随安装包分发。 */
  publicKeyPem: string;
}

/** 配置来自哪一级；设置页据此告诉用户该改哪个文件。 */
export type CorpusConfigSource = "home" | "resources";

/**
 * 加载结果。`invalid` 带着给用户看的中文短句（哪一个字段、错在哪），
 * 设置页原样展示；调用方不得把它折叠成「没有配置」。
 */
export type CorpusConfigLoadResult =
  | { kind: "ok"; config: CorpusConfig; source: CorpusConfigSource }
  | { kind: "none" }
  | { kind: "invalid"; reason: string; source: CorpusConfigSource };

export interface LoadCorpusConfigOptions {
  /** `$HARNESS_HOME`：用户/运维的运行时覆盖放这里，优先级最高。 */
  harnessHome: string;
  /** 打包形态的 `<安装目录>/resources`；开发形态没有这一级，不传。 */
  resourcesRoot?: string;
}

const CONFIG_FILE_NAME = "corpus.json";
const PEM_BEGIN = "-----BEGIN PUBLIC KEY-----";
const PEM_END = "-----END PUBLIC KEY-----";

type Validation = { ok: true; config: CorpusConfig } | { ok: false; reason: string };

/** 内部哨兵：这一级没有文件，可以继续看下一级；它不是对外的 `kind`。 */
type SourceAttempt = CorpusConfigLoadResult | { kind: "missing" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeValue(value: unknown): string {
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 去掉 UTF-8 BOM。Windows 上记事本与部分构建脚本会写出 BOM，而 `JSON.parse`
 * 见到它会直接抛 SyntaxError，于是「手写的配置」会被报成「JSON 有语法错误」，
 * 排查方向完全错。用码点判断而不是正则字面量，避免源码里出现不可见的 U+FEFF
 * （既有做法见 `src/mcp/config.ts` 的 `readJsonFile`）。
 */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * 校验已解析的 JSON 对象。
 *
 * 每条失败信息都必须点名**具体字段**：设置页只有一行位置，说「配置无效」等于
 * 什么都没说（R3）。这里只做结构校验——公钥能否真的验签是 T2 的事，配置层
 * 重复解析一遍密钥只会让两处判断悄悄分叉。
 */
function validateCorpusConfig(value: unknown, filePath: string): Validation {
  if (!isRecord(value)) {
    return { ok: false, reason: `${filePath} 的顶层必须是 JSON 对象` };
  }

  if (value.version !== 1) {
    return {
      ok: false,
      reason: `${filePath} 的 version 必须是 1（实际为 ${describeValue(value.version)}）`,
    };
  }

  const updateBaseUrl = value.updateBaseUrl;
  if (typeof updateBaseUrl !== "string" || updateBaseUrl.trim() === "") {
    return { ok: false, reason: `${filePath} 的 updateBaseUrl 必须是非空字符串` };
  }
  let parsed: URL;
  try {
    parsed = new URL(updateBaseUrl);
  } catch {
    return {
      ok: false,
      reason: `${filePath} 的 updateBaseUrl 必须是绝对 URL（如 https://example.invalid/kb/）`,
    };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      reason: `${filePath} 的 updateBaseUrl 只支持 http/https，实际是 ${parsed.protocol}`,
    };
  }
  if (!updateBaseUrl.endsWith("/")) {
    // 不是风格要求：客户端把 base 与 "latest.json" 直接拼接，少一个斜杠就会
    // 请求到同级的另一个路径，症状是 404 而不是配置错误，极难排查。
    return {
      ok: false,
      reason: `${filePath} 的 updateBaseUrl 必须以 "/" 结尾（客户端要把它和 latest.json 直接拼接）`,
    };
  }

  const publicKeyPem = value.publicKeyPem;
  if (typeof publicKeyPem !== "string" || publicKeyPem.trim() === "") {
    return { ok: false, reason: `${filePath} 的 publicKeyPem 必须是非空字符串` };
  }
  if (!publicKeyPem.includes(PEM_BEGIN) || !publicKeyPem.includes(PEM_END)) {
    return {
      ok: false,
      reason: `${filePath} 的 publicKeyPem 不是 PEM 公钥：缺少 ${PEM_BEGIN} 或 ${PEM_END} 标记`,
    };
  }

  return { ok: true, config: { version: 1, updateBaseUrl, publicKeyPem } };
}

/**
 * 尝试某一级来源。只有 ENOENT 算「这一级不存在」；其余读取失败（EACCES、EISDIR、
 * 路径被占用……）一律报 invalid——把它们当作「没有配置」会让一个权限问题伪装成
 * 「从未配置」，两种状态的处置方式完全不同。
 */
async function attemptSource(filePath: string, source: CorpusConfigSource): Promise<SourceAttempt> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "missing" };
    }
    return { kind: "invalid", source, reason: `${filePath} 读取失败：${errorMessage(error)}` };
  }

  let value: unknown;
  try {
    // 手写配置无法加注释，很容易带上 BOM；不剥掉的话「能看见内容」的文件会被
    // 报成 JSON 语法错误，把用户引向错误的排查方向。
    value = JSON.parse(stripBom(text)) as unknown;
  } catch (error) {
    return {
      kind: "invalid",
      source,
      reason: `${filePath} 不是合法的 JSON（解析失败：${errorMessage(error)}）`,
    };
  }

  const validation = validateCorpusConfig(value, filePath);
  if (!validation.ok) {
    return { kind: "invalid", source, reason: validation.reason };
  }
  return { kind: "ok", config: validation.config, source };
}

/**
 * 按优先级读取配置：`$HARNESS_HOME/corpus.json` → `<resourcesRoot>/corpus.json` → 无。
 *
 * 返回判别联合而不是抛异常或返回 null：调用方（OTA 客户端、设置页）必须能区分
 * 「没有配置」「配置坏了」「读到了」三种情况，且后者带着可展示的原因。
 */
export async function loadCorpusConfig(
  opts: LoadCorpusConfigOptions,
): Promise<CorpusConfigLoadResult> {
  const homeResult = await attemptSource(
    path.join(opts.harnessHome, CONFIG_FILE_NAME),
    "home",
  );
  if (homeResult.kind !== "missing") {
    return homeResult;
  }

  if (opts.resourcesRoot !== undefined) {
    const resourcesResult = await attemptSource(
      path.join(opts.resourcesRoot, CONFIG_FILE_NAME),
      "resources",
    );
    if (resourcesResult.kind !== "missing") {
      return resourcesResult;
    }
  }

  return { kind: "none" };
}
