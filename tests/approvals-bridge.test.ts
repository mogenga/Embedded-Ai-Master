import { describe, expect, it, vi } from "vitest";
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

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

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
    await flush();
    expect(bridge.pendingCount()).toBe(1);
    expect(bridge.decide("call-1", "allow")).toEqual({ kind: "accepted" });
    await expect(promise).resolves.toBe("allow");
    expect(bridge.pendingCount()).toBe(0);
  });

  it("append 延迟完成时 decide 返回 unknown_request", async () => {
    let release!: () => void;
    const append = vi.fn(
      (ev: Omit<SessionEvent, "seq" | "ts">) =>
        new Promise<SessionEvent>((resolve) => {
          release = () => resolve({ ...ev, seq: 0, ts: "" });
        }),
    );
    const bridge = createApprovalBridge();
    bridge.bindSession({ append });
    const promise = bridge.request(promptReq("call-deferred"));
    expect(bridge.pendingCount()).toBe(0);
    expect(bridge.decide("call-deferred", "allow")).toEqual({ kind: "unknown_request" });
    release();
    await flush();
    expect(bridge.pendingCount()).toBe(1);
    expect(bridge.decide("call-deferred", "allow")).toEqual({ kind: "accepted" });
    await expect(promise).resolves.toBe("allow");
  });

  it("deny 决策返回 deny", async () => {
    const bridge = createApprovalBridge();
    bridge.bindSession(fakeHandle());
    const promise = bridge.request(promptReq("call-2"));
    await flush();
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
    await flush();
    bridge.decide("call-3", "allow");
    await promise;
  });

  it("append 期间 abort 记录无决策并返回 deny", async () => {
    const bridge = createApprovalBridge();
    bridge.bindSession(fakeHandle());
    const controller = new AbortController();
    const promise = bridge.request(promptReq("call-4", { signal: controller.signal }));
    controller.abort();
    await expect(promise).resolves.toBe("deny");
    expect(bridge.pendingCount()).toBe(0);
    expect(bridge.decide("call-4", "allow")).toEqual({ kind: "expired" });
  });

  it("登记后 abort 清理 pending 并返回 deny", async () => {
    const bridge = createApprovalBridge();
    bridge.bindSession(fakeHandle());
    const controller = new AbortController();
    const promise = bridge.request(promptReq("call-4b", { signal: controller.signal }));
    await flush();
    expect(bridge.pendingCount()).toBe(1);
    controller.abort();
    await expect(promise).resolves.toBe("deny");
    expect(bridge.pendingCount()).toBe(0);
    expect(bridge.decide("call-4b", "allow")).toEqual({ kind: "expired" });
  });

  it("append 失败使 request reject 且不登记 pending", async () => {
    const bridge = createApprovalBridge();
    const failure = new Error("log unavailable");
    const append = vi.fn(async () => Promise.reject(failure));
    bridge.bindSession({ append });
    await expect(bridge.request(promptReq("call-5"))).rejects.toBe(failure);
    expect(bridge.pendingCount()).toBe(0);
    expect(bridge.decide("call-5", "allow")).toEqual({ kind: "unknown_request" });
  });

  it("同一 requestId 已有 pending 时新请求 reject 且不写日志", async () => {
    const handle = fakeHandle();
    const bridge = createApprovalBridge();
    bridge.bindSession(handle);
    const first = bridge.request(promptReq("dup"));
    await flush();
    expect(handle.append).toHaveBeenCalledTimes(1);
    await expect(bridge.request(promptReq("dup"))).rejects.toThrow(
      "duplicate approval request id: dup",
    );
    expect(handle.append).toHaveBeenCalledTimes(1);
    expect(bridge.pendingCount()).toBe(1);
    expect(bridge.decide("dup", "allow")).toEqual({ kind: "accepted" });
    await expect(first).resolves.toBe("allow");
  });

  it("相同决策重复返回 duplicate", async () => {
    const bridge = createApprovalBridge();
    bridge.bindSession(fakeHandle());
    const promise = bridge.request(promptReq("call-6"));
    await flush();
    expect(bridge.decide("call-6", "allow")).toEqual({ kind: "accepted" });
    await promise;
    expect(bridge.decide("call-6", "allow")).toEqual({ kind: "duplicate" });
  });

  it("相反决策返回 already_decided", async () => {
    const bridge = createApprovalBridge();
    bridge.bindSession(fakeHandle());
    const promise = bridge.request(promptReq("call-7"));
    await flush();
    expect(bridge.decide("call-7", "allow")).toEqual({ kind: "accepted" });
    await promise;
    expect(bridge.decide("call-7", "deny")).toEqual({ kind: "already_decided" });
  });

  it("未知请求返回 unknown_request", () => {
    const bridge = createApprovalBridge();
    expect(bridge.decide("nope", "allow")).toEqual({ kind: "unknown_request" });
  });

  it("settled 超过 TTL 后返回 unknown_request", async () => {
    const bridge = createApprovalBridge({ settledTtlMs: 10 });
    bridge.bindSession(fakeHandle());
    const promise = bridge.request(promptReq("call-8"));
    await flush();
    expect(bridge.decide("call-8", "allow")).toEqual({ kind: "accepted" });
    await promise;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(bridge.decide("call-8", "allow")).toEqual({ kind: "unknown_request" });
  });

  it("settled 超过上限丢弃最旧项", async () => {
    const bridge = createApprovalBridge({ settledMax: 2 });
    bridge.bindSession(fakeHandle());
    for (const id of ["a", "b", "c"]) {
      const promise = bridge.request(promptReq(id));
      await flush();
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
    await flush();
    expect(bridge.decide("call-10", "allow")).toEqual({ kind: "accepted" });
    await second;
    bridge.close();
    await expect(first).resolves.toBe("deny");
    expect(bridge.pendingCount()).toBe(0);
    expect(bridge.decide("call-10", "allow")).toEqual({ kind: "unknown_request" });
  });

  it("close 后 request 返回 deny 且不写日志", async () => {
    const handle = fakeHandle();
    const bridge = createApprovalBridge();
    bridge.bindSession(handle);
    bridge.close();
    await expect(bridge.request(promptReq("after-close"))).resolves.toBe("deny");
    expect(handle.append).not.toHaveBeenCalled();
    expect(bridge.pendingCount()).toBe(0);
    expect(bridge.decide("after-close", "allow")).toEqual({ kind: "unknown_request" });
  });

  it("append 期间 close 不登记 pending", async () => {
    let release!: () => void;
    const append = vi.fn(
      (ev: Omit<SessionEvent, "seq" | "ts">) =>
        new Promise<SessionEvent>((resolve) => {
          release = () => resolve({ ...ev, seq: 0, ts: "" });
        }),
    );
    const bridge = createApprovalBridge();
    bridge.bindSession({ append });
    const promise = bridge.request(promptReq("closing"));
    bridge.close();
    release();
    await expect(promise).resolves.toBe("deny");
    expect(bridge.pendingCount()).toBe(0);
    expect(bridge.decide("closing", "allow")).toEqual({ kind: "unknown_request" });
  });

  it("未绑定 session 返回 deny 且不写日志", async () => {
    const bridge = createApprovalBridge();
    const handle = fakeHandle();
    await expect(bridge.request(promptReq("call-11"))).resolves.toBe("deny");
    expect(handle.append).not.toHaveBeenCalled();
    expect(bridge.pendingCount()).toBe(0);
  });
});
