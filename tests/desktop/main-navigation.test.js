import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `main.js` 里链接策略的**接线**（BACKLOG 6.2 / OPT-40）。
 *
 * `main.js` 加载不了（它 `import { app } from "electron"`），既有做法是静态
 * 读取源码断言接线，见 `main-scope.test.js` 与 `close-behavior.test.js`。判定
 * 本身在 `link-policy.js` 里由 `link-policy.test.js` 单测；这里证明的是主进程
 * **真的调用了那些判定**，而不是把纯函数放进仓库就算完。
 *
 * 文本级断言证明「代码这么写了」，不证明「运行时真的这样」；把它当成运行时
 * 证据是这类测试唯一的陷阱。每一条都对应一个具体会打开的门，删掉就重新打开。
 */
const MAIN_JS = path.resolve(import.meta.dirname, "../../desktop/main.js");
const source = readFileSync(MAIN_JS, "utf8");

/** 与 `close-behavior.test.js` 同一思路：按大括号配对取函数体。 */
function functionBody(name) {
  const at = source.search(new RegExp(`function\\s+${name}\\s*\\(`));
  if (at === -1) return "";
  const braceStart = source.indexOf("{", source.indexOf(")", at));
  let depth = 0;
  for (let cursor = braceStart; cursor < source.length; cursor += 1) {
    if (source[cursor] === "{") depth += 1;
    else if (source[cursor] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(braceStart + 1, cursor);
    }
  }
  return "";
}

describe("main.js 注册了导航守卫", () => {
  it("在 startWindow 里监听 will-navigate", () => {
    const body = functionBody("startWindow");
    expect(body, "startWindow 的函数体没切出来").toContain('win.webContents.on("will-navigate"');
  });

  it("will-navigate 用 checkNavigationTarget 判定，且真正 preventDefault", () => {
    const body = functionBody("startWindow");
    const start = body.indexOf('win.webContents.on("will-navigate"');
    expect(start).toBeGreaterThan(-1);
    const handler = body.slice(start, body.indexOf("\n  });", start));
    // 判定必须来自纯函数：手写字符串比较是这个缺陷最初的样子。
    expect(handler).toContain("checkNavigationTarget(event.url, RENDERER)");
    expect(handler).toContain("event.preventDefault()");
  });

  it("守卫比较的目标是窗口真正加载的那个文件（RENDERER 常量）", () => {
    // 若拿别的路径去比，守卫要么全拦（应用打不开）要么全放（等于没有）。
    const body = functionBody("startWindow");
    expect(body).toContain("win.loadFile(RENDERER)");
    expect(body).toContain("checkNavigationTarget(event.url, RENDERER)");
  });

  it("被拦下的导航有可见反馈，不是静默", () => {
    const body = functionBody("startWindow");
    const start = body.indexOf('win.webContents.on("will-navigate"');
    const handler = body.slice(start, body.indexOf("\n  });", start));
    // R3：点了没反应和按钮坏了分不开。会加载成页面的目标要说出原因。
    expect(handler).toContain("blockedNavigationText(");
    expect(handler).toContain("sendToRenderer");
  });

  it("setWindowOpenHandler 默认 deny", () => {
    const body = functionBody("startWindow");
    expect(body).toContain("win.webContents.setWindowOpenHandler(");
    expect(body).toContain('({ action: "deny" })');
    // 本产品一个窗口、一个宿主、一个会话（D-148）；allow 会造出第二个窗口。
    expect(body).not.toContain('action: "allow"');
  });
});

describe("main.js 的 open-external 处理器", () => {
  /** 取 `ipcMain.handle("open-external"` 的处理函数体。 */
  function handlerBody() {
    const at = source.indexOf('ipcMain.handle("open-external"');
    expect(at, "找不到 open-external 处理器").toBeGreaterThan(-1);
    // 处理函数是 async (_event, url) => { … }；按大括号配对取到配对的 }。
    const braceStart = source.indexOf("{", source.indexOf("=>", at));
    let depth = 0;
    for (let cursor = braceStart; cursor < source.length; cursor += 1) {
      if (source[cursor] === "{") depth += 1;
      else if (source[cursor] === "}") {
        depth -= 1;
        if (depth === 0) return source.slice(braceStart + 1, cursor);
      }
    }
    return "";
  }

  it("先判定再打开：没有把原始字符串直接交给 shell", () => {
    const body = handlerBody();
    expect(body).toContain("checkExternalUrl(url)");
    // 关键的一条：交给 shell 的是判定过的 href，不是入参本身。
    expect(body).toContain("shell.openExternal(decision.url)");
    expect(body).not.toContain("shell.openExternal(String(url))");
    expect(body).not.toMatch(/shell\.openExternal\(\s*url\s*\)/);
  });

  it("拒绝时返回 {ok:false, reason}，并额外发一条可见 notice", () => {
    const body = handlerBody();
    expect(body).toContain("ok: false");
    expect(body).toContain("reason");
    // 返回值的三个调用点都不看它（`app.js` 的三处 `api.openExternal(...)`），
    // 所以只靠返回值等于静默拒绝。notice 才是用户看得到的信号。
    expect(body).toContain('type: "notice"');
    expect(body).toContain("blockedExternalText(");
  });

  it("shell 自己失败也要报，不把「系统打不开」伪装成成功", () => {
    const body = handlerBody();
    expect(body).toContain("try {");
    expect(body).toContain("catch");
    // 成功路径返回 ok:true；失败路径不能回 ok:true。
    expect(body).toMatch(/ok:\s*true/);
  });
});

// 这里原本有两条 `reveal-artifact` 处理器用例。2026-11-09 产物面板删除，
// 那条 IPC 链路（preload → ipcMain → shell.showItemInFolder）一并删掉。
