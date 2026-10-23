import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CorpusConfig } from "../config/corpus-config.js";
import {
  compareVersions,
  diffFiles,
  parseManifest,
  sha256File,
  verifyManifestSignature,
} from "./manifest.js";
import type { CorpusManifest, ManifestFile } from "./manifest.js";
import {
  CorpusLockError,
  ensureSnapshotDir,
  getKbLayout,
  pruneSnapshots,
  readCurrentVersion,
  readState,
  setCurrent,
  withUpdateLock,
  writeState,
} from "./snapshot.js";
import type { CorpusState, KbLayout } from "./snapshot.js";

/**
 * 语料 OTA 客户端：检查 → 验签 → 版本比较 → 下载变更文件 → 校验 → 切指针。
 * 契约见 `docs/corpus-ota.md` §6（流程）与 §6.1（HTTP 状态语义）。
 *
 * 三条贯穿全文件的规则：
 *
 * 1. **HTTP 传输失败与内容校验失败分开报**。网络错误、超时、非 200 状态属于
 *    `check_failed`（可以重试、可以换网络）；拿到了 200 但内容不是合法清单、
 *    结构不合格、签名对不上属于 `verify_failed`（重试没用，要查发布侧或怀疑篡改）。
 *    两者的用户动作完全不同，混成一个状态等于把「网络不好」和「清单可能被改过」
 *    说成同一件事。
 *
 * 2. **403 绝不等于「已是最新」**（契约 §6.1，实测结论）。华为云 OBS 只授予
 *    `GetObject`、不授予 `ListBucket` 时，**不存在的对象返回 403 而不是 404**。
 *    若把 403 当成「源上没有文件 / 没更新」，用户会看到「已是最新」——那正是
 *    R3 禁止的撒谎。所以 403/404 一律 `check_failed` 并说明可能是尚未发布或
 *    桶策略未授予 GetObject。
 *
 * 3. **检查与应用严格分开**。`checkForUpdate` 只读、只写 `state.json`；
 *    `applyUpdate` 必须由调用方显式调用。语料原文会直接进模型上下文，静默换语料
 *    会让「同一问题回答不同」不可解释，也破坏会话回放（契约 §6、BR-6）。
 *
 * fetch 一律可注入：默认 `globalThis.fetch`，测试注入假实现，全程不触网。
 */

/** 契约 §7 的七种状态，字段名与语义不得改动。 */
export type CorpusUpdateState =
  | { kind: "bundled" }
  | { kind: "up_to_date"; corpusVersion: number; checkedAt: string }
  | { kind: "update_available"; corpusVersion: number; fileCount: number; checkedAt: string }
  | { kind: "check_failed"; reason: string; checkedAt: string }
  | { kind: "verify_failed"; reason: string; checkedAt: string }
  | { kind: "config_invalid"; reason: string }
  | { kind: "unavailable" };

/**
 * 只声明用得到的部分：`init.signal` 就够了，剩下的交给真实 fetch。
 * 这样测试里的假实现不必伪造整个 `RequestInit`。
 */
export interface FetchInit {
  signal?: AbortSignal;
}

export type FetchLike = (url: string, init?: FetchInit) => Promise<Response>;

export interface CheckForUpdateOptions {
  /** `$HARNESS_HOME`；`kb/` 布局与 `state.json` 都在它下面。 */
  harnessHome: string;
  /** `loadCorpusConfig` 的 `ok` 分支产物；缺失或不合法时传 `null`。 */
  config: CorpusConfig | null;
  /** 测试注入用；默认 `globalThis.fetch`。 */
  fetchImpl?: FetchLike;
  /** 单次请求超时，默认 30 秒。 */
  timeoutMs?: number;
}

/** 下载/复用进度。`completed` 是已处理的文件数，含从上一版复用的。 */
export interface ApplyProgress {
  completed: number;
  total: number;
  path: string;
  action: "downloaded" | "reused";
}

export interface ApplyUpdateOptions {
  harnessHome: string;
  config: CorpusConfig | null;
  /** 必须是已验签的清单；这里仍会重新解析并验签一次（见 `applyUpdate`）。 */
  manifest: CorpusManifest;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  onProgress?: (progress: ApplyProgress) => void;
}

