import { execFile } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  canonicalize,
  parseManifest,
  sha256File,
  signManifestPayload,
  verifyManifestSignature,
} from "../src/corpus/manifest.js";
import { CorpusPublishError, publishCorpus } from "../scripts/corpus-publish-lib.mjs";

/**
 * 发布脚本测试。
 *
 * 两条原则：
 * 1. **密钥全部现场生成**——仓库里不出现任何私钥/公钥字面量，也不读用户真实
 *    密钥目录（`~/.corpus-signing/`）。
 * 2. 核心逻辑走 `publishCorpus` 直接单测（快、失败点明确）；只有「退出码 / usage /
 *    私钥不外泄」这类属于 CLI 壳的行为才起子进程。
 *
 * 子进程用例依赖 `dist/corpus/manifest.js`（脚本运行时从 dist 导入）。缺失时跳过
 * 而不是失败：这是「还没 build」，不是「代码坏了」——但跳过原因要打印出来，
 * 让「跳过」不会被读成「通过」。
 */

const ROOT = path.join(import.meta.dirname, "..");
const CLI = path.join(ROOT, "scripts", "corpus-publish.mjs");
const DIST_MANIFEST = path.join(ROOT, "dist", "corpus", "manifest.js");
const DIST_INBOX = path.join(ROOT, "dist-mcp", "kb", "inbox.js");
const HAS_DIST = existsSync(DIST_MANIFEST) && existsSync(DIST_INBOX);

const manifestApi = {
  canonicalize,
  parseManifest,
  signManifestPayload,
  verifyManifestSignature,
  sha256File,
};

let privateKeyPem;
let publicKeyPem;
let privateKeyPath;
const tempDirs = [];

beforeAll(async () => {
  const pair = generateKeyPairSync("ed25519");
  privateKeyPem = String(pair.privateKey.export({ type: "pkcs8", format: "pem" }));
  publicKeyPem = String(pair.publicKey.export({ type: "spki", format: "pem" }));
});

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
  privateKeyPath = undefined;
});

async function tempDir(prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** 造一个小语料：两个 .md（其中一个在子目录）、一个 index.yaml、一个 _inbox.md。 */
async function makeCorpus() {
  const root = await tempDir("corpus-publish-src-");
  await mkdir(path.join(root, "protocols", "uart"), { recursive: true });
  await writeFile(path.join(root, "index.yaml"), "version: 1\nentries: []\n", "utf8");
  await writeFile(path.join(root, "protocols", "uart", "no-output.md"), "# 无输出\n", "utf8");
  await writeFile(path.join(root, "getting-started.md"), "# 入门\n", "utf8");
  // 用户本地沉淀：必须被排除，否则 OTA 会冲掉它。
  await writeFile(path.join(root, "_inbox.md"), "# inbox\n不该进清单\n", "utf8");
  return root;
}

async function writeKey() {
  const dir = await tempDir("corpus-publish-key-");
  const keyPath = path.join(dir, "corpus-signing.key");
  await writeFile(keyPath, privateKeyPem, "utf8");
  privateKeyPath = keyPath;
  return keyPath;
}

function runCli(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: "utf8" }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : (error.code ?? 1), stdout, stderr });
    });
  });
}

