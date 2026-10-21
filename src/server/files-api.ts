import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { isValidSessionId } from "../session/handle.js";
import { readSessionHeader } from "../session/persistence.js";
import { HttpError } from "./http.js";

/**
 * Read-only file preview and artifact listing for the web UI.
 *
 * Both endpoints exist because the renderer lets an operator open the file a
 * tool touched and the artifacts a session produced. They are read-only and
 * capped on purpose: this is a viewer, not a second `fs` tool. The permission
 * gate governs what the *model* may do; nothing here may become a way to read
 * a file the kernel would have refused.
 *
 * The boundary is therefore the directories the operator is already looking at
 * — the sessions root and every session's recorded workdir — resolved through
 * `realpath` so a symlink cannot walk out of them.
 */

export interface FilePreview {
  path: string;
  content: string;
  truncated: boolean;
  binary: boolean;
}

export interface ArtifactEntry {
  path: string;
  name: string;
  kind: "text" | "unknown";
  size: number;
}

export interface TreeEntry {
  name: string;
  /** 绝对路径（realpath 后的父目录 + 目录项名称）。 */
  path: string;
  type: "dir" | "file";
}

/** Same ceiling as the `fs` tool's read: enough for a source file, not a dump. */
export const MAX_PREVIEW_BYTES = 256 * 1024;

/** 单层目录最多返回的条目数；超出即截断并标记，不报错。 */
export const MAX_DIRECTORY_ENTRIES = 500;

/**
 * 进程内登记的工作区根。
 *
 * 不持久化：这是「本次运行期间操作员打开了哪个文件夹」的状态，重启后应重新
 * 选择。只在 `allowedRoots` 里参与合并，与 sessions 根、会话 workdir 同一套
 * realpath 判定。
 */
const registeredWorkspaceRoots = new Set<string>();

/** Bytes inspected for a NUL when deciding whether a file is binary. */
const BINARY_SNIFF_BYTES = 8 * 1024;

const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".log",
  ".json",
  ".md",
  ".mdx",
  ".yaml",
  ".yml",
  ".csv",
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".css",
  ".html",
  ".xml",
  ".ini",
  ".cfg",
  ".toml",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".py",
  ".rs",
  ".go",
  ".sh",
  ".ps1",
  ".s",
  ".ld",
]);

