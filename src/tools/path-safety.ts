import { lstatSync, realpathSync } from "node:fs";
import path from "node:path";

export type ToolPathErrorCode = "path_outside_workdir" | "path_outside_root" | "path_invalid";

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
  return resolveBounded(workdir, input, "workdir", "path_outside_workdir");
}

/**
 * 同形的「根内路径」校验，供 artifact 工具使用：`ToolPathErrorCode` 仍会区分
 * 越界与非法路径，但越界码是 `path_outside_root`——调用方不能把它误当成
 * workdir 越界（两者根不同，修复建议也不同）。
 *
 * 与 `resolveInWorkdir` 共用同一套实现（词法 + realpath 双重判定），因此
 * symlink / junction 逃逸、Windows 大小写与 8.3 短名等行为完全一致。
 */
export function resolveUnder(root: string, input: string): string {
  return resolveBounded(root, input, "artifact root", "path_outside_root");
}

function resolveBounded(
  root: string,
  input: string,
  rootLabel: string,
  outsideCode: ToolPathErrorCode,
): string {
  if (typeof root !== "string" || root.length === 0) {
    throw new ToolPathError("path_invalid", `${rootLabel} is required`);
  }
  if (typeof input !== "string" || input.length === 0 || input.includes("\0")) {
    throw new ToolPathError("path_invalid", `invalid path: ${JSON.stringify(input)}`);
  }
  const base = path.resolve(root);
  const target = path.resolve(base, input);
  if (!isWithin(base, target)) {
    throw new ToolPathError(outsideCode, `path escapes ${rootLabel}: ${input}`);
  }
  const realBase = comparable(nearestExistingRealpath(base, root));
  const realTarget = comparable(nearestExistingRealpath(target, input));
  if (!isWithin(realBase, realTarget)) {
    throw new ToolPathError(outsideCode, `path escapes ${rootLabel} via symlink: ${input}`);
  }
  return target;
}