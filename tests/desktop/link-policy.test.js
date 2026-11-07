import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  EXTERNAL_PROTOCOLS,
  blockedExternalText,
  blockedNavigationText,
  checkExternalUrl,
  checkNavigationTarget,
  checkRevealTarget,
} from "../../desktop/link-policy.js";

/**
 * 链接策略的纯函数部分（BACKLOG 6.2 / OPT-40）。
 *
 * 背景：`ipcMain.handle("open-external")` 原来把渲染器给的任意字符串直接交给
 * `shell.openExternal`，而 `shell.openExternal` 不是「打开浏览器」，是「用系统
 * 注册给这个 scheme 的程序打开它」。Electron 自己的安全指南把
 * `openExternal(不可信内容)` 列为可执行任意命令的路径：`file:` 会按文件类型启动
 * 应用，`ms-msdt:` / `search-ms:` 能碰到 Windows 自带的工具链，`smb:` 会把凭据
 * 发给远端。转录里的链接来自模型输出、工具输出和 KB 条目——都不是可信内容。
 *
 * 没有 jsdom、也不该真的调用 `shell.openExternal`（那会在宿主机上启动程序），
 * 所以判定本身抽成纯函数在这里测；接线只由 `main-navigation.test.js` 做静态断言。
 * 这个文件的每个用例都是「一条会被放行的攻击面」，删掉任何一条都等于把那扇门
 * 重新打开。
 */

describe("EXTERNAL_PROTOCOLS", () => {
  it("只有 http 与 https", () => {
    expect(EXTERNAL_PROTOCOLS).toEqual(["http:", "https:"]);
  });
});

describe("checkExternalUrl 放行的部分", () => {
  it("http / https 通过，并返回规范化后的 href", () => {
    expect(checkExternalUrl("https://example.com/x")).toEqual({
      ok: true,
      url: "https://example.com/x",
      protocol: "https:",
    });
    expect(checkExternalUrl("http://example.com")).toEqual({
      ok: true,
      url: "http://example.com/",
      protocol: "http:",
    });
  });

  it("大小写与首尾空白交给 URL 解析器归一化，不是字符串前缀匹配", () => {
    // `HTTPS://` 是合法 URL；拼字符串的 `startsWith("https://")` 会误杀它。
    expect(checkExternalUrl("HTTPS://EXAMPLE.COM/A")).toEqual({
      ok: true,
      url: "https://example.com/A",
      protocol: "https:",
    });
    expect(checkExternalUrl("  https://example.com  ").ok).toBe(true);
  });

  it("没有 `//` 的 http 也接受（URL 会补全），查询串与锚点原样保留", () => {
    expect(checkExternalUrl("http:example.com").ok).toBe(true);
    const withQuery = checkExternalUrl("https://example.com/a?b=1#c");
    expect(withQuery.ok).toBe(true);
    expect(withQuery.url).toBe("https://example.com/a?b=1#c");
  });

  it("返回的是解析后的 href：交给系统的是刚刚判定过的那个串", () => {
    // 判定与打开必须是同一个值。若把原始串交给 shell，系统的解析器可能看到
    // 与这里不同的东西（这正是 URL 校验类缺陷的常见来源）。
    const decision = checkExternalUrl("https://example.com/%0Ajavascript:alert(1)");
    expect(decision.ok).toBe(true);
    expect(decision.url).toBe("https://example.com/%0Ajavascript:alert(1)");
  });
});

