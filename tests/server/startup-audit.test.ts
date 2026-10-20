import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runSession } from "../../src/index.js";
import { readSessionDir } from "../../src/session/persistence.js";

const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

const PROVIDERS_TEXT = JSON.stringify({
  gw: {
    protocol: "openai-chat-completions",
    baseUrl: "http://127.0.0.1:9/v1",
    models: { flash: { contextWindow: 8192, maxOutput: 512 } },
  },
});

describe("runSession startup audit", () => {
  it("query 启动前的失败会写入 interrupted(start_failed) 且保留原始错误", async () => {
    const home = await tempDir("eam-start-audit-");
    const sessionDir = path.join(home, "sessions", "s1");
    const failure = new Error("onSession boom");

    const generator = runSession({
      input: "hi",
      model: "gw/flash",
      providersText: PROVIDERS_TEXT,
      home,
      sessionDir,
      onSession: () => {
        throw failure;
      },
    });

    await expect(
      (async () => {
        for await (const _event of generator) {
          // drain
        }
      })(),
    ).rejects.toBe(failure);

    const { events } = readSessionDir(sessionDir);
    const interrupted = events.filter((event) => event.type === "interrupted");
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]!.payload).toMatchObject({ reason: "start_failed" });
  });
});