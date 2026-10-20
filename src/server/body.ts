import type { IncomingMessage } from "node:http";
import { HttpError } from "./http.js";

const DEFAULT_LIMIT_BYTES = 8192;
const READ_TIMEOUT_MS = 5000;

function assertJsonContentType(req: IncomingMessage): void {
  const raw = req.headers["content-type"];
  const contentType = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!contentType.startsWith("application/json")) {
    throw new HttpError(415, "unsupported_media_type", "Content-Type 必须是 application/json");
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readJsonBody(
  req: IncomingMessage,
  limitBytes: number = DEFAULT_LIMIT_BYTES,
): Promise<Record<string, unknown>> {
  assertJsonContentType(req);

  let timedOut = false;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      req.destroy();
      reject(new HttpError(408, "request_timeout", "读取请求体超时"));
    }, READ_TIMEOUT_MS);
    timer.unref();
  });

  const read = (async (): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
        total += buffer.byteLength;
        if (total > limitBytes) {
          throw new HttpError(413, "payload_too_large", `请求体超过 ${limitBytes} 字节`);
        }
        chunks.push(buffer);
      }
    } catch (error) {
      // 超时分支由 timeout 负责报错；这里吞掉 destroy 触发的读错误，避免未处理拒绝。
      if (timedOut) return Buffer.alloc(0);
      throw error;
    }
    return Buffer.concat(chunks);
  })();

  let payload: Buffer;
  try {
    payload = await Promise.race([read, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_body", "请求体不是合法 JSON");
  }
  if (!isPlainObject(parsed)) {
    throw new HttpError(400, "invalid_body", "请求体必须是 JSON 对象");
  }
  return parsed;
}