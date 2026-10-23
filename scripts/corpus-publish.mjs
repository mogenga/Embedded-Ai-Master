#!/usr/bin/env node
/**
 * 语料发布 CLI：扫描语料目录 → 生成带 Ed25519 签名的 `latest.json` → 输出待上传目录。
 *
 * 契约见 `docs/corpus-ota.md` §4/§8。这个文件只做参数解析、读私钥与打印指引；
 * 真正的逻辑在 `corpus-publish-lib.mjs`（可单测，不必起子进程）。
 *
 * 从 `dist/` 导入 `manifest.js`（与 `kb-review.mjs` 从 `dist-mcp/` 导入同一做法）：
 * 发布侧与客户端必须跑**同一份**签名/验签实现，否则「签名能生成、验证永远失败」
 * 这类故障无法在发布机上暴露。因此运行前需要 `npm run build`。
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CorpusPublishError, MANIFEST_FILE_NAME, publishCorpus } from "./corpus-publish-lib.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const MANIFEST_MODULE = path.join(ROOT, "dist", "corpus", "manifest.js");
const INBOX_MODULE = path.join(ROOT, "dist-mcp", "kb", "inbox.js");

const USAGE = [
  "用法: node scripts/corpus-publish.mjs --corpus <语料目录> --key <私钥 PEM> --version <正整数> --out <输出目录> [--base-url <桶地址>]",
  "",
  "  --corpus    语料源目录（递归收集 .md / .yaml）",
  "  --key       Ed25519 私钥 PEM 路径（PKCS#8）；内容不会被打印",
  "  --version   内容版本，≥ 1 的整数，必须大于线上已发布值（防回滚）",
  "  --out       输出目录，形成可直接上传的目录树",
  "  --base-url  可选，桶根地址（需以 / 结尾），仅用于打印上传指引",
  "",
  "运行前需要 npm run build（脚本从 dist/ 导入 manifest 实现）。",
].join("\n");

function fail(message, code = 1) {
  console.error(`corpus publish: ${message}`);
  process.exitCode = code;
}

const VALUE_FLAGS = new Set(["corpus", "key", "version", "out", "base-url"]);

/** 参数解析风格跟随 `scripts/kb-review.mjs`：未知参数立即报错、缺值不当成空串。 */
function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (!arg.startsWith("--")) {
      fail(`未知参数 ${arg}`, 2);
      return undefined;
    }
    const name = arg.slice(2);
    if (!VALUE_FLAGS.has(name)) {
      fail(`未知参数 ${arg}`, 2);
      return undefined;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      fail(`${arg} 缺少取值`, 2);
      return undefined;
    }
    options[name] = value;
    index += 1;
  }

  const missing = ["corpus", "key", "version", "out"].filter((name) => options[name] === undefined);
  if (missing.length > 0) {
    fail(`缺少参数 ${missing.map((name) => `--${name}`).join("、")}`, 2);
    console.error(USAGE);
    return undefined;
  }
  return options;
}

/**
 * 解析版本号。`Number("1.5")` 得到 1.5、`Number("1abc")` 得到 NaN，
 * 都能被后面的整数校验挡住；这里只需保证「不像数字的输入」不静默变成 0。
 */
function parseVersion(raw) {
  if (!/^\d+$/.test(raw.trim())) return undefined;
  const value = Number(raw.trim());
  // 版本单调递增是防回滚的唯一依据（契约 §4），0 与负数一律不接受。
  return Number.isSafeInteger(value) && value >= 1 ? value : undefined;
}

/** 读私钥。失败只报路径与原因，**绝不回显内容**。 */
function readPrivateKeyPem(keyPath) {
  if (!existsSync(keyPath)) {
    throw new CorpusPublishError(`私钥文件不存在：${keyPath}`);
  }
  let pem;
  try {
    pem = readFileSync(keyPath, "utf8");
  } catch (error) {
    throw new CorpusPublishError(
      `私钥文件读取失败：${keyPath}（${error instanceof Error ? error.message : String(error)}）`,
    );
  }
  if (!pem.includes("PRIVATE KEY")) {
    throw new CorpusPublishError(`私钥文件不像 PEM 私钥（缺少 PRIVATE KEY 标记）：${keyPath}`);
  }
  return pem;
}

