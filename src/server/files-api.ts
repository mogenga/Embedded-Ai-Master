import { readdir, readFile, realpath, stat } from "node:fs/promises";
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

/** Same ceiling as the `fs` tool's read: enough for a source file, not a dump. */
export const MAX_PREVIEW_BYTES = 256 * 1024;

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
 * for whoever opened that session.
 */
async function allowedRoots(harnessHome: string): Promise<string[]> {
  const sessionsDir = path.join(harnessHome, "sessions");
  const roots = new Set<string>();
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