describe("checkExternalUrl 拒绝的非 http 协议", () => {
  it("拒绝 javascript:（含大小写变体与换行/制表符夹带）", () => {
    // URL 解析器会把内嵌的 ASCII 换行去掉，所以 "java\nscript:" 解析出来就是
    // javascript:。只按字面量黑名单拦的实现在这里会漏。
    for (const raw of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "java\nscript:alert(1)",
      "java\tscript:alert(1)",
      " javascript:alert(1)",
      "\u0000javascript:alert(1)",
    ]) {
      const decision = checkExternalUrl(raw);
      expect(decision.ok, `竟然放行了 ${JSON.stringify(raw)}`).toBe(false);
      expect(decision.protocol).toBe("javascript:");
    }
  });

  it("拒绝 file:（openExternal 会按文件类型启动程序）", () => {
    const decision = checkExternalUrl("file:///C:/Windows/System32/calc.exe");
    expect(decision.ok).toBe(false);
    expect(decision.protocol).toBe("file:");
  });

  it("拒绝 data: 与 vbscript:", () => {
    expect(checkExternalUrl("data:text/html,<script>alert(1)</script>").ok).toBe(false);
    expect(checkExternalUrl("vbscript:msgbox(1)").ok).toBe(false);
  });

  it("拒绝 Windows 自带的 ms-* / search-ms 协议处理器", () => {
    for (const raw of ["ms-msdt:/id PCWDiagnostic", "search-ms:query=x", "ms-settings:privacy"]) {
      const decision = checkExternalUrl(raw);
      expect(decision.ok, `竟然放行了 ${raw}`).toBe(false);
      expect(decision.protocol).toMatch(/^(ms-|search-ms:)/);
    }
  });

  it("拒绝 smb:（会把凭据发给远端）", () => {
    expect(checkExternalUrl("smb://host/share").ok).toBe(false);
  });

  it("拒绝 mailto: / chrome: / about: / 自定义 scheme", () => {
    for (const raw of ["mailto:a@b.c", "chrome://settings", "about:blank", "myapp:open?x=1"]) {
      expect(checkExternalUrl(raw).ok, `竟然放行了 ${raw}`).toBe(false);
    }
  });
});

describe("checkExternalUrl 拒绝的畸形输入", () => {
  it("空串、空白、不是绝对 URL 的串都拒绝，并给出原因", () => {
    // "example.com" 没有 scheme：new URL 直接抛。放行等于把「解析失败」当成
    // 「没问题」，那正是默认放行的另一种写法。
    for (const raw of ["", "   ", "example.com/path", "not a url", "http://"]) {
      const decision = checkExternalUrl(raw);
      expect(decision.ok, `竟然放行了 ${JSON.stringify(raw)}`).toBe(false);
      expect(decision.reason.length).toBeGreaterThan(0);
    }
  });

  it("非字符串一律拒绝（IPC 那头什么都可能到）", () => {
    for (const raw of [null, undefined, 123, true, {}, [], () => "https://example.com"]) {
      expect(checkExternalUrl(raw).ok).toBe(false);
    }
  });
});

describe("checkNavigationTarget 只放行窗口自己的页面", () => {
  const INDEX = path.resolve("/repo/desktop/renderer/index.html");

  it("同一个文件通过，并回传解析出的协议", () => {
    expect(checkNavigationTarget(pathToFileURL(INDEX).href, INDEX)).toEqual({
      ok: true,
      protocol: "file:",
    });
  });

  it("拒绝时也带上协议：调用方据此决定要不要发通知", () => {
    const decision = checkNavigationTarget("javascript:alert(1)", INDEX);
    expect(decision.ok).toBe(false);
    expect(decision.protocol).toBe("javascript:");
  });

  it("锚点与查询串仍指向同一个文件，放行", () => {
    // will-navigate 本来就不会为同文档锚点触发，但查询串会走到这里。
    const href = `${pathToFileURL(INDEX).href}?x=1#frag`;
    expect(checkNavigationTarget(href, INDEX).ok).toBe(true);
  });

  it.skipIf(process.platform !== "win32")("Windows 上盘符大小写不同也是同一个文件（按路径语义比较）", () => {
    // `E:\…` 与 `e:\…` 在 Windows 上是同一个文件；拼字符串会误判成「外部导航」，
    // 然后每次重载都被拦。9c2166e 的教训：路径要按路径语义比较。
    const upper = INDEX.toUpperCase();
    expect(checkNavigationTarget(pathToFileURL(upper).href, INDEX).ok).toBe(true);
  });

  it("同目录下的别的文件不放行", () => {
    const other = path.resolve("/repo/desktop/renderer/other.html");
    expect(checkNavigationTarget(pathToFileURL(other).href, INDEX).ok).toBe(false);
  });

  it("前缀相同但不是一个文件的不放行（/index.html.evil 与 /index.html/../x）", () => {
    // `startsWith(indexPath)` 会把这两个都放过——这正是不能用字符串前缀的原因。
    const evil = path.resolve("/repo/desktop/renderer/index.html.evil");
    expect(checkNavigationTarget(pathToFileURL(evil).href, INDEX).ok).toBe(false);
    const escape = `${pathToFileURL(INDEX).href}/../other.html`;
    expect(checkNavigationTarget(escape, INDEX).ok).toBe(false);
  });

  it("http(s) 不放行：窗口只显示自己的页面，网页去浏览器", () => {
    const https = checkNavigationTarget("https://example.com/", INDEX);
    expect(https.ok).toBe(false);
    expect(https.protocol).toBe("https:");
    expect(checkNavigationTarget("http://example.com/", INDEX).ok).toBe(false);
  });

  it("javascript: / data: / file: 到别处都不放行", () => {
    for (const raw of [
      "javascript:alert(1)",
      "data:text/html,<h1>x</h1>",
      pathToFileURL(path.resolve("/repo/desktop/main.js")).href,
      "file:///",
    ]) {
      const decision = checkNavigationTarget(raw, INDEX);
      expect(decision.ok, `竟然放行了 ${raw}`).toBe(false);
      expect(decision.reason.length).toBeGreaterThan(0);
    }
  });

  it("畸形输入不放行，且不抛异常", () => {
    for (const raw of ["", "   ", "file:relative.html", null, undefined, 42, {}]) {
      expect(() => checkNavigationTarget(raw, INDEX)).not.toThrow();
      expect(checkNavigationTarget(raw, INDEX).ok).toBe(false);
    }
  });
});

