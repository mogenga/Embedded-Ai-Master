import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { globTool, matchesGlob } from "../src/tools/glob.js";
import type { ToolCtx } from "../src/tools/types.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});

type ReaddirWithTypes = (dir: string, options: { withFileTypes: true }) => Promise<Dirent[]>;

const readdirMock = vi.mocked(readdir as unknown as ReaddirWithTypes);
const passthrough = readdirMock.getMockImplementation();

const tempDirs: string[] = [];
const signal = new AbortController().signal;

function makeWorkdir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "eam-glob-"));
  tempDirs.push(dir);
  return dir;
}

function makeCtx(workdir: string): ToolCtx {
  return { sessionId: "test", cwd: workdir };
}

function writeAt(workdir: string, relative: string, content = ""): void {
  const absolute = path.join(workdir, relative);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, "utf8");
}

function run(workdir: string, input: Parameters<typeof globTool.execute>[0]) {
  return globTool.execute(input, makeCtx(workdir), signal);
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

afterEach(() => {
  if (passthrough) readdirMock.mockImplementation(passthrough);
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("globTool 元数据与 schema", () => {
  it("名称与注解", () => {
    expect(globTool.name).toBe("glob");
    expect(globTool.annotations).toEqual({ readOnly: true });
  });

  it.each([{}, { pattern: "" }, { pattern: 1 }, { pattern: "a", path: 1 }])(
    "拒绝非法输入 %j",
    (input) => {
      expect(globTool.schema.safeParse(input).success).toBe(false);
    },
  );

  it("接受最小输入与可选 path", () => {
    expect(globTool.schema.safeParse({ pattern: "*" }).success).toBe(true);
    expect(globTool.schema.safeParse({ pattern: "*", path: "src" }).success).toBe(true);
  });

  it("description 明确 pattern 相对 workdir 且匹配隐藏文件", () => {
    expect(globTool.description).toContain("workdir");
    expect(globTool.description).toContain("隐藏");
  });
});

describe("matchesGlob", () => {
  it("**/*.ts 匹配根级与子目录", () => {
    expect(matchesGlob("a.ts", "**/*.ts")).toBe(true);
    expect(matchesGlob("src/a.ts", "**/*.ts")).toBe(true);
    expect(matchesGlob("src/deep/a.ts", "**/*.ts")).toBe(true);
  });

  it("*.md 只匹配根级", () => {
    expect(matchesGlob("a.md", "*.md")).toBe(true);
    expect(matchesGlob("src/a.md", "*.md")).toBe(false);
  });

  it("? 匹配单字符且不跨目录", () => {
    expect(matchesGlob("a.ts", "?.ts")).toBe(true);
    expect(matchesGlob("ab.ts", "?.ts")).toBe(false);
    expect(matchesGlob("src/a.ts", "?.ts")).toBe(false);
  });

  it("** 可匹配零个或多个目录段", () => {
    expect(matchesGlob("a/b.ts", "a/**/b.ts")).toBe(true);
    expect(matchesGlob("a/x/b.ts", "a/**/b.ts")).toBe(true);
    expect(matchesGlob("a/x/y/b.ts", "a/**/b.ts")).toBe(true);
    expect(matchesGlob("a/x/y", "a/**")).toBe(true);
  });

  it("正则特殊字符按字面量匹配", () => {
    expect(matchesGlob("a+b.ts", "a+b.ts")).toBe(true);
    expect(matchesGlob("aab.ts", "a+b.ts")).toBe(false);
    expect(matchesGlob("[x].ts", "[x].ts")).toBe(true);
  });

  it("空 pattern 与 NUL 返回 false", () => {
    expect(matchesGlob("a.ts", "")).toBe(false);
    expect(matchesGlob("a.ts", "a\0b")).toBe(false);
  });

  it("** 单独匹配任意深度", () => {
    expect(matchesGlob("a", "**")).toBe(true);
    expect(matchesGlob("a/b/c", "**")).toBe(true);
  });

  it("段内 ** 按 * 处理且不跨目录", () => {
    expect(matchesGlob("ab.ts", "a**b.ts")).toBe(true);
    expect(matchesGlob("aXYZb.ts", "a**b.ts")).toBe(true);
    expect(matchesGlob("a/b.ts", "a**b.ts")).toBe(false);
    expect(matchesGlob("a/x/b", "a/**b")).toBe(false);
    expect(matchesGlob("a/x/b", "a/*/b")).toBe(true);
  });

  it("Windows 反斜杠 pattern 规范化为 /", () => {
    expect(matchesGlob("src/a.ts", "src\\*.ts")).toBe(true);
    expect(matchesGlob("src/nested/a.ts", "src\\**\\*.ts")).toBe(true);
  });

  it("* 匹配隐藏文件且大小写敏感", () => {
    expect(matchesGlob(".env", "*")).toBe(true);
    expect(matchesGlob("src/.env", "*")).toBe(false);
    expect(matchesGlob("A.TS", "*.ts")).toBe(false);
  });
});

describe("glob 执行", () => {
  it("递归结果相对 workdir、POSIX 且按字典序排序", async () => {
    const workdir = makeWorkdir();
    writeAt(workdir, "b.ts");
    writeAt(workdir, "a.ts");
    writeAt(workdir, "src/c.ts");
    writeAt(workdir, "src/nested/d.ts");
    writeAt(workdir, "z.md");

    const r = await run(workdir, { pattern: "**/*.ts" });

    expect(r.isError).toBe(false);
    expect(r.code).toBe("ok");
    expect(r.text).toBe("a.ts\nb.ts\nsrc/c.ts\nsrc/nested/d.ts");
    expect(r.text).not.toContain("\\");
  });

  it("path 限定根, 匹配仍相对 workdir", async () => {
    const workdir = makeWorkdir();
    writeAt(workdir, "src/c.ts");
    writeAt(workdir, "src/nested/d.ts");
    writeAt(workdir, "other/e.ts");

    const scoped = await run(workdir, { pattern: "**/*.ts", path: "src" });
    expect(scoped.text).toBe("src/c.ts\nsrc/nested/d.ts");

    const rootOnly = await run(workdir, { pattern: "*.ts", path: "src" });
    expect(rootOnly.text).toBe("(no matches)");
  });

  it("无匹配 → (no matches) 且不报错", async () => {
    const workdir = makeWorkdir();
    writeAt(workdir, "a.ts");

    const r = await run(workdir, { pattern: "*.zzz" });

    expect(r.isError).toBe(false);
    expect(r.code).toBe("ok");
    expect(r.text).toBe("(no matches)");
  });

  it("跳过 .git/node_modules/.harness/dist/coverage", async () => {
    const workdir = makeWorkdir();
    for (const dir of [".git", "node_modules", ".harness", "dist", "coverage"]) {
      writeAt(workdir, `${dir}/x.ts`);
    }
    writeAt(workdir, "src/keep.ts");

    const r = await run(workdir, { pattern: "**/*.ts" });

    expect(r.text).toBe("src/keep.ts");
  });

  it("不跟随 symlink 目录与文件", async (ctx) => {
    const workdir = makeWorkdir();
    writeAt(workdir, "real/a.ts");

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
      symlinkSync(path.join(workdir, "real", "a.ts"), path.join(workdir, "linked-file.ts"));
      fileLinked = true;
    } catch {
      fileLinked = false;
    }

    if (!dirLinked && !fileLinked) ctx.skip();

    const r = await run(workdir, { pattern: "**/*.ts" });

    expect(r.text).toBe("real/a.ts");
  });

  it("结果上限 200 条并标记 truncated", async () => {
    const workdir = makeWorkdir();
    for (let index = 0; index < 250; index++) {
      writeAt(workdir, `f${String(index).padStart(3, "0")}.ts`);
    }

    const r = await run(workdir, { pattern: "*.ts" });
    const lines = r.text.split("\n");

    expect(lines).toHaveLength(201);
    expect(lines[0]).toBe("f000.ts");
    expect(lines[199]).toBe("f199.ts");
    expect(lines[200]).toBe("[truncated]");
    expect(r.detail).toMatchObject({ matched: 250, returned: 200, truncated: true });
  });

  it("扫描文件数上限 5000", async () => {
    const workdir = makeWorkdir();
    const files = Array.from({ length: 5001 }, (_, index) => fakeFile(`f${index}.zzz`));
    readdirMock.mockImplementation(async (dir) => {
      if (path.resolve(dir) === path.resolve(workdir)) return files;
      return [];
    });

    const r = await run(workdir, { pattern: "*.ts" });

    expect(r.text).toContain("(no matches)");
    expect(r.text).toContain("[scan truncated at 5000 files]");
    expect(r.detail).toMatchObject({ scanned: 5000, scanTruncated: true });
  });

  it("非法 pattern → invalid_pattern", async () => {
    const workdir = makeWorkdir();

    const empty = await run(workdir, { pattern: "" });
    expect(empty.isError).toBe(true);
    expect(empty.code).toBe("invalid_pattern");

    const nul = await run(workdir, { pattern: "a\0b" });
    expect(nul.isError).toBe(true);
    expect(nul.code).toBe("invalid_pattern");
  });

  it("path 越界 → path_outside_workdir", async () => {
    const workdir = makeWorkdir();

    const r = await run(workdir, { pattern: "*", path: "../outside" });

    expect(r.isError).toBe(true);
    expect(r.code).toBe("path_outside_workdir");
  });

  it("不可读目录跳过并在 text 末尾披露", async () => {
    const workdir = makeWorkdir();
    mkdirSync(path.join(workdir, "locked"));
    writeAt(workdir, "ok.txt");

    readdirMock.mockImplementation(async (dir, options) => {
      if (path.basename(dir) === "locked") {
        const error = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return passthrough ? passthrough(dir, options) : [];
    });

    const r = await run(workdir, { pattern: "**/*.txt" });

    expect(r.isError).toBe(false);
    expect(r.text).toBe("ok.txt\n[skipped 1 unreadable entries]");
    expect(r.detail).toMatchObject({ skipped: 1 });
  });

  it("跳过 build/out/target/.pio/cmake-build-* 并保留源码", async () => {
    const workdir = makeWorkdir();
    writeAt(workdir, "src/a.c");
    writeAt(workdir, "src/b.c");
    for (let index = 0; index < 200; index++) writeAt(workdir, `build/obj/f${index}.o`);
    writeAt(workdir, "out/x.c");
    writeAt(workdir, "target/y.c");
    writeAt(workdir, ".pio/z.c");
    writeAt(workdir, "cmake-build-debug/w.c");
    writeAt(workdir, "cmake-build-release/v.c");

    const r = await run(workdir, { pattern: "**/*.c" });

    expect(r.text).toBe("src/a.c\nsrc/b.c");
  });

  it("恰好 5000 个文件不标记 scanTruncated", async () => {
    const workdir = makeWorkdir();
    const files = Array.from({ length: 5000 }, (_, index) => fakeFile(`f${index}.zzz`));
    readdirMock.mockImplementation(async (dir) => {
      if (path.resolve(dir) === path.resolve(workdir)) return files;
      return [];
    });

    const r = await run(workdir, { pattern: "*.ts" });

    expect(r.text).toBe("(no matches)");
    expect(r.detail).toMatchObject({ scanned: 5000, scanTruncated: false });
  });

  it("根不可读 → (no matches) 且披露 skipped", async () => {
    const workdir = makeWorkdir();
    readdirMock.mockImplementation(async (dir) => {
      if (path.resolve(dir) === path.resolve(workdir)) {
        const error = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return [];
    });

    const r = await run(workdir, { pattern: "*" });

    expect(r.isError).toBe(false);
    expect(r.text).toBe("(no matches)\n[skipped 1 unreadable entries]");
    expect(r.detail).toMatchObject({ skipped: 1 });
  });

  it("path 不存在/为文件/空串", async () => {
    const workdir = makeWorkdir();
    writeAt(workdir, "a.txt");

    const missing = await run(workdir, { pattern: "*", path: "missing" });
    expect(missing.isError).toBe(true);
    expect(missing.code).toBe("not_found");

    const file = await run(workdir, { pattern: "*", path: "a.txt" });
    expect(file.isError).toBe(true);
    expect(file.code).toBe("not_a_directory");

    const empty = await run(workdir, { pattern: "*", path: "" });
    expect(empty.isError).toBe(true);
    expect(empty.code).toBe("path_invalid");
  });

  it("资源错误 EMFILE → read_failed", async () => {
    const workdir = makeWorkdir();
    mkdirSync(path.join(workdir, "busy"));
    writeAt(workdir, "ok.txt");

    readdirMock.mockImplementation(async (dir, options) => {
      if (path.basename(dir) === "busy") {
        const error = new Error("EMFILE: too many open files") as NodeJS.ErrnoException;
        error.code = "EMFILE";
        throw error;
      }
      return passthrough ? passthrough(dir, options) : [];
    });

    const r = await run(workdir, { pattern: "**/*.txt" });

    expect(r.isError).toBe(true);
    expect(r.code).toBe("read_failed");
  });

  it("显式 path 根为 symlink 目录时跟随", async (ctx) => {
    const workdir = makeWorkdir();
    writeAt(workdir, "real/a.ts");
    try {
      symlinkSync(
        path.join(workdir, "real"),
        path.join(workdir, "link"),
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch {
      ctx.skip();
    }

    const r = await run(workdir, { pattern: "**/*.ts", path: "link" });

    expect(r.text).toBe("link/a.ts");
  });
});
