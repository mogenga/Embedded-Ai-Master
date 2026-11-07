import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The shortcut sheet's backdrop click closes it.
 *
 * Both the settings page and the sheet are `showModal()` dialogs, so a click
 * beside the card is retargeted to the dialog element itself — `#modal-scrim`
 * never receives it. The settings page got this listener when its draft guard
 * landed (OPT-39); the sheet did not, so clicking beside it did nothing.
 *
 * Measured, not assumed: with a modal open, `event.target` for a backdrop click
 * is the dialog, and a listener on `#modal-scrim` does not fire at all.
 *
 * No jsdom here, so this reads the renderer source the way
 * `renderer-reachability.test.js` does: the thing to pin is the wiring.
 */
const RENDERER = path.join(import.meta.dirname, "..", "..", "desktop", "renderer");
const read = (name) => readFileSync(path.join(RENDERER, name), "utf8");

describe("快捷键面板的背景点击会关闭它", () => {
  it("快捷键面板在自身上监听 click，并用 target === 自身判断背景", () => {
    const app = read("app.js");
    expect(app).toContain('shortcutsDialog.addEventListener("click"');
    // A modal dialog retargets backdrop clicks to itself; without this equality
    // check the handler would fire for clicks inside the card too.
    expect(app).toContain("event.target === shortcutsDialog");
  });

  it("命中背景时真的关闭，而不是什么都不做", () => {
    const app = read("app.js");
    const start = app.indexOf('shortcutsDialog.addEventListener("click"');
    expect(start).toBeGreaterThan(-1);
    const end = app.indexOf("\n});", start);
    const handler = app.slice(start, end);
    expect(handler).toContain("closeModal(shortcutsDialog)");
  });

  it("设置页那条路径没被顺手改坏", () => {
    const app = read("app.js");
    // The settings page owns a draft, so its backdrop close must still go
    // through the guard rather than calling closeModal directly.
    const start = app.indexOf('settingsDialog.addEventListener("click"');
    expect(start).toBeGreaterThan(-1);
    const end = app.indexOf("\n});", start);
    expect(app.slice(start, end)).toContain("settings.requestClose()");
  });
});
