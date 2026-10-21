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

export interface SessionMeta {
  title?: string;
  pinned?: boolean;
  archived?: boolean;
  updatedAt: string;
}

export interface SessionMetaPatch {
  /** null 表示清除标题；字符串按去空白后存储，超出长度截断。 */
  title?: string | null;
  pinned?: boolean;
  archived?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
    if (field !== "title" && field !== "pinned" && field !== "archived") {
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
