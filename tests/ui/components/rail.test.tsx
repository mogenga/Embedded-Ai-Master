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

  it("知识库加载中与失败时不显示未配置空态", () => {
    const root = mount();
    render(<KnowledgePane nodes={[]} root={null} state="loading" />, root);
    expect(root.textContent).toContain("加载中");
    expect(root.textContent).not.toContain("未配置知识库");
    render(<KnowledgePane nodes={[]} root={null} state="error" />, root);
    expect(root.textContent).toContain("知识库加载失败");
    expect(root.textContent).not.toContain("未配置知识库");
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

  it("会话加载中与失败时不显示暂无会话", () => {
    const root = mount();
    render(<SessionPane sessions={[]} state="loading" />, root);
    expect(root.textContent).toContain("加载中");
    expect(root.textContent).not.toContain("暂无会话");
    render(<SessionPane sessions={[]} state="error" />, root);
    expect(root.textContent).toContain("会话加载失败");
    expect(root.textContent).not.toContain("暂无会话");
  });

  it("会话目录错误显示摘要", () => {
    const root = mount();
    render(
      <SessionPane
        sessions={SESSIONS}
        errors={[
          { dir: "broken", code: "invalid_header" },
          { dir: "linked", code: "skipped_link" },
        ]}
      />,
      root,
    );
    expect(root.textContent).toContain("2 个会话目录不可读");
  });

  it("无会话目录错误时不显示摘要", () => {
    const root = mount();
    render(<SessionPane sessions={SESSIONS} />, root);
    expect(root.textContent).not.toContain("会话目录不可读");
  });

  it("空列表但有错误时仍显示摘要", () => {
    const root = mount();
    render(<SessionPane sessions={[]} errors={[{ dir: "broken", code: "invalid_header" }]} />, root);
    expect(root.textContent).toContain("暂无会话");
    expect(root.textContent).toContain("1 个会话目录不可读");
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