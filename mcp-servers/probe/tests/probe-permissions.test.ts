import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createPermissionGate } from "../../../src/permissions/gate.js";
import { evaluatePolicy } from "../../../src/permissions/policy.js";
import type { ToolDef, ToolResult } from "../../../src/tools/types.js";
import type { ProbeBackend } from "../backend.js";
import { probeTools } from "../tools.js";
import type { ProbeToolSpec } from "../tools.js";

// 只用于生成工具面；测试不调用 handler，也不需要真实后端。
const UNUSED_BACKEND = {} as unknown as ProbeBackend;

function findTool(name: string): ProbeToolSpec {
  const spec = probeTools({ renode: UNUSED_BACKEND }).find((tool) => tool.name === name);
  if (!spec) throw new Error(`工具不存在: ${name}`);
  return spec;
}

const okResult: ToolResult = { isError: false, code: "ok", message: "", text: "" };

function permissionTool(
  spec: ProbeToolSpec,
  execute: ToolDef<unknown>["execute"],
): ToolDef<unknown> {
  return {
    name: `mcp__probe__${spec.name}`,
    description: spec.description,
    schema: z.unknown(),
    annotations: {
      readOnly: spec.annotations?.readOnlyHint === true,
      destructive: spec.annotations?.destructiveHint === true,
      evidence: spec.meta?.evidence === true,
    },
    execute,
  };
}

describe("probe 工具权限策略", () => {
  it.each(["mem_write", "reset", "serial_write"])(
    "diagnose 预设下 %s 映射为 write/ask",
    (name) => {
      const execute = vi.fn(async () => okResult);
      const evaluation = evaluatePolicy({
        preset: "diagnose",
        rules: [],
        tool: permissionTool(findTool(name), execute),
        args: {},
      });

      expect(evaluation.access).toBe("write");
      expect(evaluation.action).toBe("ask");
    },
  );

  it("diagnose 预设下 mem_read 映射为 read/allow", () => {
    const execute = vi.fn(async () => okResult);
    const evaluation = evaluatePolicy({
      preset: "diagnose",
      rules: [],
      tool: permissionTool(findTool("mem_read"), execute),
      args: { address: 0x20000000, length: 4 },
    });

    expect(evaluation.access).toBe("read");
    expect(evaluation.action).toBe("allow");
  });
});

describe("headless 审批（无 prompter）", () => {
  it("ask 降级为 deny，且不执行工具", async () => {
    const execute = vi.fn(async () => okResult);
    const tool = permissionTool(findTool("mem_write"), execute);
    const gate = createPermissionGate({ preset: "diagnose", rules: [] });

    const request = await gate.check({
      callId: "call-mem-write",
      tool,
      args: { address: 0x20000000, bytes: [0x78, 0x56, 0x34, 0x12] },
      signal: new AbortController().signal,
    });

    expect(request).toMatchObject({
      tool: "mcp__probe__mem_write",
      access: "write",
      action: "ask",
      effective: "deny",
      reason: "approval_unavailable",
    });

    expect(execute).not.toHaveBeenCalled();
  });

  it("allow 只做判定，不触发 execute", async () => {
    const execute = vi.fn(async () => okResult);
    const tool = permissionTool(findTool("mem_read"), execute);
    const gate = createPermissionGate({ preset: "diagnose", rules: [] });

    const request = await gate.check({
      callId: "call-mem-read",
      tool,
      args: { address: 0x20000000, length: 4 },
      signal: new AbortController().signal,
    });

    expect(request).toMatchObject({
      tool: "mcp__probe__mem_read",
      access: "read",
      action: "allow",
      effective: "allow",
      reason: "preset:diagnose:read",
    });

    expect(execute).not.toHaveBeenCalled();
  });
});