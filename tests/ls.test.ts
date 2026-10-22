import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lsTool } from "../src/tools/ls.js";
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
  const dir = mkdtempSync(path.join(tmpdir(), "eam-ls-"));
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

function run(
  workdir: string,
  input: Parameters<typeof lsTool.execute>[0],
  signalOverride: AbortSignal = signal,
) {
  return lsTool.execute(input, makeCtx(workdir), signalOverride);
}

afterEach(() => {
  if (passthrough) readdirMock.mockImplementation(passthrough);
  readdirMock.mockClear();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("ls 元数据与 schema", () => {
  it("名称、注解与不提供 access（按注解推导为 read）", () => {
    expect(lsTool.name).toBe("ls");
    expect(lsTool.annotations).toEqual({ readOnly: true });
    expect(lsTool.access).toBeUndefined();
  });

  it("path 可选，拒绝非法输入", () => {
    expect(lsTool.schema.safeParse({}).success).toBe(true);
    expect(lsTool.schema.safeParse({ path: "src" }).success).toBe(true);
    expect(lsTool.schema.safeParse({ path: 1 }).success).toBe(false);
  });

  it("description 说明列直接子项且不递归", () => {
    expect(lsTool.description).toContain("目录");
    expect(lsTool.description).toContain("不递归");
  });
});

describe("ls 执行", () => {
  it("目录在前、文件在后，组内按名字排序", async () => {
    const workdir = makeWorkdir();
    mkdirSync(path.join(workdir, "beta"));
    mkdirSync(path.join(workdir, "alpha"));
    writeAt(workdir, "z.txt");
    writeAt(workdir, "a.txt");

    const r = await run(workdir, {});

    expect(r.isError).toBe(false);
    expect(r.code).toBe("ok");
    expect(r.text).toBe(
      ["d  alpha/", "d  beta/", "f  0.0 B  a.txt", "f  0.0 B  z.txt"].join("\n"),
    );
    expect(r.detail).toMatchObject({
      path: ".",
      truncated: false,
      entries: [
        { name: "alpha", type: "dir" },
        { name: "beta", type: "dir" },
        { name: "a.txt", type: "file", size: 0 },
        { name: "z.txt", type: "file", size: 0 },
      ],
    });
  });

  it("文件大小按 B / KB / MB 保留一位小数", async () => {
    const workdir = makeWorkdir();
    writeAt(workdir, "small.txt", "hello");
    writeAt(workdir, "mid.bin", "x".repeat(1536));
    writeAt(workdir, "big.bin", "x".repeat(1024 * 1024 * 1.5));

    const r = await run(workdir, {});

    expect(r.text.split("\n")).toEqual([
      "f  1.5 MB  big.bin",
      "f  1.5 KB  mid.bin",
      "f  5.0 B  small.txt",
    ]);
  });

  // 档位边界此前只被 5 B / 1.5 KB / 1.5 MB 隐式覆盖，换个实现（比如把 1024 的判定写成
  // <= 或改成 1000 进制）就会漂而不被发现。这里把 B→KB、KB→MB 两个切换点两侧钉死。
  it.each([
    { bytes: 0, expected: "0.0 B" },
    { bytes: 1023, expected: "1023.0 B" },
    { bytes: 1024, expected: "1.0 KB" },
    // 1048575 B = 1023.999 KB，经 toFixed(1) 进位成 "1024.0 KB"：档位仍停在 KB。
    // 这是当前 formatSize 的既定行为（信息量没丢，只是没升档），在此固定以免无意改动。
    { bytes: 1024 * 1024 - 1, expected: "1024.0 KB" },
    { bytes: 1024 * 1024, expected: "1.0 MB" },
  ])("$bytes 字节 → $expected", async ({ bytes, expected }) => {
    const workdir = makeWorkdir();
    writeAt(workdir, "probe.bin", "x".repeat(bytes));

    const r = await run(workdir, {});

    expect(r.isError).toBe(false);
    expect(r.text).toBe(`f  ${expected}  probe.bin`);
    // 人类可读单位只发生在文本层；detail 里保留原始字节数，调用方无需反解 "1.5 KB"。
    expect((r.detail as { entries: unknown[] }).entries).toEqual([
      { name: "probe.bin", type: "file", size: bytes },
    ]);
  });

  it("path 指向子目录时 detail.path 相对 workdir", async () => {
    const workdir = makeWorkdir();
    writeAt(workdir, "src/a.txt", "abc");
    writeAt(workdir, "outside.txt");

    const r = await run(workdir, { path: "src" });

    expect(r.isError).toBe(false);
    expect(r.text).toBe("f  3.0 B  a.txt");
    expect(r.detail).toMatchObject({ path: "src", truncated: false });
  });

  // detail.path 是「相对工具根的 POSIX 路径」这一条此前只在报告里给过样例、没有断言。
  // 最容易被改坏的是根目录：path.relative(workdir, workdir) 返回 ""，若直接透传就会得到空串，
  // 而空串在 detail 里与「没给路径」无法区分——所以必须固定成 "."。
  it.each([
    { label: "缺省为工具根", input: {}, expected: "." },
    { label: "显式点", input: { path: "." }, expected: "." },
    { label: "单层子目录", input: { path: "src" }, expected: "src" },
    { label: "多层子目录用 POSIX 分隔", input: { path: "src/nested" }, expected: "src/nested" },
  ])("detail.path：$label → $expected", async ({ input, expected }) => {
    const workdir = makeWorkdir();
    writeAt(workdir, "src/nested/deep.txt", "x");
    writeAt(workdir, "src/keep.txt", "x");

    const r = await run(workdir, input);

    expect(r.isError).toBe(false);
    const { path: reported } = r.detail as { path: string };
    expect(reported).toBe(expected);
    expect(reported).not.toBe("");
    expect(reported.startsWith("./")).toBe(false);
    expect(reported).not.toContain("\\");
  });

  it("空目录 → (empty directory)，不是空字符串也不是错误", async () => {
    const workdir = makeWorkdir();

    const r = await run(workdir, {});

    expect(r.isError).toBe(false);
    expect(r.code).toBe("ok");
    expect(r.text).toBe("(empty directory)");
    expect(r.text).not.toBe("");
    expect(r.detail).toEqual({ path: ".", entries: [], truncated: false });
  });

  it("不做忽略清单：node_modules 与 .git 也如实列出", async () => {
    const workdir = makeWorkdir();
    mkdirSync(path.join(workdir, "node_modules"));
    mkdirSync(path.join(workdir, ".git"));
    writeAt(workdir, "index.ts");

    const r = await run(workdir, {});

    expect(r.text.split("\n")).toEqual([
      "d  .git/",
      "d  node_modules/",
      "f  0.0 B  index.ts",
    ]);
  });

  it("path 指向文件 → not_a_directory", async () => {
    const workdir = makeWorkdir();
    writeAt(workdir, "a.txt", "x");

    const r = await run(workdir, { path: "a.txt" });

    expect(r.isError).toBe(true);
    expect(r.code).toBe("not_a_directory");
    expect(r.message).toContain("a.txt");
  });

  it("不存在的目录 → not_found（含父路径是文件的情形）", async () => {
    const workdir = makeWorkdir();
    writeAt(workdir, "a.txt", "x");

    const missing = await run(workdir, { path: "nope" });
    expect(missing.isError).toBe(true);
    expect(missing.code).toBe("not_found");

    const underFile = await run(workdir, { path: "a.txt/sub" });
    expect(underFile.isError).toBe(true);
    expect(underFile.code).toBe("not_found");
  });

  it("越界路径 → path_outside_workdir", async () => {
    const workdir = makeWorkdir();

    const r = await run(workdir, { path: ".." });

    expect(r.isError).toBe(true);
    expect(r.code).toBe("path_outside_workdir");
  });

  it("超过 500 条时只返回 500 条并如实标记 truncated", async () => {
    const workdir = makeWorkdir();
    for (let index = 0; index < 501; index++) {
      writeAt(workdir, `f${String(index).padStart(3, "0")}.txt`);
    }

    const r = await run(workdir, {});
    const lines = r.text.split("\n");

    expect(lines).toHaveLength(501);
    expect(lines[0]).toBe("f  0.0 B  f000.txt");
    expect(lines[499]).toBe("f  0.0 B  f499.txt");
    expect(lines[500]).toBe("[truncated]");
    expect(r.detail).toMatchObject({ truncated: true });
    expect((r.detail as { entries: unknown[] }).entries).toHaveLength(500);
  });

  it("恰好 500 条不标记 truncated", async () => {
    const workdir = makeWorkdir();
    for (let index = 0; index < 500; index++) {
      writeAt(workdir, `f${String(index).padStart(3, "0")}.txt`);
    }

    const r = await run(workdir, {});
    const lines = r.text.split("\n");

    expect(lines).toHaveLength(500);
    expect(lines).not.toContain("[truncated]");
    expect(r.detail).toMatchObject({ truncated: false });
  });

  it("符号链接只标记不跟随", async (ctx) => {
    const workdir = makeWorkdir();
    mkdirSync(path.join(workdir, "real"));
    writeAt(workdir, "real/a.txt", "x");

    let linked = false;
    try {
      symlinkSync(
        path.join(workdir, "real"),
        path.join(workdir, "link"),
        process.platform === "win32" ? "junction" : "dir",
      );
      linked = true;
    } catch {
      linked = false;
    }
    if (!linked) ctx.skip();

    const r = await run(workdir, {});
    const lines = r.text.split("\n");

    expect(lines).toContain("l  link");
    expect(lines).toContain("d  real/");
    expect(lines).not.toContain("d  link/");
    // 契约只固定「目录在前、文件在后」；symlink 单列一组排在最后（见 TYPE_RANK）。
    expect(r.detail).toEqual({
      path: ".",
      entries: [
        { name: "real", type: "dir" },
        { name: "link", type: "symlink" },
      ],
      truncated: false,
    });
  });
});

describe("ls 取消", () => {
  it("已取消的 signal → aborted 且不读目录", async () => {
    const workdir = makeWorkdir();
    writeAt(workdir, "a.txt", "x");
    const controller = new AbortController();
    controller.abort();
    readdirMock.mockClear();

    const r = await run(workdir, {}, controller.signal);

    expect(r).toMatchObject({ isError: true, code: "aborted" });
    expect(readdirMock).not.toHaveBeenCalled();
  });
});
