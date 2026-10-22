import { describe, expect, it } from "vitest";
import { builtinRules, evaluatePolicy, toolAccess } from "../src/permissions/policy.js";
import type { PolicyEvaluation } from "../src/permissions/policy.js";
import type { SourcedRule } from "../src/permissions/types.js";
import {
  editTool as realEditTool,
  multieditTool as realMultieditTool,
  readTool as realReadTool,
  writeTool as realWriteTool,
} from "../src/tools/fs.js";
import { shellTool as realShellTool } from "../src/tools/shell.js";
import type { ToolDef } from "../src/tools/types.js";

function tool(partial: Partial<ToolDef<any>>): ToolDef<any> {
  return {
    name: "tool",
    description: "",
    schema: {} as ToolDef<any>["schema"],
    ...partial,
  } as ToolDef<any>;
}

const readTool = tool({ name: "grep", annotations: { readOnly: true } });
const shell = tool({ name: "shell", annotations: { destructive: true } });
const unknownTool = tool({ name: "mcp__x__y", annotations: {} });
const writeTool = tool({ name: "write", access: () => "write" });
const editTool = tool({ name: "edit", access: () => "write" });
const multieditTool = tool({ name: "multiedit", access: () => "write" });

function rule(
  source: SourcedRule["source"],
  toolPattern: string,
  action: SourcedRule["rule"]["action"],
  extra: Partial<SourcedRule["rule"]> = {},
): SourcedRule {
  return { rule: { tool: toolPattern, action, ...extra }, source };
}

function evaluate(
  preset: Parameters<typeof evaluatePolicy>[0]["preset"],
  rules: readonly SourcedRule[],
  selected: ToolDef<any>,
  args: unknown = {},
): PolicyEvaluation {
  return evaluatePolicy({ preset, rules, tool: selected, args });
}

describe("toolAccess", () => {
  it("maps annotations.readOnly to read", () => {
    expect(toolAccess(readTool, {})).toBe("read");
  });

  it("maps annotations.destructive to write", () => {
    expect(toolAccess(shell, {})).toBe("write");
  });

  it("returns unknown when annotations are empty or absent", () => {
    expect(toolAccess(unknownTool, {})).toBe("unknown");
    expect(toolAccess(tool({ name: "plain" }), {})).toBe("unknown");
  });

  it("returns unknown when readOnly and destructive are both true", () => {
    expect(
      toolAccess(tool({ name: "conflict", annotations: { readOnly: true, destructive: true } }), {}),
    ).toBe("unknown");
  });

  it("prefers the explicit access function over annotations", () => {
    expect(
      toolAccess(
        tool({
          name: "annotated",
          annotations: { readOnly: true },
          access: () => "write",
        }),
        {},
      ),
    ).toBe("write");
  });

  it("lets access return unknown even when annotations say readOnly", () => {
    const accessUnknown = tool({
      name: "annotated-unknown",
      annotations: { readOnly: true },
      access: () => "unknown",
    });
    expect(toolAccess(accessUnknown, {})).toBe("unknown");
    expect(evaluate("diagnose", [], accessUnknown).action).toBe("deny");
  });

  it("lets access write override readOnly annotations in policy evaluation", () => {
    const annotatedWrite = tool({
      name: "annotated-write",
      annotations: { readOnly: true },
      access: () => "write",
    });
    expect(toolAccess(annotatedWrite, {})).toBe("write");
    expect(evaluate("read-only", [], annotatedWrite).action).toBe("deny");
    expect(evaluate("diagnose", [], annotatedWrite).action).toBe("ask");
  });

  it("throws when access is present but not a function", () => {
    expect(() => toolAccess(tool({ name: "string-access", access: "write" as any }), {})).toThrow();
    expect(() => toolAccess(tool({ name: "null-access", access: null as any }), {})).toThrow();
  });

  it("passes args to access", () => {
    const opTool = tool({
      name: "op_tool",
      access: (input: any) => (input.op === "read" ? "read" : "write"),
    });
    expect(toolAccess(opTool, { op: "read" })).toBe("read");
    expect(toolAccess(opTool, { op: "write" })).toBe("write");
    expect(toolAccess(opTool, { op: "edit" })).toBe("write");
  });

  it("throws on access returning an invalid value", () => {
    expect(() => toolAccess(tool({ name: "admin", access: () => "admin" as any }), {})).toThrow();
    expect(() => toolAccess(tool({ name: "undef", access: () => undefined as any }), {})).toThrow();
    expect(() => toolAccess(tool({ name: "promise", access: (() => Promise.resolve("read")) as any }), {})).toThrow();
  });

  it("propagates access exceptions", () => {
    expect(() =>
      toolAccess(
        tool({
          name: "boom",
          access: () => {
            throw new Error("access failed");
          },
        }),
        {},
      ),
    ).toThrow("access failed");
  });
});

