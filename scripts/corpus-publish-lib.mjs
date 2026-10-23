/**
 * 语料发布的核心逻辑：扫描 → 排除受管项 → sha256 → 生成 `latest.json` → 签名 → 自校验 → 落盘。
 *
 * 契约见 `docs/corpus-ota.md` §4（格式）与 §8（发布侧职责）。这里刻意**不**在顶层
 * import `dist/` 里的任何东西：依赖由调用方以 `manifestApi` 注入。
 * 两个理由：
 * 1. 单测可以直接传 `src/corpus/manifest.ts` 的实现，不必先 `npm run build`；
 * 2. 「发布脚本用哪一份 manifest 实现」是调用方的决定，模块本身不该替它选。
 *
 * 另一条贯穿全文件的原则：**私钥内容绝不进入任何返回值、日志或错误消息**。
 * 私钥读不出来、格式不对，报错只说路径；一旦把内容拼进异常，它就会顺着
 * stderr 落到终端、CI 日志、issue 截图里——这是泄露私钥最常见的方式。
 */

import { createPublicKey } from "node:crypto";
import { copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

/** 发布失败。消息会原样打到 stderr，所以必须自带修复线索（R3）。 */
export class CorpusPublishError extends Error {
  constructor(message) {
    super(message);
    this.name = "CorpusPublishError";
  }
}

/** 只允许这两种扩展名，与 `parseManifest` 的约束一致（大小写敏感）。 */
const ALLOWED_EXTENSIONS = [".md", ".yaml"];

/** 清单文件名。客户端按这个固定名字取，不能改。 */
export const MANIFEST_FILE_NAME = "latest.json";

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 按 UTF-16 码元比较，不用 `localeCompare`。
 *
 * `localeCompare` 的结果取决于运行机器的 locale/ICU：同一份语料在发布机与
 * 核对机上可能排出不同顺序，而顺序参与签名。固定成码元比较，字节就只由内容决定。
 */
function comparePaths(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function toPosix(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function hasAllowedExtension(name) {
  return ALLOWED_EXTENSIONS.some((extension) => name.endsWith(extension));
}

/**
 * 递归收集语料文件，返回 POSIX 相对路径（未排序）。
 *
 * 符号链接单独处理：`Dirent.isFile()` 对链接返回 false，直接跳过会让「链过去的
 * 语料」静默消失——发布出来的清单看起来完整，实际少文件。所以链接按目标类型
 * 判断，目标读不到就报错，不猜。
 */
async function collectFiles(root) {
  const found = [];
  const pending = [""];

  while (pending.length > 0) {
    const relativeDir = pending.pop();
    const absoluteDir = relativeDir === "" ? root : path.join(root, ...relativeDir.split("/"));
    let entries;
    try {
      entries = await readdir(absoluteDir, { withFileTypes: true });
    } catch (error) {
      throw new CorpusPublishError(`读取语料目录失败：${absoluteDir}（${errorMessage(error)}）`);
    }

    for (const entry of entries) {
      const relativePath = relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
      if (entry.isDirectory()) {
        pending.push(relativePath);
        continue;
      }
      if (entry.isFile()) {
        found.push(relativePath);
        continue;
      }
      if (entry.isSymbolicLink()) {
        const absolutePath = path.join(root, ...relativePath.split("/"));
        let info;
        try {
          info = await stat(absolutePath);
        } catch (error) {
          throw new CorpusPublishError(
            `语料目录里的符号链接无法解析：${relativePath}（${errorMessage(error)}）`,
          );
        }
        if (!info.isFile()) {
          // 不跟随目录链接：跟随要处理环（`a -> ..`），而且发布物会带上语料根
          // 之外的内容——那份内容不在发布者的心智模型里，却进了清单和签名。
          // 静默跳过更糟：文件从清单里消失不会有任何迹象，用户只会发现「更新后
          // 少了几篇」。所以这里显式失败，让人把语料挪成实体目录。
          throw new CorpusPublishError(
            `语料目录里的符号链接指向目录，不跟随：${relativePath}（请改成实体目录后重试）`,
          );
        }
        found.push(relativePath);
      }
    }
  }

  return found;
}

/**
 * 校验版本号。
 *
 * 只接受 ≥1 的安全整数：`parseManifest` 会拒绝别的东西，但到那一步报的是
 * 「清单不合法」，而真实原因是参数写错了。发布脚本应当当场说清是哪一项。
 */
function assertVersion(version) {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new CorpusPublishError(`--version 必须是 ≥ 1 的整数（实际为 ${String(version)}）`);
  }
}

/**
 * 确认输出目录不在语料目录内。
 *
 * 否则第二次发布时，上一次产出的 `latest.json` 与副本会被当成新语料扫进来，
 * 清单开始自我引用、sha256 每跑一次变一次——故障表现是「同样的输入产出不同清单」，
 * 极难反推到「参数指错了目录」。这里直接拒绝。
 */
function assertOutDirOutsideCorpus(corpusDir, outDir) {
  const relative = path.relative(corpusDir, outDir);
  if (relative === "") {
    throw new CorpusPublishError(`--out 不能与 --corpus 是同一个目录：${outDir}`);
  }
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    throw new CorpusPublishError(
      `--out 不能位于 --corpus 内部（${outDir}）：产物会被下一次扫描当成语料`,
    );
  }
}

/** 从 Ed25519 私钥推导公钥 PEM。自校验用公钥走客户端同一条验签路径。 */
function derivePublicKeyPem(privateKeyPem) {
  let publicKey;
  try {
    publicKey = createPublicKey(privateKeyPem);
  } catch (error) {
    // 只报「解析失败」，绝不把 key 内容或 crypto 的原始 fragment 抛出去。
    throw new CorpusPublishError(
      `私钥无法解析（需要 PKCS#8 的 Ed25519 私钥 PEM）：${errorMessage(error)}`,
    );
  }
  return String(publicKey.export({ type: "spki", format: "pem" }));
}

/** 写清单。2 空格缩进便于人眼 diff；签名覆盖的是规范 JSON，与这里的排版无关。 */
function serializeManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * 执行一次发布。
 *
 * @param {object} options
 * @param {string} options.corpusDir 语料源目录（绝对路径）
 * @param {string} options.outDir 输出目录（绝对路径），会形成可直接上传的目录树
 * @param {number} options.version 内容版本，≥1 的整数
 * @param {string} options.privateKeyPem 私钥 PEM 原文（不得记录、不得返回）
 * @param {{ canonicalize: Function, parseManifest: Function, signManifestPayload: Function,
 *           verifyManifestSignature: Function, sha256File: Function }} options.manifestApi
 * @param {Iterable<string>} [options.excludeNames] 按 basename 排除的文件名
 * @param {string} [options.publishedAt] 覆盖发布时间；不传则取当前 UTC 时间
 * @param {(message: string) => void} [options.log] 进度输出（不含私钥）
 * @returns {Promise<{ manifest: object, files: string[], skipped: {path: string, reason: string}[],
 *                     publicKeyPem: string, latestPath: string }>}
 */
export async function publishCorpus(options) {
  const {
    corpusDir,
    outDir,
    version,
    privateKeyPem,
    manifestApi,
    excludeNames = [],
    publishedAt,
    log = () => {},
  } = options;

  assertVersion(version);

  let corpusInfo;
  try {
    corpusInfo = await stat(corpusDir);
  } catch (error) {
    throw new CorpusPublishError(`语料目录不存在或不可读：${corpusDir}（${errorMessage(error)}）`);
  }
  if (!corpusInfo.isDirectory()) {
    throw new CorpusPublishError(`--corpus 必须是目录：${corpusDir}`);
  }
  assertOutDirOutsideCorpus(corpusDir, outDir);

  const excluded = new Set(excludeNames);
  const skipped = [];
  const candidates = [];

  for (const relativePath of await collectFiles(corpusDir)) {
    if (!hasAllowedExtension(relativePath)) continue;

    // 第一道闸：受管排除项。`_inbox.md` 是用户本地沉淀，OTA 会整份替换快照，
    // 把它算进清单要么冲掉用户内容、要么让新快照校验失败（契约 §3/§4）。
    const baseName = relativePath.slice(relativePath.lastIndexOf("/") + 1);
    if (excluded.has(baseName)) {
      skipped.push({ path: relativePath, reason: "受管排除项（本地沉淀/审核记录，永不进快照）" });
      continue;
    }
    candidates.push(relativePath);
  }

  for (const entry of skipped) {
    log(`跳过 ${entry.path}：${entry.reason}`);
  }

  if (candidates.length === 0) {
    throw new CorpusPublishError(
      `语料目录里没有可发布的 .md / .yaml 文件：${corpusDir}（排除项不计入）`,
    );
  }

  // 排序后再算摘要：即使 sha256 并发，产出顺序也只由路径决定。
  candidates.sort(comparePaths);

  const files = [];
  for (const relativePath of candidates) {
    const absolutePath = path.join(corpusDir, ...relativePath.split("/"));
    let sha256;
    try {
      sha256 = await manifestApi.sha256File(absolutePath);
    } catch (error) {
      throw new CorpusPublishError(`计算 sha256 失败：${relativePath}（${errorMessage(error)}）`);
    }
    files.push({ path: relativePath, sha256 });
  }

  /** @type {{ manifestVersion: 1, corpusVersion: number, publishedAt: string, files: {path: string, sha256: string}[], signature: string }} */
  const manifest = {
    manifestVersion: 1,
    corpusVersion: version,
    // 必须带 `Z`：`parseManifest` 拒绝无时区的时间，本机时区的含义在不同机器上不同。
    publishedAt: publishedAt ?? new Date().toISOString(),
    files,
    signature: "",
  };

  let signature;
  try {
    signature = manifestApi.signManifestPayload(manifest, privateKeyPem);
  } catch (error) {
    throw new CorpusPublishError(`签名失败：${errorMessage(error)}`);
  }
  manifest.signature = signature;

  // 自校验：用**即将写盘的字节**重新解析并验签，走客户端完全相同的路径。
  // 发布一份客户端必然拒绝的清单是最坏情况——它会被当成「源上没有该文件」，
  // 用户看到的是检查失败，而原因在发布侧、离现场很远。
  const serialized = serializeManifest(manifest);
  const publicKeyPem = derivePublicKeyPem(privateKeyPem);
  let reparsed;
  try {
    reparsed = manifestApi.parseManifest(JSON.parse(serialized));
  } catch (error) {
    throw new CorpusPublishError(`自校验失败：生成的清单无法被 parseManifest 解析（${errorMessage(error)}）`);
  }
  if (!manifestApi.verifyManifestSignature(reparsed, publicKeyPem)) {
    throw new CorpusPublishError("自校验失败：生成的清单用自己的公钥验签不通过，拒绝写出");
  }
  if (manifestApi.canonicalize(reparsed) !== manifestApi.canonicalize(manifest)) {
    throw new CorpusPublishError("自校验失败：清单经序列化往返后规范字节发生变化");
  }

  // 先落语料、最后写 latest.json。本地写入不是网络上传，但只要输出目录可能被
  // 同步工具实时上传，顺序就仍然有意义：清单出现时，它指向的文件必须已经在。
  for (const entry of files) {
    const source = path.join(corpusDir, ...entry.path.split("/"));
    const target = path.join(outDir, ...entry.path.split("/"));
    try {
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(source, target);
    } catch (error) {
      throw new CorpusPublishError(`写出语料失败：${entry.path}（${errorMessage(error)}）`);
    }
  }

  const latestPath = path.join(outDir, MANIFEST_FILE_NAME);
  try {
    await mkdir(outDir, { recursive: true });
    await writeFile(latestPath, serialized, "utf8");
  } catch (error) {
    throw new CorpusPublishError(`写出 ${MANIFEST_FILE_NAME} 失败：${errorMessage(error)}`);
  }
  return {
    manifest: reparsed,
    files: files.map((entry) => entry.path),
    skipped,
    publicKeyPem,
    latestPath,
    serialized,
  };
}
