import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveInWorkdir, ToolPathError } from "../src/tools/path-safety.js";

const tempDirs: string[] = [];

function makeTempDir(prefix = "eam-path-"): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function detectSymlinkSupport(): boolean {
  const dir = makeTempDir("eam-path-probe-");
  try {
    const target = path.join(dir, "target.txt");
    writeFileSync(target, "probe", "utf8");
    symlinkSync(target, path.join(dir, "link.txt"), "file");
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") return false;
    throw error;
  }
}

const fileSymlinkSupported = detectSymlinkSupport();

function detectDirLinkSupport(): boolean {
  const dir = makeTempDir("eam-dirlink-probe-");
  try {
    const target = path.join(dir, "target");
    mkdirSync(target);
    symlinkSync(target, path.join(dir, "link"), process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      code === "EPERM" ||
      code === "EACCES" ||
      code === "ENOTSUP" ||
      code === "ENOSYS" ||
      code === "EINVAL"
    ) {
      return false;
    }
    throw error;
  }
}

const dirLinkSupported = detectDirLinkSupport();

function catchPathError(fn: () => unknown): ToolPathError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ToolPathError);
    return error as ToolPathError;
  }
  throw new Error("expected ToolPathError to be thrown");
}

function relativeOf(workdir: string, target: string): string {
  return path.relative(workdir, target);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("resolveInWorkdir 合法路径", () => {
  const workdir = makeTempDir();

  it.each([
    ["a.txt"],
    ["./a.txt"],
    ["sub/../a.txt"],
    ["new/deep/file.txt"],
    ["."],
  ])("接受相对路径 %j", (input) => {
    const resolved = resolveInWorkdir(workdir, input);

    expect(path.isAbsolute(resolved)).toBe(true);
    expect(relativeOf(workdir, resolved).startsWith("..")).toBe(false);
  });

  it("接受 workdir 内的绝对路径", () => {
    const input = path.join(workdir, "abs.txt");

    expect(resolveInWorkdir(workdir, input)).toBe(input);
  });

  it("实现为空目录路径解析到 workdir 本身", () => {
    expect(resolveInWorkdir(workdir, ".")).toBe(workdir);
  });
});

describe("resolveInWorkdir 拒绝越界", () => {
  const workdir = makeTempDir();

  it.each([
    ["../x", "path_outside_workdir"],
    ["a/../../x", "path_outside_workdir"],
    ["..", "path_outside_workdir"],
    ["", "path_invalid"],
    ["\0bad", "path_invalid"],
  ])("%j → %s", (input, code) => {
    const error = catchPathError(() => resolveInWorkdir(workdir, input));

    expect(error.code).toBe(code);
    expect(error.name).toBe("ToolPathError");
  });

  it("拒绝 workdir 外的绝对路径", () => {
    const outside = makeTempDir("eam-outside-");
    const error = catchPathError(() => resolveInWorkdir(workdir, path.join(outside, "x.txt")));

    expect(error.code).toBe("path_outside_workdir");
  });

  it.skipIf(process.platform !== "win32")("拒绝 C:/Windows/x", () => {
    const error = catchPathError(() => resolveInWorkdir(workdir, "C:/Windows/x"));

    expect(error.code).toBe("path_outside_workdir");
  });
});

describe("resolveInWorkdir symlink 边界", () => {
  it.skipIf(!fileSymlinkSupported)("拒绝指向外部的 symlink 文件", () => {
    const workdir = makeTempDir();
    const outside = makeTempDir("eam-outside-");
    writeFileSync(path.join(outside, "secret.txt"), "secret", "utf8");
    symlinkSync(path.join(outside, "secret.txt"), path.join(workdir, "link.txt"), "file");

    const error = catchPathError(() => resolveInWorkdir(workdir, "link.txt"));

    expect(error.code).toBe("path_outside_workdir");
  });

  it.skipIf(!fileSymlinkSupported)("悬空 symlink 文件 fail-closed 为 path_invalid", () => {
    const workdir = makeTempDir();
    const outside = makeTempDir("eam-outside-");
    symlinkSync(path.join(outside, "missing.txt"), path.join(workdir, "dangling.txt"), "file");

    const error = catchPathError(() => resolveInWorkdir(workdir, "dangling.txt"));

    expect(error.code).toBe("path_invalid");
  });

  it.skipIf(!dirLinkSupported)("拒绝经 symlink 目录逃逸(含不存在子文件)", () => {
    const workdir = makeTempDir();
    const outside = makeTempDir("eam-outside-");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    symlinkSync(outside, path.join(workdir, "linkdir"), linkType);

    const error = catchPathError(() => resolveInWorkdir(workdir, "linkdir/new.txt"));

    expect(error.code).toBe("path_outside_workdir");
  });

  it.skipIf(!dirLinkSupported)("允许指向 workdir 内部的 symlink", () => {
    const workdir = makeTempDir();
    const realDir = path.join(workdir, "real");
    mkdirSync(realDir);
    writeFileSync(path.join(realDir, "inside.txt"), "x", "utf8");
    symlinkSync(realDir, path.join(workdir, "alias"), process.platform === "win32" ? "junction" : "dir");

    expect(resolveInWorkdir(workdir, "alias/inside.txt")).toBe(path.join(workdir, "alias", "inside.txt"));
  });
});

describe("resolveInWorkdir Windows 大小写", () => {
  it.skipIf(process.platform !== "win32")("workdir 与输入大小写不同仍视为内部", () => {
    const workdir = makeTempDir();
    writeFileSync(path.join(workdir, "MixedCase.txt"), "x", "utf8");

    const resolved = resolveInWorkdir(workdir.toUpperCase(), "MIXEDCASE.TXT");

    expect(resolved.toLowerCase()).toBe(path.join(workdir, "MixedCase.txt").toLowerCase());
  });
});