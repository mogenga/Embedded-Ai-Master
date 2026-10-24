/**
 * 下载一个归档，并证明它就是我们要的那一个。
 *
 * 两个性质比速度更重要：
 *
 *   磁盘上的字节就是被哈希的字节。第二遍再哈希会留下一个窗口，文件可以
 *   在两次读取之间被替换；边写流边哈希关掉了这个窗口。
 *
 *   哈希在解压任何东西之前校验。损坏或被替换的归档在这里失败，两个哈希
 *   都写明，而不是在解压时冒出一个奇怪的错——更糟的情况是跑起来一个
 *   不该跑的二进制。
 *
 * 重定向会被跟随，但最终应答的主机必须是目录里点过名的。厂商的下载 URL
 * 频繁重定向到 CDN；开放重定向到别处正是这里要防的场景。
 *
 * （迁移自 Prometheus/src/packs/download.ts，除 user-agent 产品名与 import
 * 后缀外逐字保留。）
 */

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, rmSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { PackSource } from "./manifest.js";

export class DownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DownloadError";
  }
}

export interface DownloadProgress {
  received: number;
  total?: number;
}

export interface DownloadOptions {
  destination: string;
  signal?: AbortSignal;
  onProgress?: (progress: DownloadProgress) => void;
  /** 测试注入用；默认用全局 fetch。 */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * 把 `source` 下载到 `destination`，边下边哈希，然后校验。
 *
 * 任何失败都会删除文件，调用方永远不用区分"不存在"和"下了一半"。
 */
export async function downloadVerified(source: PackSource, options: DownloadOptions): Promise<{ bytes: number; sha256: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const hash = createHash("sha256");
  let received = 0;

  const abort = options.signal;
  if (abort?.aborted) throw new DownloadError("cancelled before starting");

  try {
    const response = await fetchImpl(source.url, {
      redirect: "follow",
      signal: abort,
      headers: { "user-agent": "Embedded-Ai-Master toolchain packs" },
    });

    if (!response.ok) {
      throw new DownloadError(`${source.url} returned HTTP ${response.status} ${response.statusText}`);
    }

    // `response.url` 是重定向后的最终 URL。它的主机必须是目录列过的；
    // 重定向到别处意味着制品不是我们的。
    const finalHost = safeHost(response.url);
    if (finalHost && !source.hosts.some((host) => host.toLowerCase() === finalHost.toLowerCase())) {
      throw new DownloadError(
        `redirected to ${finalHost}, which is not an approved host for this pack (expected one of ${source.hosts.join(", ")})`,
      );
    }

    if (!response.body) throw new DownloadError(`${source.url} returned no body`);

    const declared = Number(response.headers.get("content-length") ?? 0);
    const total = declared > 0 ? declared : source.bytes > 0 ? source.bytes : undefined;

    const body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);

    body.on("data", (chunk: Buffer) => {
      received += chunk.length;
      hash.update(chunk);
      options.onProgress?.({ received, ...(total ? { total } : {}) });
    });

    await pipeline(body, createWriteStream(options.destination));

    if (total && received < total) {
      throw new DownloadError(`download ended at ${received} of ${total} bytes`);
    }
    if (source.bytes > 0 && received !== source.bytes) {
      throw new DownloadError(`expected ${source.bytes} bytes, received ${received}`);
    }

    const sha256 = hash.digest("hex");
    if (sha256 !== source.sha256.toLowerCase()) {
      throw new DownloadError(
        `checksum mismatch for ${source.url}\n  expected ${source.sha256}\n  received ${sha256}\n` +
          `The file was not installed. It may be a partial download, or the publisher replaced the release.`,
      );
    }

    return { bytes: received, sha256 };
  } catch (error) {
    // 永远不留半截文件：下一次尝试必须从干净状态开始，一个散落的归档
    // 恰恰是这个功能要避免的磁盘杂物。
    try {
      rmSync(options.destination, { force: true });
    } catch {
      /* 已消失 */
    }
    if (error instanceof DownloadError) throw error;
    if (abort?.aborted) throw new DownloadError("cancelled");
    throw new DownloadError(error instanceof Error ? error.message : String(error));
  }
}

function safeHost(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/**
 * 哈希一个已在磁盘上的归档，就像它是下载来的一样。
 *
 * "从文件安装"面向够不着厂商的机器——物理隔离的构建服务器、上锁的
 * 企业网络。文件仍然对照随附 `pack.json` 里的校验和检查；唯一不同的是
 * 字节的来源。
 *
 * 文件被复制而不是原地哈希，因为事务拥有它稍后要删除的每个文件，而删
 * 掉用户从自己磁盘上挑的文件会是个意外。
 */
export async function importArchive(source: PackSource, file: string, options: DownloadOptions): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let received = 0;
  const abort = options.signal;
  if (abort?.aborted) throw new DownloadError("cancelled before starting");

  try {
    const body = createReadStream(file);
    body.on("data", (chunk: string | Buffer) => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      received += buffer.length;
      hash.update(buffer);
      options.onProgress?.({ received, ...(source.bytes > 0 ? { total: source.bytes } : {}) });
    });
    await pipeline(body, createWriteStream(options.destination));

    if (source.bytes > 0 && received !== source.bytes) {
      throw new DownloadError(`${file} is ${received} bytes, but the manifest says ${source.bytes}`);
    }

    const sha256 = hash.digest("hex");
    if (sha256 !== source.sha256.toLowerCase()) {
      throw new DownloadError(
        `checksum mismatch for ${file}\n  expected ${source.sha256}\n  received ${sha256}\n` +
          `The file was not installed. It may be a different build than the one its pack.json describes.`,
      );
    }
    return { bytes: received, sha256 };
  } catch (error) {
    try {
      rmSync(options.destination, { force: true });
    } catch {
      /* 已消失 */
    }
    if (error instanceof DownloadError) throw error;
    if (abort?.aborted) throw new DownloadError("cancelled");
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new DownloadError(`no such file: ${file}`);
    throw new DownloadError(error instanceof Error ? error.message : String(error));
  }
}