describe("checkRevealTarget", () => {
  it("绝对路径通过，原样返回", () => {
    const target = path.resolve("/repo/home/sessions/s1/artifacts/out.txt");
    expect(checkRevealTarget(target)).toEqual({ ok: true, path: target });
  });

  it("空路径、相对路径、URL 形态的串都拒绝", () => {
    // `shell.showItemInFolder` 对相对路径是静默无操作；URL 串则会被当成本地路径
    // 拼出来。两种都让按钮看起来坏了，拒绝并说明比静默强（R3）。
    for (const raw of ["", "   ", "artifacts/out.txt", "./out.txt", "file:///C:/Windows/calc.exe"]) {
      const decision = checkRevealTarget(raw);
      expect(decision.ok, `竟然放行了 ${JSON.stringify(raw)}`).toBe(false);
      expect(decision.reason.length).toBeGreaterThan(0);
    }
  });

  it("非字符串拒绝", () => {
    for (const raw of [null, undefined, 0, {}, []]) {
      expect(checkRevealTarget(raw).ok).toBe(false);
    }
  });
});

describe("拒绝文案", () => {
  it("说明被拒绝的原因与目标，且压成一行", () => {
    const external = blockedExternalText("file:///C:/Windows/calc.exe", "协议 file: 不在白名单");
    expect(external).toContain("file:");
    expect(external).toContain("协议");
    // 通知是一行文本；链接里的换行不能把后面的日志挤成第二行。
    expect(external).not.toContain("\n");
    expect(blockedNavigationText("javascript:alert(1)", "协议 javascript: 不是 file:")).toContain(
      "javascript:",
    );
  });

  it("超长链接被截断，不会把通知撑成一屏", () => {
    const long = `https://example.com/${"a".repeat(500)}`;
    const text = blockedExternalText(long, "原因");
    expect(text.length).toBeLessThan(300);
    expect(text).toContain("…");
  });
});

/**
 * 打包清单。
 *
 * `link-policy.js` 被 `main.js` 在运行时 import；`desktop/package.json` 的
 * `build.files` 是白名单，漏一项 asar 里就没有这个文件，主进程一启动就
 * `ERR_MODULE_NOT_FOUND`，而且这个错误只在打好的包里出现。
 */
describe("desktop/package.json 的打包清单", () => {
  it("含 link-policy.js", () => {
    const pkg = JSON.parse(
      readFileSync(path.join(import.meta.dirname, "..", "..", "desktop", "package.json"), "utf8"),
    );
    expect(pkg.build.files).toContain("link-policy.js");
  });
});
