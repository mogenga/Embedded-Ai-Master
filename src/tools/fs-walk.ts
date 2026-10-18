import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";

export const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  ".harness",
  "dist",
  "coverage",
  "build",
  "out",
  "target",
  ".pio",
]);
export const IGNORED_DIR_PREFIXES = ["cmake-build-"];
export const MAX_SCANNED_FILES = 5000;

const UNREADABLE_CODES = new Set(["EACCES", "EPERM", "ENOENT"]);

export interface WalkState {
  scanned: number;
  skipped: number;
  scanTruncated: boolean;
}

export interface WalkResult {
  state: WalkState;
  error?: unknown;
}

export type FileVisitor = (absolute: string, relative: string) => Promise<void> | void;

export function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

export function isIgnoredDirectory(name: string): boolean {
  if (IGNORED_DIRS.has(name)) return true;
  return IGNORED_DIR_PREFIXES.some((prefix) => name.startsWith(prefix));
}

export function isUnreadable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code !== undefined && UNREADABLE_CODES.has(code);
}

export async function walkFiles(
  root: string,
  workdir: string,
  visit: FileVisitor,
  maxScanned = MAX_SCANNED_FILES,
): Promise<WalkResult> {
  const state: WalkState = { scanned: 0, skipped: 0, scanTruncated: false };

  const walk = async (dir: string, entries: Dirent[]): Promise<unknown | undefined> => {
    for (const entry of entries) {
      if (state.scanned >= maxScanned) {
        state.scanTruncated = true;
        return undefined;
      }
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (isIgnoredDirectory(entry.name)) continue;
        let children: Dirent[];
        try {
          children = await readdir(absolute, { withFileTypes: true });
        } catch (error) {
          if (isUnreadable(error)) {
            state.skipped += 1;
            continue;
          }
          return error;
        }
        const nested = await walk(absolute, children);
        if (nested !== undefined) return nested;
        continue;
      }
      if (!entry.isFile()) continue;
      state.scanned += 1;
      await visit(absolute, toPosix(path.relative(workdir, absolute)));
    }
    return undefined;
  };

  let rootEntries: Dirent[];
  try {
    rootEntries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isUnreadable(error)) {
      state.skipped += 1;
      return { state };
    }
    return { state, error };
  }

  const error = await walk(root, rootEntries);
  return error === undefined ? { state } : { state, error };
}