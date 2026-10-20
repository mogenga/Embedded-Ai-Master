import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUiServer } from "../../src/server/api.js";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close(() => reject(new Error("无法获取空闲端口")));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

// 只对包含 "blocked" 的 header.json 注入 EACCES;其余路径走真实 fs。
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const denied = (target: unknown): never => {
    const error = new Error(`EACCES: permission denied, ${String(target)}`);
    (error as NodeJS.ErrnoException).code = "EACCES";
    throw error;
  };
  return {
    ...actual,
    lstatSync: ((target: Parameters<typeof actual.lstatSync>[0], options?: unknown) => {
      if (String(target).includes("blocked") && String(target).endsWith("header.json")) {
        return denied(target);
      }
      return actual.lstatSync(target, options as never);
    }) as typeof actual.lstatSync,
  };
});

const homes: string[] = [];

function makeHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), "eam-api-unreadable-"));
  homes.push(home);
  mkdirSync(path.join(home, "sessions", "blocked"), { recursive: true });
  writeFileSync(
    path.join(home, "sessions", "blocked", "header.json"),
    JSON.stringify({ id: "blocked", createdAt: "2026-10-20T00:00:00.000Z", status: "closed" }),
  );
  writeFileSync(
    path.join(home, "sessions", "blocked", "session.v1.jsonl"),
    `${JSON.stringify({ seq: 0, ts: "t", type: "user", payload: { content: "hi" } })}\n`,
  );
  return home;
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("会话列表权限错误归类", () => {
  it("header 读取抛 EACCES 时记 unreadable 而不是 invalid_header", async () => {
    const port = await freePort();
    const server = createUiServer({ harnessHome: makeHome(), port });
    try {
      const body = (await (await fetch(`http://127.0.0.1:${port}/api/sessions`)).json()) as {
        sessions: unknown[];
        errors: Array<{ dir: string; code: string }>;
      };
      expect(body.sessions).toEqual([]);
      expect(body.errors).toContainEqual({ dir: "blocked", code: "unreadable" });
    } finally {
      await server.close();
    }
  });
});
