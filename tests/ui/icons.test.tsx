// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { render } from "preact";
import { Icon, SYMBOL_SPRITE } from "../../src/ui/icons.js";

describe("icons", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });
  it("Icon 渲染 use 引用", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    render(<Icon name="i-logo" />, root);
    const use = root.querySelector("use");
    expect(use?.getAttribute("href")).toBe("#i-logo");
    const svg = root.querySelector("svg");
    expect(svg?.getAttribute("class")).toContain("ico");
    expect(svg?.getAttribute("width")).toBe("16");
    expect(svg?.getAttribute("height")).toBe("16");
  });
  it("sprite 含 i-logo 且 aria-hidden", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    render(SYMBOL_SPRITE, root);
    const sym = document.getElementById("i-logo");
    expect(sym).not.toBeNull();
    expect(document.querySelector("svg[aria-hidden=true]")).not.toBeNull();
  });
  it("sprite 覆盖 30 个 symbol", () => {
    const root = document.createElement("div");
    document.body.appendChild(root);
    render(SYMBOL_SPRITE, root);
    expect(root.querySelectorAll("symbol")).toHaveLength(30);
  });
});