/**
 * 打包前置：把所有「`extraResources` 要从 `desktop/` 里取、但仓库里还没有」的
 * 目录准备出来。
 *
 * 两件事，缺一不可：
 *
 * 1. **`desktop/build/node_modules`** —— 内核产物保留裸说明符（`import { z } from
 *    "zod"`），安装后内核住在 `resources/dist/`，Node 从那里向上找 `node_modules`。
 *    `resources/` 下没有它，包就打不开。闭包由 `scripts/runtime-deps.mjs` 从
 *    `package-lock.json` 算出，只装运行时真正需要的十几个，不装构建工具。
 *
 * 2. **`desktop/build/corpus`** —— 语料正文与已签名的 `latest.json`。必须按清单
 *    逐文件搬并校验 sha256（`scripts/corpus-stage.mjs`），不能直接拿
 *    `mcp-servers/kb/kb`：那个目录里有 `_inbox.md`、`manifest.sha256` 这类不纳管
 *    的东西，也有可能在发布后被改过。
 *
 * **为什么合成一个脚本**：`npm --prefix desktop run dist` 只该有一条前置命令。
 * 分两条就会有人只跑一条，而两条都属于「缺了包就打不开」那类。
 *
 * 语料清单从哪来：优先 `--manifest`；没给就用已发布的地址现取一份（`config/
 * corpus.json` 里的 `updateBaseUrl`）。取回后**只用于装包**，运行时的验签仍在
 * 宿主里做——这一步不验签，因为它只是搬文件。
 *
 * 不装依赖、不改版本、不写 git。
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stageCorpus } from "./corpus-stage.mjs";
import { stageRuntimeDeps } from "./runtime-deps.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, "..");

export const USAGE = `用法: node scripts/package-prepare.mjs [--manifest <latest.json>] [--skip-corpus]

  --manifest    已签名的 latest.json 路径；不给就用 config/corpus.json 的地址现取
  --skip-corpus 只准备 node_modules（当包只需要内核、不需要随包语料时）

准备出：
  desktop/build/node_modules/   运行时依赖闭包（extraResources → resources/node_modules）
  desktop/build/corpus/         语料正文 + latest.json（extraResources → resources/corpus）

两个目录已存在时会被**先删除再重建**：它们是纯粹由输入推导出来的产物，
留一份旧的只会让「包里到底是哪一版语料」说不清。`;

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** 取 `config/corpus.json` 的 `updateBaseUrl`，用来现取一份清单。 */
async function publishedBaseUrl() {
  const configPath = path.join(REPO_ROOT, "config", "corpus.json");
  let text;
  try {
    text = await readFile(configPath, "utf8");
  } catch (error) {
    throw new Error(`读不到 ${configPath}（${messageOf(error)}）`, { cause: error });
  }
  const parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  if (typeof parsed?.updateBaseUrl !== "string" || parsed.updateBaseUrl.trim() === "") {
    throw new Error(`${configPath} 缺少 updateBaseUrl`);
  }
  return parsed.updateBaseUrl;
}

/**
 * 现取一份 `latest.json` 到一个临时文件。
 *
 * 刻意**不校验签名**：这一步只决定「把哪些文件装进包里」，而运行时安装后的
 * 每次检查都会重新验签（`src/corpus/update.ts`）。在这里再验一次等于把同一份
 * 判断写两遍，而两份迟早会对「什么算通过」给出不同结论。
 */
async function fetchManifest(baseUrl, target) {
  const url = new URL("latest.json", baseUrl).toString();
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (response.status !== 200) {
    throw new Error(
      `取 ${url} 返回 HTTP ${response.status}（OBS 上不存在的对象会返回 403 而不是 404）`,
    );
  }
  const { writeFile } = await import("node:fs/promises");
  const text = await response.text();
  await writeFile(target, text, "utf8");
  return { url, text };
}

async function main(argv) {
  let manifestPath = null;
  let skipCorpus = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }
    if (arg === "--skip-corpus") {
      skipCorpus = true;
      continue;
    }
    if (arg === "--manifest") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--manifest 缺少值");
      }
      manifestPath = path.resolve(value);
      index += 1;
      continue;
    }
    throw new Error(`不认识的参数：${arg}`);
  }

  const buildDir = path.join(REPO_ROOT, "desktop", "build");
  const runtimeOut = path.join(buildDir, "node_modules");
  const corpusOut = path.join(buildDir, "corpus");

  // 1. 运行时依赖闭包。
  //
  // 先删上一次的产物。`runtime-deps.mjs` 作为独立 CLI 时对已存在的输出目录一律
  // 拒绝（那是它该有的谨慎：覆盖会静默销毁别人指着的东西），但它在这里的产物
  // 完全由 lockfile 与 dist/ 推导出来 —— 留一份旧的只会让「包里到底是哪一版
  // 依赖」说不清，而 `npm run dist` 第二次必然重跑这一步。
  process.stdout.write("→ 装配运行时依赖…\n");
  if (await exists(runtimeOut)) {
    process.stdout.write(`  删除上一次的 ${runtimeOut}\n`);
    const { rm } = await import("node:fs/promises");
    await rm(runtimeOut, { recursive: true, force: true });
  }
  await stageRuntimeDeps({
    repoRoot: REPO_ROOT,
    outDir: runtimeOut,
    log: (message) => process.stdout.write(`  ${message}\n`),
  });

  if (skipCorpus) {
    process.stdout.write("→ 跳过语料（--skip-corpus）\n");
    return 0;
  }

  // 2. 语料正文 + 清单。
  let disposableManifest = null;
  let sourceManifest = manifestPath;
  if (sourceManifest === null) {
    const baseUrl = await publishedBaseUrl();
    disposableManifest = path.join(buildDir, ".latest.json");
    process.stdout.write(`→ 从 ${new URL("latest.json", baseUrl)} 取清单…\n`);
    const fetched = await fetchManifest(baseUrl, disposableManifest);
    process.stdout.write(`  取到 ${fetched.text.length} 字节\n`);
    sourceManifest = disposableManifest;
  }

  try {
    process.stdout.write("→ 装配语料…\n");
    // 输出目录由本脚本重建：`corpus-stage` 对已存在的目录一律拒绝，那是它作为
    // 独立 CLI 时该有的谨慎；这里重建成「上一次的产物不该被当成这一次的输入」。
    const { rm } = await import("node:fs/promises");
    if (await exists(corpusOut)) {
      process.stdout.write(`  删除上一次的 ${corpusOut}\n`);
      await rm(corpusOut, { recursive: true, force: true });
    }
    await stageCorpus({
      corpusDir: path.join(REPO_ROOT, "mcp-servers", "kb", "kb"),
      manifestPath: sourceManifest,
      outDir: corpusOut,
      log: (message) => process.stdout.write(`  ${message}\n`),
    });
  } finally {
    if (disposableManifest !== null) {
      const { rm } = await import("node:fs/promises");
      await rm(disposableManifest, { force: true });
    }
  }

  process.stdout.write("\n准备完成。可以运行 electron-builder 了。\n");
  return 0;
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${path.resolve(process.argv[1])}`).href
) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`失败：${messageOf(error)}\n`);
    process.exitCode = 1;
  }
}