describe("publishCorpus", () => {
  it("正常发布：清单可解析、用对应公钥验签通过", async () => {
    const corpusDir = await makeCorpus();
    const outDir = await tempDir("corpus-publish-out-");

    const result = await publishCorpus({
      corpusDir,
      outDir,
      version: 2,
      privateKeyPem,
      manifestApi,
      excludeNames: ["_inbox.md", "_reviewed.md"],
    });

    const raw = await readFile(path.join(outDir, "latest.json"), "utf8");
    const manifest = parseManifest(JSON.parse(raw));
    expect(manifest.manifestVersion).toBe(1);
    expect(manifest.corpusVersion).toBe(2);
    expect(manifest.publishedAt.endsWith("Z")).toBe(true);
    expect(verifyManifestSignature(manifest, publicKeyPem)).toBe(true);
    expect(result.manifest.signature).toBe(manifest.signature);

    // 产物目录里语料正文已就位，且与清单一致。
    expect(existsSync(path.join(outDir, "protocols", "uart", "no-output.md"))).toBe(true);
    expect(existsSync(path.join(outDir, "index.yaml"))).toBe(true);
    expect(await sha256File(path.join(outDir, "index.yaml"))).toBe(
      manifest.files.find((file) => file.path === "index.yaml").sha256,
    );
  });

  it("_inbox.md 不在 files 里，并报告跳过原因", async () => {
    const corpusDir = await makeCorpus();
    const outDir = await tempDir("corpus-publish-out-");
    const logs = [];

    const result = await publishCorpus({
      corpusDir,
      outDir,
      version: 1,
      privateKeyPem,
      manifestApi,
      excludeNames: ["_inbox.md", "_reviewed.md"],
      log: (message) => logs.push(message),
    });

    expect(result.manifest.files.map((file) => file.path)).not.toContain("_inbox.md");
    expect(result.skipped.map((entry) => entry.path)).toEqual(["_inbox.md"]);
    expect(logs.some((line) => line.includes("_inbox.md"))).toBe(true);
    // 被排除的文件也不该被复制进输出目录。
    expect(existsSync(path.join(outDir, "_inbox.md"))).toBe(false);
  });

  it("files 按 path 字典序", async () => {
    const corpusDir = await makeCorpus();
    const outDir = await tempDir("corpus-publish-out-");

    const result = await publishCorpus({
      corpusDir,
      outDir,
      version: 1,
      privateKeyPem,
      manifestApi,
      excludeNames: ["_inbox.md"],
    });

    const paths = result.manifest.files.map((file) => file.path);
    expect(paths).toEqual(["getting-started.md", "index.yaml", "protocols/uart/no-output.md"]);
    expect(paths).toEqual([...paths].sort());
  });

  it("同样输入跑两次，除 publishedAt 外产出相同字节", async () => {
    const corpusDir = await makeCorpus();
    const logs = [];
    const options = {
      corpusDir,
      version: 7,
      privateKeyPem,
      manifestApi,
      excludeNames: ["_inbox.md"],
      log: (message) => logs.push(message),
    };

    const first = await publishCorpus({ ...options, outDir: await tempDir("corpus-publish-a-") });
    const second = await publishCorpus({ ...options, outDir: await tempDir("corpus-publish-b-") });

    expect(second.manifest.files).toEqual(first.manifest.files);
    expect(second.manifest.corpusVersion).toBe(first.manifest.corpusVersion);
    expect(second.manifest.manifestVersion).toBe(first.manifest.manifestVersion);

    // 排除 publishedAt 后，规范字节必须逐字节相同——否则「同内容同清单」不成立，
    // diff 与幂等重发都失去意义。
    const strip = (manifest) => ({ ...manifest, publishedAt: "", signature: "" });
    expect(canonicalize(strip(second.manifest))).toBe(canonicalize(strip(first.manifest)));
  });

  it("publishedAt 可覆盖，且必须带 Z 才能通过自校验", async () => {
    const corpusDir = await makeCorpus();
    const outDir = await tempDir("corpus-publish-out-");
    const result = await publishCorpus({
      corpusDir,
      outDir,
      version: 3,
      privateKeyPem,
      manifestApi,
      excludeNames: ["_inbox.md"],
      publishedAt: "2026-10-23T12:00:00Z",
    });
    expect(result.manifest.publishedAt).toBe("2026-10-23T12:00:00Z");
    expect(verifyManifestSignature(result.manifest, publicKeyPem)).toBe(true);
  });

  it("语料目录不存在 → CorpusPublishError", async () => {
    const missing = path.join(os.tmpdir(), "corpus-publish-definitely-missing-dir");
    await expect(
      publishCorpus({
        corpusDir: missing,
        outDir: await tempDir("corpus-publish-out-"),
        version: 1,
        privateKeyPem,
        manifestApi,
      }),
    ).rejects.toBeInstanceOf(CorpusPublishError);
  });

  it("没有合法文件 → CorpusPublishError", async () => {
    const corpusDir = await tempDir("corpus-publish-empty-");
    await writeFile(path.join(corpusDir, "_inbox.md"), "# inbox\n", "utf8");
    await writeFile(path.join(corpusDir, "notes.txt"), "x\n", "utf8");
    await expect(
      publishCorpus({
        corpusDir,
        outDir: await tempDir("corpus-publish-out-"),
        version: 1,
        privateKeyPem,
        manifestApi,
        excludeNames: ["_inbox.md"],
      }),
    ).rejects.toBeInstanceOf(CorpusPublishError);
  });

  it("--version 非正整数 → CorpusPublishError", async () => {
    const corpusDir = await makeCorpus();
    const outDir = await tempDir("corpus-publish-out-");
    for (const version of [0, -1, 1.5, Number.NaN]) {
      await expect(
        publishCorpus({ corpusDir, outDir, version, privateKeyPem, manifestApi }),
      ).rejects.toBeInstanceOf(CorpusPublishError);
    }
  });

  it("输出目录位于语料目录内 → 拒绝（否则产物会被下次扫描当成语料）", async () => {
    const corpusDir = await makeCorpus();
    await expect(
      publishCorpus({
        corpusDir,
        outDir: path.join(corpusDir, "dist-out"),
        version: 1,
        privateKeyPem,
        manifestApi,
        excludeNames: ["_inbox.md"],
      }),
    ).rejects.toThrow(/不能位于 --corpus 内部/);
  });

  it("私钥无法解析 → 报错且不含私钥内容", async () => {
    const corpusDir = await makeCorpus();
    const outDir = await tempDir("corpus-publish-out-");
    const bogus = "-----BEGIN PRIVATE KEY-----\nbm90LWEta2V5\n-----END PRIVATE KEY-----\n";
    let message = "";
    try {
      await publishCorpus({ corpusDir, outDir, version: 1, privateKeyPem: bogus, manifestApi });
    } catch (error) {
      message = String(error.message);
    }
    expect(message).not.toBe("");
    expect(message).not.toContain("bm90LWEta2V5");
  });
});

