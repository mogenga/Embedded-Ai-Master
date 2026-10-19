import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { Dirent, Stats } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { grepTool } from "../src/tools/grep.js";
import type { ToolCtx } from "../src/tools/types.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
    readdir: vi.fn(actual.readdir),
    stat: vi.fn(actual.stat),
  };
});

type ReadFileFn = (target: string) => Promise<Buffer>;
type ReaddirWithTypes = (dir: string, options: { withFileTypes: true }) => Promise<Dirent[]>;
type StatFn = (target: string) => Promise<Stats>;

const readFileMock = vi.mocked(readFile as unknown as ReadFileFn);
const passthrough = readFileMock.getMockImplementation();
const readdirMock = vi.mocked(readdir as unknown as ReaddirWithTypes);
const passthroughReaddir = readdirMock.getMockImplementation();
const statMock = vi.mocked(stat as unknown as StatFn);
const passthroughStat = statMock.getMockImplementation();

const tempDirs: string[] = [];
const signal = new AbortController().signal;
const MIB = 1024 * 1024;

function makeWorkdir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "eam-grep-"));
  tempDirs.push(dir);
  return dir;
}

function makeCtx(workdir: string): ToolCtx {
  return { sessionId: "test", cwd: workdir };
}

function writeAt(workdir: string, relative: string, content: string | Buffer = ""): void {
  const absolute = path.join(workdir, relative);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function fakeFile(name: string): Dirent {
  return {
    name,
    parentPath: "",
    path: "",
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
  } as unknown as Dirent;
}

function run(
  workdir: string,
  input: Parameters<typeof grepTool.execute>[0],
  signalOverride: AbortSignal = signal,
) {
  return grepTool.execute(input, makeCtx(workdir), signalOverride);
}

afterEach(() => {
  if (passthrough) readFileMock.mockImplementation(passthrough);
  if (passthroughReaddir) readdirMock.mockImplementation(passthroughReaddir);
  if (passthroughStat) statMock.mockImplementation(passthroughStat);
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("grepTool 元数据与 schema", () => {
  it("名称与只读注解", () => {
    expect(grepTool.name).toBe("grep");
    expect(grepTool.annotations).toEqual({ readOnly: true });
  });

  it.each([
    {},
    { pattern: "" },
    { pattern: 1 },
    { pattern: "a", path: 1 },
    { pattern: "a", glob: 1 },
    { pattern: "a", ignoreCase: "yes" },
    { pattern: "a", maxResults: 0 },
    { pattern: "a", maxResults: 1001 },
    { pattern: "a", maxResults: 1.5 },
  ])("拒绝非法输入 %j", (input) => {
    expect(grepTool.schema.safeParse(input).success).toBe(false);
  });

  it("接受最小输入与全部可选项", () => {
    expect(grepTool.schema.safeParse({ pattern: "a" }).success).toBe(true);
    expect(
      grepTool.schema.safeParse({
        pattern: "a",
        path: "src",
        glob: "*.ts",
        ignoreCase: true,
        maxResults: 1000,
      }).success,
    ).toBe(true);
  });

  it("description 说明结果相对 workdir", () => {
    expect(grepTool.description).toContain("workdir");
  });
});

describe("grep 执行", () => {
  it("匹配返回 path:line:text 且按路径与行号排序", async () => {
    const workdir = makeWorkdir();
    writeAt(workdir, "b.txt", "alpha\nneedle two\n");
    writeAt(workdir, "a.txt", "needle one\nother\nneedle three\n");

    const r = await run(workdir, { pattern: "needle" });

    expect(r.isError).toBe(false);
    expect(r.code).toBe("ok");
    expect(r.text).toBe(
      [
        "a.txt:1:needle one",
        "a.txt:3:needle three",
        "b.txt:2:needle two",
      ].join("\n"),
    );
    expect(r.text).not.toContain("\\");
    expect(r.detail).toMatchObject({ matched: 3, returned: 3, truncated: false });
  });

  it("ignoreCase 控制大小写敏感", async () => {
    const workdir = makeWorkdir();
    writeAt(workdir, "a.txt", "Hello World\n");

    const sensitive = await run(workdir, { pattern: "hello" });
    expect(sensitive.text).toBe("(no matches)");

    const insensitive = await run(workdir, { pattern: "hello", ignoreCase: true });
    expect(insensitive.text).toBe("a.txt:1:Hello World");
  });

  it("glob 过滤相对 workdir 的文件", async () => {
    const workdir = makeWorkdir();
    writeAt(workdir, "a.ts", "needle\n");
    writeAt(workdir, "b.md", "needle\n");
    writeAt(workdir, "src/c.ts", "needle\n");

    const r = await run(workdir, { pattern: "needle", glob: "**/*.ts" });

    expect(r.text).toBe("a.ts:1:needle\nsrc/c.ts:1:needle");
  });

  it.each([
    "",
    "a\0b",
    "a".repeat(257),
    Array.from({ length: 65 }, () => "a").join("/"),
  ])("非法 glob %j → invalid_pattern", async (glob) => {
    const workdir = makeWorkdir();
    writeAt(workdir, "a.txt", "needle\n");

    const r = await run(workdir, { pattern: "needle", glob });

    expect(r.isError).toBe(true);
    expect(r.code).toBe("invalid_pattern");
  });

  it("无匹配 → (no matches) 且不报错", async () => {
    const workdir = makeWorkdir();
    writeAt(workdir, "a.txt", "alpha\nbeta\n");

    const r = await run(workdir, { pattern: "needle" });

    expect(r.isError).toBe(false);
    expect(r.code).toBe("ok");
    expect(r.text).toBe("(no matches)");
  });

  it("无效正则 → invalid_pattern", async () => {
    const workdir = makeWorkdir();
    writeAt(workdir, "a.txt", "alpha\n");

    const r = await run(workdir, { pattern: "(" });

    expect(r.isError).toBe(true);
    expect(r.code).toBe("invalid_pattern");
  });

  it("空 pattern 直接执行 → invalid_pattern", async () => {
    const workdir = makeWorkdir();
    writeAt(workdir, "a.txt", "alpha\n");

    const r = await run(workdir, { pattern: "" });

    expect(r.isError).toBe(true);
    expect(r.code).toBe("invalid_pattern");
  });

  it("含 NUL 的二进制文件跳过并披露", async () => {
    const workdir = makeWorkdir();
    writeAt(workdir, "bin.dat", Buffer.from("needle\0tail", "utf8"));
    writeAt(workdir, "ok.txt", "needle\n");

    const r = await run(workdir, { pattern: "needle" });

    expect(r.text).toBe("ok.txt:1:needle\n[skipped 1 entries (1 files, 0 unreadable directories)]");
    expect(r.detail).toMatchObject({
      skipped: { binary: 1, tooLarge: 0, unreadableFiles: 0, unreadableDirectories: 0 },
    });
  });

  it("超过 2 MiB 的文件跳过并披露", async () => {
    const workdir = makeWorkdir();
    writeAt(workdir, "big.txt", Buffer.alloc(2 * MIB + 1, 0x61));

    const r = await run(workdir, { pattern: "a" });

    expect(r.isError).toBe(false);
    expect(r.text).toBe("(no matches)\n[skipped 1 entries (1 files, 0 unreadable directories)]");
    expect(r.detail).toMatchObject({
      skipped: { binary: 0, tooLarge: 1, unreadableFiles: 0, unreadableDirectories: 0 },
    });
  });

  it("恰好 2 MiB 的文件仍会读取", async () => {
    const workdir = makeWorkdir();
    const content = Buffer.alloc(2 * MIB, 0x20);
    content.write("needle\n", 0, "utf8");
    for (let offset = 1024; offset < content.length; offset += 1024) content[offset] = 0x0a;
    writeAt(workdir, "limit.txt", content);

    const r = await run(workdir, { pattern: "needle" });

    expect(r.text).toBe("limit.txt:1:needle");
    expect(r.detail).toMatchObject({
      skipped: { binary: 0, tooLarge: 0, unreadableFiles: 0, unreadableDirectories: 0 },
    });
  });

  it("超过 1 MiB 的单行跳过并披露", async () => {
    const workdir = makeWorkdir();
    writeAt(workdir, "long.txt", `needle${"a".repeat(MIB)}`);

    const r = await run(workdir, { pattern: "needle" });

    expect(r.isError).toBe(false);
    expect(r.text).toBe("(no matches)\n[skipped 1 lines longer than 1 MiB]");
    expect(r.detail).toMatchObject({ matched: 0, skippedLongLines: 1 });
  });

  it("扫描 5001 个文件时追加 scan truncated 披露", async () => {
    const workdir = makeWorkdir();
    const files = Array.from({ length: 5001 }, (_, index) => fakeFile(`f${index}.txt`));
    readdirMock.mockImplementation(async (dir) => {
      if (path.resolve(dir) === path.resolve(workdir)) return files;
      return [];
    });
    statMock.mockImplementation(async (target) => {
      if (path.resolve(target) === path.resolve(workdir)) {
        return passthroughStat ? passthroughStat(target) : ({ isDirectory: () => true } as Stats);
      }
      return { isFile: () => true, size: 0 } as Stats;
    });
    readFileMock.mockImplementation(async () => Buffer.from(""));

    const r = await run(workdir, { pattern: "needle" });

    expect(r.isError).toBe(false);
    expect(r.text).toBe("(no matches)\n[scan truncated at 5000 files]");
    expect(r.detail).toMatchObject({ scanned: 5000, scanTruncated: true });
  });

  it("不可读文件跳过并披露", async () => {
    const workdir = makeWorkdir();
    writeAt(workdir, "locked.txt", "needle\n");
    writeAt(workdir, "ok.txt", "needle\n");

    readFileMock.mockImplementation(async (target) => {
      if (path.basename(target) === "locked.txt") {
        const error = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return passthrough ? passthrough(target) : Buffer.alloc(0);
    });

    const r = await run(workdir, { pattern: "needle" });

    expect(r.isError).toBe(false);
    expect(r.text).toBe("ok.txt:1:needle\n[skipped 1 entries (1 files, 0 unreadable directories)]");
    expect(r.detail).toMatchObject({
      skipped: { binary: 0, tooLarge: 0, unreadableFiles: 1, unreadableDirectories: 0 },
    });
  });

  it("根目录不可读 → 合并披露并计入 detail", async () => {
    const workdir = makeWorkdir();
    readdirMock.mockImplementation(async (dir) => {
      if (path.resolve(dir) === path.resolve(workdir)) {
        const error = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return [];
    });

    const r = await run(workdir, { pattern: "needle" });

    expect(r.isError).toBe(false);
    expect(r.text).toBe("(no matches)\n[skipped 1 entries (0 files, 1 unreadable directories)]");
    expect(r.detail).toMatchObject({
      skipped: { binary: 0, tooLarge: 0, unreadableFiles: 0, unreadableDirectories: 1 },
    });
  });

  it("嵌套目录不可读 → 合并披露并计入 detail", async () => {
    const workdir = makeWorkdir();
    mkdirSync(path.join(workdir, "locked"));
    writeAt(workdir, "ok.txt", "needle\n");

    readdirMock.mockImplementation(async (dir, options) => {
      if (path.basename(dir) === "locked") {
        const error = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return passthroughReaddir ? passthroughReaddir(dir, options) : [];
    });

    const r = await run(workdir, { pattern: "needle" });

    expect(r.isError).toBe(false);
    expect(r.text).toBe("ok.txt:1:needle\n[skipped 1 entries (0 files, 1 unreadable directories)]");
    expect(r.detail).toMatchObject({
      skipped: { binary: 0, tooLarge: 0, unreadableFiles: 0, unreadableDirectories: 1 },
    });
  });

  it("默认上限 200 条并标记 truncated", async () => {
    const workdir = makeWorkdir();
    const lines = Array.from({ length: 201 }, (_, index) => `hit ${index}`);
    writeAt(workdir, "a.txt", `${lines.join("\n")}\n`);

    const r = await run(workdir, { pattern: "hit" });
    const output = r.text.split("\n");

    expect(output).toHaveLength(201);
    expect(output[0]).toBe("a.txt:1:hit 0");
    expect(output[199]).toBe("a.txt:200:hit 199");
    expect(output[200]).toBe("[truncated]");
    expect(r.detail).toMatchObject({ matched: 201, returned: 200, truncated: true });
  });

  it("maxResults 可提升到 1000", async () => {
    const workdir = makeWorkdir();
    const lines = Array.from({ length: 1001 }, (_, index) => `hit ${index}`);
    writeAt(workdir, "a.txt", `${lines.join("\n")}\n`);

    const r = await run(workdir, { pattern: "hit", maxResults: 1000 });
    const output = r.text.split("\n");

    expect(output).toHaveLength(1001);
    expect(output[999]).toBe("a.txt:1000:hit 999");
    expect(output[1000]).toBe("[truncated]");
    expect(r.detail).toMatchObject({ matched: 1001, returned: 1000, truncated: true });
  });

  it("path 限定根, 结果仍相对 workdir", async () => {
    const workdir = makeWorkdir();
    writeAt(workdir, "src/nested/a.txt", "needle\n");
    writeAt(workdir, "other/b.txt", "needle\n");

    const r = await run(workdir, { pattern: "needle", path: "src" });

    expect(r.text).toBe("src/nested/a.txt:1:needle");
  });

  it("path 越界 → path_outside_workdir", async () => {
    const workdir = makeWorkdir();

    const r = await run(workdir, { pattern: "needle", path: "../outside" });

    expect(r.isError).toBe(true);
    expect(r.code).toBe("path_outside_workdir");
  });

  it("path 不存在或为文件时报错", async () => {
    const workdir = makeWorkdir();
    writeAt(workdir, "a.txt", "needle\n");

    const missing = await run(workdir, { pattern: "needle", path: "missing" });
    expect(missing.isError).toBe(true);
    expect(missing.code).toBe("not_found");

    const file = await run(workdir, { pattern: "needle", path: "a.txt" });
    expect(file.isError).toBe(true);
    expect(file.code).toBe("not_a_directory");
  });

  it("不跟随 symlink 文件与目录", async (ctx) => {
    const workdir = makeWorkdir();
    writeAt(workdir, "real/a.txt", "needle\n");

    let dirLinked = false;
    try {
      symlinkSync(
        path.join(workdir, "real"),
        path.join(workdir, "linked"),
        process.platform === "win32" ? "junction" : "dir",
      );
      dirLinked = true;
    } catch {
      dirLinked = false;
    }

    let fileLinked = false;
    try {
      symlinkSync(path.join(workdir, "real", "a.txt"), path.join(workdir, "linked.txt"));
      fileLinked = true;
    } catch {
      fileLinked = false;
    }

    if (!dirLinked && !fileLinked) ctx.skip();

    const r = await run(workdir, { pattern: "needle" });

    expect(r.text).toBe("real/a.txt:1:needle");
  });

  it("忽略构建与依赖目录", async () => {
    const workdir = makeWorkdir();
    for (const dir of [
      ".git",
      "node_modules",
      ".harness",
      "dist",
      "coverage",
      "build",
      "out",
      "target",
      ".pio",
      "cmake-build-debug",
    ]) {
      writeAt(workdir, `${dir}/x.txt`, "needle\n");
    }
    writeAt(workdir, "src/keep.txt", "needle\n");

    const r = await run(workdir, { pattern: "needle" });

    expect(r.text).toBe("src/keep.txt:1:needle");
  });

  it("CRLF 行按内容输出且行号正确", async () => {
    const workdir = makeWorkdir();
    writeAt(workdir, "a.txt", "first\r\nneedle\r\nlast\r\n");

    const r = await run(workdir, { pattern: "needle" });

    expect(r.text).toBe("a.txt:2:needle");
  });

  it("无匹配但有跳过时同时披露", async () => {
    const workdir = makeWorkdir();
    writeAt(workdir, "bin.dat", Buffer.from("alpha\0beta", "utf8"));

    const r = await run(workdir, { pattern: "needle" });

    expect(r.isError).toBe(false);
    expect(r.text).toBe("(no matches)\n[skipped 1 entries (1 files, 0 unreadable directories)]");
  });

  it("根 stat 报 ENOTDIR → not_a_directory", async () => {
    const workdir = makeWorkdir();
    writeAt(workdir, "a.txt", "needle\n");
    statMock.mockRejectedValueOnce(
      Object.assign(new Error("ENOTDIR: not a directory"), { code: "ENOTDIR" }),
    );

    const r = await run(workdir, { pattern: "needle", path: "a.txt/child" });

    expect(r.isError).toBe(true);
    expect(r.code).toBe("not_a_directory");
  });

  it("遍历遇到非权限类错误 → read_failed 并保留原始信息", async () => {
    const workdir = makeWorkdir();
    writeAt(workdir, "a.txt", "needle\n");
    readdirMock.mockImplementationOnce(async () => {
      throw "boom";
    });

    const r = await run(workdir, { pattern: "needle" });

    expect(r.isError).toBe(true);
    expect(r.code).toBe("read_failed");
    expect(r.text).toContain("boom");
  });

  it("已取消 signal 时返回 aborted", async () => {
    const workdir = makeWorkdir();
    writeAt(workdir, "a.txt", "needle\n");
    const controller = new AbortController();
    controller.abort();

    const r = await run(workdir, { pattern: "needle" }, controller.signal);

    expect(r).toMatchObject({ isError: true, code: "aborted" });
  });
});