import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  artifactTool,
  DEFAULT_ARTIFACT_LIMIT_BYTES,
  MAX_ARTIFACT_LIMIT_BYTES,
} from "../src/tools/artifact.js";
import type { ArtifactInput } from "../src/tools/artifact.js";
import { executeBatch } from "../src/tools/pipeline.js";
import { ToolRegistry } from "../src/tools/registry.js";
import type { SessionHandle } from "../src/session/session.js";
import type { ToolCtx, ToolDef } from "../src/tools/types.js";

const tempDirs: string[] = [];
const signal = new AbortController().signal;

function makeTempDir(prefix = "eam-artifact-"): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function runArtifact(
  artifactDir: string | undefined,
  input: ArtifactInput,
  signalOverride: AbortSignal = signal,
  cwd = makeTempDir("eam-artifact-cwd-"),
) {
  const ctx: ToolCtx = artifactDir === undefined
    ? { sessionId: "test", cwd }
    : { sessionId: "test", cwd, artifactDir };
  return artifactTool.execute(input, ctx, signalOverride);
}

function detectSymlinkSupport(): boolean {
  const dir = makeTempDir("eam-artifact-probe-");
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
  const dir = makeTempDir("eam-artifact-dirlink-probe-");
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

function makeSession(dir: string): SessionHandle {
  return {
    id: "sess-1",
    dir,
    header: { id: "sess-1", createdAt: "2026-01-01T00:00:00.000Z", status: "open" },
    append: async () => ({ seq: 0, ts: "2026-01-01T00:00:00.000Z", type: "status", payload: {} }),
    events: () => [],
    usageTotals: () => ({ promptTokens: 0, completionTokens: 0, cachedTokens: 0 }),
    close: async () => {},
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("artifact 工具元数据", () => {
  it("只读、非证据，且不声明 access（由注解推导为 read）", () => {
    expect(artifactTool.name).toBe("artifact");
    expect(artifactTool.annotations).toEqual({ readOnly: true, evidence: false });
    expect(artifactTool.access).toBeUndefined();
  });
});

describe("artifact schema", () => {
  it.each([
    [{}],
    [{ path: "" }],
    [{ path: "x", offset: -1 }],
    [{ path: "x", offset: 1.5 }],
    [{ path: "x", limit: 0 }],
    [{ path: "x", limit: 1.5 }],
    [{ path: "x", limit: MAX_ARTIFACT_LIMIT_BYTES + 1 }],
  ])("拒绝非法输入 %j", (input) => {
    expect(artifactTool.schema.safeParse(input).success).toBe(false);
  });

  it("接受 offset=0 与 limit=上限的边界值", () => {
    expect(artifactTool.schema.safeParse({ path: "x", offset: 0 }).success).toBe(true);
    expect(
      artifactTool.schema.safeParse({ path: "x", limit: MAX_ARTIFACT_LIMIT_BYTES }).success,
    ).toBe(true);
  });
});

describe("artifact 读取", () => {
  it("读回落盘在 artifact 根下的文件，正文逐字节一致", async () => {
    const root = makeTempDir();
    const text = "frame 0x1a: 0x20000000\nframe 0x1b: 0x20000004\n";
    writeFileSync(path.join(root, "capture-abc.txt"), text, "utf8");

    const r = await runArtifact(root, { path: "capture-abc.txt" });

    expect(r.isError).toBe(false);
    expect(r.code).toBe("ok");
    expect(r.text).toBe(text);
    expect(r.detail).toMatchObject({
      path: "capture-abc.txt",
      offset: 0,
      bytes: Buffer.byteLength(text, "utf8"),
      size: Buffer.byteLength(text, "utf8"),
      truncated: false,
      nextOffset: Buffer.byteLength(text, "utf8"),
    });
  });

  it("接受子目录相对路径，detail.path 用正斜杠表示", async () => {
    const root = makeTempDir();
    mkdirSync(path.join(root, "nested"));
    writeFileSync(path.join(root, "nested", "dump.txt"), "abcd", "utf8");

    const r = await runArtifact(root, { path: "nested/dump.txt" });

    expect(r.isError).toBe(false);
    expect(r.text).toBe("abcd");
    expect(r.detail).toMatchObject({ path: "nested/dump.txt" });
  });

  it("接受落在根内的绝对路径", async () => {
    const root = makeTempDir();
    const absolute = path.join(root, "abs.txt");
    writeFileSync(absolute, "absolute", "utf8");

    const r = await runArtifact(root, { path: absolute });

    expect(r.isError).toBe(false);
    expect(r.text).toBe("absolute");
  });

  it("空文件返回明确的占位文本，而不是空字符串", async () => {
    const root = makeTempDir();
    writeFileSync(path.join(root, "empty.txt"), "", "utf8");

    const r = await runArtifact(root, { path: "empty.txt" });

    expect(r.isError).toBe(false);
    expect(r.text).toBe("(no bytes at offset)");
    expect(r.detail).toMatchObject({ bytes: 0, size: 0, truncated: false });
  });

  it("offset 超出文件末尾时返回占位文本且不误报截断", async () => {
    const root = makeTempDir();
    writeFileSync(path.join(root, "a.txt"), "abc", "utf8");

    const r = await runArtifact(root, { path: "a.txt", offset: 10 });

    expect(r.isError).toBe(false);
    expect(r.text).toBe("(no bytes at offset)");
    expect(r.detail).toMatchObject({ bytes: 0, truncated: false, nextOffset: 3 });
  });
});

describe("artifact offset/limit 分页", () => {
  it("offset/limit 按字节生效，截断追加 [truncated] 并披露 nextOffset", async () => {
    const root = makeTempDir();
    writeFileSync(path.join(root, "a.txt"), "0123456789", "utf8");

    const r = await runArtifact(root, { path: "a.txt", offset: 3, limit: 4 });

    expect(r.isError).toBe(false);
    expect(r.text).toBe("3456\n[truncated]");
    expect(r.detail).toMatchObject({
      offset: 3,
      bytes: 4,
      truncated: true,
      nextOffset: 7,
    });
  });

  it("按 nextOffset 翻页可以读完剩余内容", async () => {
    const root = makeTempDir();
    writeFileSync(path.join(root, "a.txt"), "0123456789", "utf8");

    const first = await runArtifact(root, { path: "a.txt", offset: 3, limit: 4 });
    const next = (first.detail as { nextOffset: number }).nextOffset;
    const second = await runArtifact(root, { path: "a.txt", offset: next });

    expect(second.isError).toBe(false);
    expect(second.text).toBe("789");
    expect(second.detail).toMatchObject({ truncated: false, nextOffset: 10 });
  });

  it("limit 恰好到文件末尾时不标截断", async () => {
    const root = makeTempDir();
    writeFileSync(path.join(root, "a.txt"), "0123", "utf8");

    const r = await runArtifact(root, { path: "a.txt", limit: 4 });

    expect(r.text).toBe("0123");
    expect(r.detail).toMatchObject({ truncated: false, nextOffset: 4 });
  });

  it("未给 limit 时使用默认上限并如实标记截断", async () => {
    const root = makeTempDir();
    const text = "x".repeat(DEFAULT_ARTIFACT_LIMIT_BYTES + 100);
    writeFileSync(path.join(root, "big.txt"), text, "utf8");

    const r = await runArtifact(root, { path: "big.txt" });

    expect(r.isError).toBe(false);
    expect(r.detail).toMatchObject({
      bytes: DEFAULT_ARTIFACT_LIMIT_BYTES,
      truncated: true,
      nextOffset: DEFAULT_ARTIFACT_LIMIT_BYTES,
    });
    expect(r.text.endsWith("\n[truncated]")).toBe(true);
  });

  it("limit 落在多字节字符中间时回退到完整字符，不产生替换符", async () => {
    const root = makeTempDir();
    writeFileSync(path.join(root, "zh.txt"), "中文字符", "utf8");

    const r = await runArtifact(root, { path: "zh.txt", limit: 4 });

    expect(r.isError).toBe(false);
    expect(r.text).toBe("中\n[truncated]");
    expect(r.text).not.toContain("�");
    expect(r.detail).toMatchObject({ bytes: 3, truncated: true, nextOffset: 3 });
  });

  it("limit 小于一个字符时仍返回一个完整字符且继续有进展", async () => {
    const root = makeTempDir();
    writeFileSync(path.join(root, "zh.txt"), "中文字符", "utf8");

    const r = await runArtifact(root, { path: "zh.txt", limit: 1 });

    expect(r.isError).toBe(false);
    expect(r.text).toBe("中\n[truncated]");
    expect(r.text).not.toContain("�");
    expect(r.detail).toMatchObject({ bytes: 3, truncated: true, nextOffset: 3 });
  });

  it("offset 落在多字节字符中间时从下一个完整字符开始", async () => {
    const root = makeTempDir();
    writeFileSync(path.join(root, "zh.txt"), "中文字符", "utf8");

    const r = await runArtifact(root, { path: "zh.txt", offset: 1 });

    expect(r.isError).toBe(false);
    expect(r.text).toBe("文字符");
    expect(r.text).not.toContain("�");
    expect(r.detail).toMatchObject({ offset: 3, bytes: 9, truncated: false });
  });
});

describe("artifact 路径边界", () => {
  it("../ 逃逸 → path_outside_root", async () => {
    const root = makeTempDir();

    const r = await runArtifact(root, { path: "../outside.txt" });

    expect(r).toMatchObject({ isError: true, code: "path_outside_root" });
  });

  it("根外绝对路径 → path_outside_root", async () => {
    const root = makeTempDir();
    const outside = makeTempDir("eam-artifact-outside-");
    writeFileSync(path.join(outside, "secret.txt"), "secret", "utf8");

    const r = await runArtifact(root, { path: path.join(outside, "secret.txt") });

    expect(r).toMatchObject({ isError: true, code: "path_outside_root" });
  });

  it.skipIf(!fileSymlinkSupported)("指向根外的 symlink 文件 → path_outside_root", async () => {
    const root = makeTempDir();
    const outside = makeTempDir("eam-artifact-outside-");
    writeFileSync(path.join(outside, "secret.txt"), "secret", "utf8");
    symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link.txt"), "file");

    const r = await runArtifact(root, { path: "link.txt" });

    expect(r).toMatchObject({ isError: true, code: "path_outside_root" });
  });

  it.skipIf(!fileSymlinkSupported)("悬空 symlink fail-closed 为 path_invalid", async () => {
    const root = makeTempDir();
    const outside = makeTempDir("eam-artifact-outside-");
    symlinkSync(path.join(outside, "missing.txt"), path.join(root, "dangling.txt"), "file");

    const r = await runArtifact(root, { path: "dangling.txt" });

    expect(r).toMatchObject({ isError: true, code: "path_invalid" });
  });

  it.skipIf(!dirLinkSupported)("经 symlink 目录逃逸 → path_outside_root", async () => {
    const root = makeTempDir();
    const outside = makeTempDir("eam-artifact-outside-");
    const linkType = process.platform === "win32" ? "junction" : "dir";
    symlinkSync(outside, path.join(root, "linkdir"), linkType);

    const r = await runArtifact(root, { path: "linkdir/new.txt" });

    expect(r).toMatchObject({ isError: true, code: "path_outside_root" });
  });
});

describe("artifact 根缺失与文件缺失可区分", () => {
  it("artifactDir 未设置 → artifact_dir_missing，且不回退到 cwd", async () => {
    const cwd = makeTempDir("eam-artifact-cwd-");
    writeFileSync(path.join(cwd, "a.txt"), "in cwd", "utf8");

    const r = await runArtifact(undefined, { path: "a.txt" }, signal, cwd);

    expect(r).toMatchObject({ isError: true, code: "artifact_dir_missing" });
  });

  it("artifactDir 为空串 → artifact_dir_missing", async () => {
    const r = await runArtifact("", { path: "a.txt" });

    expect(r).toMatchObject({ isError: true, code: "artifact_dir_missing" });
  });

  it("artifactDir 指向不存在的目录 → artifact_dir_missing", async () => {
    const root = makeTempDir();
    const missingRoot = path.join(root, "no-such-dir");

    const r = await runArtifact(missingRoot, { path: "a.txt" });

    expect(r).toMatchObject({ isError: true, code: "artifact_dir_missing" });
  });

  it("artifactDir 指向普通文件 → artifact_dir_missing", async () => {
    const root = makeTempDir();
    const fileRoot = path.join(root, "not-a-dir");
    writeFileSync(fileRoot, "x", "utf8");

    const r = await runArtifact(fileRoot, { path: "a.txt" });

    expect(r).toMatchObject({ isError: true, code: "artifact_dir_missing" });
  });

  it("文件不存在与目录不存在是两个错误码", async () => {
    const root = makeTempDir();

    const missingFile = await runArtifact(root, { path: "ghost.txt" });
    const missingDir = await runArtifact(path.join(root, "no-such-dir"), { path: "ghost.txt" });

    expect(missingFile.code).toBe("not_found");
    expect(missingDir.code).toBe("artifact_dir_missing");
    expect(missingFile.code).not.toBe(missingDir.code);
  });

  it("目录作为 path → not_a_file", async () => {
    const root = makeTempDir();
    mkdirSync(path.join(root, "sub"));

    const r = await runArtifact(root, { path: "sub" });

    expect(r).toMatchObject({ isError: true, code: "not_a_file" });
  });

  it("已取消的 signal → aborted", async () => {
    const root = makeTempDir();
    writeFileSync(path.join(root, "a.txt"), "content", "utf8");
    const controller = new AbortController();
    controller.abort();

    const r = await runArtifact(root, { path: "a.txt" }, controller.signal);

    expect(r).toMatchObject({ isError: true, code: "aborted" });
  });
});

describe("pipeline 与 artifact 共用同一个产物根", () => {
  it("pipeline 落盘的大输出可被 artifact 读回，且工具 ctx.artifactDir 就是落盘目录", async () => {
    const sessionDir = makeTempDir("eam-artifact-session-");
    const root = path.join(sessionDir, "artifacts");
    const text = "x".repeat(40000);
    let received: ToolCtx | undefined;
    const bigTool: ToolDef<{}> = {
      name: "big",
      description: "大输出",
      schema: z.object({}),
      annotations: { readOnly: true },
      execute: async (_input, ctx) => {
        received = ctx;
        return { isError: false, code: "ok", message: "", text };
      },
    };

    const results = await executeBatch(
      makeSession(sessionDir),
      new ToolRegistry([bigTool]),
      [{ id: "big-1", name: "big", input: {} }],
      { signal, artifactDir: root, unsafeSkipPermission: true },
    );

    expect(received?.artifactDir).toBe(root);
    const artifactPath = results[0].result.artifactPath;
    expect(typeof artifactPath).toBe("string");
    const relative = path.relative(root, String(artifactPath));
    // 默认 limit 只有 24 KiB，这里显式放大到全文长度以验证逐字节读回。
    const readBack = await runArtifact(root, { path: relative, limit: text.length });

    expect(readBack.isError).toBe(false);
    expect(readBack.text).toBe(text);
  });
});
