#!/usr/bin/env node
/**
 * 语料打包前置：按已签名清单把语料正文搬进可打包目录。
 *
 * 为什么需要它：安装包里的语料必须是**清单点名的那些文件**，而不是语料工作目录
 * 的全集。工作目录里有 `_inbox.md`（用户本地沉淀）与 `manifest.sha256`（发布前的
 * 旧校验文件），它们都不在 OTA 清单里、也不该进快照（契约 §3/§4）。直接
 * `extraResources: { from: "mcp-servers/kb/kb" }` 会把它们一起装进安装包；用户
 * 首次启动物化后，`kb_read` 会读到一份既不是「出厂语料」也不是「OTA 快照」的东西。
 * 所以这里做一次「按清单搬运 + 校验」。
 *
 * 与 `scripts/corpus-publish*.mjs` 的分工：
 * - 发布侧（离线签名机）：扫语料 → 算 sha256 → 生成并**签名** `latest.json`。
 * - 这里（打包机）：读清单 → 逐文件复制 → 校验 sha256 → 把 `latest.json` 放到顶层。
 *   它**不读私钥、不验签**：验签是运行时（`src/corpus/manifest.ts`）的事，安装包
 *   里的清单来自发布产物，打包机不该拥有签署能力。
 *
 * 失败语义（R3）：任何一处不一致都非零退出并点名路径。绝不产出「半套语料」的
 * 目录——先写临时目录，全部通过后再整体改名到 `--out`。
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));

/** 清单文件名。客户端按这个固定名字取，与 `src/corpus/manifest.ts` 一致。 */
export const MANIFEST_FILE_NAME = "latest.json";

export const USAGE = [
  "用法: node scripts/corpus-stage.mjs --corpus <语料目录> --manifest <latest.json> --out <输出目录>",
  "      node scripts/corpus-stage.mjs --corpus <语料目录> --manifest <latest.json> --verify-only",
  "",
  "  --corpus       语料源目录（发布侧扫过的同一份目录）",
  "  --manifest     已签名的 latest.json 路径（只在本地读，不触网）",
  "  --out          输出目录；只在全部校验通过后一次性生成（已存在则拒绝，不覆盖）",
  "  --verify-only  只校验不写盘：确认语料与清单逐字节一致，供打包前置检查用",
  "",
  "行为：",
  "  · 只复制清单 files 里点名的文件；语料目录里的其它文件（_inbox.md、manifest.sha256）不进入输出。",
  "  · 每个文件复制前、复制后各校验一次 sha256，任何不符即失败并给出期望值与实际值。",
  "  · 最后把 latest.json 写到输出目录顶层（与 corpus/ 的其余文件同目录，契约 §5）。",
  "  · 清单 path 必须是 POSIX 相对路径：含 .. / 绝对路径 / 盘符的条目一律拒绝。",
  "  · 不验签（验签在运行时做）；不读私钥；不联网。",
].join("\n");

/** 打包失败。消息会原样打到 stderr，所以必须自带修复线索（R3）。 */
export class CorpusStageError extends Error {
    /**
     * @param {string} message
     * @param {{ exitCode?: number }} [options] 2 = 用法错误，1 = 执行失败
     */
    constructor(message, options = {}) {
        super(message);
        this.name = "CorpusStageError";
        this.exitCode = options.exitCode ?? 1;
    }
}

function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}

/**
 * 流式算 sha256。与 `src/corpus/manifest.ts` 的 `sha256File` 同一算法，
 * 但这里不 import `dist/`：打包前置检查不应要求先跑 `npm run build`。
 */
async function sha256File(filePath) {
    return await new Promise((resolve, reject) => {
        const hash = createHash("sha256");
        const stream = createReadStream(filePath);
        stream.on("error", reject);
        stream.on("data", (chunk) => hash.update(chunk));
        stream.on("end", () => resolve(hash.digest("hex")));
    });
}

function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * 校验清单里的相对路径。
 *
 * 与 `src/corpus/manifest.ts` 的 `validateRelativePath` 是**同一条规矩的两处实现**：
 * 那边是运行时验签的权威版本，这里只是打包前置，不能 import 它（需要 dist/ 构建，
 * 而打包机可能刚 checkout）。这里的检查是那边的子集——只保留「拼路径时会逃出根
 * 目录」的那些，多出来的格式要求（扩展名、`.md`/`.yaml`）不在这里重复。
 *
 * 拒绝：反斜杠、绝对路径、盘符、NUL、空段、`.`、`..`。每一条都对应一种真实的
 * 路径逃逸或歧义（`../etc/passwd` 会写到暂存目录之外）。
 */