function normalizeForCompare(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(normalizeForCompare(parent), normalizeForCompare(child));
  if (relative === "") return true;
  if (path.isAbsolute(relative)) return false;
  return relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

async function realpathOrNull(value: string): Promise<string | null> {
  try {
    return await realpath(value);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

/**
 * Every directory the viewer may read from.
 *
 * The sessions root always qualifies. Each session's workdir joins it: a
 * session that ran in another project has files that are legitimate reading
 * for whoever opened that session. Workspace roots the operator opened through
 * `registerWorkspaceRoot` join them too — that is what makes a folder outside
 * the harness browsable without widening the rule for everyone.
 *
 * Registered roots are already realpath'd on registration; they are re-resolved
 * here (and dropped if they vanished) so a deleted folder cannot keep granting
 * access through a stale entry.
 */
async function allowedRoots(harnessHome: string): Promise<string[]> {
  const sessionsDir = path.join(harnessHome, "sessions");
  const roots = new Set<string>();
  for (const registered of registeredWorkspaceRoots) {
    const real = await realpathOrNull(registered);
    if (real !== null) roots.add(real);
  }
  const realSessions = await realpathOrNull(sessionsDir);
  if (realSessions !== null) roots.add(realSessions);
  let entries: Array<{ name: string; isDirectory(): boolean }> = [];
  try {
    entries = await readdir(sessionsDir, { withFileTypes: true });
  } catch {
    return [...roots];
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidSessionId(entry.name)) continue;
    try {
      const header = readSessionHeader(path.join(sessionsDir, entry.name));
      if (header.workdir === undefined) continue;
      const real = await realpathOrNull(header.workdir);
      if (real !== null) roots.add(real);
    } catch {
      // A session whose header cannot be read contributes no root; the
      // sessions root still covers its own directory.
    }
  }
  return [...roots];
}

function hasNulByte(buffer: Buffer): boolean {
  const limit = Math.min(buffer.length, BINARY_SNIFF_BYTES);
  for (let index = 0; index < limit; index += 1) {
    if (buffer[index] === 0x00) return true;
  }
  return false;
}

/** Cut on a code-point boundary so the preview never ends in a broken glyph. */
function truncateUtf8(buffer: Buffer): string {
  let end = buffer.length;
  if (end > 0) {
    // Step back over a trailing partial sequence (at most three bytes).
    let back = 0;
    while (end > 0 && back < 3 && (buffer[end - 1] & 0xc0) === 0x80) {
      end -= 1;
      back += 1;
    }
    if (end > 0 && (buffer[end - 1] & 0x80) !== 0) end -= 1;
  }
  return buffer.subarray(0, end).toString("utf8");
}

/**
 * Read one file for the preview pane.
 *
 * `rawPath` is whatever the renderer sent — an absolute path from a tool row,
 * or one the operator typed. Everything about it is untrusted.
 */
export async function readFilePreview(
  harnessHome: string,
  rawPath: unknown,
): Promise<FilePreview> {
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    throw new HttpError(400, "invalid_path", "path 必须是非空字符串");
  }
  if (rawPath.includes("\0")) {
    throw new HttpError(400, "invalid_path", "路径非法");
  }
  const target = path.resolve(rawPath);
  const realTarget = await realpathOrNull(target);
  if (realTarget === null) {
    throw new HttpError(404, "not_found", "文件不存在");
  }
  const roots = await allowedRoots(harnessHome);
  if (!roots.some((root) => isInside(root, realTarget))) {
    // The path exists but is outside what the viewer may read. Saying which
    // rule refused it keeps the message actionable instead of a bare 403.
    throw new HttpError(
      400,
      "invalid_path",
      "只能查看会话目录或会话工作目录内的文件",
    );
  }
  const info = await stat(realTarget);
  if (!info.isFile()) {
    throw new HttpError(400, "invalid_path", "不是普通文件");
  }
  const truncated = info.size > MAX_PREVIEW_BYTES;
  let payload: Buffer;
  try {
    payload = truncated
      ? (await readFile(realTarget)).subarray(0, MAX_PREVIEW_BYTES)
      : await readFile(realTarget);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") {
      throw new HttpError(403, "file_unreadable", "文件不可读");
    }
    throw error;
  }
  if (hasNulByte(payload)) {
    // Report the fact rather than decoding mojibake: a capture or an ELF is
    // not text, and showing replacement characters would claim it was.
    return { path: realTarget, content: "", truncated, binary: true };
  }
  return {
    path: realTarget,
    content: truncateUtf8(payload),
    truncated,
    binary: false,
  };
}

function artifactKind(name: string): "text" | "unknown" {
  return TEXT_EXTENSIONS.has(path.extname(name).toLowerCase()) ? "text" : "unknown";
}

/**
 * List the artifacts a session produced.
 *
 * `pipeline.writeArtifact` writes plain text files under
 * `<sessionDir>/artifacts/`; a directory that does not exist yet is an empty
 * list, not an error — most sessions never overflow a tool result.
 */
export async function listSessionArtifacts(
  harnessHome: string,
  rawId: string,
): Promise<ArtifactEntry[]> {
  if (!isValidSessionId(rawId)) {
    throw new HttpError(400, "invalid_session_id", "非法的会话 id");
  }
  const dir = path.join(harnessHome, "sessions", rawId, "artifacts");
  let entries: Array<{ name: string; isFile(): boolean; isSymbolicLink(): boolean }> = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  }
  const out: ArtifactEntry[] = [];
  for (const entry of entries) {
    // A symlink here would be a way to read outside the session; skip it.
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    let size = 0;
    try {
      size = (await stat(full)).size;
    } catch {
      continue;
    }
    out.push({ path: full, name: entry.name, kind: artifactKind(entry.name), size });
  }
  out.sort((left, right) => left.name.localeCompare(right.name));
  return out;
}

/** 大小写不敏感的稳定名称比较：同名前缀的项不因平台/区域设置换位。 */
function compareEntryNames(left: string, right: string): number {
  const folded = left.toLowerCase().localeCompare(right.toLowerCase());
  return folded !== 0 ? folded : left.localeCompare(right);
}

