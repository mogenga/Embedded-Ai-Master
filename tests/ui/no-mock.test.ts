import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const UI_DIR = path.resolve(process.cwd(), "src/ui");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("no demo data", () => {
  it("生产源码不含演示常量", () => {
    const hits: string[] = [];
    for (const file of walk(UI_DIR)) {
      const text = readFileSync(file, "utf8");
      if (/DEMO_[A-Z_]+|UART_TRANSCRIPT_EVENTS|SESSION_GROUPS|KB_TREE|support\/builders/.test(text)) {
        hits.push(path.relative(UI_DIR, file));
      }
    }
    expect(hits).toEqual([]);
  });

  it("演示数据目录已删除", () => {
    expect(existsSync(path.join(UI_DIR, "demo"))).toBe(false);
  });
});