function validateRelativePath(value, where) {
    if (typeof value !== "string") {
        throw new CorpusStageError(`清单 ${where} 的 path 必须是字符串（实际为 ${JSON.stringify(value)}）`);
    }
    if (value === "") {
        throw new CorpusStageError(`清单 ${where} 的 path 不能是空路径`);
    }
    if (value.includes("\\")) {
        throw new CorpusStageError(`清单 ${where} 的 path 含反斜杠，必须用 POSIX 风格的 "/"：${value}`);
    }
    if (value.startsWith("/")) {
        throw new CorpusStageError(`清单 ${where} 的 path 不能是绝对路径：${value}`);
    }
    if (/^[A-Za-z]:/.test(value)) {
        throw new CorpusStageError(`清单 ${where} 的 path 不能带盘符：${value}`);
    }
    if (value.includes("\0")) {
        throw new CorpusStageError(`清单 ${where} 的 path 含 NUL 字符：${JSON.stringify(value)}`);
    }
    for (const segment of value.split("/")) {
        if (segment === "") {
            throw new CorpusStageError(`清单 ${where} 的 path 含空路径段（连续 "/"、开头或结尾的 "/"）：${value}`);
        }
        if (segment === ".") {
            throw new CorpusStageError(`清单 ${where} 的 path 含 "." 路径段：${value}`);
        }
        if (segment === "..") {
            throw new CorpusStageError(`清单 ${where} 的 path 含 ".." 路径段（路径穿越）：${value}`);
        }
    }
    return value;
}

/**
 * 解析并校验 `latest.json`，返回 `{ raw, files }`。
 *
 * 只做结构校验，**不验签**：打包机没有公钥的权威来源，验签是运行时的事。
 * 但字段缺失必须当场报错——一份读不出 `files` 的清单会让输出目录「看起来成功、
 * 实际没有语料」，那是 R3 明令禁止的静默失败。
 */
function parseStageManifest(raw, manifestPath) {
    if (!isRecord(raw)) {
        throw new CorpusStageError(`清单顶层必须是 JSON 对象：${manifestPath}`);
    }
    if (raw.manifestVersion !== 1) {
        throw new CorpusStageError(
            `清单的 manifestVersion 必须是 1（实际为 ${JSON.stringify(raw.manifestVersion)}）：${manifestPath}`,
        );
    }
    const corpusVersion = raw.corpusVersion;
    if (typeof corpusVersion !== "number" || !Number.isSafeInteger(corpusVersion) || corpusVersion < 1) {
        throw new CorpusStageError(
            `清单的 corpusVersion 必须是 ≥ 1 的整数（实际为 ${JSON.stringify(corpusVersion)}）：${manifestPath}`,
        );
    }
    if (typeof raw.publishedAt !== "string" || raw.publishedAt === "") {
        throw new CorpusStageError(`清单缺少 publishedAt（或不是字符串）：${manifestPath}`);
    }
    if (typeof raw.signature !== "string" || raw.signature === "") {
        throw new CorpusStageError(
            `清单缺少 signature（或不是字符串）：${manifestPath}——没有签名的清单装进安装包，运行时会验签失败`,
        );
    }
    if (!Array.isArray(raw.files)) {
        throw new CorpusStageError(`清单的 files 必须是数组（实际为 ${JSON.stringify(raw.files)}）：${manifestPath}`);
    }

    const files = [];
    const seen = new Set();
    for (let index = 0; index < raw.files.length; index += 1) {
        const entry = raw.files[index];
        const where = `files[${index}]`;
        if (!isRecord(entry)) {
            throw new CorpusStageError(`清单 ${where} 必须是对象：${manifestPath}`);
        }
        const relativePath = validateRelativePath(entry.path, `${where}.path`);
        const sha256 = entry.sha256;
        if (typeof sha256 !== "string" || !SHA256_HEX.test(sha256)) {
            throw new CorpusStageError(
                `清单 ${where}（${relativePath}）的 sha256 必须是 64 位小写十六进制（实际为 ${JSON.stringify(sha256)}）`,
            );
        }
        if (seen.has(relativePath)) {
            throw new CorpusStageError(`清单里 path 重复：${relativePath}（${where}）`);
        }
        seen.add(relativePath);
        files.push({ path: relativePath, sha256 });
    }

    if (files.length === 0) {
        // 空清单能「成功」产出一个只有 latest.json 的语料目录：装出来的应用有版本号、
        // 没有一条知识。这比打包失败更难查，所以在这里就拒绝。
        throw new CorpusStageError(`清单 files 为空，拒绝产出空语料目录：${manifestPath}`);
    }
    return { raw, files };
}

