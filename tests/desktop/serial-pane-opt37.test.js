import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dictionaries } from "../../desktop/renderer/i18n.js";

/**
 * BACKLOG 5.6 ①② — the two serial gaps that live in the renderer (OPT-37).
 *
 * The host side was already correct for both, which is why they survived:
 *
 * ① The host counts what never left its own 500-line ring and reports it as
 *    `dropped`. The pane keeps a larger ring (4000) and trims it silently, so
 *    the status line could read "0 dropped" while the top of the transcript
 *    kept disappearing.
 * ② `serialBaud` reconfigures an open port in place — the host answers with
 *    `mode: "reconfigured"` and the session survives — but the select was
 *    disabled while open and the command was never sent, making a supported
 *    operation unreachable.
 *
 * No jsdom in this repo, so these read the renderer sources as text, the same
 * way `composer-copy.test.js` and `renderer-reachability.test.js` do. What is
 * asserted is wiring a future edit could drop, not behaviour under a DOM.
 */
const RENDERER = path.join(import.meta.dirname, "..", "..", "desktop", "renderer");
const read = (name) => readFileSync(path.join(RENDERER, name), "utf8");

/** The body of a top-level `function name(` block, up to its closing brace. */
function functionBody(source, marker) {
  const start = source.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("\n}", start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe("串口面板裁行会计数（OPT-37 ① / BACKLOG 5.6①）", () => {
  it("appendSerialLines 裁行时累加 droppedLocal，而不是静默 splice", () => {
    const body = functionBody(read("app.js"), "function appendSerialLines(");
    // The splice alone is the old behaviour: lines vanish and nothing counts.
    expect(body).toContain("serial.droppedLocal");
    expect(body).toContain("excess");
  });

  it("状态行单独显示面板裁掉的行数，不并进宿主的 dropped", () => {
    const body = functionBody(read("app.js"), "function renderSerialStatus(");
    expect(body).toContain("serial.droppedLocal");
    expect(body).toContain("t.serialTrimmed");
    // Two separate counters: folding them would make the number wrong whenever
    // only one side trimmed.
    expect(body).toContain("t.serialDropped");
  });

  it("开新口与手动清屏都重置面板计数", () => {
    const app = read("app.js");
    const resets = app.match(/serial\.droppedLocal = 0/g) ?? [];
    // Two sites: the open/reconfigure branch and the clear button.
    expect(resets.length).toBeGreaterThanOrEqual(2);
  });

  it("两种语言都有「被面板裁掉」的文案", () => {
    for (const locale of ["en", "zh"]) {
      const text = dictionaries[locale].serialTrimmed;
      expect(typeof text).toBe("string");
      expect(text.trim()).not.toBe("");
    }
  });
});

describe("串口打开时可改波特率（OPT-37 ② / BACKLOG 5.6②）", () => {
  it("波特率下拉在串口打开时不再禁用", () => {
    const body = functionBody(read("app.js"), "function fillSerialControls(");
    // The port stays disabled — switching it would be a different connection.
    expect(body).toContain("portSelect.disabled = state.serial.open");
    // The baud rate must not be.
    expect(body).not.toContain("baudSelect.disabled = state.serial.open");
  });

  it("运行中改波特率会真正发 serialBaud", () => {
    const app = read("app.js");
    const start = app.indexOf('$("serial-baud").addEventListener("change"');
    expect(start).toBeGreaterThan(-1);
    const end = app.indexOf("\n});", start);
    const handler = app.slice(start, end);
    expect(handler).toContain('cmd: "serialBaud"');
    expect(handler).toContain("state.serial.open");
  });
});
