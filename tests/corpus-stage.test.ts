import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CorpusStageError, parseArgs, stageCorpus } from "../scripts/corpus-stage.mjs";

/**
 * 打包前置脚本测试。
 *
 * 全部在 `mkdtemp` 临时目录内，**绝不触网、不碰真实语料目录**：清单在测试里
 * 现场生成，sha256 由本文件自己算（不 import `src/corpus/manifest.ts` 的
 * `sha256File`——那会让「被测脚本算得对不对」与「参照实现算得对不对」共用同一个
 * 实现，两边一起错就测不出来）。
 *
 * 也不用真实地址/真实公钥：仓库里不出现任何桶地址或密钥字面量。
 */

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** 独立的 sha256 参照实现（与被测脚本各写一份，避免「一起错」）。 */
function sha256Of(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

interface CorpusFile {
  path: string;
  content: string;
}

interface StageFixture {
  corpusDir: string;
  manifestPath: string;
  manifest: Record<string, unknown>;
  files: CorpusFile[];
}

/**
 * 造一套「语料目录 + 已签名清单」。
 *
 * 默认包含：子目录里的 .md、根上的 index.yaml，外加两个**不该被复制**的文件
 * （`_inbox.md` 用户沉淀、`manifest.sha256` 发布侧旧校验文件）——它们正是
 * `mcp-servers/kb/kb` 里的真实情况。
 */
async function setup(
  options: {
    files?: CorpusFile[];
    extraFiles?: CorpusFile[];
    /** 清单里列出、但磁盘上不写出来的文件（模拟「清单点了名，文件没了」）。 */
    manifestOnly?: CorpusFile[];
    /** 篡改落盘内容：清单里的 sha256 仍是原值的。 */
    tamper?: (files: CorpusFile[]) => CorpusFile[];
    /** 直接改清单对象，用于路径逃逸一类用例。 */
    mutateManifest?: (manifest: Record<string, unknown>) => Record<string, unknown>;
  } = {},
): Promise<StageFixture> {
  const root = await tempDir("corpus-stage-");
  const corpusDir = path.join(root, "corpus");
  await mkdir(corpusDir, { recursive: true });

  const files = options.files ?? [
    { path: "index.yaml", content: "version: 1\nentries: []\n" },
    { path: "protocols/uart/no-output.md", content: "# 无输出\n" },
    { path: "getting-started.md", content: "# 入门\n" },
  ];
  const extraFiles = options.extraFiles ?? [
    { path: "_inbox.md", content: "# 用户沉淀，永不进快照\n" },
    { path: "manifest.sha256", content: "deadbeef  index.yaml\n" },
  ];

  for (const file of [...files, ...extraFiles]) {
    const target = path.join(corpusDir, ...file.path.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content, "utf8");
  }

  const manifestOnly = options.manifestOnly ?? [];
  const onDisk = options.tamper === undefined ? files : options.tamper(files);

  const manifest: Record<string, unknown> = {
    manifestVersion: 1,
    corpusVersion: 1,
    publishedAt: "2026-10-24T00:00:00Z",
    files: [...files, ...manifestOnly].map((file) => ({
      path: file.path,
      sha256: sha256Of(file.content),
    })),
    // 打包脚本不验签，这里用形状合法但无意义的值：签名是否有效由运行时校验。
    signature: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
  };

  const finalManifest = options.mutateManifest === undefined ? manifest : options.mutateManifest(manifest);
  const manifestPath = path.join(root, "latest.json");
  await writeFile(manifestPath, `${JSON.stringify(finalManifest, null, 2)}\n`, "utf8");

  // `onDisk` 只用于 tamper 场景：先按清单写一遍，再用被篡改的内容覆盖。
  if (options.tamper !== undefined) {
    for (const file of onDisk) {
      const target = path.join(corpusDir, ...file.path.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.content, "utf8");
    }
  }

  return { corpusDir, manifestPath, manifest: finalManifest, files };
}

/** 递归列出目录下所有文件的 POSIX 相对路径（不含目录本身）。 */
async function listFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const pending = [""];
  while (pending.length > 0) {
    const relative = pending.pop()!;
    const absolute = relative === "" ? root : path.join(root, ...relative.split("/"));
    const entries = await readdir(absolute, { withFileTypes: true });
    for (const entry of entries) {
      const next = relative === "" ? entry.name : `${relative}/${entry.name}`;
      if (entry.isDirectory()) pending.push(next);
      else found.push(next);
    }
  }
  return found.sort();
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** 捕获 `stageCorpus` 抛出的错误；没抛就返回 undefined。 */
async function captureError(promise: Promise<unknown>): Promise<CorpusStageError | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(CorpusStageError);
    return error as CorpusStageError;
  }
}

