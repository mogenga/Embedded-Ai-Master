import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * T-035: the serial `dropped` counter used to double-count. The host sends its
 * running total (`serial-bridge.js` emits `dropped: session.dropped`), but the
 * renderer accumulated it (`state.serial.dropped += message.dropped`), so each
 * flush added the same figure again and the status line grew without bound.
 * Fixed in dbb8226 by assigning the host's figure instead.
 *
 * Why a source-text check and not a behavioural one: `desktop/renderer/app.js`
 * runs inside Electron against a DOM, the repository has no jsdom, and adding
 * one is a new dependency nobody approved. The same convention as
 * `composer-copy.test.js` / `renderer-reachability.test.js` applies — the thing
 * to pin is a wiring decision, and reading the `serial_lines` branch is enough
 * to see it. Nothing else in the suite notices if the `+=` comes back, which is
 * exactly how the fix landed while the ledger still said "待修".
 */
const RENDERER = path.join(import.meta.dirname, "..", "..", "desktop", "renderer");
const read = (name) => readFileSync(path.join(RENDERER, name), "utf8");

/** The body of `case "serial_lines":` up to the next case label. */
function serialLinesBranch(source) {
  const marker = 'case "serial_lines":';
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const next = source.indexOf('case "', start + marker.length);
  return source.slice(start, next === -1 ? undefined : next);
}

describe("串口 dropped 计数不重复累加（T-035）", () => {
  it("serial_lines 分支把宿主的累计值赋给 state.serial.dropped，而不是叠加", () => {
    const block = serialLinesBranch(read("app.js"));

    // Exactly one write to the counter in this branch, and it is a plain
    // assignment. `+=` here is the regression: the host's value is a total,
    // not a per-flush delta.
    const writes = [...block.matchAll(/state\.serial\.dropped\s*(\+=|=(?![=]))([^\n]*)/g)];
    expect(writes).toHaveLength(1);
    expect(writes[0][1]).toBe("=");

    // The right-hand side takes the figure from the host ...
    expect(writes[0][2]).toContain("message.dropped");
    // ... and never adds it to the previous value (`x = x + message.dropped`),
    // which is the other shape the same bug can take.
    expect(writes[0][2]).not.toMatch(/\+\s*\(?\s*message\.dropped/);
  });

  it("分支里的注释仍说明「宿主发的是累计值」，赋值才成立", () => {
    const block = serialLinesBranch(read("app.js"));
    const comment = block.slice(0, block.indexOf("state.serial.dropped"));
    // Assignment is only correct because the host sends a running total; if
    // that premise is ever revisited, the comment has to be revisited too.
    expect(comment).toMatch(/running total/i);
    expect(comment).toMatch(/accumulat/i);
  });
});