describe("real tool access declarations", () => {
  it("readTool reports read, the three write tools report write", () => {
    expect(toolAccess(realReadTool, { path: "a.txt" })).toBe("read");
    expect(toolAccess(realWriteTool, { path: "a.txt", content: "x" })).toBe("write");
    expect(toolAccess(realEditTool, { path: "a.txt", oldText: "a", newText: "b" })).toBe("write");
    expect(
      toolAccess(realMultieditTool, {
        path: "a.txt",
        edits: [{ oldText: "a", newText: "b" }],
      }),
    ).toBe("write");
  });

  it("shellTool always reports write", () => {
    expect(toolAccess(realShellTool, { command: "node -v" })).toBe("write");
    expect(toolAccess(realShellTool, { command: "dir" })).toBe("write");
  });

  it("evaluates the real tools against presets", () => {
    expect(
      evaluate("diagnose", [], realWriteTool, { path: "a.txt", content: "x" }).action,
    ).toBe("ask");
    expect(
      evaluate("workspace-write", [], realWriteTool, { path: "a.txt", content: "x" }).action,
    ).toBe("allow");
    expect(evaluate("read-only", [], realShellTool, { command: "node -v" }).action).toBe("deny");
  });
});

describe("builtinRules", () => {
  it("returns one allow rule per write tool for workspace-write", () => {
    expect(builtinRules("workspace-write")).toEqual([
      {
        rule: {
          tool: "write",
          action: "allow",
          reason: "preset:workspace-write:write",
        },
        source: "builtin",
      },
      {
        rule: {
          tool: "edit",
          action: "allow",
          reason: "preset:workspace-write:edit",
        },
        source: "builtin",
      },
      {
        rule: {
          tool: "multiedit",
          action: "allow",
          reason: "preset:workspace-write:multiedit",
        },
        source: "builtin",
      },
    ]);
  });

  it("does not use a wildcard that would also cover shell", () => {
    const patterns = builtinRules("workspace-write").map((entry) => entry.rule.tool);

    expect(patterns).toEqual(["write", "edit", "multiedit"]);
    expect(patterns.some((pattern) => pattern.includes("*") || pattern.includes("?"))).toBe(false);
  });

  it.each(["read-only", "diagnose", "danger-full-access"] as const)(
    "returns no builtin rules for %s",
    (preset) => {
      expect(builtinRules(preset)).toEqual([]);
    },
  );
});