/**
 * 应用结果。失败时要如实带上「当前版本没有被改动」——调用方据此告诉用户
 * 现在跑的还是旧语料，而不是含糊的「更新失败」。
 */
export type ApplyResult =
  | { ok: true; corpusVersion: number }
  | { ok: false; reason: string; corpusVersionUnchanged: number | null };

export interface ReadCorpusStatusOptions {
  harnessHome: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

const LATEST_FILE_NAME = "latest.json";

/** 与 `corpus-config.ts` 的 PEM 头保持一致。 */
const PEM_BEGIN = "-----BEGIN PUBLIC KEY-----";

/**
 * 检查阶段「拿到了 200，但内容不可用」。单独成类是为了把它和网络异常分开：
 * 前者是 `verify_failed`，后者是 `check_failed`。
 */
class ManifestContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestContentError";
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function nowIso(): string {
  return new Date().toISOString();
}

function tryGetLayout(harnessHome: string): KbLayout | null {
  try {
    return getKbLayout(harnessHome);
  } catch {
    // 空/非法的 HARNESS_HOME：没有知识库根，属于 `unavailable`，不是配置问题。
    return null;
  }
}

/** 指针里的版本号可能被人手改成天文数字；`compareVersions` 只接受非负安全整数。 */
function safeLocalVersion(value: number | null): number | null {
  if (value === null) return null;
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizeTimeout(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.max(1, Math.floor(value));
}

function durationText(milliseconds: number): string {
  return milliseconds >= 1000 ? `${Math.round(milliseconds / 1000)} 秒` : `${milliseconds} 毫秒`;
}

/** 配置是经过 JS 宿主传进来的，类型在运行时不存在，所以再校验一遍。 */
function normalizeConfig(
  input: CorpusConfig | null | undefined,
): { ok: true; config: CorpusConfig } | { ok: false; reason: string } {
  if (input === null || input === undefined) {
    return { ok: false, reason: "没有语料更新配置（corpus.json 缺失），无法检查更新" };
  }
  if (typeof input !== "object") {
    return { ok: false, reason: "语料更新配置不是对象" };
  }

  const record = input as unknown as Record<string, unknown>;
  if (record.version !== 1) {
    return { ok: false, reason: `语料更新配置的 version 必须是 1（实际为 ${String(record.version)}）` };
  }

  const updateBaseUrl = record.updateBaseUrl;
  if (typeof updateBaseUrl !== "string" || updateBaseUrl.trim() === "") {
    return { ok: false, reason: "语料更新配置缺少 updateBaseUrl" };
  }
  let parsed: URL;
  try {
    parsed = new URL(updateBaseUrl);
  } catch {
    return { ok: false, reason: `语料更新配置的 updateBaseUrl 不是绝对 URL：${updateBaseUrl}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      reason: `语料更新配置的 updateBaseUrl 只支持 http/https，实际是 ${parsed.protocol}`,
    };
  }
  if (!updateBaseUrl.endsWith("/")) {
    // 少一个斜杠会拼到同级的另一个路径，症状是 403/404 而不是配置错误，极难排查。
    return { ok: false, reason: '语料更新配置的 updateBaseUrl 必须以 "/" 结尾' };
  }

  const publicKeyPem = record.publicKeyPem;
  if (typeof publicKeyPem !== "string" || !publicKeyPem.includes(PEM_BEGIN)) {
    return { ok: false, reason: `语料更新配置的 publicKeyPem 不是 PEM 公钥（缺少 ${PEM_BEGIN}）` };
  }

  return { ok: true, config: { version: 1, updateBaseUrl, publicKeyPem } };
}

// ---------------------------------------------------------------------------
// URL 与路径
// ---------------------------------------------------------------------------

/**
 * 用 `new URL` 拼接而不是 `path.join`：后者在 Windows 上产出反斜杠，
 * 拼出来的 URL 会指向另一个对象。
 */
function latestManifestUrl(updateBaseUrl: string): string {
  const base = updateBaseUrl.endsWith("/") ? updateBaseUrl : `${updateBaseUrl}/`;
  return new URL(LATEST_FILE_NAME, base).toString();
}

/**
 * 逐段 percent-encode：清单路径允许中文与空格，直接拼进 URL 会被截断或拒绝；
 * 句柄里的 `#` 会被当成 fragment，必须编码。
 */
function fileUrl(updateBaseUrl: string, relativePath: string): string {
  const base = updateBaseUrl.endsWith("/") ? updateBaseUrl : `${updateBaseUrl}/`;
  const encoded = relativePath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  return new URL(encoded, base).toString();
}

function isWithin(base: string, target: string): boolean {
  const relative = path.relative(base, target);
  if (relative === "") return true;
  if (path.isAbsolute(relative)) return false;
  return relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

/**
 * 下载/复制目标的第二道闸：`parseManifest` 已经校验过一次路径，但这一层是
 * 真正要写盘的地方，不能只依赖上游（清单可能经 JS 宿主传进来，类型不设防）。
 *
 * 已知不覆盖：快照目录内部若预先放了指向外部的 junction，resolve + 前缀比较
 * 看不出来。能造出这种目录的人本就能直接改 `current`，不在这条防线的威胁模型内。
 */
function resolveInsideSnapshot(snapshotDir: string, relativePath: string): string {
  const base = path.resolve(snapshotDir);
  const target = path.resolve(base, relativePath);
  if (target === base || !isWithin(base, target)) {
    throw new Error(`拒绝写入：路径越出快照目录 ${relativePath}（目标 ${target}）`);
  }
  return target;
}

/**
 * 与 `snapshot.ts` 私有的目录名格式保持一致（`v<数字>`，无前导零）。
 * 那边的函数没有导出，这里只能各写一份；一旦格式变动两处必须同时改。
 */
function snapshotDirName(version: number): string {
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new Error(`快照版本号必须是非负整数，实际收到：${String(version)}`);
  }
  return `v${version}`;
}

// ---------------------------------------------------------------------------
// 错误描述
// ---------------------------------------------------------------------------

function isAbortLike(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as { code?: unknown }).code;
  // AbortSignal.timeout 让 fetch 以 TimeoutError 拒绝；手工 abort 是 AbortError。
  return error.name === "TimeoutError" || error.name === "AbortError" || code === "ABORT_ERR";
}

function describeNetworkFailure(error: unknown, timeoutMs: number): string {
  if (isAbortLike(error)) return `请求超时（超过 ${durationText(timeoutMs)}）`;
  // Node 的 fetch 把真正的原因（ENOTFOUND / ECONNREFUSED / 证书错误）放在 cause 里，
  // 只报 "fetch failed" 对排查毫无帮助（R3）。
  const cause = error instanceof Error && error.cause !== undefined
    ? `：${messageOf(error.cause)}`
    : "";
  return `网络请求失败${cause}`;
}

/**
 * 契约 §6.1 的实测结论，逐条落到措辞上：
 * - 403/404：OBS 只授予 GetObject 时，**不存在的对象返回 403 而不是 404**。
 *   两者都只能说明「源上没有该文件或无权读取」，绝不能翻译成「已是最新」。
 * - 5xx：服务端临时故障，可以稍后重试。
 */
function describeHttpFailure(status: number, url: string): string {
  if (status === 403 || status === 404) {
    return `更新源返回 ${status}，可能是尚未发布或桶策略未授予 GetObject（${url}）`;
  }
  if (status >= 500 && status <= 599) {
    return `更新源返回 ${status}，属于服务端临时故障，可稍后重试（${url}）`;
  }
  return `更新源返回 ${status}，无法获取该文件（${url}）`;
}

// ---------------------------------------------------------------------------
// 状态文件
// ---------------------------------------------------------------------------

/**
 * 写 `state.json`。**失败不抛错**：它只是「上次检查的备注」，语料本身在
 * `snapshots/` 里，备注写不进去不该把一次成功的检查改判成失败
 * （与 `snapshot.ts` 里 `readState` 的取舍一致）。
 */
async function recordState(layout: KbLayout, state: CorpusState): Promise<void> {
  try {
    await writeState(layout, state);
  } catch {
    // 状态文件写不进去不改变本次检查/更新的结论；调用方拿到的是真实结果。
  }
}

/** 有结果但没写检查时间（手改过的文件）：退回状态文件的写入时间，再不行就给空串。 */
async function checkedAtOf(layout: KbLayout, state: CorpusState): Promise<string> {
  if (typeof state.lastCheckedAt === "string" && state.lastCheckedAt !== "") {
    return state.lastCheckedAt;
  }
  try {
    return (await stat(layout.stateFile)).mtime.toISOString();
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// 检查更新
// ---------------------------------------------------------------------------

function stripBom(text: string): string {
  // 记事本存过的 JSON 会带 BOM，JSON.parse 见到它直接抛 SyntaxError，
  // 于是「能看见内容」的清单被报成「JSON 语法错误」，排查方向完全错。
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * 解析 + 结构校验 + 验签，任一步失败都抛 `ManifestContentError`。
 * 三类失败都属于「拿到了内容但不可信」，统一走 `verify_failed`。
 */
function parseAndVerifyManifest(text: string, publicKeyPem: string): CorpusManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(stripBom(text)) as unknown;
  } catch (error) {
    throw new ManifestContentError(`更新源返回的 latest.json 不是合法 JSON（${messageOf(error)}）`);
  }

  let manifest: CorpusManifest;
  try {
    manifest = parseManifest(raw);
  } catch (error) {
    throw new ManifestContentError(`更新源返回的清单结构不合法：${messageOf(error)}`);
  }

  if (!verifyManifestSignature(manifest, publicKeyPem)) {
    throw new ManifestContentError(
      "清单验签失败：签名与内容不符，可能被篡改或配置的公钥与发布密钥不匹配（已拒绝）",
    );
  }
  return manifest;
}

async function failedCheckState(
  layout: KbLayout,
  kind: "check_failed" | "verify_failed",
  reason: string,
  localVersion: number | null,
): Promise<CorpusUpdateState> {
  const checkedAt = nowIso();
  await recordState(layout, {
    lastCheckedAt: checkedAt,
    lastResult: kind,
    ...(localVersion === null ? {} : { corpusVersion: localVersion }),
    detail: reason,
  });
  return { kind, reason, checkedAt };
}

/**
 * 检查更新。**绝不抛错**：任何失败都转成状态对象（契约 §7、R3）。
 *
 * 本地没有 `current` 指针时按版本 0 处理：任何远端版本都算更新（首次用 OTA 建库）。
 */
export async function checkForUpdate(opts: CheckForUpdateOptions): Promise<CorpusUpdateState> {
  const configCheck = normalizeConfig(opts.config);
  if (!configCheck.ok) return { kind: "config_invalid", reason: configCheck.reason };
  const config = configCheck.config;

  const layout = tryGetLayout(opts.harnessHome);
  if (layout === null) return { kind: "unavailable" };

  const currentVersion = safeLocalVersion(await readCurrentVersion(layout));
  const localForCompare = currentVersion ?? 0;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = normalizeTimeout(opts.timeoutMs);

  let manifest: CorpusManifest;
  try {
    const url = latestManifestUrl(config.updateBaseUrl);
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (response.status !== 200) {
      return await failedCheckState(
        layout,
        "check_failed",
        describeHttpFailure(response.status, url),
        currentVersion,
      );
    }
    const text = await response.text();
    manifest = parseAndVerifyManifest(text, config.publicKeyPem);
  } catch (error) {
    if (error instanceof ManifestContentError) {
      return await failedCheckState(layout, "verify_failed", error.message, currentVersion);
    }
    return await failedCheckState(
      layout,
      "check_failed",
      `${describeNetworkFailure(error, timeoutMs)}，当前语料版本保持不变`,
      currentVersion,
    );
  }

  let comparison: ReturnType<typeof compareVersions>;
  try {
    comparison = compareVersions(localForCompare, manifest.corpusVersion);
  } catch (error) {
    // 版本号坏掉不能静默落进任何一个分支，更不能显示成「已是最新」。
    return await failedCheckState(
      layout,
      "check_failed",
      `无法比较语料版本：${messageOf(error)}`,
      currentVersion,
    );
  }

  if (comparison === "rollback_rejected") {
    // 契约 §4：`corpusVersion <= 本地当前版本` 拒绝。旧清单哪怕签名合法也要拒——
    // 攻击者拿不到私钥，但可以把桶里的清单换成旧的合法版本，把语料退回含注入的版本。
    return await failedCheckState(
      layout,
      "check_failed",
      `更新源的语料版本 v${manifest.corpusVersion} 低于本地 v${localForCompare}，已拒绝回滚（可能是发布侧误传了旧清单）`,
      currentVersion,
    );
  }

  const checkedAt = nowIso();
  if (comparison === "up_to_date") {
    await recordState(layout, {
      lastCheckedAt: checkedAt,
      lastResult: "up_to_date",
      corpusVersion: manifest.corpusVersion,
    });
    return { kind: "up_to_date", corpusVersion: manifest.corpusVersion, checkedAt };
  }

  // fileCount 是**新版本的文件总数**（契约 §7「有新版（版本号、文件数）」），
  // 不是本次需要下载的数量——后者要等拿到本地快照的哈希才算得出来。
  await recordState(layout, {
    lastCheckedAt: checkedAt,
    lastResult: "update_available",
    corpusVersion: manifest.corpusVersion,
    fileCount: manifest.files.length,
    detail: `有新版 v${manifest.corpusVersion}，共 ${manifest.files.length} 个文件`,
  });
  return {
    kind: "update_available",
    corpusVersion: manifest.corpusVersion,
    fileCount: manifest.files.length,
    checkedAt,
  };
}

// ---------------------------------------------------------------------------
// 应用更新
// ---------------------------------------------------------------------------

interface ApplyLockedOptions {
  layout: KbLayout;
  config: CorpusConfig;
  manifest: CorpusManifest;
  fetchImpl: FetchLike;
  timeoutMs: number;
  onProgress: ((progress: ApplyProgress) => void) | undefined;
}

/** 进度回调是显示用的，它抛错不该让更新失败。 */
function notifyProgress(
  onProgress: ((progress: ApplyProgress) => void) | undefined,
  progress: ApplyProgress,
): void {
  if (onProgress === undefined) return;
  try {
    onProgress(progress);
  } catch {
    // 忽略：进度显示失败与语料完整性无关。
  }
}

/**
 * 只清理 `snapshots/` 的直接子目录 `v<N>`，且绝不碰 `current` 指向的版本。
 *
 * 删除前重新校验，理由与 `snapshot.ts` 的 `assertSnapshotDirPath` 相同：
 * 这个路径下面紧跟一个递归删除，任何一次拼接失误都会删掉别的东西。
 */
async function removeSnapshotDir(layout: KbLayout, version: number): Promise<void> {
  const name = snapshotDirName(version);
  const snapshotsAbs = path.resolve(layout.snapshotsDir);
  const target = path.resolve(snapshotsAbs, name);
  if (path.dirname(target) !== snapshotsAbs || path.basename(target) !== name) {
    throw new Error(`拒绝删除：路径不是快照目录下的 ${name}（${target}）`);
  }
  if ((await readCurrentVersion(layout)) === version) {
    throw new Error(`拒绝删除：${name} 正是当前使用的快照`);
  }

  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if (codeOf(error) === "ENOENT") return;
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`拒绝删除：${target} 不是普通目录`);
  }
  await rm(target, { recursive: true, force: false });
}

/**
 * 准备目标快照目录：清掉上一次失败留下的同版本残留，再建空目录。
 *
 * 为什么必须清空：本次只写「变化的文件」+ 复制「未变化的文件」，残留的旧文件
 * 若恰好是被新版本删掉的路径，就会混进这个「完整快照」，让语料内容与签名清单
 * 不一致——而签名只覆盖清单，发现不了多出来的文件。
 */
async function prepareSnapshotDir(layout: KbLayout, version: number): Promise<string> {
  if ((await readCurrentVersion(layout)) === version) {
    // 理论上前面已经用版本比较拒绝过；真走到这里也绝不能往当前快照里写。
    throw new Error(`拒绝写入：v${version} 正是当前使用的快照`);
  }

  const name = snapshotDirName(version);
  const target = path.join(path.resolve(layout.snapshotsDir), name);
  let info;
  try {
    info = await lstat(target);
  } catch (error) {
    if (codeOf(error) !== "ENOENT") throw error;
    info = null;
  }
  if (info !== null) {
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`快照路径不是普通目录，拒绝覆盖：${target}`);
    }
    await rm(target, { recursive: true, force: false });
  }
  return ensureSnapshotDir(layout, version);
}

/**
 * 上一版快照里各文件的实际 sha256（只算清单里出现过的路径）。
 *
 * 用磁盘实际内容而不是「上一版清单」：本地文件被改坏时哈希对不上，
 * `diffFiles` 会把它判成需要下载，从而自愈。
 * 读不到的文件直接不列入——`diffFiles` 会把缺失的文件当成需要下载（R3：不猜）。
 */
async function hashExistingFiles(
  currentDir: string | null,
  manifest: CorpusManifest,
): Promise<ManifestFile[]> {
  if (currentDir === null) return [];
  const files: ManifestFile[] = [];
  for (const file of manifest.files) {
    let absolute: string;
    try {
      absolute = resolveInsideSnapshot(currentDir, file.path);
    } catch {
      continue;
    }
    try {
      files.push({ path: file.path, sha256: await sha256File(absolute) });
    } catch {
      // 不存在 / 读不动：交给下载。
    }
  }
  return files;
}

interface DownloadOptions {
  url: string;
  destPath: string;
  expectedSha256: string;
  relativePath: string;
  fetchImpl: FetchLike;
  timeoutMs: number;
}

/**
 * 下载单个文件：先拿全内容算 sha256，校验通过才**写临时文件再 rename**。
 *
 * 先校验后落盘：半截文件、被中间设备改过的内容根本进不了快照目录。
 * 先写 `.tmp-*` 再 rename：即便 rename 之前进程被杀，也不会在快照里留下
 * 一个名字正确但内容不完整的文件。
 */
async function downloadInto(opts: DownloadOptions): Promise<void> {
  const { url, destPath, expectedSha256, relativePath, fetchImpl, timeoutMs } = opts;

  let response: Response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new Error(`下载 ${relativePath} 失败：${describeNetworkFailure(error, timeoutMs)}`, {
      cause: error,
    });
  }
  if (response.status !== 200) {
    throw new Error(`下载 ${relativePath} 失败：${describeHttpFailure(response.status, url)}`);
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    // 读响应体时断线同样算网络失败，不能算验签失败。
    throw new Error(`下载 ${relativePath} 失败：${describeNetworkFailure(error, timeoutMs)}`, {
      cause: error,
    });
  }

  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expectedSha256) {
    throw new Error(
      `文件 ${relativePath} 校验失败：sha256 与清单不符（清单 ${expectedSha256}，实际 ${actual}）`,
    );
  }

  await mkdir(path.dirname(destPath), { recursive: true });
  const tmpPath = `${destPath}.tmp-${randomUUID()}`;
  try {
    await writeFile(tmpPath, bytes, { flag: "wx" });
    await rename(tmpPath, destPath);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw new Error(`写入 ${relativePath} 失败：${messageOf(error)}`, { cause: error });
  }
}

