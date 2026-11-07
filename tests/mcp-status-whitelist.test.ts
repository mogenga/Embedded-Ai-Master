import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { toMcpStatusPayload } from "../src/index.js";
import type { McpStatusEvent } from "../src/mcp/manager.js";
import { MCP_STATUS_PAYLOAD_KINDS } from "../src/session/types.js";

/**
 * `MCP_STATUS_PAYLOAD_KINDS` 是 `toMcpStatusPayload` 的运行时白名单，而
 * `McpStatusKind` 是编译期联合类型。两者是两份各自维护的清单 —— 加一个新 kind
 * 却忘了白名单，结果不是类型错误，而是**事件被静默丢弃**：
 *
 *   src/index.ts:268  `if (kind === undefined || !MCP_STATUS_KIND_SET.has(kind))`
 *
 * 2026-11-07 的 6.1 就踩了这个坑：`dispose_incomplete` 加进了 `McpStatusKind`，
 * 上报代码也写了，但白名单没跟上。所有测试都绿 —— 因为没有任何测试同时看两边。
 * 这是一条**假绿地**：实现看起来在了，实际到不了日志与界面。
 *
 * 下面这条用例把「两份清单必须一致」钉住。它不需要知道每个 kind 的业务含义，
 * 只需要知道**不许有只在一边存在的 kind**。
 */
describe("MCP 状态事件的白名单与联合类型必须一致", () => {
  it("manager 会发出的每个 kind 都能通过 toMcpStatusPayload", () => {
    // **不要**遍历 `MCP_STATUS_PAYLOAD_KINDS` 来测 —— 那是在问「白名单里的
    // 每一项过不过白名单」，恒真。第一版就是这么写的，RED 证明了它抓不到
    // 任何东西：把 `dispose_incomplete` 从白名单删掉，那条断言仍然绿。
    //
    // 真正的来源是 `McpStatusKind`（`src/mcp/manager.ts` 里 manager 实际会
    // emit 的集合）。这里从源码读出那个联合类型的所有字面量，逐个过白名单。
    const source = readFileSync(
      path.join(import.meta.dirname, "..", "src", "mcp", "manager.ts"),
      "utf8",
    );
    const union = /export type McpStatusKind =([\s\S]*?);/.exec(source);
    expect(union).not.toBeNull();
    if (union === null) return;

    const emitted = [...union[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
    // 防止正则没匹配上时得到一个空数组、让下面的循环空过。8 是今天联合类型的
    // 条数；写成「至少 8」而不是「等于 8」，这样**新增** kind 不需要改这条，
    // 而删除或正则失效会立刻红。新增 kind 必须同时进白名单，由下面的循环管。
    expect(emitted.length).toBeGreaterThanOrEqual(8);

    const dropped: string[] = [];
    for (const kind of emitted) {
      const event = { kind, server: "probe" } as unknown as McpStatusEvent;
      // 返回 undefined ⇔ 被白名单过滤掉了，也就是日志与界面里什么都看不到。
      if (toMcpStatusPayload(event) === undefined) dropped.push(kind);
    }
    expect(dropped).toStrictEqual([]);
  });

  it("dispose_incomplete 在清单里（6.1 / D-225 的回归钉）", () => {
    // 单独点名一条：它曾经缺失，而缺失的代价是「关闭没回收进程树」这件事
    // 永远不被人看见 —— 正是 R3 要禁止的「把没确认的事当成成功」。
    expect(MCP_STATUS_PAYLOAD_KINDS).toContain("dispose_incomplete");
  });

  it("白名单没有重复项", () => {
    // 重复会让清单看起来比实际长，掩盖某个 kind 其实没被加进来。
    expect(new Set(MCP_STATUS_PAYLOAD_KINDS).size).toBe(MCP_STATUS_PAYLOAD_KINDS.length);
  });
});