/**
 * List one directory's direct children for the file tree.
 *
 * The boundary is exactly `readFilePreview`'s: the realpath of the requested
 * directory has to sit inside an allowed root. Resolution happens before the
 * boundary check so a symlinked path cannot walk out of the roots, and entries
 * that are themselves symlinks are skipped for the same reason
 * `listSessionArtifacts` skips them — following one would expose a target the
 * viewer never agreed to.
 *
 * Errors are explicit rather than an empty array: a caller that gets `[]` must
 * be able to believe the directory really is empty (R3).
 */
export async function listDirectory(
  harnessHome: string,
  rawPath: unknown,
): Promise<{ path: string; entries: TreeEntry[]; truncated: boolean }> {
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    throw new HttpError(400, "invalid_path", "path 必须是非空字符串");
  }
  if (rawPath.includes("\0")) {
    throw new HttpError(400, "invalid_path", "路径非法");
  }
  const target = path.resolve(rawPath);
  const realTarget = await realpathOrNull(target);
  if (realTarget === null) {
    throw new HttpError(404, "not_found", "目录不存在");
  }
  const roots = await allowedRoots(harnessHome);
  if (!roots.some((root) => isInside(root, realTarget))) {
    throw new HttpError(
      400,
      "invalid_path",
      "只能查看会话目录、会话工作目录或已登记的工作区内的目录",
    );
  }
  const info = await stat(realTarget);
  if (!info.isDirectory()) {
    throw new HttpError(400, "not_directory", "不是目录");
  }
  let dirents: Array<{
    name: string;
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  }>;
  try {
    dirents = await readdir(realTarget, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new HttpError(404, "not_found", "目录不存在");
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new HttpError(403, "directory_unreadable", "目录不可读");
    }
    throw error;
  }
  const dirs: TreeEntry[] = [];
  const files: TreeEntry[] = [];
  for (const dirent of dirents) {
    let isLink = dirent.isSymbolicLink();
    let isDir = dirent.isDirectory();
    let isFile = dirent.isFile();
    if (!isLink && !isDir && !isFile) {
      // Dirent 说不清类型（d_type 为 DT_UNKNOWN 的文件系统）：退回 lstat。
      // 类型明确时不额外 stat —— 大目录逐项 stat 会让列目录退化成秒级。
      try {
        const entryInfo = await lstat(path.join(realTarget, dirent.name));
        isLink = entryInfo.isSymbolicLink();
        isDir = entryInfo.isDirectory();
        isFile = entryInfo.isFile();
      } catch {
        // 目录项在 readdir 与 lstat 之间消失：跳过，不能让整次列目录失败。
        continue;
      }
    }
    // A symlink here would be a way to leave the allowed roots; skip it,
    // same rule as `listSessionArtifacts`.
    if (isLink) continue;
    const entry: TreeEntry = {
      name: dirent.name,
      path: path.join(realTarget, dirent.name),
      type: isDir ? "dir" : "file",
    };
    (isDir ? dirs : files).push(entry);
  }
  dirs.sort((left, right) => compareEntryNames(left.name, right.name));
  files.sort((left, right) => compareEntryNames(left.name, right.name));
  const ordered = [...dirs, ...files];
  // 截断发生在排序之后：调用方拿到的始终是「前 N 个」，不是任意 N 个。
  const truncated = ordered.length > MAX_DIRECTORY_ENTRIES;
  return {
    path: realTarget,
    entries: truncated ? ordered.slice(0, MAX_DIRECTORY_ENTRIES) : ordered,
    truncated,
  };
}

/**
 * Register a directory as a workspace root this process may browse.
 *
 * Only an existing directory qualifies; a file or a missing path is a caller
 * mistake, not an empty workspace. The stored value is the realpath so later
 * boundary checks compare physical paths, exactly like the other roots.
 */
export async function registerWorkspaceRoot(rawPath: unknown): Promise<string> {
  if (typeof rawPath !== "string" || rawPath.trim() === "") {
    throw new HttpError(400, "invalid_path", "path 必须是非空字符串");
  }
  if (rawPath.includes("\0")) {
    throw new HttpError(400, "invalid_path", "路径非法");
  }
  const target = path.resolve(rawPath);
  const realTarget = await realpathOrNull(target);
  if (realTarget === null) {
    throw new HttpError(400, "invalid_path", `目录不存在: ${rawPath}`);
  }
  const info = await stat(realTarget);
  if (!info.isDirectory()) {
    throw new HttpError(400, "invalid_path", `不是目录: ${rawPath}`);
  }
  registeredWorkspaceRoots.add(realTarget);
  return realTarget;
}

