import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogTailEventSource } from "../src/events/log-tail.js";
import { runSession } from "../src/index.js";
import { createUiServer } from "../src/server/api.js";
import type { SessionEventEnvelope } from "../src/session/types.js";
import { sessionEventsToMessages } from "../desktop/renderer/protocol.js";

const MCP_FIXTURE = path.join(import.meta.dirname, "fixtures", "mcp-echo-server.mjs");
const SESSION_ID = "e2e-device";
const tempDirs: string[] = [];

function tempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix)).then((dir) => {
    tempDirs.push(dir);
    return dir;
  });
}

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

function providersText(): string {
  return JSON.stringify({
    gw: {
      protocol: "openai-chat-completions",
      baseUrl: "http://127.0.0.1:9/v1",
      models: { flash: { contextWindow: 8192, maxOutput: 512 } },
      pricePerMillion: { input: 1, output: 1 },
    },
  });
}

function mockFetch(bodies: unknown[]): typeof fetch {
  let index = 0;
  return async () => {
    const payload = bodies[Math.min(index, bodies.length - 1)];
    index += 1;
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

const TOOL_RESPONSE = {
  choices: [
    {
      message: {
        content: "",
        tool_calls: [
          { id: "call-device", type: "function", function: { name: "mcp__echo__device", arguments: "{}" } },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 2 },
};

const DONE_RESPONSE = {
  choices: [{ message: { content: "done" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 20, completion_tokens: 3 },
};

async function freePort(): Promise<number> {
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

interface Frame {
  event?: string;
  id?: number;
  data?: string;
}

function parseFrames(text: string): Frame[] {
  const frames: Frame[] = [];
  for (const block of text.split("\n\n")) {
    const frame: Frame = {};
    for (const line of block.split("\n")) {
      if (line.length === 0 || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") frame.event = value;
      else if (field === "id") frame.id = Number(value);
      else if (field === "data") frame.data = (frame.data ?? "") + value;
    }
    if (frame.data !== undefined) frames.push(frame);
  }
  return frames;
}

async function readStream(base: string, since?: number) {
  const query = new URLSearchParams({ sessionId: SESSION_ID });
  if (since !== undefined) query.set("since", String(since));
  const response = await fetch(`${base}/api/events?${query.toString()}`);
  const text = await response.text();
  const frames = parseFrames(text);
  const events = frames
    .filter((frame) => frame.event === undefined && frame.data !== undefined)
    .map((frame) => JSON.parse(frame.data!) as SessionEventEnvelope);
  return {
    status: response.status,
    events,
    ended: frames.some((frame) => frame.event === "stream_end"),
    errors: frames.filter((frame) => frame.event === "stream_error"),
  };
}

describe("事件流端到端", () => {
  it("runSession 真实日志经 LogTailEventSource 与 SSE 投影", async () => {
    const home = await tempDir("eam-events-e2e-");
    vi.stubEnv("HARNESS_HOME", home);
    const configDir = await tempDir("eam-events-e2e-config-");
    const userConfigPath = path.join(configDir, "mcp.json");
    await writeFile(
      userConfigPath,
      JSON.stringify({
        mcpServers: { echo: { command: process.execPath, args: [MCP_FIXTURE] } },
      }),
      "utf8",
    );

    const sessionDir = path.join(home, "sessions", SESSION_ID);
    const loop: string[] = [];
    for await (const event of runSession({
      input: "检查设备状态",
      model: "gw/flash",
      providersText: providersText(),
      sessionId: SESSION_ID,
      sessionDir,
      cwd: home,
      fetchImpl: mockFetch([TOOL_RESPONSE, DONE_RESPONSE]),
      mcp: { userConfigPath },
    })) {
      loop.push(event.kind);
    }
    expect(loop.at(-1)).toBe("done");
    expect(existsSync(path.join(sessionDir, "session.v1.jsonl"))).toBe(true);

    const port = await freePort();
    const ui = createUiServer({
      harnessHome: home,
      port,
      eventSource: createLogTailEventSource({ sessionsRoot: path.join(home, "sessions") }),
    });
    const base = `http://127.0.0.1:${port}`;
    try {
      const first = await readStream(base);
      expect(first.status).toBe(200);
      expect(first.ended).toBe(true);
      expect(first.errors).toEqual([]);

      const lifecycle = first.events
        .filter((event) =>
          ["permission_decision", "tool_started", "tool_result", "device_status"].includes(event.type),
        )
        .map((event) => event.type);
      expect(lifecycle).toEqual(["permission_decision", "tool_started", "tool_result", "device_status"]);

      const device = first.events.find((event) => event.type === "device_status");
      expect(device?.payload).toMatchObject({
        callId: "call-device",
        server: "echo",
        tool: "mcp__echo__device",
        state: { probe: "attached", serial: "open", cpu: "halted", backend: "renode" },
      });
      expect(first.events.some((event) => event.type === "mcp_status")).toBe(true);
      expect(first.events.every((event) => event.sessionId === SESSION_ID)).toBe(true);
      expect(first.events.map((event) => event.seq)).toEqual(
        [...first.events.map((event) => event.seq)].sort((left, right) => left - right),
      );

      const seqs = first.events.map((event) => event.seq);
      const cut = seqs[Math.floor(seqs.length / 2)];
      const tail = await readStream(base, cut);
      expect(tail.ended).toBe(true);
      expect(tail.events.map((event) => event.seq)).toEqual(seqs.filter((seq) => seq > cut));

      const merged = [...first.events, ...tail.events]
        .filter((event, index, all) => all.findIndex((item) => item.seq === event.seq) === index)
        .sort((left, right) => left.seq - right.seq);
      const detail = (await (await fetch(`${base}/api/sessions/${SESSION_ID}`)).json()) as {
        events: SessionEventEnvelope[];
      };
      // 合并 SSE 重放与实时尾部后，桌面渲染器重建的消息序列必须与整篇日志一致。
      expect(sessionEventsToMessages(merged)).toEqual(sessionEventsToMessages(detail.events));
    } finally {
      await ui.close();
    }
  }, 30_000);
});