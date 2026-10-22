import { describe, expect, it } from "vitest";

describe("keil mcp bootstrap", () => {
  it("keeps domain code outside src", async () => {
    const fs = await import("node:fs");
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["build:mcp"]).toContain("tsconfig.mcp.json");
    expect(pkg.scripts["test:mcp"]).toContain("mcp-servers");
    expect(fs.existsSync("mcp-servers/keil")).toBe(true);
    expect(fs.existsSync("mcp-servers/keil/server.ts")).toBe(true);
    // 领域代码不许进内核：Keil 的任何模块都不应出现在 src/ 下。
    expect(fs.existsSync("src/embedded")).toBe(false);
    expect(fs.existsSync("src/tools/keilTools.ts")).toBe(false);
  });
});