/** `--out` 不能与 `--corpus` 相同、也不能落在它里面：否则第二次打包会把产物当语料。 */
function assertOutDirOutsideCorpus(corpusDir, outDir) {
    const relative = path.relative(corpusDir, outDir);
    if (relative === "") {
        throw new CorpusStageError(`--out 不能与 --corpus 是同一个目录：${outDir}`);
    }
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
        throw new CorpusStageError(`--out 不能位于 --corpus 内部（${outDir}）：产物会被下一次打包当成语料`);
    }
}

async function assertDirectory(target, label) {
    let info;
    try {
        info = await stat(target);
    } catch (error) {
        throw new CorpusStageError(`${label} 不存在或不可访问：${target}（${errorMessage(error)}）`);
    }
    if (!info.isDirectory()) {
        throw new CorpusStageError(`${label} 必须是目录：${target}`);
    }
}

/**
 * 逐文件校验（不写盘）。`stageCorpus` 的 `--verify-only` 与复制前检查共用这一份，
 * 避免「校验」与「复制」两条路径对「什么算一致」有两种理解。
 */
async function verifySourceFile(corpusDir, entry) {
    const source = path.join(corpusDir, ...entry.path.split("/"));
    let info;
    try {
        info = await stat(source);
    } catch (error) {
        const code = error?.code;
        if (code === "ENOENT" || code === "ENOTDIR") {
            throw new CorpusStageError(`清单点名的文件在语料目录里不存在：${entry.path}（${source}）`);
        }
        throw new CorpusStageError(`清单点名的文件无法访问：${entry.path}（${source}）：${errorMessage(error)}`);
    }
    if (!info.isFile()) {
        throw new CorpusStageError(`清单点名的路径不是普通文件：${entry.path}（${source}）`);
    }

    let actual;
    try {
        actual = await sha256File(source);
    } catch (error) {
        throw new CorpusStageError(`计算 sha256 失败：${entry.path}（${source}）：${errorMessage(error)}`);
    }
    if (actual !== entry.sha256) {
        throw new CorpusStageError(
            `sha256 不符：${entry.path}（${source}）\n  期望：${entry.sha256}\n  实际：${actual}`,
        );
    }
    return source;
}

/**
 * 执行一次打包搬运。
 *
 * @param {object} options
 * @param {string} options.corpusDir 语料源目录（绝对路径）
 * @param {string} options.manifestPath 已签名 `latest.json` 的绝对路径
 * @param {string} [options.outDir] 输出目录（绝对路径）；`verifyOnly` 时不需要
 * @param {boolean} [options.verifyOnly] 只校验不写盘
 * @param {(message: string) => void} [options.log] 进度输出
 * @returns {Promise<{ corpusVersion: number, files: string[], outDir: string | null,
 *                     verifyOnly: boolean, latestPath: string | null }>}
 */