describe("evaluatePolicy preset matrix", () => {
  it("diagnose allows reads, asks writes, denies unknown", () => {
    expect(evaluate("diagnose", [], readTool).action).toBe("allow");
    expect(evaluate("diagnose", [], shell).action).toBe("ask");
    expect(evaluate("diagnose", [], unknownTool).action).toBe("deny");
  });

  it("diagnose asks for every file write tool", () => {
    for (const writeCandidate of [writeTool, editTool, multieditTool]) {
      const result = evaluate("diagnose", [], writeCandidate);
      expect(result.action).toBe("ask");
      expect(result.access).toBe("write");
      expect(result.reason).toBe("preset:diagnose:write");
    }
    expect(evaluate("diagnose", [], readTool).action).toBe("allow");
  });

  it("read-only allows reads and denies writes and unknown", () => {
    expect(evaluate("read-only", [], readTool).action).toBe("allow");
    expect(evaluate("read-only", [], shell).action).toBe("deny");
    expect(evaluate("read-only", [], unknownTool).action).toBe("deny");
  });

  it("workspace-write allows write/edit/multiedit through the builtin rules and still asks for shell", () => {
    const expected = [
      [writeTool, "preset:workspace-write:write", 0],
      [editTool, "preset:workspace-write:edit", 1],
      [multieditTool, "preset:workspace-write:multiedit", 2],
    ] as const;
    for (const [candidate, reason, ruleIndex] of expected) {
      const result = evaluate("workspace-write", [], candidate);
      expect(result.action).toBe("allow");
      expect(result.source).toBe("builtin");
      expect(result.ruleIndex).toBe(ruleIndex);
      expect(result.reason).toBe(reason);
    }
    expect(evaluate("workspace-write", [], readTool).action).toBe("allow");
    // shell 没有被通配符顺带放行:它仍是 ask,不是 allow。
    expect(evaluate("workspace-write", [], shell).action).toBe("ask");
    expect(evaluate("workspace-write", [], unknownTool).action).toBe("deny");
  });

  it("danger-full-access allows every access class", () => {
    expect(evaluate("danger-full-access", [], readTool).action).toBe("allow");
    expect(evaluate("danger-full-access", [], shell).action).toBe("allow");
    expect(evaluate("danger-full-access", [], unknownTool).action).toBe("allow");
  });

  it("defaults to builtin source and preset reason without a ruleIndex", () => {
    const result = evaluate("diagnose", [], shell);
    expect(result).toMatchObject({
      action: "ask",
      reason: "preset:diagnose:write",
      preset: "diagnose",
      source: "builtin",
      access: "write",
    });
    expect(result.ruleIndex).toBeUndefined();
  });
});

describe("evaluatePolicy user rules", () => {
  it("lets a user allow rule override a preset ask", () => {
    const result = evaluate("diagnose", [rule("user", "shell", "allow")], shell);
    expect(result.action).toBe("allow");
    expect(result.source).toBe("user");
    expect(result.ruleIndex).toBe(0);
  });

  it("lets a user ask rule override a preset allow", () => {
    const result = evaluate("danger-full-access", [rule("project", "grep", "ask")], readTool);
    expect(result.action).toBe("ask");
    expect(result.source).toBe("project");
    expect(result.ruleIndex).toBe(0);
  });

  it("deny wins over allow regardless of order", () => {
    const rules = [
      rule("user", "shell", "allow"),
      rule("project", "shell", "deny"),
      rule("inline", "shell", "allow"),
    ];
    expect(evaluate("diagnose", rules, shell).action).toBe("deny");
    expect(evaluate("diagnose", rules.slice().reverse(), shell).action).toBe("deny");
  });

  it("takes the first matching rule for each action priority", () => {
    const rules = [
      rule("inline", "s*", "ask", { reason: "inline ask" }),
      rule("project", "shell", "ask", { reason: "project ask" }),
      rule("user", "shell", "allow"),
    ];
    const result = evaluate("read-only", rules, shell);
    expect(result.action).toBe("ask");
    expect(result.source).toBe("inline");
    expect(result.ruleIndex).toBe(0);
    expect(result.reason).toBe("inline ask");
  });

  it("counts builtin rules appended after configured rules in ruleIndex", () => {
    const configured = [rule("user", "shell", "allow")];
    const result = evaluate("workspace-write", configured, writeTool);
    expect(result.action).toBe("allow");
    expect(result.source).toBe("builtin");
    expect(result.ruleIndex).toBe(1);
  });

  it("lets an earlier configured allow beat the builtin allow", () => {
    const configured = [rule("user", "write", "allow")];
    const result = evaluate("workspace-write", configured, writeTool);
    expect(result.source).toBe("user");
    expect(result.ruleIndex).toBe(0);
  });

  it("lets a configured deny or ask beat the workspace-write builtin allow", () => {
    const denied = evaluate("workspace-write", [rule("user", "write", "deny")], writeTool);
    expect(denied.action).toBe("deny");
    expect(denied.source).toBe("user");
    expect(denied.ruleIndex).toBe(0);

    const asked = evaluate("workspace-write", [rule("user", "write", "ask")], writeTool);
    expect(asked.action).toBe("ask");
    expect(asked.source).toBe("user");
    expect(asked.ruleIndex).toBe(0);
  });

  it("prefers the rule reason over rule:<action>", () => {
    expect(evaluate("diagnose", [rule("user", "shell", "ask", { reason: "confirm shell" })], shell).reason).toBe(
      "confirm shell",
    );
    expect(evaluate("diagnose", [rule("user", "shell", "ask")], shell).reason).toBe("rule:ask");
  });
});

