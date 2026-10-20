import { afterEach, describe, expect, it, vi } from "vitest";
import { PermissionConfigError } from "../src/permissions/errors.js";
import { createPermissionGate } from "../src/permissions/gate.js";
import { evaluatePolicy } from "../src/permissions/policy.js";
import type { PermissionPrompter, SourcedRule } from "../src/permissions/types.js";
import type { ToolDef } from "../src/tools/types.js";

vi.mock("../src/permissions/policy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/permissions/policy.js")>();
  return { ...actual, evaluatePolicy: vi.fn(actual.evaluatePolicy) };
});

type ApprovalResult = "allow" | "deny";

function tool(partial: Partial<ToolDef<any>>): ToolDef<any> {
  return {
    name: "tool",
    description: "",
    schema: {} as ToolDef<any>["schema"],
    ...partial,
  } as ToolDef<any>;
}

const shell = tool({ name: "shell", annotations: { destructive: true } });
const readTool = tool({ name: "grep", annotations: { readOnly: true } });

function deferredPrompter(): {
  prompter: PermissionPrompter;
  requests: Array<{
    req: Parameters<PermissionPrompter["request"]>[0];
    resolve: (value: ApprovalResult) => void;
    reject: (error: unknown) => void;
  }>;
} {
  const requests: Array<{
    req: Parameters<PermissionPrompter["request"]>[0];
    resolve: (value: ApprovalResult) => void;
    reject: (error: unknown) => void;
  }> = [];
  const prompter: PermissionPrompter = {
    request: vi.fn(
      (req) =>
        new Promise<ApprovalResult>((resolve, reject) => {
          requests.push({ req, resolve, reject });
        }),
    ),
  };
  return { prompter, requests };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function firstPromptRequest(
  fixture: ReturnType<typeof deferredPrompter>,
  callId = "call-1",
  args: unknown = { op: "write" },
): Promise<Parameters<PermissionPrompter["request"]>[0]> {
  const gate = createPermissionGate({ preset: "diagnose", rules: [], prompter: fixture.prompter });
  const pending = check(gate, callId, shell, args);
  await flush();
  expect(fixture.requests).toHaveLength(1);
  const captured = fixture.requests[0]!.req;
  fixture.requests[0]!.resolve("allow");
  await pending;
  return captured;
}

function check(
  gate: ReturnType<typeof createPermissionGate>,
  callId: string,
  selected: ToolDef<any> = shell,
  args: unknown = {},
  signal: AbortSignal = new AbortController().signal,
) {
  return gate.check({ callId, tool: selected, args, signal });
}

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(evaluatePolicy).mockClear();
});

describe("createPermissionGate configuration", () => {
  it.each([0, -1, 1.5, 2_147_483_648, Number.NaN, Number.POSITIVE_INFINITY, null])(
    "throws PermissionConfigError for approvalTimeoutMs=%s",
    (value) => {
      expect(() =>
        createPermissionGate({
          preset: "diagnose",
          rules: [],
          approvalTimeoutMs: value as number,
        }),
      ).toThrow(PermissionConfigError);
    },
  );

  it("accepts boundary values", () => {
    expect(() =>
      createPermissionGate({ preset: "diagnose", rules: [], approvalTimeoutMs: 1 }),
    ).not.toThrow();
    expect(() =>
      createPermissionGate({ preset: "diagnose", rules: [], approvalTimeoutMs: 2_147_483_647 }),
    ).not.toThrow();
  });
});

