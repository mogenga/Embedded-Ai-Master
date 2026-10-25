#!/usr/bin/env node
/**
 * 检查 PE 文件（`.exe` / `.dll`）有没有 Authenticode 签名。
 *
 * **为什么不用 `Get-AuthenticodeSignature`**：本机 PowerShell 加载该 cmdlet 失败
 * （模块/provider 起不来），`signtool verify` 又依赖 Windows SDK。签名状态在 PE 头
 * 里就是一个字段，读它不需要任何外部工具，所以这里直接读字节。
 *
 * **判据**：可选头的数据目录第 4 项（`IMAGE_DIRECTORY_ENTRY_SECURITY`）的 Size 字段。
 * `size > 0` ⇔ 文件末尾挂着证书表 ⇔ 已签名。`size === 0` ⇔ 没有签名数据。
 *
 * **一个容易读错的点**：Security Directory 的 `VirtualAddress` 不是 RVA，而是
 * **文件偏移**（它是唯一一项按文件偏移解释的目录）。所以这里直接拿它当偏移用，
 * 并在输出里如实标注。
 *
 * **诚实的边界（R3）**：本脚本只回答「PE 头里有没有证书表」，**不验证签名是否
 * 有效**——不校验证书链、不校验摘要、不校验时间戳。证书表存在但内容被篡改、
 * 证书已过期且无时间戳，这里都会报「已签名」。要判有效性得用
 * `signtool verify /pa /v` 或系统 API。
 *
 * 用法：`node scripts/verify-signature.mjs <exe 路径> [<exe 路径> ...]`
 * 退出码：全部已签名 = 0；任一未签名 = 1；任一无法检查（不存在 / 不是 PE / 读不动）= 2。
 *
 * 无依赖，只用 `node:*`。
 */

