import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { request } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { readJsonBody } from "../../src/server/body.js";
import { HttpError, sendError } from "../../src/server/http.js";

interface Running {
  port: number;
  close(): Promise<void>;
}

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function start(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>): Promise<Running> {
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  const close = async (): Promise<void> => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  closers.push(close);
  return { port: address.port, close };
}

describe("readJsonBody timeout", () => {
  it("慢速未完成 body 在超时后返回 408 而不是断开连接", async () => {
    const api = await start(async (req, res) => {
      try {
        const body = await readJsonBody(req, 1024, 50);
        res.end(JSON.stringify(body));
      } catch (error) {
        req.resume();
        if (error instanceof HttpError) {
          sendError(res, error.status, error.code, error.message);
          return;
        }
        sendError(res, 500, "internal", "unexpected");
      }
    });

    const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request({
        host: "127.0.0.1",
        port: api.port,
        path: "/",
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": "1000",
          connection: "close",
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      });
      req.on("error", reject);
      req.write('{"text":');
    });

    expect(response.status).toBe(408);
    expect(JSON.parse(response.body)).toMatchObject({
      error: { code: "request_timeout" },
    });
  });
});