describe("evaluatePolicy errors", () => {
  it("turns access exceptions into deny", () => {
    const broken = tool({
      name: "broken",
      access: () => {
        throw new Error("access failed");
      },
    });
    const result = evaluate("danger-full-access", [], broken);
    expect(result.action).toBe("deny");
    expect(result.source).toBe("builtin");
    expect(result.ruleIndex).toBeUndefined();
    expect(result.reason).toBe("permission_error:access failed");
  });

  it.each([
    ["admin", () => "admin" as any],
    ["undefined", () => undefined as any],
    ["a Promise", (() => Promise.resolve("read")) as any],
  ])("turns access returning %s into deny even under danger-full-access", (_label, access) => {
    const result = evaluate("danger-full-access", [], tool({ name: "invalid", access }));
    expect(result.action).toBe("deny");
    expect(result.source).toBe("builtin");
    expect(result.ruleIndex).toBeUndefined();
    expect(result.reason.startsWith("permission_error:")).toBe(true);
  });

  it.each([
    ["a string", "write"],
    ["null", null],
    ["an object", { call: () => "read" }],
  ])(
    "turns a non-function access (%s) into deny even under danger-full-access",
    (_label, access) => {
      const result = evaluate(
        "danger-full-access",
        [],
        tool({
          name: "readonly-with-bad-access",
          annotations: { readOnly: true },
          access: access as any,
        }),
      );
      expect(result.action).toBe("deny");
      expect(result.source).toBe("builtin");
      expect(result.ruleIndex).toBeUndefined();
      expect(result.reason.startsWith("permission_error:")).toBe(true);
    },
  );

  it("turns matcher exceptions into deny", () => {
    const badRule: SourcedRule = {
      source: "user",
      rule: {
        tool: "shell",
        // matcher 读取时抛错，模拟求值期异常
        params: [
          {
            key: "command",
            get eq(): never {
              throw new Error("matcher boom");
            },
          },
        ],
        action: "allow",
      },
    };
    const result = evaluate("diagnose", [badRule], shell);
    expect(result.action).toBe("deny");
    expect(result.source).toBe("builtin");
    expect(result.ruleIndex).toBeUndefined();
    expect(result.reason).toBe("permission_error:matcher boom");
  });

  it("truncates the error reason to 200 characters", () => {
    const result = evaluate(
      "diagnose",
      [],
      tool({
        name: "long",
        access: () => {
          throw new Error("x".repeat(400));
        },
      }),
    );
    expect(result.action).toBe("deny");
    expect(result.reason).toHaveLength(200);
    expect(result.reason.startsWith("permission_error:")).toBe(true);
  });

  it("falls back to a fixed reason when the thrown error's message getter throws", () => {
    const poisoned = new Error("seed");
    Object.defineProperty(poisoned, "message", {
      get() {
        throw new Error("message getter boom");
      },
    });
    const result = evaluate(
      "diagnose",
      [],
      tool({
        name: "poisoned-error",
        access: () => {
          throw poisoned;
        },
      }),
    );
    expect(result.action).toBe("deny");
    expect(result.source).toBe("builtin");
    expect(result.ruleIndex).toBeUndefined();
    expect(result.reason).toBe("permission_error:unknown error");
  });

  it("uses String() for non-Error throwables", () => {
    const result = evaluate(
      "diagnose",
      [],
      tool({
        name: "string-throw",
        access: () => {
          throw "plain failure";
        },
      } as Partial<ToolDef<any>>),
    );
    expect(result.action).toBe("deny");
    expect(result.reason).toBe("permission_error:plain failure");
  });
});
