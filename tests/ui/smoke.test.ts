// @vitest-environment happy-dom
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { render } from "preact";

describe("ui smoke", () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
  });
  it("preact 可渲染 app 根节点", () => {
    render(<div class="app" />, document.getElementById("root")!);
    expect(document.querySelector(".app")).not.toBeNull();
  });
  it("styles.css 含首屏令牌（:root --bg-canvas）", () => {
    const css = readFileSync(fileURLToPath(new URL("../../src/ui/styles.css", import.meta.url)), "utf8");
    expect(css).toContain("--bg-canvas:#0e131a");
  });
});