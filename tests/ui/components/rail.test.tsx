// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { render } from "preact";
import { KnowledgePane } from "../../../src/ui/components/rail/knowledge-pane.js";
import { SessionPane } from "../../../src/ui/components/rail/session-pane.js";
import type { SessionSummary } from "../../../src/ui/api/client.js";
import type { KbNode } from "../../../src/ui/api/client.js";

const KB_TREE: KbNode[] = [
  {
    name: "vendor",
    path: "/kb/vendor",
    kind: "dir",
    children: [
      { name: "stm32", path: "/kb/vendor/stm32", kind: "dir", children: [] },
      { name: "esp", path: "/kb/vendor/esp", kind: "dir", children: [] },
    ],
  },
  { name: "protocols", path: "/kb/protocols", kind: "dir", children: [] },
  { name: "index.yaml", path: "/kb/index.yaml", kind: "file" },
];

const SESSIONS: SessionSummary[] = [
  { id: "s2", createdAt: "2026-10-18T21:40:00.000Z", status: "open" },
  { id: "s1", createdAt: "2026-10-17T09:00:00.000Z", status: "closed" },
];

function mount(): HTMLElement {
  const root = document.createElement("div");
  document.body.appendChild(root);
  return root;
}

describe("rail", () => {
  it("知识库空树显示未配置知识库", () => {
    const root = mount();
    render(<KnowledgePane nodes={[]} root={null} />, root);
    expect(root.textContent).toContain("未配置知识库");
    expect(root.querySelectorAll(".tree-row").length).toBe(0);
  });

  it("知识库渲染 API 树并默认展开顶层目录", () => {
    const root = mount();
    render(<KnowledgePane nodes={KB_TREE} root="/kb" />, root);
    const vendor = [...root.querySelectorAll(".tree-row")].find((r) => r.textContent?.includes("vendor"));
    expect(vendor?.getAttribute("aria-expanded")).toBe("true");
    expect(root.textContent).toContain("stm32");
    expect(root.textContent).toContain("index.yaml");
  });

  it("知识库检索框占位正确且有 aria-label", () => {
    const root = mount();
    render(<KnowledgePane nodes={KB_TREE} root="/kb" />, root);
    const input = root.querySelector("input[type=search]");
    expect(input?.getAttribute("aria-label")).toBe("检索知识库");
    expect(input?.getAttribute("placeholder")).toContain("kb_lookup");
  });

  it("点击可展开项切换 aria-expanded", async () => {
    const root = mount();
    render(<KnowledgePane nodes={KB_TREE} root="/kb" />, root);
    const vendor = [...root.querySelectorAll(".tree-row")].find((r) => r.textContent?.includes("vendor"))!;
    vendor.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await Promise.resolve();
    expect(vendor.getAttribute("aria-expanded")).toBe("false");
  });

  it("会话空列表显示暂无会话", () => {
    const root = mount();
    render(<SessionPane sessions={[]} />, root);
    expect(root.textContent).toContain("暂无会话");
    expect(root.querySelectorAll(".session").length).toBe(0);
  });

  it("会话列表按状态分组、标记当前项并回传选择", () => {
    const root = mount();
    const selected: string[] = [];
    render(
      <SessionPane sessions={SESSIONS} activeId="s2" onSelect={(id) => selected.push(id)} />,
      root,
    );
    expect([...root.querySelectorAll(".session-group")].map((el) => el.textContent)).toEqual(["进行中", "历史"]);
    expect(root.querySelector(".session.is-active")?.textContent).toContain("s2");
    const closed = [...root.querySelectorAll<HTMLButtonElement>(".session")].find((el) =>
      el.textContent?.includes("s1"),
    )!;
    closed.click();
    expect(selected).toEqual(["s1"]);
  });
});