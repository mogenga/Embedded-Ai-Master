import { describe, expect, it } from "vitest";

describe("mcp-servers bootstrap", () => {
  it("keeps domain code outside src", async () => {
    const fs = await import("node:fs");
    const pkg = JSON.parse(fs.readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["build:mcp"]).toContain("tsconfig.mcp.json");
    expect(pkg.scripts["test:mcp"]).toContain("mcp-servers");
    expect(fs.existsSync("mcp-servers/probe")).toBe(true);
  });
});