export async function stageCorpus(options) {
    const { corpusDir, manifestPath, outDir, verifyOnly = false, log = () => {} } = options;

    await assertDirectory(corpusDir, "--corpus");

    let manifestText;
    try {
        manifestText = await readFile(manifestPath, "utf8");
    } catch (error) {
        throw new CorpusStageError(`清单读取失败：${manifestPath}（${errorMessage(error)}）`);
    }

    let rawManifest;
    try {
        rawManifest = JSON.parse(manifestText.charCodeAt(0) === 0xfeff ? manifestText.slice(1) : manifestText);
    } catch (error) {
        throw new CorpusStageError(`清单不是合法 JSON：${manifestPath}（${errorMessage(error)}）`);
    }
    const { raw, files } = parseStageManifest(rawManifest, manifestPath);

    if (verifyOnly) {
        // 只读校验：先把所有文件查一遍，全部通过才返回。这里不写任何字节，
        // 因此打包前置检查可以在「产物目录还不该存在」的时候跑。
        for (const entry of files) {
            await verifySourceFile(corpusDir, entry);
            log(`校验通过 ${entry.path}`);
        }
        return { corpusVersion: raw.corpusVersion, files: files.map((entry) => entry.path), outDir: null, verifyOnly: true, latestPath: null };
    }

    if (outDir === undefined) {
        throw new CorpusStageError("缺少 --out（或用 --verify-only 只校验）", { exitCode: 2 });
    }
    assertOutDirOutsideCorpus(corpusDir, outDir);

    // 已存在的 --out 一律拒绝，而不是覆盖或改名备份：
    // 覆盖会静默销毁上一次的产物；改名备份会在目录里留下一个很容易被当成
    // 「当前语料」的旧副本（打包脚本按固定路径取用）。要求人工先删，代价是一次
    // 明确的删除动作，换来的是「目录里出现的东西一定是这一次的」。
    try {
        await stat(outDir);
        throw new CorpusStageError(
            `输出目录已存在，拒绝覆盖：${outDir}\n  请先删除它（或换一个 --out）后重试；本脚本不删除任何已有目录`,
        );
    } catch (error) {
        if (error instanceof CorpusStageError) throw error;
        const code = error?.code;
        if (code !== "ENOENT" && code !== "ENOTDIR") {
            throw new CorpusStageError(`无法检查输出目录是否存在：${outDir}（${errorMessage(error)}）`);
        }
    }

    const parentDir = path.dirname(outDir);
    try {
        await mkdir(parentDir, { recursive: true });
    } catch (error) {
        throw new CorpusStageError(`输出目录的父目录无法创建：${parentDir}（${errorMessage(error)}）`);
    }

    // 临时目录与 --out 同父级：同一卷上 rename 才是原子的。命名带前缀，便于
    // 失败后一眼看出是残留（成功路径与失败路径都会清理它）。
    let tempDir;
    try {
        tempDir = await mkdtemp(path.join(parentDir, ".corpus-stage-"));
    } catch (error) {
        throw new CorpusStageError(`临时目录无法创建：${parentDir}（${errorMessage(error)}）`);
    }

    try {
        for (const entry of files) {
            const source = await verifySourceFile(corpusDir, entry);
            const target = path.join(tempDir, ...entry.path.split("/"));
            try {
                await mkdir(path.dirname(target), { recursive: true });
                await copyFile(source, target);
            } catch (error) {
                throw new CorpusStageError(`复制失败：${entry.path}（${errorMessage(error)}）`);
            }
            // 复制后再算一次：磁盘满、并发改写、杀软隔离都会让副本与源不同。
            // 只校验源的那一次「复制前」步骤，查不出「复制出来的是坏文件」。
            let copied;
            try {
                copied = await sha256File(target);
            } catch (error) {
                throw new CorpusStageError(`复制后校验读取失败：${entry.path}（${errorMessage(error)}）`);
            }
            if (copied !== entry.sha256) {
                throw new CorpusStageError(
                    `复制后 sha256 不符：${entry.path}\n  期望：${entry.sha256}\n  实际：${copied}`,
                );
            }
            log(`已复制 ${entry.path}`);
        }

        // 清单最后写：目录里出现 latest.json 时，它点名的文件必须都已在。
        const latestTarget = path.join(tempDir, MANIFEST_FILE_NAME);
        try {
            await writeFile(latestTarget, manifestText, "utf8");
        } catch (error) {
            throw new CorpusStageError(`写出 ${MANIFEST_FILE_NAME} 失败：${latestTarget}（${errorMessage(error)}）`);
        }

        try {
            await rename(tempDir, outDir);
        } catch (error) {
            throw new CorpusStageError(`无法把暂存目录改名为输出目录：${tempDir} → ${outDir}（${errorMessage(error)}）`);
        }
        tempDir = null;

        return {
            corpusVersion: raw.corpusVersion,
            files: files.map((entry) => entry.path),
            outDir,
            verifyOnly: false,
            // 改名之后暂存路径已经不存在了，报出来的必须是最终位置。
            latestPath: path.join(outDir, MANIFEST_FILE_NAME),
        };
    } finally {
        if (tempDir !== null) {
            // 清理失败不应掩盖真正的错误，所以只尽力而为；但要把路径打出来，
            // 否则下次跑会因为「目录残留」而困惑。
            await rm(tempDir, { recursive: true, force: true }).catch((error) => {
                log(`警告：暂存目录清理失败，请手工删除 ${tempDir}（${errorMessage(error)}）`);
            });
        }
    }
}