async function applyLocked(opts: ApplyLockedOptions): Promise<ApplyResult> {
  const { layout, config, manifest, fetchImpl, timeoutMs, onProgress } = opts;
  const currentVersion = safeLocalVersion(await readCurrentVersion(layout));
  const refuse = (reason: string): ApplyResult => ({
    ok: false,
    reason,
    corpusVersionUnchanged: currentVersion,
  });

  // 契约 §4：`corpusVersion <= 本地当前版本` 一律拒绝。
  const comparison = compareVersions(currentVersion ?? 0, manifest.corpusVersion);
  if (comparison === "rollback_rejected") {
    return refuse(
      `更新源的语料版本 v${manifest.corpusVersion} 低于已安装的 v${currentVersion}，已拒绝回滚`,
    );
  }
  if (comparison === "up_to_date") {
    // 同版本不重装：目标目录名就是当前快照，写进去等于改动正在使用的语料。
    return refuse(`已安装的语料版本就是 v${manifest.corpusVersion}，无需更新`);
  }

  // 指针一旦切过去就不能再回滚删除，后面的清理失败也只能算「收拾现场失败」。
  let switched = false;
  try {
    const snapshotDir = await prepareSnapshotDir(layout, manifest.corpusVersion);
    const currentDir = currentVersion === null
      ? null
      : path.join(layout.snapshotsDir, snapshotDirName(currentVersion));
    const currentFiles = await hashExistingFiles(currentDir, manifest);
    const changed = diffFiles(currentFiles, manifest);
    const toDownload = new Set(changed.map((file) => file.path));

    const total = manifest.files.length;
    let completed = 0;
    for (const file of manifest.files) {
      const destPath = resolveInsideSnapshot(snapshotDir, file.path);
      let action: ApplyProgress["action"];
      if (toDownload.has(file.path)) {
        await downloadInto({
          url: fileUrl(config.updateBaseUrl, file.path),
          destPath,
          expectedSha256: file.sha256,
          relativePath: file.path,
          fetchImpl,
          timeoutMs,
        });
        action = "downloaded";
      } else {
        // 未变化的文件从上一版复制：只下载变化的，但新快照必须是**完整**语料，
        // 否则切过去之后知识库会静默少文件（R3）。
        if (currentDir === null) {
          throw new Error(`内部状态异常：没有当前快照却判定 ${file.path} 未变化`);
        }
        await mkdir(path.dirname(destPath), { recursive: true });
        await copyFile(resolveInsideSnapshot(currentDir, file.path), destPath);
        action = "reused";
      }
      completed += 1;
      notifyProgress(onProgress, { completed, total, path: file.path, action });
    }

    await setCurrent(layout, manifest.corpusVersion);
    switched = true;

    // 保留上一版；清理更早的。切指针已经成功，这里的失败不该把更新说成失败。
    await pruneSnapshots(layout, 2).catch(() => undefined);
    await recordState(layout, {
      lastCheckedAt: nowIso(),
      lastResult: "up_to_date",
      corpusVersion: manifest.corpusVersion,
    });
    return { ok: true, corpusVersion: manifest.corpusVersion };
  } catch (error) {
    let cleanupNote = "";
    if (!switched) {
      try {
        await removeSnapshotDir(layout, manifest.corpusVersion);
      } catch (cleanupError) {
        // 清理不掉就如实说，别让用户以为磁盘上是干净的。
        cleanupNote = `；半成品快照清理失败（${messageOf(cleanupError)}），请手工删除 snapshots/${snapshotDirName(manifest.corpusVersion)}`;
      }
    }
    return refuse(`更新未生效，当前语料版本保持不变：${messageOf(error)}${cleanupNote}`);
  }
}

