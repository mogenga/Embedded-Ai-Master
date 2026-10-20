import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createUiServer } from "../src/server/api.js";
import { createSessionRunner } from "../src/server/runner.js";
import type { SessionRunner } from "../src/server/runner.js";
import type { SessionEventEnvelope } from "../src/session/types.js";

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

interface ScriptStep {
  body: unknown;
  waitFor?: Promise<void>;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, resolve: release };
}

function toolCallBody(id: string, command: string): unknown {
  return {
    choices: [
      {
        message: {
          content: "",
          tool_calls: [
            {
              id,
              type: "function",
              function: { name: "shell", arguments: JSON.stringify({ command }) },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 2 },
  };
}

const DONE_BODY = {
  choices: [{ message: { content: "done" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 20, completion_tokens: 3 },
};

function fakeFetch(steps: ScriptStep[]): typeof fetch {
  let index = 0;
  return async () => {
    const step = steps[Math.min(index, steps.length - 1)]!;
    index += 1;
    if (step.waitFor !== undefined) await step.waitFor;
    return new Response(JSON.stringify(step.body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

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

interface Harness {
  home: string;
  base: string;
  runner: SessionRunner;
  close(): Promise<void>;
}

async function setup(options: {
  steps: ScriptStep[];
  permissions?: unknown;
}): Promise<Harness> {
  const home = await tempDir("eam-web-approval-");
  if (options.permissions !== undefined) {
    await writeFile(
      path.join(home, "permissions.json"),
      JSON.stringify(options.permissions),
      "utf8",
    );
  }
  const runner = createSessionRunner({
    harnessHome: home,
    model: "gw/flash",
    providersText: providersText(),
    fetchImpl: fakeFetch(options.steps),
    cwd: home,
  });
  const port = await freePort();
  const ui = createUiServer({ harnessHome: home, runner, port });
  if (!ui.server.listening) await once(ui.server, "listening");
  return {
    home,
    base: `http://127.0.0.1:${port}`,
    runner,
    async close() {
      await ui.close();
      await runner.close();
    },
  };
}

function post(base: string, pathname: string, body: unknown, origin = true): Promise<Response> {
  return fetch(`${base}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(origin ? { origin: base } : {}),
    },
    body: JSON.stringify(body),
  });
}

interface Frame {
  event?: string;
  data?: string;
}

function parseFrame(block: string): Frame {
  const frame: Frame = {};
  for (const line of block.split("\n")) {
    if (line.length === 0 || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") frame.event = value;
    else if (field === "data") frame.data = (frame.data ?? "") + value;
  }
  return frame;
}

interface SseStream {
  events: SessionEventEnvelope[];
  waitFor(
    predicate: (event: SessionEventEnvelope) => boolean,
    timeoutMs?: number,
  ): Promise<SessionEventEnvelope>;
  close(): void;
}

async function openSse(base: string, sessionId: string): Promise<SseStream> {
  const controller = new AbortController();
  const response = await fetch(
    `${base}/api/events?${new URLSearchParams({ sessionId }).toString()}`,
    { signal: controller.signal },
  );
  expect(response.status).toBe(200);
  expect(response.body).not.toBeNull();
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: SessionEventEnvelope[] = [];
  let buffer = "";
  let ended = false;

  const pump = async (): Promise<void> => {
    const chunk = await reader.read();
    if (chunk.done) {
      ended = true;
      return;
    }
    buffer += decoder.decode(chunk.value, { stream: true });
    for (;;) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary < 0) break;
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const frame = parseFrame(block);
      if (frame.event === "stream_end") {
        ended = true;
      } else if (frame.event === "stream_error") {
        throw new Error(`SSE stream_error: ${frame.data ?? ""}`);
      } else if (frame.data !== undefined) {
        events.push(JSON.parse(frame.data) as SessionEventEnvelope);
      }
    }
  };

  return {
    events,
    async waitFor(predicate, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = events.find(predicate);
        if (found !== undefined) return found;
        if (ended) throw new Error("SSE 流已结束但未等到期望事件");
        if (Date.now() > deadline) throw new Error("等待 SSE 事件超时");
        await pump();
      }
    },
    close() {
      controller.abort();
      reader.cancel().catch(() => undefined);
    },
  };
}

async function startAction(harness: Harness, text: string) {
  const response = await post(harness.base, "/api/actions", { text });
  expect(response.status).toBe(202);
  const body = (await response.json()) as { sessionId: string };
  const sse = await openSse(harness.base, body.sessionId);
  const request = await sse.waitFor((event) => event.type === "approval_request");
  return { sessionId: body.sessionId, sse, request };
}

describe("Web 审批端到端闭环", () => {
  it("allow：等待期间审批请求可见，决策后执行工具并按序落事件", async () => {
    const harness = await setup({
      steps: [{ body: toolCallBody("call-allow", "echo ok") }, { body: DONE_BODY }],
    });
    let sse: SseStream | undefined;
    try {
      const started = await startAction(harness, "执行诊断");
      sse = started.sse;
      const requestId = String(started.request.payload.requestId);
      const callId = String(started.request.payload.callId);
      expect(callId).toBe("call-allow");
      expect(started.request.payload).toMatchObject({ action: "ask", tool: "shell" });
      expect(started.request.payload.args).toBeUndefined();
      expect(typeof started.request.payload.paramsDigest).toBe("string");
      expect(String(started.request.payload.paramsDigest).length).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(String(started.request.payload.deadlineAt)))).toBe(false);

      const duringWait = started.sse.events.filter(
        (event) => event.type === "permission_decision" && event.payload.callId === callId,
      );
      expect(duringWait).toEqual([]);

      const approval = await post(harness.base, "/api/approvals", {
        sessionId: started.sessionId,
        requestId,
        decision: "allow",
      });
      expect(approval.status).toBe(202);

      const result = await started.sse.waitFor(
        (event) => event.type === "tool_result" && event.payload.id === callId,
      );
      expect(result.payload).toMatchObject({ ok: true, code: "ok" });
      await started.sse.waitFor(
        (event) => event.type === "status" && event.payload.status === "done",
      );

      const ordered = started.sse.events.filter(
        (event) =>
          ["approval_request", "permission_decision", "tool_started", "tool_result"].includes(
            event.type,
          )
          && (event.payload.callId === callId || event.payload.id === callId),
      );
      expect(ordered.map((event) => event.type)).toEqual([
        "approval_request",
        "permission_decision",
        "tool_started",
        "tool_result",
      ]);
      expect(ordered[1]!.payload).toMatchObject({
        effective: "allow",
        action: "ask",
        callId,
      });
      expect(String(ordered[1]!.payload.reason)).toContain("approval_granted");
      expect(ordered[2]!.payload).toMatchObject({ callId, tool: "shell" });
    } finally {
      sse?.close();
      await harness.close();
    }
  }, 30_000);

  it("deny：有效决策为 deny，不产生 tool_started", async () => {
    const harness = await setup({
      steps: [{ body: toolCallBody("call-deny", "echo denied") }, { body: DONE_BODY }],
    });
    let sse: SseStream | undefined;
    try {
      const started = await startAction(harness, "执行诊断");
      sse = started.sse;
      const requestId = String(started.request.payload.requestId);
      const callId = String(started.request.payload.callId);
      expect(callId).toBe("call-deny");

      const approval = await post(harness.base, "/api/approvals", {
        sessionId: started.sessionId,
        requestId,
        decision: "deny",
      });
      expect(approval.status).toBe(202);

      const decision = await started.sse.waitFor(
        (event) => event.type === "permission_decision" && event.payload.callId === callId,
      );
      expect(decision.payload).toMatchObject({ effective: "deny", action: "ask", callId });
      expect(String(decision.payload.reason)).toContain("approval_denied");

      const result = await started.sse.waitFor(
        (event) => event.type === "tool_result" && event.payload.id === callId,
      );
      expect(result.payload).toMatchObject({ ok: false, code: "permission_denied" });
      await started.sse.waitFor(
        (event) => event.type === "status" && event.payload.status === "done",
      );

      expect(
        started.sse.events.some(
          (event) => event.type === "tool_started" && event.payload.callId === callId,
        ),
      ).toBe(false);
    } finally {
      sse?.close();
      await harness.close();
    }
  }, 30_000);

  it("超时：approval_timeout 落审计，迟到决策返回 410 且不执行工具", async () => {
    const secondResponse = deferred();
    const harness = await setup({
      permissions: { version: 1, approvalTimeoutMs: 300 },
      steps: [
        { body: toolCallBody("call-timeout", "echo timeout") },
        { body: DONE_BODY, waitFor: secondResponse.promise },
      ],
    });
    let sse: SseStream | undefined;
    try {
      const started = await startAction(harness, "执行诊断");
      sse = started.sse;
      const requestId = String(started.request.payload.requestId);
      const callId = String(started.request.payload.callId);
      expect(callId).toBe("call-timeout");

      expect(
        started.sse.events.some(
          (event) => event.type === "permission_decision" && event.payload.callId === callId,
        ),
      ).toBe(false);

      const decision = await started.sse.waitFor(
        (event) => event.type === "permission_decision" && event.payload.callId === callId,
      );
      expect(decision.payload).toMatchObject({ effective: "deny", callId });
      expect(String(decision.payload.reason)).toContain("approval_timeout");

      const late = await post(harness.base, "/api/approvals", {
        sessionId: started.sessionId,
        requestId,
        decision: "allow",
      });
      expect(late.status).toBe(410);
      expect(((await late.json()) as { error: { code: string } }).error.code).toBe(
        "approval_expired",
      );

      secondResponse.resolve();
      await started.sse.waitFor(
        (event) => event.type === "status" && event.payload.status === "done",
      );
      expect(
        started.sse.events.some(
          (event) => event.type === "tool_started" && event.payload.callId === callId,
        ),
      ).toBe(false);
    } finally {
      secondResponse.resolve();
      sse?.close();
      await harness.close();
    }
  }, 30_000);

  it("缺少 Origin 的审批 POST 返回 403", async () => {
    const harness = await setup({
      steps: [{ body: DONE_BODY }],
    });
    try {
      const response = await post(
        harness.base,
        "/api/approvals",
        { sessionId: "s1", requestId: "r1", decision: "allow" },
        false,
      );
      expect(response.status).toBe(403);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
        "forbidden_origin",
      );
    } finally {
      await harness.close();
    }
  }, 30_000);
});