import { open, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const USAGE = `用法: node scripts/verify-signature.mjs <exe 路径> [<exe 路径> ...]

读取 PE 头的 Security Directory，报告每个文件是否带 Authenticode 签名。

退出码:
  0  全部已签名
  1  至少一个未签名
  2  至少一个无法检查（文件不存在 / 不是 PE / 读取失败），或用法错误

注意: 本脚本只看「有没有证书表」，不验证签名有效性（证书链、摘要、时间戳都不校验）。
`;

/** 数据目录里的第 4 项（0 起算）是 Security Directory。 */
const IMAGE_DIRECTORY_ENTRY_SECURITY = 4;

const PE32_MAGIC = 0x10b;
const PE32_PLUS_MAGIC = 0x20b;

/** DOS 头 `MZ` 与 `e_lfanew` 都在这 64 字节里。 */
const DOS_HEADER_SIZE = 0x40;

/**
 * 一次最多读这么多字节找 PE 头。正常的 PE 里 `e_lfanew` 是几百字节、可选头不到
 * 1 KiB，128 KiB 对任何真实产物都绰绰有余；读 246 MB 的 Electron 主程序全文没有
 * 意义。超过这个范围会显式报「PE 头超出自读窗口」而不是假装读到了。
 */
export const MAX_HEADER_BYTES = 128 * 1024;

/** 用法错误（参数不对）与检查失败（文件/格式问题）都用它，靠 `exitCode` 区分。 */
export class VerifySignatureError extends Error {
  /**
   * @param {string} message
   * @param {{ exitCode?: number; cause?: unknown }} [options] 2 = 无法检查，1 = 内部误用
   */
  constructor(message, options = {}) {
    super(message);
    this.name = "VerifySignatureError";
    this.exitCode = options.exitCode ?? 1;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/**
 * 是不是一个 PE 文件（只看 DOS 头与 `PE\0\0` 签名，不看数据目录）。
 *
 * 纯函数、不抛错：任何读不出来/长度不够的情况都返回 `false`。
 *
 * @param {Buffer} buf
 * @returns {boolean}
 */
export function isPeFile(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < DOS_HEADER_SIZE) {
    return false;
  }
  if (buf[0] !== 0x4d || buf[1] !== 0x5a) {
    // "MZ"
    return false;
  }
  const peOffset = buf.readUInt32LE(0x3c);
  if (peOffset < DOS_HEADER_SIZE || peOffset + 4 > buf.length) {
    return false;
  }
  return buf.readUInt32LE(peOffset) === 0x00004550; // "PE\0\0"
}

/**
 * 从 PE 的可选头里读出 Security Directory。
 *
 * 结构参考 PE/COFF 规范：
 * - `e_lfanew`（DOS 头 0x3c 处，4 字节）= PE 头偏移；
 * - PE 头 = `PE\0\0`(4) + COFF 头(20) + 可选头；
 * - COFF 头偏移 16 处是 `SizeOfOptionalHeader`（2 字节）；
 * - 可选头开头是 `Magic`（2 字节）：0x10b = PE32，0x20b = PE32+；
 * - `NumberOfRvaAndSizes` 在 PE32 的可选头偏移 92、PE32+ 的 108；
 * - 数据目录表紧随其后（PE32 偏移 96、PE32+ 偏移 112），每项 8 字节
 *   （VirtualAddress 4 + Size 4）。
 *
 * 三者对不上（声明有第 5 项但可选头装不下）时**抛错**而不是报「未签名」：那种
 * 头是坏的，我们并不知道它到底签没签，说「未签名」就是撒谎（R3）。
 *
 * @param {Buffer} buf 至少覆盖到数据目录表
 * @returns {{
 *   peType: "PE32" | "PE32+",
 *   signed: boolean,
 *   size: number,
 *   certificateTableOffset: number,
 *   numberOfRvaAndSizes: number,
 *   peHeaderOffset: number,
 *   sizeOfOptionalHeader: number,
 * }}
 */
export function readSecurityDirectory(buf) {
  if (!Buffer.isBuffer(buf)) {
    throw new VerifySignatureError("readSecurityDirectory 需要 Buffer", { exitCode: 2 });
  }
  if (buf.length < DOS_HEADER_SIZE) {
    throw new VerifySignatureError(
      `文件太小（${buf.length} 字节），连 DOS 头都不完整`,
      { exitCode: 2 },
    );
  }
  if (buf[0] !== 0x4d || buf[1] !== 0x5a) {
    throw new VerifySignatureError(
      `不是 PE 文件：缺少 MZ 头（前两字节 0x${buf[0].toString(16).padStart(2, "0")} 0x${buf[1]
        .toString(16)
        .padStart(2, "0")}）`,
      { exitCode: 2 },
    );
  }

  const peHeaderOffset = buf.readUInt32LE(0x3c);
  // COFF 头 20 字节 + 可选头 Magic 2 字节，先确认这部分在缓冲区内。
  if (peHeaderOffset < DOS_HEADER_SIZE || peHeaderOffset + 24 > buf.length) {
    throw new VerifySignatureError(
      `PE 头超出自读窗口：e_lfanew=0x${peHeaderOffset.toString(16)}，缓冲区只有 ${buf.length} 字节`,
      { exitCode: 2 },
    );
  }
  if (buf.readUInt32LE(peHeaderOffset) !== 0x00004550) {
    throw new VerifySignatureError("不是 PE 文件：e_lfanew 处没有 PE\\0\\0 签名", { exitCode: 2 });
  }

  const coffHeaderOffset = peHeaderOffset + 4;
  const sizeOfOptionalHeader = buf.readUInt16LE(coffHeaderOffset + 16);
  const optionalHeaderOffset = coffHeaderOffset + 20;

  if (optionalHeaderOffset + 2 > buf.length) {
    throw new VerifySignatureError("PE 可选头被截断（连 Magic 都读不到）", { exitCode: 2 });
  }
  const magic = buf.readUInt16LE(optionalHeaderOffset);

  /** @type {"PE32" | "PE32+"} */
  let peType;
  let numberOfRvaAndSizesOffsetInOptional;
  let dataDirectoryOffsetInOptional;
  if (magic === PE32_MAGIC) {
    peType = "PE32";
    numberOfRvaAndSizesOffsetInOptional = 92;
    dataDirectoryOffsetInOptional = 96;
  } else if (magic === PE32_PLUS_MAGIC) {
    peType = "PE32+";
    numberOfRvaAndSizesOffsetInOptional = 108;
    dataDirectoryOffsetInOptional = 112;
  } else {
    throw new VerifySignatureError(
      `未知的可选头 Magic 0x${magic.toString(16)}（既不是 PE32 的 0x10b 也不是 PE32+ 的 0x20b）`,
      { exitCode: 2 },
    );
  }

  const base = {
    peType,
    peHeaderOffset,
    sizeOfOptionalHeader,
  };

  // 可选头自身要装得下 NumberOfRvaAndSizes + 到第 4 项目录项为止的字节。
  // 数据目录从 `dataDirectoryOffsetInOptional` 起，每项 8 字节；Security 是第 4 项
  // （0 起算），所以它的 8 字节结束于 `dataDirectoryOffsetInOptional + (4+1)*8`。
  const securityEntryOffsetInOptional =
    dataDirectoryOffsetInOptional + IMAGE_DIRECTORY_ENTRY_SECURITY * 8;
  const neededInOptionalHeader = securityEntryOffsetInOptional + 8;
  if (sizeOfOptionalHeader < numberOfRvaAndSizesOffsetInOptional + 4) {
    // 可选头短到没有 NumberOfRvaAndSizes 字段：按规范这不可能，但真遇到了就说清楚。
    throw new VerifySignatureError(
      `PE 可选头长度异常：SizeOfOptionalHeader=${sizeOfOptionalHeader}，` +
        `装不下 ${peType} 的 NumberOfRvaAndSizes（偏移 ${numberOfRvaAndSizesOffsetInOptional}）`,
      { exitCode: 2 },
    );
  }
  if (optionalHeaderOffset + numberOfRvaAndSizesOffsetInOptional + 4 > buf.length) {
    throw new VerifySignatureError("PE 可选头被截断（读不到 NumberOfRvaAndSizes）", { exitCode: 2 });
  }

  const numberOfRvaAndSizes = buf.readUInt32LE(optionalHeaderOffset + numberOfRvaAndSizesOffsetInOptional);
  if (numberOfRvaAndSizes <= IMAGE_DIRECTORY_ENTRY_SECURITY) {
    // 没有 Security Directory 这一项 = 不可能有证书表。
    return {
      ...base,
      numberOfRvaAndSizes,
      signed: false,
      size: 0,
      certificateTableOffset: 0,
    };
  }

  if (sizeOfOptionalHeader < neededInOptionalHeader) {
    throw new VerifySignatureError(
      `PE 头自相矛盾：NumberOfRvaAndSizes=${numberOfRvaAndSizes}（声明有 Security Directory），` +
        `但 SizeOfOptionalHeader=${sizeOfOptionalHeader} 只够到偏移 ${sizeOfOptionalHeader}，` +
        `第 ${IMAGE_DIRECTORY_ENTRY_SECURITY} 项目录需要到 ${neededInOptionalHeader}`,
      { exitCode: 2 },
    );
  }
  const securityEntryOffset = optionalHeaderOffset + securityEntryOffsetInOptional;
  if (securityEntryOffset + 8 > buf.length) {
    throw new VerifySignatureError(
      `PE 头超出自读窗口：Security Directory 项在偏移 0x${securityEntryOffset.toString(16)}，` +
        `缓冲区只有 ${buf.length} 字节`,
      { exitCode: 2 },
    );
  }

  // 注意：Security Directory 的 VirtualAddress 是**文件偏移**，不是 RVA。
  const certificateTableOffset = buf.readUInt32LE(securityEntryOffset);
  const size = buf.readUInt32LE(securityEntryOffset + 4);

  return {
    ...base,
    numberOfRvaAndSizes,
    signed: size > 0,
    size,
    certificateTableOffset: size > 0 ? certificateTableOffset : 0,
  };
}

/**
 * 读一个文件的 PE 头并报告签名状态。
 *
 * 只读文件开头最多 `MAX_HEADER_BYTES` 字节，不把整份可执行文件读进内存。
 *
 * @param {string} filePath
 * @returns {Promise<{
 *   file: string,
 *   fileSize: number,
 *   peType: "PE32" | "PE32+",
 *   signed: boolean,
 *   size: number,
 *   certificateTableOffset: number,
 *   certificateTableWithinFile: boolean,
 *   numberOfRvaAndSizes: number,
 *   peHeaderOffset: number,
 *   sizeOfOptionalHeader: number,
 * }>}
 */
export async function inspectFile(filePath) {
  let info;
  try {
    info = await stat(filePath);
  } catch (error) {
    throw new VerifySignatureError(
      `无法访问 ${filePath}：${error.code ?? error.message}`,
      { exitCode: 2, cause: error },
    );
  }
  if (!info.isFile()) {
    throw new VerifySignatureError(`${filePath} 不是普通文件`, { exitCode: 2 });
  }
  if (info.size < DOS_HEADER_SIZE) {
    throw new VerifySignatureError(
      `不是 PE 文件：${filePath} 只有 ${info.size} 字节，连 DOS 头都不完整`,
      { exitCode: 2 },
    );
  }

  const readLength = Math.min(info.size, MAX_HEADER_BYTES);
  const buf = Buffer.alloc(readLength);
  let bytesRead = 0;
  let handle;
  try {
    handle = await open(filePath, "r");
    const result = await handle.read(buf, 0, readLength, 0);
    bytesRead = result.bytesRead;
  } catch (error) {
    throw new VerifySignatureError(
      `读取 ${filePath} 失败：${error.code ?? error.message}`,
      { exitCode: 2, cause: error },
    );
  } finally {
    if (handle !== undefined) {
      await handle.close();
    }
  }
  if (bytesRead < DOS_HEADER_SIZE) {
    throw new VerifySignatureError(
      `读取 ${filePath} 时只拿到 ${bytesRead} 字节，文件可能在读取期间被截断`,
      { exitCode: 2 },
    );
  }

  let parsed;
  try {
    parsed = readSecurityDirectory(buf.subarray(0, bytesRead));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new VerifySignatureError(`${filePath}：${reason}`, { exitCode: 2, cause: error });
  }

  return {
    file: filePath,
    fileSize: info.size,
    ...parsed,
    // 证书表声称的范围是否真的落在文件里。超出并不意味着「没签名」——头里有 size
    // 就说明有证书表声明——但那种文件是坏的，值得点名。
    certificateTableWithinFile:
      parsed.size === 0 ? true : parsed.certificateTableOffset + parsed.size <= info.size,
  };
}

/**
 * @param {string[]} argv
 * @returns {{ help: true } | { help: false, files: string[] }}
 */
export function parseArgs(argv) {
  /** @type {string[]} */
  const files = [];
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      return { help: true };
    }
    if (arg.startsWith("--")) {
      throw new VerifySignatureError(`未知选项：${arg}\n\n${USAGE}`, { exitCode: 2 });
    }
    files.push(arg);
  }
  if (files.length === 0) {
    throw new VerifySignatureError(`缺少要检查的文件\n\n${USAGE}`, { exitCode: 2 });
  }
  return { help: false, files };
}