/** 仅供测试重置进程内登记；生产代码不应调用。 */
export function __resetWorkspaceRootsForTests(): void {
  registeredWorkspaceRoots.clear();
}

/**
 * 本次运行登记过的工作区根（只读快照）。
 *
 * `/api/workspace/resolve` 用它把「上次打开过的工作区」纳入候选搜索范围：
 * 浏览器只给裸文件夹名，而这个进程知道操作员刚才打开过哪些目录。
 */
export function listRegisteredWorkspaceRoots(): string[] {
  return [...registeredWorkspaceRoots];
}

/** 与 `allowedRoots` 同一份已知根的只读快照，供候选搜索取「上次的工作目录」。 */
export async function listKnownReadableRoots(harnessHome: string): Promise<string[]> {
  return allowedRoots(harnessHome);
}

/*
 * `/api/workspace/resolve`：把浏览器拿到的裸文件夹名换成本机绝对路径候选。
 *
 * 浏览器的 `showDirectoryPicker` 只给 `FileSystemDirectoryHandle.name`（如
 * `myproject`），绝不暴露绝对路径；而 `/api/tree` 与 `/api/file` 要绝对路径。
 * 服务端替它做一次**有界**的名字查找：只读目录名、不读文件内容、不跟随符号
 * 链接、不进以 `.` 开头的目录（`.git` / `.cache` / `$HARNESS_HOME` 都在这一类），
 * 并受深度、条目数与总时长三重预算约束。
 *
 * 找到候选不等于授权：候选只是一串路径，真正让它可读的仍然是
 * `POST /api/workspace` 与 `registerWorkspaceRoot`。这里绝不登记、不读内容。
 */

/** 候选搜索的默认深度上限（根的直接子目录为第 1 层）。 */
export const RESOLVE_MAX_DEPTH = 4;

/** 一次搜索最多检查的目录条目数；超出即停止并标记 `truncated`。 */
export const RESOLVE_MAX_ENTRIES = 20000;

/** 一次搜索的总时长预算（毫秒）；到点返回已找到的，不阻塞请求。 */
export const RESOLVE_TIMEOUT_MS = 300;

/** 返回给前端的候选上限：再多就没法在一个列表里挑了。 */
export const MAX_RESOLVE_CANDIDATES = 10;

/** 单个文件夹名的长度上限（大多数文件系统的上限是 255）。 */
const MAX_RESOLVE_NAME_LENGTH = 255;

export interface WorkspaceCandidate {
  path: string;
  name: string;
}

export interface ResolveWorkspaceOptions {
  /** 搜索起点（绝对路径）。不存在的根安静跳过。 */
  roots: string[];
  /** 不进入的目录前缀（`$HARNESS_HOME` 之类）；按 realpath 比较。 */
  exclude?: string[];
  maxDepth?: number;
  maxEntries?: number;
  timeoutMs?: number;
}

export interface ResolveWorkspaceResult {
  candidates: WorkspaceCandidate[];
  /** 预算（深度之外的条目/时长/候选上限）是否截断了搜索。 */
  truncated: boolean;
  /** 实际检查过的目录条目数，测试与诊断用。 */
  scanned: number;
}

/**
 * 校验「文件夹名」。
 *
 * 候选搜索只接受一个名字，不接受路径：一旦允许分隔符或 `..`，这个端点就变成
 * 「任意路径探测」，而它存在的理由恰恰相反。`name` 是外部输入，全部按不可信处理。
 */
function assertSearchName(rawName: unknown): string {
  if (typeof rawName !== "string") {
    throw new HttpError(400, "invalid_name", "name 必须是字符串");
  }
  const name = rawName.trim();
  if (name === "") {
    throw new HttpError(400, "invalid_name", "name 不能为空");
  }
  if (name.length > MAX_RESOLVE_NAME_LENGTH) {
    throw new HttpError(400, "invalid_name", `name 不能超过 ${MAX_RESOLVE_NAME_LENGTH} 个字符`);
  }
  if (name.includes("\0")) {
    throw new HttpError(400, "invalid_name", "name 含非法字符");
  }
  if (name.includes("/") || name.includes("\\")) {
    throw new HttpError(400, "invalid_name", "name 只能是文件夹名，不能包含路径分隔符");
  }
  if (name === "." || name === "..") {
    throw new HttpError(400, "invalid_name", "name 不能是 . 或 ..");
  }
  return name;
}

