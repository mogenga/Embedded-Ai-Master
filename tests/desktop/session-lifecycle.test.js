import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dictionaries } from "../../desktop/renderer/i18n.js";

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

describe("装好的应用不硬塞一个工作区", () => {
  it("打包形态一开始没有工作区，开发形态保留仓库根", () => {
    const main = read("main.js");
    // Three attempts, and the third is the rule (2026-11-09):
    //   1. process.cwd()  → the install directory
    //   2. documents      → someone else's folder, still not chosen
    //   3. null           → "nothing chosen yet"; the UI says 暂无
    expect(main).toContain("const startCwd = app.isPackaged ? null : process.cwd();");
    expect(main).not.toContain("const startCwd = process.cwd();");
  });

  it("不猜任何目录：文档 / 家目录 / 用户数据都不许成为工作区", () => {
    const main = read("main.js");
    const line = main.split("\n").find((entry) => entry.includes("const startCwd ="));
    for (const guess of [
      'getPath("documents")',
      'getPath("home")',
      'getPath("userData")',
      "homedir()",
    ]) {
      expect(line, `startCwd 不该猜 ${guess}`).not.toContain(guess);
    }
  });

  it("没工作区时 init 不带 cwd，宿主据此显示「暂无」", () => {
    const main = read("main.js");
    // The workspace is a separate fact from the process's startup directory;
    // this is the wire where they could get confused again.
    expect(main).toContain('...(hostCwd === null || hostCwd === "" ? {} : { cwd: hostCwd })');
    const host = read("host/host.js");
    expect(host).toContain('let cwd = "";');
    expect(host).not.toContain("let cwd = process.cwd();");
  });

  it("没工作区时不去列安装目录，也不把它写进 header", () => {
    const host = read("host/host.js");
    const tree = bodyOf(host, "  async getTree(payload = {}) {");
    // Falling back to `process.cwd()` here meant "no workspace" listed the
    // install directory — the phantom folder one layer down.
    expect(tree).toContain('if (cwd === "")');
    expect(tree).not.toContain('path.resolve(cwd === "" ? process.cwd() : cwd, raw)');
    const runner = bodyOf(host, "function createRunner()");
    expect(runner).toContain('...(cwd === "" ? {} : { cwd })');
    // And the host process itself must not start in the install directory:
    // `runSession` falls back to `process.cwd()` for a new session's workdir.
    const main = read("main.js");
    expect(main).toContain("const spawnCwd = homedir();");
    expect(main).toContain("      cwd: spawnCwd,");
  });
});

describe("没有工作区时说「暂无」，不硬塞也不冒充", () => {
  it("顶栏显示「暂无」，不拿产品名占那个位置", () => {
    const app = read("renderer/app.js");
    const body = bodyOf(app, "function renderTopbarLocation() {");
    expect(body).toContain("t.workspaceNone");
    // The product name in a folder slot reads as "this conversation lives in
    // the app's own folder" — the exact idea the phantom workspace created.
    expect(body).not.toContain("name || t.appName");
  });

  it("侧栏区分「没有工作区」与「没有会话」与「搜不到」", () => {
    const app = read("renderer/app.js");
    const body = bodyOf(app, "function renderSessions(sessions) {");
    expect(body).toContain("t.workspaceNoneHint");
    expect(body).toContain("t.noSessions");
    expect(body).toContain("t.noSessionMatches");
    // Three facts, three sentences — the workspace one must come first.
    expect(body.indexOf("t.workspaceNoneHint")).toBeLessThan(body.indexOf("t.noSessions"));
  });

  it("两种语言都有这两句，且与「没有会话」不是同一句", () => {
    for (const locale of ["en", "zh"]) {
      for (const key of ["workspaceNone", "workspaceNoneHint"]) {
        const text = dictionaries[locale][key];
        expect(typeof text, `${locale}.${key}`).toBe("string");
        expect(text.trim()).not.toBe("");
      }
      expect(dictionaries[locale].workspaceNoneHint).not.toBe(dictionaries[locale].noSessions);
    }
    expect(dictionaries.zh.workspaceNone).toBe("暂无");
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