describe("stageCorpus 正常路径", () => {
  it("产出文件集等于清单 files 的路径集合，且 latest.json 在顶层", async () => {
    const { corpusDir, manifestPath, files } = await setup();
    const outDir = path.join(path.dirname(corpusDir), "out");

    const result = await stageCorpus({ corpusDir, manifestPath, outDir });

    expect(result.verifyOnly).toBe(false);
    expect(result.corpusVersion).toBe(1);
    expect(result.files).toEqual(files.map((file) => file.path));

    const produced = await listFiles(outDir);
    expect(new Set(produced)).toEqual(new Set([...files.map((file) => file.path), "latest.json"]));
    expect(produced).toContain("latest.json");
    // `latestPath` 必须是改名后的最终位置：报暂存路径等于指向一个已不存在的文件。
    expect(result.latestPath).toBe(path.join(outDir, "latest.json"));
    expect(await exists(result.latestPath!)).toBe(true);
  });

  it("清单外的文件不被复制（_inbox.md、manifest.sha256 不在输出里）", async () => {
    const { corpusDir, manifestPath } = await setup();
    const outDir = path.join(path.dirname(corpusDir), "out");

    await stageCorpus({ corpusDir, manifestPath, outDir });

    const produced = await listFiles(outDir);
    expect(produced).not.toContain("_inbox.md");
    expect(produced).not.toContain("manifest.sha256");
  });

  it("文件内容逐字节一致，latest.json 原样写出", async () => {
    const { corpusDir, manifestPath, files } = await setup();
    const outDir = path.join(path.dirname(corpusDir), "out");

    await stageCorpus({ corpusDir, manifestPath, outDir });

    for (const file of files) {
      const copied = await readFile(path.join(outDir, ...file.path.split("/")), "utf8");
      expect(copied).toBe(file.content);
    }
    const stagedManifest = await readFile(path.join(outDir, "latest.json"), "utf8");
    const originalManifest = await readFile(manifestPath, "utf8");
    expect(stagedManifest).toBe(originalManifest);
  });

  it("成功后不留暂存目录", async () => {
    const { corpusDir, manifestPath } = await setup();
    const parent = path.dirname(corpusDir);
    const outDir = path.join(parent, "out");

    await stageCorpus({ corpusDir, manifestPath, outDir });

    const leftovers = (await readdir(parent)).filter((name) => name.startsWith(".corpus-stage-"));
    expect(leftovers).toEqual([]);
  });
});

describe("stageCorpus 失败语义（R3：失败要点名路径）", () => {
  it("语料文件被篡改：失败，点名路径并给出期望值与实际值", async () => {
    const { corpusDir, manifestPath } = await setup({
      tamper: (files) =>
        files.map((file) =>
          file.path === "protocols/uart/no-output.md" ? { ...file, content: "# 被改过\n" } : file,
        ),
    });
    const outDir = path.join(path.dirname(corpusDir), "out");

    const error = await captureError(stageCorpus({ corpusDir, manifestPath, outDir }));

    expect(error).toBeDefined();
    expect(error!.message).toContain("protocols/uart/no-output.md");
    expect(error!.message).toContain("sha256");
    expect(error!.message).toContain(sha256Of("# 无输出\n"));
    expect(error!.message).toContain(sha256Of("# 被改过\n"));
  });

  it("篡改时不产出输出目录（不留半成品）", async () => {
    const { corpusDir, manifestPath } = await setup({
      tamper: (files) => files.map((file) => ({ ...file, content: `${file.content}改` })),
    });
    const parent = path.dirname(corpusDir);
    const outDir = path.join(parent, "out");

    await captureError(stageCorpus({ corpusDir, manifestPath, outDir }));

    expect(await exists(outDir)).toBe(false);
    const leftovers = (await readdir(parent)).filter((name) => name.startsWith(".corpus-stage-"));
    expect(leftovers).toEqual([]);
  });

  it("清单列了语料目录没有的文件：失败并点名该路径", async () => {
    const { corpusDir, manifestPath } = await setup({
      manifestOnly: [{ path: "protocols/missing.md", content: "# 只在清单里\n" }],
    });
    const outDir = path.join(path.dirname(corpusDir), "out");

    const error = await captureError(stageCorpus({ corpusDir, manifestPath, outDir }));

    expect(error).toBeDefined();
    expect(error!.message).toContain("protocols/missing.md");
    expect(await exists(outDir)).toBe(false);
  });
});