async function loadModules() {
  for (const [label, file] of [
    ["manifest", MANIFEST_MODULE],
    ["inbox", INBOX_MODULE],
  ]) {
    if (!existsSync(file)) {
      throw new CorpusPublishError(`未找到构建产物 ${label}（${file}）；请先运行 npm run build`);
    }
  }
  const manifestApi = await import(pathToFileURL(MANIFEST_MODULE).href);
  // 排除名单取自 inbox 模块，而不是在这里抄一份常量：抄一份的后果是两处漂移，
  // 新增排除项时发布脚本还在把用户沉淀打进清单。
  const inboxModule = await import(pathToFileURL(INBOX_MODULE).href);
  return { manifestApi, excludeNames: inboxModule.MANAGED_CORPUS_EXCLUDES ?? [] };
}

function printUploadGuide({ baseUrl, fileCount, outDir }) {
  const lines = [
    "",
    "发布完成。上传顺序（先文件、最后清单）不可颠倒：",
    "  客户端把「清单在、文件不在」视为下载失败并保留当前版本；",
    "  反过来则会让部分用户在清单生效的瞬间读到半套语料。",
    "",
    `1. 先上传 ${fileCount} 个语料文件（保持目录结构）：`,
    `   ${outDir}`,
    `2. 最后上传 ${MANIFEST_FILE_NAME}：`,
    `   ${path.join(outDir, MANIFEST_FILE_NAME)}`,
  ];
  if (typeof baseUrl === "string" && baseUrl !== "") {
    lines.push(
      "",
      `更新源基地址（客户端据此拼接 ${MANIFEST_FILE_NAME} 与相对路径）：${baseUrl}`,
      baseUrl.endsWith("/")
        ? "  请确认桶根下直接放这些对象（不加前缀）。"
        : "  注意：该地址没有以 / 结尾，与 config/corpus.json 的要求不符，请改正。",
      `  发布后的清单地址：${baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`}${MANIFEST_FILE_NAME}`,
    );
  } else {
    lines.push(
      "",
      `未提供 --base-url；记得把 updateBaseUrl 写进 config/corpus.local.json（需以 / 结尾）。`,
    );
  }
  lines.push("");
  console.log(lines.join("\n"));
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === undefined) return;
  if (parsed.help === true) {
    console.log(USAGE);
    return;
  }

  const version = parseVersion(parsed.version);
  if (version === undefined) {
    fail(`--version 必须是 ≥ 1 的整数（实际为 ${JSON.stringify(parsed.version)}）`, 2);
    return;
  }

  const corpusDir = path.resolve(ROOT, parsed.corpus);
  const outDir = path.resolve(ROOT, parsed.out);
  const keyPath = path.resolve(ROOT, parsed.key);

  let modules;
  let privateKeyPem;
  try {
    modules = await loadModules();
    privateKeyPem = readPrivateKeyPem(keyPath);
  } catch (error) {
    fail(error instanceof CorpusPublishError ? error.message : String(error), 2);
    return;
  }

  let result;
  try {
    result = await publishCorpus({
      corpusDir,
      outDir,
      version,
      privateKeyPem,
      manifestApi: modules.manifestApi,
      excludeNames: modules.excludeNames,
      log: (message) => console.log(message),
    });
  } catch (error) {
    fail(error instanceof CorpusPublishError ? error.message : String(error), 1);
    return;
  } finally {
    // 立刻丢掉引用，避免后续任何日志路径意外把 key 带出去。
    privateKeyPem = undefined;
  }

  console.log(
    [
      "",
      `已发布 corpusVersion=${result.manifest.corpusVersion}，`
        + `${result.manifest.files.length} 个文件，publishedAt=${result.manifest.publishedAt}`,
      `清单签名（前 16 位）：${result.manifest.signature.slice(0, 16)}...`,
      `输出目录：${outDir}`,
    ].join("\n"),
  );
  printUploadGuide({ baseUrl: parsed["base-url"], fileCount: result.files.length, outDir });
}

await main();