/**
 * 一行一个文件的报告。已签名写证书表位置，未签名写 size=0，都带上 PE 类型。
 *
 * @param {Awaited<ReturnType<typeof inspectFile>>} info
 * @returns {string}
 */
export function formatResult(info) {
  const lines = [];
  const head = info.signed
    ? `[已签名] ${info.file}`
    : `[未签名] ${info.file}`;
  lines.push(head);
  lines.push(`         ${info.peType}  Security Directory: size=${info.size}（0x${info.size.toString(16)}）`);
  if (info.signed) {
    lines.push(
      `         证书表: 文件偏移 0x${info.certificateTableOffset.toString(16)}，` +
        `${info.size} 字节（Semantics: VirtualAddress 即文件偏移，不是 RVA）`,
    );
    if (!info.certificateTableWithinFile) {
      lines.push(
        `         警告: 证书表声称的范围超出文件末尾（${info.certificateTableOffset + info.size} > ${info.fileSize}），文件已损坏`,
      );
    }
    lines.push("         注意: 只表明存在证书表，未验证签名有效性（证书链 / 摘要 / 时间戳）");
  }
  return lines.join("\n");
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`verify-signature: ${message}`);
    process.exitCode = error instanceof VerifySignatureError ? error.exitCode : 2;
    return;
  }
  if (parsed.help === true) {
    console.log(USAGE);
    return;
  }

  let signedCount = 0;
  let unsignedCount = 0;
  let errorCount = 0;

  for (const file of parsed.files) {
    try {
      const info = await inspectFile(file);
      console.log(formatResult(info));
      if (info.signed) {
        signedCount += 1;
      } else {
        unsignedCount += 1;
      }
    } catch (error) {
      errorCount += 1;
      const message = error instanceof VerifySignatureError ? error.message : String(error);
      console.error(`[错误] ${message}`);
    }
  }

  console.log("");
  console.log(
    `合计 ${parsed.files.length} 个文件：${signedCount} 已签名，${unsignedCount} 未签名，${errorCount} 无法检查`,
  );

  // 错误优先于未签名：无法检查的文件也不该被当成「通过门禁」。
  if (errorCount > 0) {
    process.exitCode = 2;
  } else if (unsignedCount > 0) {
    process.exitCode = 1;
  } else {
    process.exitCode = 0;
  }
}

// 只有被当成脚本直接运行时才跑 CLI。测试 import 本模块拿纯函数，不应触发 argv 解析。
const invokedPath =
  process.argv[1] === undefined ? "" : pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath !== "" && import.meta.url === invokedPath) {
  await main();
}