/**
 * 应用更新。只能由调用方显式调用（契约 §6：不自动应用）。
 *
 * 流程：抢锁 → 版本比较（拒绝回滚/重复）→ 只下载 sha256 变化的文件、其余从上一版
 * 复制 → 逐个校验 → 全部就位才切 `current` → 保留上一版、清理更早的。
 * 任一步失败：删掉本次半成品，`current` 不动，如实报原因。
 */
export async function applyUpdate(opts: ApplyUpdateOptions): Promise<ApplyResult> {
  const layoutResult = tryGetLayout(opts.harnessHome);
  const observedVersion = layoutResult === null
    ? null
    : safeLocalVersion(await readCurrentVersion(layoutResult));
  const refuse = (
    reason: string,
    unchanged: number | null = observedVersion,
  ): ApplyResult => ({ ok: false, reason, corpusVersionUnchanged: unchanged });

  const configCheck = normalizeConfig(opts.config);
  if (!configCheck.ok) return refuse(`语料配置不可用：${configCheck.reason}`);
  if (layoutResult === null) return refuse("HARNESS_HOME 无效，无法定位知识库目录");
  const layout = layoutResult;

  // 第二道闸：清单可能经 JS 宿主传进来（运行时没有类型保护），落盘前重新解析并验签。
  // 上游 `checkForUpdate` 已经验过；这里再验一次的成本是一次 Ed25519 验证，
  // 换的是「任何调用方都无法让我们装上未经验签的语料」。
  let manifest: CorpusManifest;
  try {
    manifest = parseManifest(opts.manifest);
  } catch (error) {
    return refuse(`清单不合法，已拒绝更新：${messageOf(error)}`);
  }
  if (!verifyManifestSignature(manifest, configCheck.config.publicKeyPem)) {
    return refuse("清单验签失败，已拒绝更新：签名与内容不符，可能被篡改或公钥不匹配");
  }

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const timeoutMs = normalizeTimeout(opts.timeoutMs);

  try {
    return await withUpdateLock(layout, () =>
      applyLocked({
        layout,
        config: configCheck.config,
        manifest,
        fetchImpl,
        timeoutMs,
        onProgress: opts.onProgress,
      }));
  } catch (error) {
    if (error instanceof CorpusLockError) {
      return refuse("另一个实例正在更新知识库（更新锁被占用），本次未改动任何文件");
    }
    return refuse(`更新失败：${messageOf(error)}`);
  }
}

