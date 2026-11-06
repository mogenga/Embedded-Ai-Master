import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { open, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { readSessionHeader } from "./persistence.js";

/**
 * 会话元数据（标题 / 置顶 / 归档）。
 *
 * 存成**旁挂文件** `meta.json`，不改 `header.json`：header 有严格校验
 * （`validateHeader` 只保留已知字段），往里塞 title 会被静默丢弃；而且 header
 * 的 status 由会话句柄在 close 时重写，两处写同一文件会互相覆盖。
 *
 * 读侧对损坏保持宽容——旁挂数据坏了不该让会话打不开；写侧保持原子性。
 */

export const SESSION_META_FILE = "meta.json";
export const SESSION_TITLE_MAX_LENGTH = 200;

/** 系统提示词某一节的哈希与长度（设计稿 §3.1，写 `meta.json` 不写会话日志）。 */
export type PromptSectionDigest = { hash: string; chars: number };
export type PromptSections = Record<string, PromptSectionDigest>;

export interface SessionMeta {
  title?: string;
  pinned?: boolean;
  archived?: boolean;
  updatedAt: string;
  promptSections?: PromptSections;
}

export interface SessionMetaPatch {
  /** null 表示清除标题；字符串按去空白后存储，超出长度截断。 */
  title?: string | null;
  pinned?: boolean;
  archived?: boolean;
  promptSections?: PromptSections;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSectionDigest(value: unknown): value is PromptSectionDigest {
  return (
    isRecord(value)
    && typeof value.hash === "string"
    && value.hash !== ""
    && typeof value.chars === "number"
    && Number.isInteger(value.chars)
    && value.chars >= 0
  );
}

/**
 * 校验并拷贝 `promptSections`。
 *
 * 读侧对坏项保持宽容（与 title 一致：坏字段不该让整个 meta 读不出来），
 * 这里**逐项丢弃**坏形状而不是整块作废。
 */
function parsePromptSections(value: unknown): PromptSections | undefined {
  if (!isRecord(value)) return undefined;
  const sections: PromptSections = {};
  for (const [key, digest] of Object.entries(value)) {
    if (isSectionDigest(digest)) sections[key] = { hash: digest.hash, chars: digest.chars };
  }
  return Object.keys(sections).length > 0 ? sections : undefined;
}

function fallbackUpdatedAt(dir: string): string {
  try {
    return readSessionHeader(dir).createdAt;
  } catch {
    return new Date().toISOString();
  }
}

const UTF8_BOM = String.fromCharCode(0xfeff);

function stripBom(text: string): string {
  return text.startsWith(UTF8_BOM) ? text.slice(UTF8_BOM.length) : text;
}

export function readSessionMeta(dir: string): SessionMeta {
  const file = path.join(dir, SESSION_META_FILE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripBom(readFileSync(file, "utf8"))) as unknown;
  } catch {
    // 不存在 / 不可读 / JSON 损坏一律按空元数据；updatedAt 回落到 header.createdAt。
    return { updatedAt: fallbackUpdatedAt(dir) };
  }
  if (!isRecord(parsed)) {
    return { updatedAt: fallbackUpdatedAt(dir) };
  }
  const meta: SessionMeta = {
    updatedAt:
      typeof parsed.updatedAt === "string" && !Number.isNaN(Date.parse(parsed.updatedAt))
        ? parsed.updatedAt
        : fallbackUpdatedAt(dir),
  };
  if (typeof parsed.title === "string" && parsed.title.trim() !== "") {
    meta.title = parsed.title.trim().slice(0, SESSION_TITLE_MAX_LENGTH);
  }
  if (typeof parsed.pinned === "boolean") meta.pinned = parsed.pinned;
  if (typeof parsed.archived === "boolean") meta.archived = parsed.archived;
  const promptSections = parsePromptSections(parsed.promptSections);
  if (promptSections !== undefined) meta.promptSections = promptSections;
  return meta;
}

// UI 里输入的标题超长不该让整条请求失败——截断比拒绝更符合用户意图。
function normalizeTitle(title: string | null): string | undefined {
  if (title === null) return undefined;
  const trimmed = title.trim();
  if (trimmed === "") return undefined;
  return trimmed.slice(0, SESSION_TITLE_MAX_LENGTH);
}

function assertPatch(patch: unknown): asserts patch is SessionMetaPatch {
  if (!isRecord(patch)) {
    throw new TypeError("会话元数据 patch 必须是对象");
  }
  for (const field of Object.keys(patch)) {
    if (
      field !== "title"
      && field !== "pinned"
      && field !== "archived"
      && field !== "promptSections"
    ) {
      throw new TypeError(`会话元数据不支持字段 ${JSON.stringify(field)}`);
    }
  }
  if (patch.title !== undefined && patch.title !== null && typeof patch.title !== "string") {
    throw new TypeError("会话元数据 title 必须是字符串或 null");
  }
  if (patch.pinned !== undefined && typeof patch.pinned !== "boolean") {
    throw new TypeError("会话元数据 pinned 必须是布尔值");
  }
  if (patch.archived !== undefined && typeof patch.archived !== "boolean") {
    throw new TypeError("会话元数据 archived 必须是布尔值");
  }
  if (patch.promptSections !== undefined) {
    if (!isRecord(patch.promptSections)) {
      throw new TypeError("会话元数据 promptSections 必须是对象");
    }
    for (const [key, digest] of Object.entries(patch.promptSections)) {
      if (!isRecord(digest) || typeof digest.hash !== "string" || digest.hash === "") {
        throw new TypeError(`会话元数据 promptSections[${JSON.stringify(key)}].hash 必须是非空字符串`);
      }
      if (
        typeof digest.chars !== "number"
        || !Number.isInteger(digest.chars)
        || digest.chars < 0
      ) {
        throw new TypeError(`会话元数据 promptSections[${JSON.stringify(key)}].chars 必须是非负整数`);
      }
    }
  }
}

/**
 * 两组节哈希是否等价（纯函数，用于「没变就不重写」）。
 *
 * 每次运行都重写 `meta.json` 会 bump `updatedAt`，让「最近使用」排序被无意义地
 * 刷新；调用方应先用本函数比较，相等则跳过写入。`undefined` 与空对象都表示
 * 「没有节」，视为相等；键顺序不影响结果。
 */
export function promptSectionsEqual(a: PromptSections | undefined, b: PromptSections | undefined): boolean {
  const left = a ?? {};
  const right = b ?? {};
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  for (const key of leftKeys) {
    const leftDigest = left[key]!;
    const rightDigest = right[key];
    if (rightDigest === undefined) return false;
    if (leftDigest.hash !== rightDigest.hash || leftDigest.chars !== rightDigest.chars) return false;
  }
  return true;
}

export async function writeSessionMeta(dir: string, patch: SessionMetaPatch): Promise<SessionMeta> {
  assertPatch(patch);
  const current = readSessionMeta(dir);
  const next: SessionMeta = { ...current, updatedAt: new Date().toISOString() };
  if (patch.title !== undefined) {
    const title = normalizeTitle(patch.title);
    if (title === undefined) delete next.title;
    else next.title = title;
  }
  if (patch.pinned !== undefined) next.pinned = patch.pinned;
  if (patch.archived !== undefined) next.archived = patch.archived;
  // patch 没给 promptSections 时必须保留原值：`{...current}` 已带上它，这里只在
  // 显式写入时覆盖——与 title 不同，它没有「清除」语义。
  if (patch.promptSections !== undefined) {
    next.promptSections = parsePromptSections(patch.promptSections);
    if (next.promptSections === undefined) delete next.promptSections;
  }

  const file = path.join(dir, SESSION_META_FILE);
  const tmpPath = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    const handle = await open(tmpPath, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmpPath, file);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return next;
}
