import { afterEach, describe, expect, it, vi } from "vitest";
import { createApprovalBridge } from "../src/server/approvals.js";
import type { PermissionPromptRequest } from "../src/permissions/types.js";
import type { SessionEvent } from "../src/session/types.js";

function fakeHandle() {
  const append = vi.fn(
    async (ev: Omit<SessionEvent, "seq" | "ts">): Promise<SessionEvent> => ({
      ...ev,
      seq: 0,
      ts: "",
    }),
  );
  return { append };
}

function promptReq(
  requestId: string,
  overrides: Partial<PermissionPromptRequest> = {},
): PermissionPromptRequest {
  return {
    requestId,
    callId: requestId,
    tool: "shell",
    args: { command: "echo hi" },
    reason: "needs approval",
    preset: "diagnose",
    access: "write",
    deadlineAt: "2026-10-20T00:05:00.000Z",
    paramsDigest: "digest-1",
    paramsKeys: ["command"],
    paramsPreview: { command: "echo hi" },
    signal: new AbortController().signal,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ApprovalBridge", () => {
  it("先写 approval_request 再等待决策", async () => {
    const handle = fakeHandle();
    const bridge = createApprovalBridge();
    bridge.bindSession(handle);
    const req = promptReq("call-1");
    const promise = bridge.request(req);
    expect(handle.append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "approval_request",
        payload: expect.objectContaining({
          requestId: "call-1",
          callId: "call-1",
          action: "ask",
          deadlineAt: req.deadlineAt,
        }),
      }),
    );
    expect(bridge.pendingCount()).toBe(1);
    expect(bridge.decide("call-1", "allow")).toEqual({ kind: "accepted" });
    await expect(promise).resolves.toBe("allow");
    expect(bridge.pendingCount()).toBe(0);
  });

  it("deny 决策返回 deny", async () => {
    const bridge = createApprovalBridge();
    bridge.bindSession(fakeHandle());
    const promise = bridge.request(promptReq("call-2"));
    expect(bridge.decide("call-2", "deny")).toEqual({ kind: "accepted" });
    await expect(promise).resolves.toBe("deny");
  });

  it("payload 复制审批所需字段", async () => {
    const handle = fakeHandle();
    const bridge = createApprovalBridge();
    bridge.bindSession(handle);
    const req = promptReq("call-3");
    const promise = bridge.request(req);
    const event = handle.append.mock.calls[0]![0];
    expect(event.payload).toEqual({
      requestId: "call-3",
      callId: "call-3",
      tool: "shell",
      action: "ask",
      access: "write",
      reason: "needs approval",
      preset: "diagnose",
      paramsDigest: "digest-1",
      paramsKeys: ["command"],
      paramsPreview: { command: "echo hi" },
      deadlineAt: req.deadlineAt,
    });
    bridge.decide("call-3", "allow");
    await promise;
  });

  it("signal abort 清理 pending 并返回 deny", async () => {
    const bridge = createApprovalBridge();
    bridge.bindSession(fakeHandle());
    const controller = new AbortController();
    const promise = bridge.request(promptReq("call-4", { signal: controller.signal }));
    controller.abort();
    await expect(promise).resolves.toBe("deny");
    expect(bridge.pendingCount()).toBe(0);
    expect(bridge.decide("call-4", "allow")).toEqual({ kind: "expired" });
  });

  it("append 失败使 request reject", async () => {
    const bridge = createApprovalBridge();
    const failure = new Error("log unavailable");
    bridge.bindSession({ append: vi.fn(async () => Promise.reject(failure)) });
    await expect(bridge.request(promptReq("call-5"))).rejects.toBe(failure);
    expect(bridge.pendingCount()).toBe(0);
    expect(bridge.decide("call-5", "allow")).toEqual({ kind: "unknown_request" });
  });

  it("相同决策重复返回 duplicate", async () => {
    const bridge = createApprovalBridge();
    bridge.bindSession(fakeHandle());
    const promise = bridge.request(promptReq("call-6"));
    expect(bridge.decide("call-6", "allow")).toEqual({ kind: "accepted" });
    await promise;
    expect(bridge.decide("call-6", "allow")).toEqual({ kind: "duplicate" });
  });

  it("相反决策返回 already_decided", async () => {
    const bridge = createApprovalBridge();
    bridge.bindSession(fakeHandle());
    const promise = bridge.request(promptReq("call-7"));
    expect(bridge.decide("call-7", "allow")).toEqual({ kind: "accepted" });
    await promise;
    expect(bridge.decide("call-7", "deny")).toEqual({ kind: "already_decided" });
  });

  it("未知请求返回 unknown_request", () => {
    const bridge = createApprovalBridge();
    expect(bridge.decide("nope", "allow")).toEqual({ kind: "unknown_request" });
  });

  it("settled 超过 TTL 后返回 unknown_request", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-20T00:00:00.000Z"));
    const bridge = createApprovalBridge({ settledTtlMs: 60_000 });
    bridge.bindSession(fakeHandle());
    const promise = bridge.request(promptReq("call-8"));
    expect(bridge.decide("call-8", "allow")).toEqual({ kind: "accepted" });
    await promise;
    vi.setSystemTime(new Date("2026-10-20T00:02:00.000Z"));
    expect(bridge.decide("call-8", "allow")).toEqual({ kind: "unknown_request" });
  });

  it("settled 超过上限丢弃最旧项", async () => {
    const bridge = createApprovalBridge({ settledMax: 2 });
    bridge.bindSession(fakeHandle());
    for (const id of ["a", "b", "c"]) {
      const promise = bridge.request(promptReq(id));
      expect(bridge.decide(id, "allow")).toEqual({ kind: "accepted" });
      await promise;
    }
    expect(bridge.decide("a", "allow")).toEqual({ kind: "unknown_request" });
    expect(bridge.decide("b", "allow")).toEqual({ kind: "duplicate" });
    expect(bridge.decide("c", "allow")).toEqual({ kind: "duplicate" });
  });

  it("close 清理 pending 与 settled", async () => {
    const bridge = createApprovalBridge();
    bridge.bindSession(fakeHandle());
    const first = bridge.request(promptReq("call-9"));
    const second = bridge.request(promptReq("call-10"));
    bridge.decide("call-10", "allow");
    await second;
    bridge.close();
    await expect(first).resolves.toBe("deny");
    expect(bridge.pendingCount()).toBe(0);
    expect(bridge.decide("call-10", "allow")).toEqual({ kind: "unknown_request" });
  });

  it("未绑定 session 返回 deny 且不写日志", async () => {
    const bridge = createApprovalBridge();
    const handle = fakeHandle();
    await expect(bridge.request(promptReq("call-11"))).resolves.toBe("deny");
    expect(handle.append).not.toHaveBeenCalled();
    expect(bridge.pendingCount()).toBe(0);
  });
});