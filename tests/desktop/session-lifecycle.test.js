import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 会话生命周期的两处用户可见行为（2026-11-09 反馈）：
 *
 *   1. **装好的应用不该把安装目录当成工作区。** `main.js` 原来用
 *      `process.cwd()`，而安装形态下那就是
 *      `%LOCALAPPDATA%\Programs\embedded-ai-master-desktop`。侧栏于是多出一行
 *      叫 `embedded-ai-master-desktop` 的"项目"，切到别的会话后又消失——
 *      用户报「这个文件夹本就不应该存在」。
 *   2. **当前打开的会话应该能删。** `deleteSession` 原来直接拒绝，让用户先新建
 *      会话再回来删；删掉之后应当回到新会话的初始界面。
 *
 * 这两条都在 `host.js` / `main.js` 里，而两个模块都**不能被 import**
 * （`host.js` 在模块作用域就开始读 stdin，`main.js` 直接 `import "electron"`）。
 * 所以断言的是源码结构，与 `main-scope.test.js` / `window-icon.test.js` 同一种
 * 手法。局限写明：这证明的是接线与守卫的形状，不证明运行时的每一条分支。
 */
const ROOT = path.join(import.meta.dirname, "..", "..");
const DESKTOP = path.join(ROOT, "desktop");
const read = (name) => readFileSync(path.join(DESKTOP, ...name.split("/")), "utf8");

/** `header` 起、到同缩进的 `}` 为止的那一段。 */
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

describe("装好的应用不把安装目录当工作区", () => {
  it("打包形态用文档目录，开发形态保留 process.cwd()", () => {
    const main = read("main.js");
    // The whole point: `app.isPackaged` decides, and the packaged branch is
    // NOT `process.cwd()` (which is the install directory).
    expect(main).toContain('app.isPackaged ? app.getPath("documents") : process.cwd()');
    expect(main).not.toContain("const startCwd = process.cwd();");
  });

  it("那个路径必须是用户能自己换掉的普通目录", () => {
    // A folder the user can point at something else, and that exists without
    // the app being installed — `documents` is exactly that. `userData` (the
    // app's own storage) would be the wrong answer: it is internal state, and
    // sessions recorded there would look like a project called
    // `embedded-ai-master-desktop`'s sibling.
    const main = read("main.js");
    const line = main.split("\n").find((entry) => entry.includes("const startCwd ="));
    expect(line).toContain('app.getPath("documents")');
    expect(line).not.toContain('app.getPath("userData")');
    expect(line).not.toContain("process.execPath");
  });
});

describe("当前会话可以删除，删完回到新会话界面", () => {
  it("deleteSession 不再因为「是当前会话」而拒绝", () => {
    const host = read("host/host.js");
    const body = bodyOf(host, "  async deleteSession(payload) {");
    // The old refusal is gone: it asked the operator to do the cleanup by hand
    // for an action they had already asked for.
    expect(body).not.toContain("不能删除当前打开的会话");
    expect(body).not.toContain("请先新建会话");
  });

  it("删除当前会话走 handleNewSession，而不是自己再实现一遍「回到初始态」", () => {
    const host = read("host/host.js");
    const body = bodyOf(host, "  async deleteSession(payload) {");
    expect(body).toContain("deletingOpen");
    expect(body).toContain("handleNewSession()");
    // Reused, not reimplemented: a second "reset to the start" path would drift
    // from the one `/clear` and the sidebar's "new chat" already use.
    // Assignments only — the declaration at the top of the file is not a reset.
    const resets = host.match(/^\s+sessionId = "";/gm) ?? [];
    expect(resets.length, "只应有一处把 sessionId 置空（handleNewSession 里）").toBe(1);
  });

  it("先删文件，再重置界面——删除失败时屏幕不能已经清空", () => {
    const host = read("host/host.js");
    const body = bodyOf(host, "  async deleteSession(payload) {");
    const remove = body.indexOf("admin.remove(id)");
    const reset = body.indexOf("handleNewSession()");
    expect(remove).toBeGreaterThan(-1);
    expect(reset).toBeGreaterThan(remove);
    // The failure path returns before the reset.
    const failure = body.indexOf("会话未删除");
    expect(failure).toBeGreaterThan(remove);
    expect(failure).toBeLessThan(reset);
  });

  it("跑着的回合仍然拒绝删除（日志被它持有着）", () => {
    const host = read("host/host.js");
    const body = bodyOf(host, "  async deleteSession(payload) {");
    // Only the running guard survives; it protects the log, not the menu.
    expect(body).toContain("if (deletingOpen && ctx.running)");
    expect(body).toContain("当前回合尚未结束");
  });
});