describe("stageCorpus 路径逃逸（安全边界）", () => {
  for (const evilPath of ["../evil.md", "../../etc/passwd.md", "/etc/passwd.md", "C:/evil.md", "a/../../evil.md"]) {
    it(`清单 path 为 ${evilPath} 时拒绝`, async () => {
      const { corpusDir, manifestPath } = await setup({
        mutateManifest: (manifest) => ({
          ...manifest,
          files: [{ path: evilPath, sha256: sha256Of("x") }],
        }),
      });
      const parent = path.dirname(corpusDir);
      const outDir = path.join(parent, "out");

      const error = await captureError(stageCorpus({ corpusDir, manifestPath, outDir }));

      expect(error).toBeDefined();
      expect(error!.message).toContain("清单");
      expect(await exists(outDir)).toBe(false);
      // 逃逸目标不能被写出：`../evil.md` 会落在 parent 下。
      expect(await exists(path.join(parent, "evil.md"))).toBe(false);
    });
  }
});

describe("stageCorpus 清单结构校验", () => {
  it("清单不是合法 JSON：失败并说明", async () => {
    const { corpusDir, manifestPath } = await setup();
    const root = path.dirname(corpusDir);
    const brokenPath = path.join(root, "broken.json");
    await writeFile(brokenPath, "{ not json", "utf8");
    const outDir = path.join(root, "out");

    const error = await captureError(stageCorpus({ corpusDir, manifestPath: brokenPath, outDir }));

    expect(error).toBeDefined();
    expect(error!.message).toContain("JSON");
  });

  it("缺 files 字段：失败并点名 files", async () => {
    const { corpusDir, manifestPath } = await setup({
      mutateManifest: ({ files: _files, ...rest }) => rest,
    });
    const outDir = path.join(path.dirname(corpusDir), "out");

    const error = await captureError(stageCorpus({ corpusDir, manifestPath, outDir }));

    expect(error).toBeDefined();
    expect(error!.message).toContain("files");
  });

  it("缺 signature 字段：失败并说明装进安装包会验签失败", async () => {
    const { corpusDir, manifestPath } = await setup({
      mutateManifest: ({ signature: _signature, ...rest }) => rest,
    });
    const outDir = path.join(path.dirname(corpusDir), "out");

    const error = await captureError(stageCorpus({ corpusDir, manifestPath, outDir }));

    expect(error).toBeDefined();
    expect(error!.message).toContain("signature");
  });

  it("files 为空：拒绝产出空语料目录", async () => {
    const { corpusDir, manifestPath } = await setup({
      mutateManifest: (manifest) => ({ ...manifest, files: [] }),
    });
    const outDir = path.join(path.dirname(corpusDir), "out");

    const error = await captureError(stageCorpus({ corpusDir, manifestPath, outDir }));

    expect(error).toBeDefined();
    expect(error!.message).toContain("空");
    expect(await exists(outDir)).toBe(false);
  });

  it("sha256 不是 64 位小写十六进制：失败并点名条目", async () => {
    const { corpusDir, manifestPath } = await setup({
      mutateManifest: (manifest) => ({
        ...manifest,
        files: [{ path: "index.yaml", sha256: "NOT-A-HASH" }],
      }),
    });
    const outDir = path.join(path.dirname(corpusDir), "out");

    const error = await captureError(stageCorpus({ corpusDir, manifestPath, outDir }));

    expect(error).toBeDefined();
    expect(error!.message).toContain("index.yaml");
    expect(error!.message).toContain("sha256");
  });
});