describe.skipIf(!HAS_DIST)("corpus-publish CLI（子进程）", () => {
  beforeEach(() => {
    // 让「跳过」有明确理由可查：dist 缺失时 vitest 的 skipIf 会整体跳过本组。
    if (!HAS_DIST) console.warn("dist 缺失，跳过 CLI 子进程用例：请先 npm run build 与 npm run build:mcp");
  });

  it("缺参数 → 非 0 退出并打印用法", async () => {
    const result = await runCli([]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("用法");
  });

  it("--version 0 / 非整数 → 非 0 退出", async () => {
    const corpusDir = await makeCorpus();
    const keyPath = await writeKey();
    const outDir = await tempDir("corpus-publish-out-");
    for (const version of ["0", "abc", "1.5"]) {
      const result = await runCli([
        "--corpus", corpusDir, "--key", keyPath, "--version", version, "--out", outDir,
      ]);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("--version");
    }
  });

  it("私钥路径不存在 → 非 0 退出、stderr 有原因", async () => {
    const corpusDir = await makeCorpus();
    const outDir = await tempDir("corpus-publish-out-");
    const missingKey = path.join(os.tmpdir(), "corpus-publish-no-such.key");
    const result = await runCli([
      "--corpus", corpusDir, "--key", missingKey, "--version", "1", "--out", outDir,
    ]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("私钥文件不存在");
  });

  it("成功发布时私钥内容不出现在 stdout/stderr，且清单验签通过", async () => {
    const corpusDir = await makeCorpus();
    const keyPath = await writeKey();
    const outDir = await tempDir("corpus-publish-out-");
    const result = await runCli([
      "--corpus", corpusDir,
      "--key", keyPath,
      "--version", "4",
      "--out", outDir,
      "--base-url", "https://bucket.example/",
    ]);

    expect(result.code).toBe(0);
    // 私钥 PEM 的正文（base64 行）任何一段都不得出现；这里用整段做最严格断言。
    const body = privateKeyPem
      .split("\n")
      .filter((line) => line !== "" && !line.startsWith("-----"))
      .join("");
    expect(body.length).toBeGreaterThan(0);
    expect(result.stdout).not.toContain(body);
    expect(result.stderr).not.toContain(body);
    expect(`${result.stdout}${result.stderr}`).not.toContain("PRIVATE KEY");

    const manifest = parseManifest(JSON.parse(await readFile(path.join(outDir, "latest.json"), "utf8")));
    expect(manifest.corpusVersion).toBe(4);
    expect(verifyManifestSignature(manifest, publicKeyPem)).toBe(true);
    expect(manifest.files.map((file) => file.path)).not.toContain("_inbox.md");
    // 上传指引：先文件、最后清单，并带上配置里的 updateBaseUrl。
    expect(result.stdout).toContain("latest.json");
    expect(result.stdout).toContain("https://bucket.example/");
  });

  it("私钥不可解析 → 非 0 退出且不回显内容", async () => {
    const corpusDir = await makeCorpus();
    const outDir = await tempDir("corpus-publish-out-");
    const dir = await tempDir("corpus-publish-badkey-");
    const keyPath = path.join(dir, "bad.key");
    const bogus = "-----BEGIN PRIVATE KEY-----\nbm90LWEta2V5\n-----END PRIVATE KEY-----\n";
    await writeFile(keyPath, bogus, "utf8");

    const result = await runCli([
      "--corpus", corpusDir, "--key", keyPath, "--version", "1", "--out", outDir,
    ]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).not.toContain("bm90LWEta2V5");
  });
});
