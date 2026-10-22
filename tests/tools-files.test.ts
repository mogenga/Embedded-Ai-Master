import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { editTool, multieditTool, readTool, writeTool } from "../src/tools/fs.js";
import type { ToolCtx, ToolDef } from "../src/tools/types.js";

// writeFile 的调用次数是 multiedit 原子性的直接证据:全部替换在内存完成后才落盘,
// 失败路径上必须一次都没调用。因此这里和 fs.test.ts 一样对 fs/promises 做 spy 包装。
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
    writeFile: vi.fn(actual.writeFile),
  };
});

type ReadFileFn = (target: string, encoding?: BufferEncoding) => Promise<string | Buffer>;
type WriteFileFn = (target: string, data: string, encoding?: BufferEncoding) => Promise<void>;

const readFileMock = vi.mocked(readFile as unknown as ReadFileFn);
const passthroughReadFile = readFileMock.getMockImplementation();
const writeFileMock = vi.mocked(writeFile as unknown as WriteFileFn);
const passthroughWriteFile = writeFileMock.getMockImplementation();

const tempDirs: string[] = [];
const signal = new AbortController().signal;

function makeWorkdir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "eam-tools-files-"));
  tempDirs.push(dir);
  return dir;
}

function run<I>(tool: ToolDef<I>, workdir: string, input: I, signalOverride: AbortSignal = signal) {
  const ctx: ToolCtx = { sessionId: "test", cwd: workdir };
  return tool.execute(input, ctx, signalOverride);
}

