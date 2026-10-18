import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

export type ToolPathErrorCode = "path_outside_workdir" | "path_invalid";

export class ToolPathError extends Error {
  readonly code: ToolPathErrorCode;

  constructor(code: ToolPathErrorCode, message: string) {
    super(message);
    this.name = "ToolPathError";
    this.code = code;
  }
}

function isWithin(base: string, target: string): boolean {
  const rel = path.relative(base, target);
  if (rel === "") return true;
  if (path.isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(`..${path.sep}`);
}

function comparable(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function nearestExistingRealpath(target: string, input: string): string {
  let current = target;
  for (;;) {
    let present = true;
    try {
      lstatSync(current);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw new ToolPathError("path_invalid", `cannot inspect path: ${input}`);
      }
      present = false;
    }
    if (present) {
      try {
        return realpathSync(current);
      } catch {
        throw new ToolPathError("path_invalid", `cannot resolve path: ${input}`);
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new ToolPathError("path_invalid", `cannot resolve path: ${input}`);
    }
    current = parent;
  }
}

export function resolveInWorkdir(workdir: string, input: string): string {
  if (typeof workdir !== "string" || workdir.length === 0) {
    throw new ToolPathError("path_invalid", "workdir is required");
  }
  if (typeof input !== "string" || input.length === 0 || input.includes("\0")) {
    throw new ToolPathError("path_invalid", `invalid path: ${JSON.stringify(input)}`);
  }
  const base = path.resolve(workdir);
  const target = path.resolve(base, input);
  if (!isWithin(base, target)) {
    throw new ToolPathError("path_outside_workdir", `path escapes workdir: ${input}`);
  }
  const realBase = comparable(nearestExistingRealpath(base, workdir));
  const realTarget = comparable(nearestExistingRealpath(target, input));
  if (!isWithin(realBase, realTarget)) {
    throw new ToolPathError("path_outside_workdir", `path escapes workdir via symlink: ${input}`);
  }
  return target;
}