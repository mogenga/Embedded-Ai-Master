// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { render } from "preact";
import { KnowledgePane } from "../../../src/ui/components/rail/knowledge-pane.js";
import { SessionPane } from "../../../src/ui/components/rail/session-pane.js";

describe("rail", () => {
  it("知识库默认展开厂商分流且当前厂商高亮", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    render(<KnowledgePane />, root);
    const vendor = [...root.querySelectorAll(".tree-row")].find((r) => r.textContent?.includes("厂商分流"));
    expect(vendor?.getAttribute("aria-expanded")).toBe("true");
    expect(root.querySelector(".tree-row.is-active")?.textContent).toContain("STM32");
  });
  it("知识库检索框占位正确且有 aria-label", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    render(<KnowledgePane />, root);
    const input = root.querySelector("input[type=search]");
    expect(input?.getAttribute("aria-label")).toBe("检索知识库");
    expect(input?.getAttribute("placeholder")).toContain("kb_lookup");
  });
  it("点击可展开项切换 aria-expanded", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    render(<KnowledgePane />, root);
    const protocols = [...root.querySelectorAll(".tree-row")].find((r) => r.textContent?.includes("协议层"));
    protocols?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(protocols?.getAttribute("aria-expanded")).toBe("true");
  });
  it("会话列表分两组且含状态点", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    render(<SessionPane />, root);
    expect([...root.querySelectorAll(".session-group")].map((e) => e.textContent)).toEqual(["进行中", "历史"]);
    expect(root.querySelectorAll(".session .dot").length).toBeGreaterThanOrEqual(4);
  });
});