const VALUE_FLAGS = new Set(["corpus", "manifest", "out"]);

/**
 * 参数解析。风格跟随 `scripts/corpus-publish.mjs`：未知参数当场报错、缺值不当成空串。
 *
 * 抛 `CorpusStageError`（exitCode 2）而不是写 `process.exitCode`：测试要能直接
 * 断言「这个参数组合被拒绝」，不必起子进程。
 */
export function parseArgs(argv) {
    const options = { verifyOnly: false };
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--help" || arg === "-h") return { help: true };
        if (arg === "--verify-only") {
            options.verifyOnly = true;
            continue;
        }
        if (!arg.startsWith("--")) {
            throw new CorpusStageError(`未知参数 ${arg}`, { exitCode: 2 });
        }
        const name = arg.slice(2);
        if (!VALUE_FLAGS.has(name)) {
            throw new CorpusStageError(`未知参数 ${arg}`, { exitCode: 2 });
        }
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("--")) {
            throw new CorpusStageError(`${arg} 缺少取值`, { exitCode: 2 });
        }
        options[name] = value;
        index += 1;
    }

    const missing = ["corpus", "manifest"].filter((name) => options[name] === undefined);
    if (missing.length > 0) {
        throw new CorpusStageError(
            `缺少参数 ${missing.map((name) => `--${name}`).join("、")}\n\n${USAGE}`,
            { exitCode: 2 },
        );
    }
    if (options.verifyOnly) {
        // 静默忽略 --out 会让人以为「已经产出了」。要么只校验，要么正常产出。
        if (options.out !== undefined) {
            throw new CorpusStageError("--verify-only 不接受 --out：只校验时不写任何目录", { exitCode: 2 });
        }
    } else if (options.out === undefined) {
        throw new CorpusStageError(`缺少参数 --out（或用 --verify-only 只校验）\n\n${USAGE}`, { exitCode: 2 });
    }
    return options;
}

async function main() {
    let parsed;
    try {
        parsed = parseArgs(process.argv.slice(2));
    } catch (error) {
        const message = error instanceof CorpusStageError ? error.message : String(error);
        console.error(`corpus stage: ${message}`);
        process.exitCode = error instanceof CorpusStageError ? error.exitCode : 2;
        return;
    }
    if (parsed.help === true) {
        console.log(USAGE);
        return;
    }

    const corpusDir = path.resolve(ROOT, parsed.corpus);
    const manifestPath = path.resolve(ROOT, parsed.manifest);
    const outDir = parsed.out === undefined ? undefined : path.resolve(ROOT, parsed.out);

    let result;
    try {
        result = await stageCorpus({
            corpusDir,
            manifestPath,
            outDir,
            verifyOnly: parsed.verifyOnly,
            log: (message) => console.log(message),
        });
    } catch (error) {
        const message = error instanceof CorpusStageError ? error.message : String(error);
        console.error(`corpus stage: ${message}`);
        process.exitCode = error instanceof CorpusStageError ? error.exitCode : 1;
        return;
    }

    if (result.verifyOnly) {
        console.log("");
        console.log(`校验完成：corpusVersion=${result.corpusVersion}，${result.files.length} 个文件与清单逐字节一致。`);
        return;
    }
    console.log("");
    console.log(
        [
            `已暂存 corpusVersion=${result.corpusVersion}，${result.files.length} 个文件。`,
            `输出目录：${result.outDir}`,
            `清单：${result.latestPath}`,
        ].join("\n"),
    );
}

// 只有被当成脚本直接运行时才进 main()。测试 import 本模块拿 `stageCorpus` /
// `parseArgs` 的纯函数，不应触发 argv 解析。
const invokedPath = process.argv[1] === undefined ? "" : pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath !== "" && import.meta.url === invokedPath) {
    await main();
}