/** 以 `.` 开头的目录一律不进入，也不作为候选：噪声（`.git`）与配置目录（`$HARNESS_HOME`）。 */
function isDotName(name: string): boolean {
  return name.startsWith(".");
}

/**
 * 候选搜索用的 realpath：任何失败都只是「这个根用不了」，不是请求错误。
 *
 * `realpathOrNull` 只吞 ENOENT/ENOTDIR；搜索的根来自用户主目录与登记的
 * 工作区，路径上任何一段没有权限（EACCES）都会让它抛错，而一次名字查找
 * 不该因此 500。
 */
async function realpathQuietly(value: string): Promise<string | null> {
  try {
    return await realpath(value);
  } catch {
    return null;
  }
}

/**
 * 按文件夹名在给定根下查找同名目录。
 *
 * 广度优先：候选天然按层数从浅到深排列，浅层（更可能是用户指的那个）先返回。
 * 预算用尽时返回已经找到的，并用 `truncated` 说明搜索被截断——「没找到」与
 * 「没找完」是两件事，调用方要分得清（R3）。
 */
export async function resolveWorkspaceCandidates(
  rawName: unknown,
  options: ResolveWorkspaceOptions,
): Promise<ResolveWorkspaceResult> {
  const name = assertSearchName(rawName);
  const maxDepth = options.maxDepth ?? RESOLVE_MAX_DEPTH;
  const maxEntries = options.maxEntries ?? RESOLVE_MAX_ENTRIES;
  const deadline = Date.now() + (options.timeoutMs ?? RESOLVE_TIMEOUT_MS);
  const wanted = normalizeForCompare(name);
  const excluded: string[] = [];
  for (const entry of options.exclude ?? []) {
    const real = await realpathQuietly(entry);
    if (real !== null && real !== "") excluded.push(real);
  }

  const matches: Array<{ path: string; name: string; depth: number }> = [];
  /** 已入队的物理路径：同一个目录被多个根扫到时不重复展开。 */
  const seen = new Set<string>();
  const queue: Array<{ dir: string; depth: number }> = [];
  let scanned = 0;
  let truncated = false;

  for (const rawRoot of options.roots) {
    const real = await realpathQuietly(rawRoot);
    if (real === null) continue;
    const key = normalizeForCompare(real);
    if (seen.has(key) || excluded.some((entry) => isInside(entry, real))) continue;
    seen.add(key);
    queue.push({ dir: real, depth: 0 });
  }

  for (let index = 0; index < queue.length; index += 1) {
    if (Date.now() >= deadline) {
      truncated = true;
      break;
    }
    const current = queue[index];
    if (current === undefined) break;
    const base = path.basename(current.dir);
    if (!isDotName(base) && normalizeForCompare(base) === wanted) {
      matches.push({ path: current.dir, name: base, depth: current.depth });
    }
    if (current.depth >= maxDepth) continue;
    let entries: Dirent[];
    try {
      entries = await readdir(current.dir, { withFileTypes: true });
    } catch {
      // 无权限、已消失、不是目录：跳过这个分支，不能让整次搜索失败。
      continue;
    }
    for (const entry of entries) {
      if (scanned >= maxEntries) {
        truncated = true;
        break;
      }
      scanned += 1;
      if (isDotName(entry.name)) continue;
      // 符号链接一律不跟随：跟着它就能走出搜索根，这条规则与 listDirectory 一致。
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      const child = path.join(current.dir, entry.name);
      const key = normalizeForCompare(child);
      if (seen.has(key) || excluded.some((excludedRoot) => isInside(excludedRoot, child))) continue;
      seen.add(key);
      queue.push({ dir: child, depth: current.depth + 1 });
    }
    if (truncated) break;
  }

  matches.sort(
    (left, right) => left.depth - right.depth || compareEntryNames(left.path, right.path),
  );
  const unique: WorkspaceCandidate[] = [];
  const paths = new Set<string>();
  for (const match of matches) {
    const key = normalizeForCompare(match.path);
    if (paths.has(key)) continue;
    paths.add(key);
    unique.push({ path: match.path, name: match.name });
  }
  if (unique.length > MAX_RESOLVE_CANDIDATES) truncated = true;
  return {
    candidates: unique.slice(0, MAX_RESOLVE_CANDIDATES),
    truncated,
    scanned,
  };
}