// ---------------------------------------------------------------------------
// 读取状态（设置页用，不联网）
// ---------------------------------------------------------------------------

/**
 * 把 `state.json` + 本地当前版本映射成状态对象，不需要网络。
 *
 * 两处「如实降级」需要解释：
 *
 * 1. **存储的 `update_available` 可能缺 `fileCount`**。该状态要求带 `fileCount`，
 *    `CorpusState` 现在存了它；但早期版本写下的状态文件里没有这个字段，此时报
 *    `check_failed` 并说明「记录不完整，请重新检查」——用 `fileCount: 0` 顶上就是
 *    撒谎（R3）。启动时的静默检查（契约 §6）会立刻写入新的完整结果。
 * 2. **没有 `current` 指针就是 `unavailable`**（契约 §7「没有 KB 根」）。
 *    此时连内置快照都没有，说成 `bundled` 会谎称「有语料、只是没检查过」。
 */
export async function readCorpusStatus(
  opts: ReadCorpusStatusOptions,
): Promise<CorpusUpdateState> {
  const layout = tryGetLayout(opts.harnessHome);
  if (layout === null) return { kind: "unavailable" };

  const currentVersion = safeLocalVersion(await readCurrentVersion(layout));
  if (currentVersion === null) return { kind: "unavailable" };

  const state = await readState(layout);
  if (state.lastResult === "never") return { kind: "bundled" };

  const checkedAt = await checkedAtOf(layout, state);

  if (state.lastResult === "up_to_date") {
    // 以指针为准：它才是「现在装着什么」，state.json 只是上次检查的备注。
    return { kind: "up_to_date", corpusVersion: currentVersion, checkedAt };
  }

  if (state.lastResult === "update_available") {
    const versionText = state.corpusVersion === undefined ? "" : ` v${state.corpusVersion}`;
    // 新版版本号以 state 为准：指针还停在旧版本，那才是「发现新版但尚未应用」。
    if (state.corpusVersion !== undefined && state.fileCount !== undefined) {
      return {
        kind: "update_available",
        corpusVersion: state.corpusVersion,
        fileCount: state.fileCount,
        checkedAt,
      };
    }
    return {
      kind: "check_failed",
      reason: `上次检查发现新版${versionText}，但状态文件没有记录文件数，无法完整还原更新信息；请重新检查更新确认`,
      checkedAt,
    };
  }

  if (state.lastResult === "check_failed") {
    return {
      kind: "check_failed",
      reason: state.detail ?? "上次检查更新失败（状态文件未记录原因）",
      checkedAt,
    };
  }

  // verify_failed：readState 只会返回上面这几种。
  return {
    kind: "verify_failed",
    reason: state.detail ?? "上次检查时清单验签失败（状态文件未记录原因）",
    checkedAt,
  };
}