afterEach(() => {
  if (passthroughReadFile) readFileMock.mockImplementation(passthroughReadFile);
  if (passthroughWriteFile) writeFileMock.mockImplementation(passthroughWriteFile);
  readFileMock.mockClear();
  writeFileMock.mockClear();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("文件工具元数据", () => {
  it("read 只读,且不声明 access(由注解推导为 read)", () => {
    expect(readTool.name).toBe("read");
    expect(readTool.annotations).toEqual({ readOnly: true });
    expect(readTool.access).toBeUndefined();
  });

  it.each([
    ["write", writeTool],
    ["edit", editTool],
    ["multiedit", multieditTool],
  ] as const)("%s 非只读、destructive,access 恒为 write", (name, tool) => {
    expect(tool.name).toBe(name);
    expect(tool.annotations).toEqual({ readOnly: false, destructive: true });
    expect((tool.access as () => string)()).toBe("write");
  });
});

describe("文件工具 schema", () => {
  it.each([
    [{ path: "" }],
    [{ path: "x", offset: -1 }],
    [{ path: "x", limit: 0 }],
    [{ path: "x", limit: 2001 }],
    [{ path: "x", offset: 1.5 }],
    [{}],
  ])("read 拒绝非法输入 %j", (input) => {
    expect(readTool.schema.safeParse(input).success).toBe(false);
  });

  it("read 接受 offset=0 与 limit=2000 的边界值", () => {
    expect(readTool.schema.safeParse({ path: "x", offset: 0, limit: 2000 }).success).toBe(true);
  });

  it.each([
    [{ path: "x" }],
    [{ path: "", content: "x" }],
    [{ path: "x", content: 1 }],
  ])("write 拒绝非法输入 %j", (input) => {
    expect(writeTool.schema.safeParse(input).success).toBe(false);
  });

  it("write 接受空 content(写出空文件是合法操作)", () => {
    expect(writeTool.schema.safeParse({ path: "x", content: "" }).success).toBe(true);
  });

  it.each([
    [{ path: "x", newText: "y" }],
    [{ path: "x", oldText: "a" }],
    [{ path: "", oldText: "a", newText: "b" }],
  ])("edit 拒绝非法输入 %j", (input) => {
    expect(editTool.schema.safeParse(input).success).toBe(false);
  });

  it("edit 接受空 newText(删除)", () => {
    expect(editTool.schema.safeParse({ path: "x", oldText: "a", newText: "" }).success).toBe(true);
  });

  it("multiedit 拒绝空 edits", () => {
    expect(multieditTool.schema.safeParse({ path: "x", edits: [] }).success).toBe(false);
  });

  it("multiedit 拒绝超过 50 条 edits", () => {
    const tooMany = Array.from({ length: 51 }, () => ({ oldText: "a", newText: "b" }));
    expect(multieditTool.schema.safeParse({ path: "x", edits: tooMany }).success).toBe(false);
  });

  it("multiedit 接受 50 条上限", () => {
    const max = Array.from({ length: 50 }, () => ({ oldText: "a", newText: "b" }));
    expect(multieditTool.schema.safeParse({ path: "x", edits: max }).success).toBe(true);
  });

  it.each([
    [{ path: "x", edits: [{ oldText: "a" }] }],
    [{ path: "x", edits: [{}] }],
    [{ path: "x", edits: [{ oldText: "a", newText: 1 }] }],
  ])("multiedit 拒绝缺字段的 edit 项 %j", (input) => {
    expect(multieditTool.schema.safeParse(input).success).toBe(false);
  });
});

describe("multiedit 原子性", () => {
  it("两处都命中时一次调用改两处,且只写一次盘", async () => {
    const workdir = makeWorkdir();
    writeFileSync(path.join(workdir, "note.txt"), "alpha beta gamma", "utf8");

    const r = await run(multieditTool, workdir, {
      path: "note.txt",
      edits: [
        { oldText: "alpha", newText: "ALPHA" },
        { oldText: "gamma", newText: "GAMMA" },
      ],
    });

    expect(r.isError).toBe(false);
    expect(r.detail).toMatchObject({ path: "note.txt", occurrences: 2 });
    expect(readFileSync(path.join(workdir, "note.txt"), "utf8")).toBe("ALPHA beta GAMMA");
    expect(writeFileMock).toHaveBeenCalledTimes(1);
  });

  it("顺序应用:后一个 oldText 在前一个替换结果里查找", async () => {
    const workdir = makeWorkdir();
    writeFileSync(path.join(workdir, "chain.txt"), "one", "utf8");

    const r = await run(multieditTool, workdir, {
      path: "chain.txt",
      edits: [
        { oldText: "one", newText: "two" },
        { oldText: "two", newText: "three" },
      ],
    });

    expect(r.isError).toBe(false);
    expect(readFileSync(path.join(workdir, "chain.txt"), "utf8")).toBe("three");
  });

  it("第二个找不到 → edit_not_found,detail.index=1,文件逐字节不变", async () => {
    const workdir = makeWorkdir();
    const original = "alpha beta\r\ngamma\r\n";
    writeFileSync(path.join(workdir, "note.txt"), original, "utf8");

    const r = await run(multieditTool, workdir, {
      path: "note.txt",
      edits: [
        { oldText: "alpha", newText: "ALPHA" },
        { oldText: "missing", newText: "x" },
      ],
    });

    expect(r).toMatchObject({ isError: true, code: "edit_not_found" });
    expect(r.detail).toMatchObject({ path: "note.txt", index: 1 });
    expect(readFileSync(path.join(workdir, "note.txt"), "utf8")).toBe(original);
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it("第二个不唯一 → edit_not_unique,detail.index=1,文件逐字节不变", async () => {
    const workdir = makeWorkdir();
    const original = "x x keep\n";
    writeFileSync(path.join(workdir, "note.txt"), original, "utf8");

    const r = await run(multieditTool, workdir, {
      path: "note.txt",
      edits: [
        { oldText: "keep", newText: "KEEP" },
        { oldText: "x", newText: "y" },
      ],
    });

    expect(r).toMatchObject({ isError: true, code: "edit_not_unique" });
    expect(r.detail).toMatchObject({ path: "note.txt", index: 1 });
    expect(readFileSync(path.join(workdir, "note.txt"), "utf8")).toBe(original);
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it("oldText 为空 → edit_not_found 且带 detail.index,不写盘", async () => {
    const workdir = makeWorkdir();
    const original = "alpha";
    writeFileSync(path.join(workdir, "note.txt"), original, "utf8");

    const r = await run(multieditTool, workdir, {
      path: "note.txt",
      edits: [
        { oldText: "alpha", newText: "ALPHA" },
        { oldText: "", newText: "x" },
      ],
    });

    expect(r).toMatchObject({ isError: true, code: "edit_not_found" });
    expect(r.detail).toMatchObject({ index: 1 });
    expect(readFileSync(path.join(workdir, "note.txt"), "utf8")).toBe(original);
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it("两条相同 oldText 只出现一次时,第二条 edit_not_found 且不改文件", async () => {
    const workdir = makeWorkdir();
    const original = "only once";
    writeFileSync(path.join(workdir, "note.txt"), original, "utf8");

    const r = await run(multieditTool, workdir, {
      path: "note.txt",
      edits: [
        { oldText: "once", newText: "twice" },
        { oldText: "once", newText: "thrice" },
      ],
    });

    expect(r).toMatchObject({ isError: true, code: "edit_not_found" });
    expect(r.detail).toMatchObject({ index: 1 });
    expect(readFileSync(path.join(workdir, "note.txt"), "utf8")).toBe(original);
  });

  it("writeFile 抛错 → write_failed,且只尝试写一次", async () => {
    const workdir = makeWorkdir();
    writeFileSync(path.join(workdir, "note.txt"), "alpha beta", "utf8");
    writeFileMock.mockRejectedValueOnce(new Error("disk full"));

    const r = await run(multieditTool, workdir, {
      path: "note.txt",
      edits: [
        { oldText: "alpha", newText: "A" },
        { oldText: "beta", newText: "B" },
      ],
    });

    expect(r).toMatchObject({ isError: true, code: "write_failed" });
    expect(writeFileMock).toHaveBeenCalledTimes(1);
    expect(readFileSync(path.join(workdir, "note.txt"), "utf8")).toBe("alpha beta");
  });
});

describe("multiedit 换行风格", () => {
  it("CRLF 文件:多步替换保留 CRLF", async () => {
    const workdir = makeWorkdir();
    writeFileSync(path.join(workdir, "crlf.txt"), "a\r\nb\r\nc\r\nd\r\n", "utf8");

    const r = await run(multieditTool, workdir, {
      path: "crlf.txt",
      edits: [
        { oldText: "b", newText: "x\ny" },
        { oldText: "d", newText: "z" },
      ],
    });

    expect(r.isError).toBe(false);
    expect(readFileSync(path.join(workdir, "crlf.txt"), "utf8")).toBe(
      "a\r\nx\r\ny\r\nc\r\nz\r\n",
    );
  });

  it("混合换行:未触及行的 CRLF 原样保留", async () => {
    const workdir = makeWorkdir();
    writeFileSync(path.join(workdir, "mixed.txt"), "a\r\nb\nc\r\n", "utf8");

    const r = await run(multieditTool, workdir, {
      path: "mixed.txt",
      edits: [
        { oldText: "b", newText: "x" },
        { oldText: "c", newText: "y" },
      ],
    });

    expect(r.isError).toBe(false);
    expect(readFileSync(path.join(workdir, "mixed.txt"), "utf8")).toBe("a\r\nx\ny\r\n");
  });

  it("空替换(删除)不会把被删内容重新拼回", async () => {
    const workdir = makeWorkdir();
    writeFileSync(path.join(workdir, "del.txt"), "abcdef", "utf8");

    const r = await run(multieditTool, workdir, {
      path: "del.txt",
      edits: [{ oldText: "cd", newText: "" }],
    });

    expect(r.isError).toBe(false);
    expect(readFileSync(path.join(workdir, "del.txt"), "utf8")).toBe("abef");
  });
});

describe("multiedit 错误路径", () => {
  it("文件不存在 → not_found", async () => {
    const workdir = makeWorkdir();

    const r = await run(multieditTool, workdir, {
      path: "missing.txt",
      edits: [{ oldText: "a", newText: "b" }],
    });

    expect(r).toMatchObject({ isError: true, code: "not_found" });
  });

  it("越界 → path_outside_workdir", async () => {
    const workdir = makeWorkdir();

    const r = await run(multieditTool, workdir, {
      path: "../note.txt",
      edits: [{ oldText: "a", newText: "b" }],
    });

    expect(r).toMatchObject({ isError: true, code: "path_outside_workdir" });
  });

  it.each(["CON", "sub/NUL", "COM1.txt"])("保留设备名 %s → reserved_name", async (target) => {
    const workdir = makeWorkdir();

    const r = await run(multieditTool, workdir, {
      path: target,
      edits: [{ oldText: "a", newText: "b" }],
    });

    expect(r).toMatchObject({ isError: true, code: "reserved_name" });
  });

  it("readFile 抛错 → read_failed,不写盘", async () => {
    const workdir = makeWorkdir();
    writeFileSync(path.join(workdir, "note.txt"), "alpha", "utf8");
    readFileMock.mockRejectedValueOnce(new Error("EACCES: permission denied"));

    const r = await run(multieditTool, workdir, {
      path: "note.txt",
      edits: [{ oldText: "alpha", newText: "beta" }],
    });

    expect(r).toMatchObject({ isError: true, code: "read_failed" });
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it("已取消 signal 时 multiedit 不改文件", async () => {
    const workdir = makeWorkdir();
    writeFileSync(path.join(workdir, "a.txt"), "hello", "utf8");
    const controller = new AbortController();
    controller.abort();

    const r = await run(
      multieditTool,
      workdir,
      { path: "a.txt", edits: [{ oldText: "hello", newText: "bye" }] },
      controller.signal,
    );

    expect(r).toMatchObject({ isError: true, code: "aborted" });
    expect(readFileSync(path.join(workdir, "a.txt"), "utf8")).toBe("hello");
  });
});

describe("write 空内容", () => {
  it("content 为空串时写出空文件(合法的写,不是错误)", async () => {
    const workdir = makeWorkdir();

    const r = await run(writeTool, workdir, { path: "empty.txt", content: "" });

    expect(r.isError).toBe(false);
    expect(r.text).toBe("wrote 0 bytes to empty.txt");
    expect(r.detail).toMatchObject({ path: "empty.txt", bytes: 0 });
    expect(readFileSync(path.join(workdir, "empty.txt"), "utf8")).toBe("");
  });
});
