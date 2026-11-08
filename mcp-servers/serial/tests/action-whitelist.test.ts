import { describe, expect, it } from "vitest";
import { SERIAL_ACTIONS, SERIAL_DESTRUCTIVE_ACTIONS, SERIAL_READONLY_ACTIONS } from "../actions.js";
import { embedSerialTool } from "../tools.js";

/**
 * `_meta` 的动作白名单一旦只发一份，未覆盖的动作会变成 `unknown`，`diagnose`
 * 预设下直接 deny——**比不发还糟**。
 *
 * 实测（2026-11-08）：serial 起初只发了 `destructiveActions`，于是 `read` /
 * `ports` / `status` 从「审批后可用」变成「不可能可用」。内核侧没有问题，
 * 是这边漏发了一份。
 */
describe("embed_serial 的 _meta 动作白名单", () => {
  const meta = (embedSerialTool.meta ?? {}) as {
    readOnlyActions?: string[];
    destructiveActions?: string[];
  };

  it("两份白名单都发出去了", () => {
    expect(Array.isArray(meta.readOnlyActions)).toBe(true);
    expect(Array.isArray(meta.destructiveActions)).toBe(true);
  });

  it("两份白名单覆盖 SERIAL_ACTIONS 的每一个动作，一个不漏", () => {
    const covered = new Set([...(meta.readOnlyActions ?? []), ...(meta.destructiveActions ?? [])]);
    const uncovered = SERIAL_ACTIONS.filter((action) => !covered.has(action));

    // 未覆盖 = 内核判 `unknown` = diagnose 下 deny。这不是「保守」，是动作消失。
    expect(uncovered).toEqual([]);
  });

  it("两份白名单不相交（同一个动作两边都在会被判 unknown）", () => {
    const both = (meta.readOnlyActions ?? []).filter((action) =>
      (meta.destructiveActions ?? []).includes(action),
    );

    expect(both).toEqual([]);
  });

  it("只读的是 read / ports / status，破坏性的是 write / open / close", () => {
    expect([...(meta.readOnlyActions ?? [])].sort()).toEqual(["ports", "read", "status"]);
    expect([...(meta.destructiveActions ?? [])].sort()).toEqual(["close", "open", "write"]);
    // 两个常量的分工也与发出去的一致，避免「常量对、发的却是另一份」。
    expect([...SERIAL_READONLY_ACTIONS].sort()).toEqual(["ports", "read", "status"]);
    expect([...SERIAL_DESTRUCTIVE_ACTIONS].sort()).toEqual(["close", "open", "write"]);
  });
});
