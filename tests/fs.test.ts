import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fsTool } from "../src/tools/fs.js";
import type { ToolCtx } from "../src/tools/types.js";

const tempDirs: string[] = [];
const signal = new AbortController().signal;

function makeWorkdir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "eam-fs-"));
  tempDirs.push(dir);
  return dir;
}

function run(workdir: string, input: Parameters<typeof fsTool.execute>[0]) {
  const ctx: ToolCtx = { sessionId: "test", cwd: workdir };
  return fsTool.execute(input, ctx, signal);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("fsTool 元数据与 schema", () => {
  it("名称与注解", () => {
    expect(fsTool.name).toBe("fs");
    expect(fsTool.annotations).toEqual({ readOnly: false, destructive: true });
  });

  it.each([
    [{ op: "delete", path: "x" }],
    [{ op: "read", path: "" }],
    [{ op: "read", path: "x", offset: -1 }],
    [{ op: "read", path: "x", limit: 0 }],
    [{ op: "read", path: "x", limit: 2001 }],
    [{ op: "read", path: "x", offset: 1.5 }],
  ])("拒绝非法输入 %j", (input) => {
    expect(fsTool.schema.safeParse(input).success).toBe(false);
  });

  it("write 的 content 在 schema 层可选(运行时校验)", () => {
    expect(fsTool.schema.safeParse({ op: "write", path: "x" }).success).toBe(true);
  });
});

describe("fs read", () => {
  it("返回 1-based 行号内容", async () => {
    const workdir = makeWorkdir();
    writeFileSync(path.join(workdir, "a.txt"), "alpha\nbeta\ngamma\n", "utf8");

    const r = await run(workdir, { op: "read", path: "a.txt" });

    expect(r.isError).toBe(false);
    expect(r.text).toBe("   1| alpha\n   2| beta\n   3| gamma");
  });

  it("保留 UTF-8 中文内容", async () => {
    const workdir = makeWorkdir();
    writeFileSync(path.join(workdir, "zh.txt"), "第一行\n第二行", "utf8");

    const r = await run(workdir, { op: "read", path: "zh.txt" });

    expect(r.text).toBe("   1| 第一行\n   2| 第二行");
  });

  it("支持 offset/limit 窗口", async () => {
    const workdir = makeWorkdir();
    writeFileSync(path.join(workdir, "a.txt"), "a\nb\nc\n", "utf8");

    const r = await run(workdir, { op: "read", path: "a.txt", offset: 1, limit: 1 });

    expect(r.text).toContain("   2| b");
    expect(r.text).not.toContain("   1| a");
    expect(r.text).not.toContain("   3| c");
  });

  it("默认最多 2000 行并标记截断", async () => {
    const workdir = makeWorkdir();
    const lines = Array.from({ length: 2005 }, (_, i) => `line-${i + 1}`);
    writeFileSync(path.join(workdir, "big.txt"), lines.join("\n"), "utf8");

    const r = await run(workdir, { op: "read", path: "big.txt" });

    expect(r.isError).toBe(false);
    expect(r.text).toContain("2000| line-2000");
    expect(r.text).not.toContain("line-2001");
    expect(r.text.endsWith("[truncated]")).toBe(true);
  });

  it("超过 256KiB 时截断", async () => {
    const workdir = makeWorkdir();
    const line = "x".repeat(400);
    const content = Array.from({ length: 700 }, () => line).join("\n");
    writeFileSync(path.join(workdir, "wide.txt"), content, "utf8");

    const r = await run(workdir, { op: "read", path: "wide.txt" });

    expect(r.isError).toBe(false);
    expect(r.text.endsWith("[truncated]")).toBe(true);
    expect(Buffer.byteLength(r.text, "utf8")).toBeLessThan(256 * 1024 + 32);
  });

  it("不存在 → not_found,不返回空内容", async () => {
    const workdir = makeWorkdir();

    const r = await run(workdir, { op: "read", path: "missing.txt" });

    expect(r.isError).toBe(true);
    expect(r.code).toBe("not_found");
    expect(r.text.length).toBeGreaterThan(0);
  });

  it("目录 → not_a_file", async () => {
    const workdir = makeWorkdir();
    mkdirSync(path.join(workdir, "dir"));

    const r = await run(workdir, { op: "read", path: "dir" });

    expect(r.isError).toBe(true);
    expect(r.code).toBe("not_a_file");
  });

  it("越界 → path_outside_workdir", async () => {
    const workdir = makeWorkdir();

    const r = await run(workdir, { op: "read", path: "../secret.txt" });

    expect(r.isError).toBe(true);
    expect(r.code).toBe("path_outside_workdir");
  });
});

describe("fs write", () => {
  it("创建父目录并返回字节数", async () => {
    const workdir = makeWorkdir();

    const r = await run(workdir, { op: "write", path: "a/b/c.txt", content: "你好" });

    expect(r.isError).toBe(false);
    expect(r.text).toBe("wrote 6 bytes to a/b/c.txt");
    expect(readFileSync(path.join(workdir, "a/b/c.txt"), "utf8")).toBe("你好");
  });

  it("覆盖已有文件", async () => {
    const workdir = makeWorkdir();
    writeFileSync(path.join(workdir, "x.txt"), "old", "utf8");

    const r = await run(workdir, { op: "write", path: "x.txt", content: "new-content" });

    expect(r.isError).toBe(false);
    expect(readFileSync(path.join(workdir, "x.txt"), "utf8")).toBe("new-content");
  });

  it("缺 content → invalid_input", async () => {
    const workdir = makeWorkdir();

    const r = await run(workdir, { op: "write", path: "x.txt" });

    expect(r).toMatchObject({ isError: true, code: "invalid_input" });
    expect(existsSync(path.join(workdir, "x.txt"))).toBe(false);
  });

  it("越界 → path_outside_workdir 且不落盘", async () => {
    const workdir = makeWorkdir();

    const r = await run(workdir, { op: "write", path: "../escape.txt", content: "x" });

    expect(r).toMatchObject({ isError: true, code: "path_outside_workdir" });
    expect(existsSync(path.join(path.dirname(workdir), "escape.txt"))).toBe(false);
  });
});

describe("fs edit", () => {
  it("唯一匹配替换并写回", async () => {
    const workdir = makeWorkdir();
    writeFileSync(path.join(workdir, "note.txt"), "alpha beta", "utf8");

    const r = await run(workdir, {
      op: "edit",
      path: "note.txt",
      oldText: "beta",
      newText: "gamma",
    });

    expect(r.isError).toBe(false);
    expect(r.text).toBe("replaced 1 occurrence in note.txt");
    expect(readFileSync(path.join(workdir, "note.txt"), "utf8")).toBe("alpha gamma");
  });

  it("newText 可为空(删除)", async () => {
    const workdir = makeWorkdir();
    writeFileSync(path.join(workdir, "note.txt"), "keep drop", "utf8");

    const r = await run(workdir, {
      op: "edit",
      path: "note.txt",
      oldText: " drop",
      newText: "",
    });

    expect(r.isError).toBe(false);
    expect(readFileSync(path.join(workdir, "note.txt"), "utf8")).toBe("keep");
  });

  it("oldText 不存在 → edit_not_found 且文件不变", async () => {
    const workdir = makeWorkdir();
    writeFileSync(path.join(workdir, "note.txt"), "alpha", "utf8");

    const r = await run(workdir, {
      op: "edit",
      path: "note.txt",
      oldText: "zzz",
      newText: "y",
    });

    expect(r).toMatchObject({ isError: true, code: "edit_not_found" });
    expect(readFileSync(path.join(workdir, "note.txt"), "utf8")).toBe("alpha");
  });

  it("oldText 多处匹配 → edit_not_unique 且文件不变", async () => {
    const workdir = makeWorkdir();
    writeFileSync(path.join(workdir, "note.txt"), "a a", "utf8");

    const r = await run(workdir, {
      op: "edit",
      path: "note.txt",
      oldText: "a",
      newText: "b",
    });

    expect(r).toMatchObject({ isError: true, code: "edit_not_unique" });
    expect(readFileSync(path.join(workdir, "note.txt"), "utf8")).toBe("a a");
  });

  it.each([
    [{ op: "edit", path: "note.txt", newText: "y" }],
    [{ op: "edit", path: "note.txt", oldText: "a" }],
    [{ op: "edit", path: "note.txt", oldText: "", newText: "y" }],
  ])("缺 oldText/newText → invalid_input (%j)", async (input) => {
    const workdir = makeWorkdir();
    writeFileSync(path.join(workdir, "note.txt"), "a", "utf8");

    const r = await run(workdir, input as Parameters<typeof fsTool.execute>[0]);

    expect(r).toMatchObject({ isError: true, code: "invalid_input" });
    expect(readFileSync(path.join(workdir, "note.txt"), "utf8")).toBe("a");
  });

  it("文件不存在 → not_found", async () => {
    const workdir = makeWorkdir();

    const r = await run(workdir, {
      op: "edit",
      path: "missing.txt",
      oldText: "a",
      newText: "b",
    });

    expect(r).toMatchObject({ isError: true, code: "not_found" });
  });

  it("越界 → path_outside_workdir", async () => {
    const workdir = makeWorkdir();

    const r = await run(workdir, {
      op: "edit",
      path: "../note.txt",
      oldText: "a",
      newText: "b",
    });

    expect(r).toMatchObject({ isError: true, code: "path_outside_workdir" });
  });
});