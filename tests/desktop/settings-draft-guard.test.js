import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { settingsStrings } from "../../desktop/renderer/settings-i18n.js";

/**
 * OPT-39 / BACKLOG 5.3 — closing Settings used to discard an unsaved
 * model-services draft without a word.
 *
 * There is no jsdom in this repository (adding one is a dependency the user
 * has not approved), so this reads the renderer sources the way
 * `composer-copy.test.js` and `renderer-reachability.test.js` do. What is
 * asserted is wiring, not pixels: which function the close paths call, whether
 * the draft-free path can reach a confirmation at all, and that the
 * confirmation is a real modal `<dialog>`.
 *
 * Why the `<dialog>` part is load-bearing (measured, not assumed): Settings is
 * opened with `showModal()`, which puts it in the browser's top layer. A plain
 * element — even at `z-index: 200` — renders *behind* it and cannot take focus
 * (hit-tested in Electron 44: `document.elementFromPoint` at the confirm
 * button returned `settings-dialog`). A confirmation that cannot be seen or
 * clicked would make the guard worse than no guard: Esc would keep closing
 * nothing while the draft silently disappeared.
 */
const RENDERER = path.join(import.meta.dirname, "..", "..", "desktop", "renderer");
const read = (name) => readFileSync(path.join(RENDERER, name), "utf8");

/**
 * Block starting at `header`, up to the line that closes it.
 *
 * The closing line is found by indentation, not brace counting: these sources
 * are full of `}` inside template literals (the confirm dialog's own markup
 * ends every `${…}` with one), and not by "first column-0 `}`" either — the
 * Escape branch lives inside a listener callback, so a slice that wide reaches
 * far past the branch and keeps matching after the branch is reverted (it did:
 * a revert of the guard still passed). The block ends at the first line whose
 * indentation equals the header's and which starts with `}`.
 */
function bodyOf(text, header) {
  const start = text.indexOf(header);
  expect(start, `${header} not found`).toBeGreaterThan(-1);
  const lineStart = text.lastIndexOf("\n", start) + 1;
  const indent = text.slice(lineStart, start);
  expect(indent.trim(), `${header} must start its line`).toBe("");
  let cursor = text.indexOf("\n", start);
  while (cursor !== -1) {
    const next = text.indexOf("\n", cursor + 1);
    const line = text.slice(cursor + 1, next === -1 ? text.length : next);
    if (line.startsWith(`${indent}}`)) return text.slice(start, next === -1 ? text.length : next);
    cursor = next;
  }
  throw new Error(`unterminated ${header}`);
}

describe("设置页关闭时保住未保存的草稿（OPT-39）", () => {
  it("Esc 与遮罩/背景两处关闭都走同一个带守卫的入口", () => {
    const app = read("app.js");
    // The Escape chain's settings branch no longer closes the dialog itself.
    expect(app).not.toContain("closeModal(settingsDialog)");
    const escape = bodyOf(app, 'if (!settingsDialog.hidden || !shortcutsDialog.hidden) {');
    expect(escape).toContain("settings.requestClose()");

    // A backdrop click is dispatched to the modal dialog element, not to the
    // sibling `#modal-scrim` (measured). The listener therefore has to live on
    // the dialog and look for a click that landed on the dialog itself.
    expect(app).toContain('settingsDialog.addEventListener("click"');
    expect(app).toContain("event.target === settingsDialog");
    const click = bodyOf(app, 'settingsDialog.addEventListener("click"');
    expect(click).toContain("settings.requestClose()");
  });

  it("Esc 分支吞掉按键：否则同一个按键会立刻取消刚弹出的确认框", () => {
    // Regression, found by driving the real window (Electron 44 + CDP), not by
    // reading the source: both dialogs are `showModal()`, so the browser turns
    // an unhandled Escape into a native close request *after* the handler
    // returns. That request landed on the confirmation `requestClose` had just
    // opened — Escape opened the prompt, dismissed it, and natively closed
    // Settings while `settingsDialog.hidden` still read false. The trace was
    // `showModal:confirm-overlay → cancel:confirm-overlay → cancel:settings-dialog`.
    // A source-text test cannot see that, but it can pin the one line that
    // prevents it.
    const escape = bodyOf(read("app.js"), 'if (!settingsDialog.hidden || !shortcutsDialog.hidden) {');
    expect(escape).toContain("event.preventDefault()");
  });

  it("原生 close 请求不会把顶层状态和 hidden 拆开", () => {
    // The shell's `hidden` attribute is the single source of truth for "is
    // Settings open". A native close would drop the dialog out of the top layer
    // without touching it, leaving `hidden === false` with nothing on screen.
    const app = read("app.js");
    expect(app).toContain('settingsDialog.addEventListener("cancel"');
    expect(bodyOf(app, 'settingsDialog.addEventListener("cancel"')).toContain("event.preventDefault()");
  });

  it("没有草稿时不弹确认：requestClose 先看 connectionDirty，再谈确认", () => {
    const settingsBody = bodyOf(read("settings.js"), "async function requestClose()");
    const guard = settingsBody.indexOf("if (!connectionDirty)");
    const ask = settingsBody.indexOf("confirmAction(");
    expect(guard).toBeGreaterThan(-1);
    expect(ask).toBeGreaterThan(guard);
    // The draft-free branch closes directly — a prompt with nothing to warn
    // about would be a lie.
    const noDraft = settingsBody.slice(guard, ask);
    expect(noDraft).toContain("closeModal(settingsDialog)");
    expect(noDraft).not.toContain("confirmAction");
  });

  it("有草稿时确认才关，取消则留在原地", () => {
    const body = bodyOf(read("settings.js"), "async function requestClose()");
    expect(body).toContain("confirmAction(s.connDiscardConfirm");
    // Cancel must not close: the draft is the only copy of those edits.
    expect(body).toContain("if (!discard) return false;");
    // Discarding clears the flag and only then closes.
    const discard = body.indexOf("if (!discard) return false;");
    const clear = body.indexOf("connectionDirty = false;", discard);
    const close = body.indexOf("closeModal(settingsDialog)", discard);
    expect(clear).toBeGreaterThan(discard);
    expect(close).toBeGreaterThan(clear);
  });

  it("返回栏的「返回」按钮也走同一守卫", () => {
    const settings = read("settings.js");
    const back = bodyOf(settings, '$("settings-back").addEventListener("click"');
    expect(back).toContain("requestClose()");
  });

  it("确认框是模态 <dialog>：否则它会画在 showModal() 的设置页后面", () => {
    const app = read("app.js");
    const body = bodyOf(app, "function confirmAction(");
    expect(body).toContain('document.createElement("dialog")');
    expect(body).toContain("overlay.showModal(");
    // Removing an open modal dialog is what drops it out of the top layer.
    expect(body).toContain("overlay.close?.()");
  });

  it("新文案两种语言都在，且不是同一句", () => {
    for (const locale of ["en", "zh"]) {
      for (const key of ["connDiscardConfirm", "connDiscardOk", "connDiscardCancel"]) {
        const text = settingsStrings[locale][key];
        expect(typeof text, `${locale}.${key}`).toBe("string");
        expect(text.trim(), `${locale}.${key}`).not.toBe("");
      }
    }
    expect(settingsStrings.en.connDiscardConfirm).not.toBe(settingsStrings.zh.connDiscardConfirm);
    expect(settingsStrings.en.connDiscardOk).not.toBe(settingsStrings.zh.connDiscardOk);
    expect(settingsStrings.en.connDiscardCancel).not.toBe(settingsStrings.zh.connDiscardCancel);
  });
});