describe("stageCorpus 输出目录", () => {
  it("--out 已存在时拒绝覆盖，且不动原有内容", async () => {
    const { corpusDir, manifestPath } = await setup();
    const outDir = path.join(path.dirname(corpusDir), "out");
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, "keep.txt"), "上一次的产物\n", "utf8");

    const error = await captureError(stageCorpus({ corpusDir, manifestPath, outDir }));

    expect(error).toBeDefined();
    expect(error!.message).toContain("已存在");
    expect(error!.message).toContain(outDir);
    expect(await readFile(path.join(outDir, "keep.txt"), "utf8")).toBe("上一次的产物\n");
  });

  it("--out 位于 --corpus 内部时拒绝", async () => {
    const { corpusDir, manifestPath } = await setup();
    const outDir = path.join(corpusDir, "staged");

    const error = await captureError(stageCorpus({ corpusDir, manifestPath, outDir }));

    expect(error).toBeDefined();
    expect(await exists(outDir)).toBe(false);
  });
});

describe("stageCorpus --verify-only", () => {
  it("不写盘：输出目录不存在", async () => {
    const { corpusDir, manifestPath } = await setup();
    const outDir = path.join(path.dirname(corpusDir), "out");

    const result = await stageCorpus({ corpusDir, manifestPath, outDir, verifyOnly: true });

    expect(result.verifyOnly).toBe(true);
    expect(result.outDir).toBeNull();
    expect(result.latestPath).toBeNull();
    expect(await exists(outDir)).toBe(false);
  });

  it("校验逻辑同样生效：篡改时失败", async () => {
    const { corpusDir, manifestPath } = await setup({
      tamper: (files) =>
        files.map((file) => (file.path === "index.yaml" ? { ...file, content: "version: 999\n" } : file)),
    });

    const error = await captureError(stageCorpus({ corpusDir, manifestPath, verifyOnly: true }));

    expect(error).toBeDefined();
    expect(error!.message).toContain("index.yaml");
  });

  it("不清空也不创建任何暂存目录", async () => {
    const { corpusDir, manifestPath } = await setup();
    const parent = path.dirname(corpusDir);

    await stageCorpus({ corpusDir, manifestPath, verifyOnly: true });

    const leftovers = (await readdir(parent)).filter((name) => name.startsWith(".corpus-stage-"));
    expect(leftovers).toEqual([]);
  });
});

describe("parseArgs", () => {
  it("--help 返回 help", () => {
    expect(parseArgs(["--help"])).toEqual({ help: true });
    expect(parseArgs(["-h"])).toEqual({ help: true });
  });

  it("正常参数", () => {
    expect(parseArgs(["--corpus", "a", "--manifest", "b.json", "--out", "c"])).toEqual({
      corpus: "a",
      manifest: "b.json",
      out: "c",
      verifyOnly: false,
    });
  });

  it("--verify-only 时不需要 --out", () => {
    const parsed = parseArgs(["--corpus", "a", "--manifest", "b.json", "--verify-only"]);
    expect(parsed).toEqual({ corpus: "a", manifest: "b.json", verifyOnly: true });
  });

  it("--verify-only 与 --out 同时出现时拒绝（避免误以为已产出）", () => {
    expect(() => parseArgs(["--corpus", "a", "--manifest", "b.json", "--verify-only", "--out", "c"]))
      .toThrow(CorpusStageError);
  });

  it("缺 --out 且不是 verify-only 时拒绝", () => {
    expect(() => parseArgs(["--corpus", "a", "--manifest", "b.json"])).toThrow(CorpusStageError);
  });

  it("未知参数拒绝", () => {
    expect(() => parseArgs(["--corpus", "a", "--manifest", "b.json", "--out", "c", "--wat"])).toThrow(
      CorpusStageError,
    );
  });

  it("--flag 后缺值不当成空串", () => {
    expect(() => parseArgs(["--corpus", "--manifest", "b.json"])).toThrow(CorpusStageError);
  });
});