describe("createPermissionGate", () => {
  it("denies ask immediately when no prompter is configured", async () => {
    const gate = createPermissionGate({ preset: "diagnose", rules: [] });
    const result = await check(gate, "c1");
    expect(result.action).toBe("ask");
    expect(result.effective).toBe("deny");
    expect(result.reason).toBe("approval_unavailable");
  });

  it("grants when the prompter allows, retaining the policy reason", async () => {
    const prompter: PermissionPrompter = { request: vi.fn().mockResolvedValue("allow") };
    const gate = createPermissionGate({ preset: "diagnose", rules: [], prompter });
    const result = await check(gate, "c1", shell, { command: "echo hi" });
    expect(result.action).toBe("ask");
    expect(result.effective).toBe("allow");
    expect(result.reason).toContain("approval_granted");
    expect(result.reason).toContain("preset:diagnose:write");
    expect(prompter.request).toHaveBeenCalledTimes(1);
    expect(prompter.request).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "shell", preset: "diagnose" }),
    );
  });

  it("passes approval context including deadline and params summary to the prompter", async () => {
    const fixture = deferredPrompter();
    const captured = await firstPromptRequest(fixture);
    expect(captured.requestId).toBe("call-1");
    expect(captured.callId).toBe("call-1");
    expect(captured.access).toBe("write");
    expect(captured.deadlineAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(Date.parse(captured.deadlineAt)).toBeGreaterThan(Date.now());
    expect(captured.paramsDigest).toMatch(/^[a-f0-9]{16}$/);
    expect(captured.paramsKeys).toEqual(["op"]);
    expect(captured.paramsPreview).toEqual({ op: "write" });
  });

  it("denies when the prompter denies", async () => {
    const prompter: PermissionPrompter = { request: vi.fn().mockResolvedValue("deny") };
    const gate = createPermissionGate({ preset: "diagnose", rules: [], prompter });
    const result = await check(gate, "c1");
    expect(result.effective).toBe("deny");
    expect(result.reason).toBe("approval_denied");
  });

  it("times out when the prompter never settles", async () => {
    vi.useFakeTimers();
    const prompter: PermissionPrompter = { request: vi.fn(() => new Promise<"allow" | "deny">(() => {})) };
    const gate = createPermissionGate({
      preset: "diagnose",
      rules: [],
      prompter,
      approvalTimeoutMs: 100,
    });
    const pending = check(gate, "c1");
    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;
    expect(result.effective).toBe("deny");
    expect(result.reason).toBe("approval_timeout");
  });

  it("does not call the prompter when the signal is already aborted", async () => {
    const prompter: PermissionPrompter = { request: vi.fn().mockResolvedValue("allow") };
    const gate = createPermissionGate({ preset: "diagnose", rules: [], prompter });
    const controller = new AbortController();
    controller.abort();
    const result = await check(gate, "c1", shell, {}, controller.signal);
    expect(result.effective).toBe("deny");
    expect(result.reason).toBe("approval_aborted");
    expect(prompter.request).not.toHaveBeenCalled();
  });

  it("reports a truncated approval_error when the prompter rejects", async () => {
    const prompter: PermissionPrompter = {
      request: vi.fn().mockRejectedValue(new Error("x".repeat(1_000))),
    };
    const gate = createPermissionGate({ preset: "diagnose", rules: [], prompter });
    const result = await check(gate, "c1");
    expect(result.effective).toBe("deny");
    expect(result.reason.startsWith("approval_error")).toBe(true);
    expect(result.reason.length).toBeLessThanOrEqual(200);
  });

  it("treats an invalid prompter return value as approval_error", async () => {
    const prompter = { request: vi.fn().mockResolvedValue("maybe") } as unknown as PermissionPrompter;
    const gate = createPermissionGate({ preset: "diagnose", rules: [], prompter });
    const result = await check(gate, "c1");
    expect(result.effective).toBe("deny");
    expect(result.reason.startsWith("approval_error")).toBe(true);
  });

  it("serializes prompter calls in check arrival order", async () => {
    const { prompter, requests } = deferredPrompter();
    const gate = createPermissionGate({ preset: "diagnose", rules: [], prompter });
    const first = check(gate, "c1", shell, { marker: "first" });
    const second = check(gate, "c2", shell, { marker: "second" });
    await flush();
    expect(prompter.request).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.req.args).toEqual({ marker: "first" });

    requests[0]!.resolve("allow");
    await expect(first).resolves.toMatchObject({ callId: "c1", effective: "allow" });
    await flush();
    expect(prompter.request).toHaveBeenCalledTimes(2);
    expect(requests[1]!.req.args).toEqual({ marker: "second" });

    requests[1]!.resolve("deny");
    await expect(second).resolves.toMatchObject({ callId: "c2", effective: "deny" });
  });

  it("aborts a queued approval without calling the prompter for it", async () => {
    const { prompter, requests } = deferredPrompter();
    const gate = createPermissionGate({ preset: "diagnose", rules: [], prompter });
    const first = check(gate, "c1", shell, { marker: "first" });
    const controller = new AbortController();
    const second = check(gate, "c2", shell, { marker: "second" }, controller.signal);
    await flush();
    expect(requests).toHaveLength(1);

    controller.abort();
    await expect(second).resolves.toMatchObject({
      callId: "c2",
      effective: "deny",
      reason: "approval_aborted",
    });
    expect(prompter.request).toHaveBeenCalledTimes(1);

    requests[0]!.resolve("allow");
    await first;
  });

  it("times out a queued approval from enqueue time without waiting for the first prompter", async () => {
    vi.useFakeTimers();
    const prompter: PermissionPrompter = { request: vi.fn(() => new Promise<"allow" | "deny">(() => {})) };
    const gate = createPermissionGate({
      preset: "diagnose",
      rules: [],
      prompter,
      approvalTimeoutMs: 100,
    });
    const first = check(gate, "c1");
    const second = check(gate, "c2");
    await vi.advanceTimersByTimeAsync(99);
    expect(prompter.request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const secondResult = await second;
    expect(prompter.request).toHaveBeenCalledTimes(1);
    expect(secondResult.effective).toBe("deny");
    expect(secondResult.reason).toBe("approval_timeout");
    await expect(first).resolves.toMatchObject({ reason: "approval_timeout" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not let a rejected approval poison later queue items", async () => {
    let calls = 0;
    const prompter: PermissionPrompter = {
      request: vi.fn(() => {
        calls += 1;
        return calls === 1 ? Promise.reject(new Error("boom")) : Promise.resolve<"allow">("allow");
      }),
    };
    const gate = createPermissionGate({ preset: "diagnose", rules: [], prompter });
    const first = check(gate, "c1");
    const second = check(gate, "c2");
    await expect(first).resolves.toMatchObject({
      effective: "deny",
      reason: expect.stringContaining("approval_error"),
    });
    await expect(second).resolves.toMatchObject({ effective: "allow" });
    expect(prompter.request).toHaveBeenCalledTimes(2);
  });

  it("returns audit fields and callId for allowed calls without prompting", async () => {
    const prompter: PermissionPrompter = { request: vi.fn().mockResolvedValue("allow") };
    const gate = createPermissionGate({ preset: "read-only", rules: [], prompter });
    const result = await check(gate, "call-42", readTool, { path: "src/a.ts", op: "read" });
    expect(result.callId).toBe("call-42");
    expect(result.action).toBe("allow");
    expect(result.effective).toBe("allow");
    expect(result.paramsDigest).toMatch(/^[0-9a-f]{16}$/);
    expect(result.paramsKeys).toEqual(["op", "path"]);
    expect(result.paramsPreview).toEqual({ op: "read", path: "src/a.ts" });
    expect(prompter.request).not.toHaveBeenCalled();
  });

  it("does not prompt for deny decisions", async () => {
    const prompter: PermissionPrompter = { request: vi.fn().mockResolvedValue("allow") };
    const gate = createPermissionGate({ preset: "read-only", rules: [], prompter });
    const result = await check(gate, "c1");
    expect(result.action).toBe("deny");
    expect(result.effective).toBe("deny");
    expect(prompter.request).not.toHaveBeenCalled();
  });

  it("ignores a late prompter result after timeout", async () => {
    vi.useFakeTimers();
    const { prompter, requests } = deferredPrompter();
    const gate = createPermissionGate({
      preset: "diagnose",
      rules: [],
      prompter,
      approvalTimeoutMs: 100,
    });
    const pending = check(gate, "c1");
    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;
    expect(result.reason).toBe("approval_timeout");

    requests[0]!.resolve("allow");
    await flush();
    expect(result.effective).toBe("deny");
    expect(result.reason).toBe("approval_timeout");
  });

  it("ignores a late prompter rejection after timeout", async () => {
    vi.useFakeTimers();
    const { prompter, requests } = deferredPrompter();
    const gate = createPermissionGate({
      preset: "diagnose",
      rules: [],
      prompter,
      approvalTimeoutMs: 100,
    });
    const pending = check(gate, "c1");
    await vi.advanceTimersByTimeAsync(100);
    const result = await pending;
    requests[0]!.reject(new Error("late"));
    await flush();
    expect(result.reason).toBe("approval_timeout");
  });

  it("aborts an in-flight approval and ignores its late result", async () => {
    const { prompter, requests } = deferredPrompter();
    const gate = createPermissionGate({ preset: "diagnose", rules: [], prompter });
    const controller = new AbortController();
    const pending = check(gate, "c1", shell, {}, controller.signal);
    await flush();
    expect(requests).toHaveLength(1);

    controller.abort();
    await expect(pending).resolves.toMatchObject({
      effective: "deny",
      reason: "approval_aborted",
    });
    expect(requests[0]!.req.signal.aborted).toBe(true);

    requests[0]!.resolve("allow");
    await flush();
    await expect(pending).resolves.toMatchObject({ reason: "approval_aborted" });
  });

  it("aborts the prompter signal on timeout", async () => {
    vi.useFakeTimers();
    const { prompter, requests } = deferredPrompter();
    const gate = createPermissionGate({
      preset: "diagnose",
      rules: [],
      prompter,
      approvalTimeoutMs: 100,
    });
    const pending = check(gate, "c1");
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    expect(requests[0]!.req.signal.aborted).toBe(true);
  });

  it("cleans up its timer once approval settles", async () => {
    vi.useFakeTimers();
    const prompter: PermissionPrompter = { request: vi.fn().mockResolvedValue("allow") };
    const gate = createPermissionGate({
      preset: "diagnose",
      rules: [],
      prompter,
      approvalTimeoutMs: 1_000,
    });
    const pending = check(gate, "c1");
    await vi.advanceTimersByTimeAsync(0);
    await expect(pending).resolves.toMatchObject({ effective: "allow" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects non-thenable prompter return values with approval_error", async () => {
    const prompter = { request: vi.fn(() => "allow") } as unknown as PermissionPrompter;
    const gate = createPermissionGate({ preset: "diagnose", rules: [], prompter });
    const result = await check(gate, "c1");
    expect(result.effective).toBe("deny");
    expect(result.reason.startsWith("approval_error")).toBe(true);
  });

  it("contains a throwing thenable as approval_error and keeps the queue alive", async () => {
    const throwingThen = {
      then() {
        throw new Error("then boom");
      },
    };
    const throwingGetter = Object.defineProperty({}, "then", {
      get() {
        throw new Error("then getter boom");
      },
    });

    let calls = 0;
    const prompter: PermissionPrompter = {
      request: vi.fn(() => {
        calls += 1;
        if (calls === 1) return throwingThen as unknown as Promise<"allow" | "deny">;
        if (calls === 2) return throwingGetter as unknown as Promise<"allow" | "deny">;
        return Promise.resolve<"allow">("allow");
      }),
    };
    const gate = createPermissionGate({ preset: "diagnose", rules: [], prompter });

    const first = check(gate, "c1");
    const second = check(gate, "c2");
    const third = check(gate, "c3");

    await expect(first).resolves.toMatchObject({
      callId: "c1",
      effective: "deny",
      reason: expect.stringContaining("approval_error"),
    });
    await expect(second).resolves.toMatchObject({
      callId: "c2",
      effective: "deny",
      reason: expect.stringContaining("approval_error"),
    });
    await expect(third).resolves.toMatchObject({ callId: "c3", effective: "allow" });
    expect(prompter.request).toHaveBeenCalledTimes(3);
  });

  it("settles with approval_error when the rejection's message getter throws", async () => {
    const poisoned = new Error("seed");
    Object.defineProperty(poisoned, "message", {
      get() {
        throw new Error("message getter boom");
      },
    });
    let calls = 0;
    const prompter: PermissionPrompter = {
      request: vi.fn(() => {
        calls += 1;
        return calls === 1
          ? Promise.reject(poisoned)
          : Promise.resolve<"allow">("allow");
      }),
    };
    const gate = createPermissionGate({ preset: "diagnose", rules: [], prompter });

    const first = check(gate, "c1");
    const second = check(gate, "c2");

    await expect(first).resolves.toMatchObject({
      callId: "c1",
      action: "ask",
      effective: "deny",
      reason: expect.stringContaining("approval_error"),
    });
    await expect(second).resolves.toMatchObject({ callId: "c2", effective: "allow" });
    expect(prompter.request).toHaveBeenCalledTimes(2);
  });

  it("settles with approval_error when describing an invalid result throws", async () => {
    const poisoned = Object.defineProperty({}, Symbol.toStringTag, {
      get() {
        throw new Error("toStringTag getter boom");
      },
    });
    let calls = 0;
    const prompter: PermissionPrompter = {
      request: vi.fn(() => {
        calls += 1;
        return calls === 1
          ? Promise.resolve(poisoned as unknown as "allow")
          : Promise.resolve<"allow">("allow");
      }),
    };
    const gate = createPermissionGate({ preset: "diagnose", rules: [], prompter });

    const first = check(gate, "c1");
    const second = check(gate, "c2");

    await expect(first).resolves.toMatchObject({
      callId: "c1",
      effective: "deny",
      reason: expect.stringContaining("approval_error"),
    });
    await expect(second).resolves.toMatchObject({ callId: "c2", effective: "allow" });
    expect(prompter.request).toHaveBeenCalledTimes(2);
  });

  it("propagates rule source and ruleIndex into the decision", async () => {
    const rules: SourcedRule[] = [
      { rule: { tool: "shell", action: "ask", reason: "custom-reason" }, source: "project" },
    ];
    const prompter: PermissionPrompter = { request: vi.fn().mockResolvedValue("allow") };
    const gate = createPermissionGate({ preset: "diagnose", rules, prompter });
    const result = await check(gate, "c1");
    expect(result.action).toBe("ask");
    expect(result.source).toBe("project");
    expect(result.ruleIndex).toBe(0);
    expect(result.reason).toBe("custom-reason;approval_granted");
  });

  it("omits paramsPreview for non-object arguments", async () => {
    const prompter: PermissionPrompter = { request: vi.fn().mockResolvedValue("allow") };
    const gate = createPermissionGate({ preset: "diagnose", rules: [], prompter });
    const result = await check(gate, "c1", shell, 42);
    expect(result.paramsKeys).toEqual([]);
    expect(result.paramsPreview).toBeUndefined();
  });

  it("maps runtime-invalid policy actions to deny", async () => {
    vi.mocked(evaluatePolicy).mockReturnValueOnce({
      action: "allow-everything" as never,
      reason: "bogus",
      preset: "diagnose",
      source: "builtin",
      access: "write",
    });
    const prompter: PermissionPrompter = { request: vi.fn().mockResolvedValue("allow") };
    const gate = createPermissionGate({ preset: "diagnose", rules: [], prompter });
    const result = await check(gate, "c1");
    expect(result.action).toBe("deny");
    expect(result.effective).toBe("deny");
    expect(prompter.request).not.toHaveBeenCalled();
  });

  it("returns access unknown for policy errors and does not prompt", async () => {
    const broken = tool({
      name: "broken",
      access: () => {
        throw new Error("boom");
      },
    });
    const prompter: PermissionPrompter = { request: vi.fn().mockResolvedValue("allow") };
    const gate = createPermissionGate({ preset: "diagnose", rules: [], prompter });
    const result = await check(gate, "c1", broken);
    expect(result.action).toBe("deny");
    expect(result.effective).toBe("deny");
    expect(result.access).toBe("unknown");
    expect(result.reason.startsWith("permission_error:")).toBe(true);
    expect(prompter.request).not.toHaveBeenCalled();
  });
});
