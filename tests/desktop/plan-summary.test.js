import { describe, expect, it } from "vitest";
import { planSummary } from "../../desktop/renderer/plan-summary.js";

const item = (content, status = "pending") => ({ content, status });

describe("planSummary", () => {
  it("没有计划时返回 null：空列表与缺失都是「不显示」", () => {
    expect(planSummary([])).toBeNull();
    expect(planSummary(null)).toBeNull();
    expect(planSummary(undefined)).toBeNull();
    expect(planSummary("读 datasheet")).toBeNull();
  });

  it("计完整条计划的总数与已完成数", () => {
    const summary = planSummary([
      item("读 datasheet", "completed"),
      item("定位 USART2", "in_progress"),
      item("验证 UE 位"),
    ]);
    expect(summary).toMatchObject({ total: 3, done: 1 });
  });

  it("当前项优先取 in_progress，而不是第一个未完成项", () => {
    // 计划可以重排成 [未做, 在做]；把第一个未完成项当成「当前」会在这种顺序
    // 下点名一件还没开始的事。
    const summary = planSummary([
      item("先不做的"),
      item("现在在做的", "in_progress"),
    ]);
    expect(summary.index).toBe(1);
    expect(summary.current).toBe("现在在做的");
  });

  it("没有 in_progress 时退回第一个未完成项", () => {
    const summary = planSummary([
      item("已完成的", "completed"),
      item("下一步"),
      item("再下一步"),
    ]);
    expect(summary.index).toBe(1);
    expect(summary.current).toBe("下一步");
  });

  it("全部完成时 index 为 -1，current 为空串", () => {
    const summary = planSummary([
      item("a", "completed"),
      item("b", "completed"),
    ]);
    expect(summary).toEqual({ total: 2, done: 2, current: "", index: -1 });
  });

  it("两条 in_progress 时只认第一条：一次只应该有一个当前步", () => {
    const summary = planSummary([
      item("甲", "in_progress"),
      item("乙", "in_progress"),
    ]);
    expect(summary.index).toBe(0);
  });

  it("未知状态按未完成处理，不吞掉那一行", () => {
    // 协议层已经把非法状态降级为 pending；这一层再见到未知值也只管一件事：
    // 这条待办还在，别把它藏起来。
    const summary = planSummary([item("状态坏了的", "blocked")]);
    expect(summary).toMatchObject({ total: 1, done: 0, index: 0 });
    expect(summary.current).toBe("状态坏了的");
  });

  it("缺失 content 时 current 是空串而不是 'undefined'", () => {
    const summary = planSummary([{ status: "in_progress" }]);
    expect(summary.current).toBe("");
    expect(summary.index).toBe(0);
  });

  it("不改动入参", () => {
    const items = [item("a", "completed"), item("b")];
    const snapshot = JSON.stringify(items);
    planSummary(items);
    expect(JSON.stringify(items)).toBe(snapshot);
  });
});
