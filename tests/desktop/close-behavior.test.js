/**
 * 关闭行为（托盘 / 退出）的纯函数部分：校验、文件解析、原子写、托盘菜单模板。
 *
 * 照 `tests/desktop/updater.test.js` 的写法：不加载 electron、不触网；真实文件
 * 系统只有 `writeCloseBehavior` 的落盘用例碰，且每个用例都在 `os.tmpdir()` 下的
 * 独立目录里，结束即删。
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLOSE_BEHAVIOR_FILE,
  CLOSE_BEHAVIORS,
  DEFAULT_CLOSE_BEHAVIOR,
  normalizeCloseBehavior,
  parseCloseBehaviorFile,
  readCloseBehavior,
  shouldHideOnClose,
  trayFailureText,
  trayHintText,
  trayMenuTemplate,
  writeCloseBehavior,
} from "../../desktop/close-behavior.js";

const created = [];

async function tempDir(prefix = "close-behavior-") {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

afterEach(async () => {
  while (created.length > 0) {
    await rm(created.pop(), { recursive: true, force: true });
  }
});

describe("CLOSE_BEHAVIORS", () => {
  it("只有 tray / quit 两个值，不重复", () => {
    expect(CLOSE_BEHAVIORS).toEqual(["tray", "quit"]);
  });

  it("默认是 tray（保持后台任务存活，坏配置不会顺手结束一次调试）", () => {
    expect(DEFAULT_CLOSE_BEHAVIOR).toBe("tray");
    expect(CLOSE_BEHAVIORS).toContain(DEFAULT_CLOSE_BEHAVIOR);
  });
});

describe("normalizeCloseBehavior", () => {
  it("合法值原样返回，来源标记为 file", () => {
    expect(normalizeCloseBehavior("tray")).toEqual({ behavior: "tray", source: "file" });
    expect(normalizeCloseBehavior("quit")).toEqual({ behavior: "quit", source: "file" });
  });

  it("null / undefined 是「还没选过」，回落 tray 且来源为 default", () => {
    expect(normalizeCloseBehavior(null)).toEqual({ behavior: "tray", source: "default" });
    expect(normalizeCloseBehavior(undefined)).toEqual({ behavior: "tray", source: "default" });
  });

  it("非法值回落 tray，来源为 invalid，并带上原因", () => {
    for (const value of ["TRay", "QUIT", "tray ", 123, "", true, {}, []]) {
      const result = normalizeCloseBehavior(value);
      expect(result.behavior).toBe("tray");
      expect(result.source).toBe("invalid");
      expect(typeof result.reason).toBe("string");
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });

  it("原因里写出被拒绝的值，便于用户自己找到文件里的那一行", () => {
    expect(normalizeCloseBehavior("TRay").reason).toContain('"TRay"');
    expect(normalizeCloseBehavior(123).reason).toContain("123");
  });
});

describe("shouldHideOnClose", () => {
  it("tray + 未退出 → 拦截并隐藏", () => {
    expect(shouldHideOnClose({ behavior: "tray", isQuitting: false })).toBe(true);
  });

  it("quit + 未退出 → 不拦截（照旧关窗停宿主并退出）", () => {
    expect(shouldHideOnClose({ behavior: "quit", isQuitting: false })).toBe(false);
  });

  it("tray + 正在退出 → 不拦截（否则托盘菜单的「退出」和 quitAndInstall 会被吞掉）", () => {
    expect(shouldHideOnClose({ behavior: "tray", isQuitting: true })).toBe(false);
  });

  it("quit + 正在退出 → 不拦截", () => {
    expect(shouldHideOnClose({ behavior: "quit", isQuitting: true })).toBe(false);
  });

  it("behavior 缺失或非法时按默认 tray 处理，isQuitting 缺省按 false", () => {
    expect(shouldHideOnClose({})).toBe(true);
    expect(shouldHideOnClose({ behavior: undefined })).toBe(true);
    expect(shouldHideOnClose({ behavior: "TRay" })).toBe(true);
    expect(shouldHideOnClose({ behavior: "quit", isQuitting: "yes" })).toBe(false);
    expect(shouldHideOnClose()).toBe(true);
  });
});

describe("parseCloseBehaviorFile", () => {
  it("合法 JSON → 读出 file 来源的值", () => {
    expect(parseCloseBehaviorFile('{"closeBehavior":"quit"}')).toEqual({
      behavior: "quit",
      source: "file",
    });
    expect(parseCloseBehaviorFile('{\n  "closeBehavior": "tray"\n}\n')).toEqual({
      behavior: "tray",
      source: "file",
    });
  });

  it("坏 JSON → tray / invalid，不抛", () => {
    const result = parseCloseBehaviorFile('{"closeBehavior":');
    expect(result.behavior).toBe("tray");
    expect(result.source).toBe("invalid");
    expect(result.reason).toContain("JSON");
  });

  it("值不是合法字符串（数字、拼错的值）→ tray / invalid", () => {
    for (const raw of ['{"closeBehavior":123}', '{"closeBehavior":"trayy"}', '{"closeBehavior":true}']) {
      const result = parseCloseBehaviorFile(raw);
      expect(result.behavior).toBe("tray");
      expect(result.source).toBe("invalid");
    }
  });

  it("显式的 null 与「键不存在」同义：tray / default（不是坏值，是没选过）", () => {
    expect(parseCloseBehaviorFile('{"closeBehavior":null}')).toEqual({
      behavior: "tray",
      source: "default",
    });
  });

  it("值是普通字符串（整份文件就是一个 JSON 字符串）→ tray / invalid", () => {
    const result = parseCloseBehaviorFile('"quit"');
    expect(result.behavior).toBe("tray");
    expect(result.source).toBe("invalid");
    expect(result.reason).toContain("对象");
  });

  it("顶层是数组 → tray / invalid", () => {
    const result = parseCloseBehaviorFile("[]");
    expect(result.behavior).toBe("tray");
    expect(result.source).toBe("invalid");
  });

  it("空文件 / 只有空白 → tray / default（首次运行的正常形态，不报警）", () => {
    expect(parseCloseBehaviorFile("")).toEqual({ behavior: "tray", source: "default" });
    expect(parseCloseBehaviorFile("   \n\t")).toEqual({ behavior: "tray", source: "default" });
    expect(parseCloseBehaviorFile(undefined)).toEqual({ behavior: "tray", source: "default" });
  });

  it("没有 closeBehavior 键 → tray / default", () => {
    expect(parseCloseBehaviorFile("{}")).toEqual({ behavior: "tray", source: "default" });
    expect(parseCloseBehaviorFile('{"other":1}')).toEqual({ behavior: "tray", source: "default" });
  });

  it("未知键被忽略，值照读", () => {
    expect(parseCloseBehaviorFile('{"closeBehavior":"quit","future":true}')).toEqual({
      behavior: "quit",
      source: "file",
    });
  });
});

describe("readCloseBehavior", () => {
  it("文件不存在 → tray / default（不抛，首次运行）", async () => {
    const dir = await tempDir();
    expect(readCloseBehavior({ userDataDir: dir })).toEqual({
      behavior: "tray",
      source: "default",
    });
  });

  it("目录也不存在 → tray / default", async () => {
    const dir = path.join(await tempDir(), "nested", "missing");
    expect(readCloseBehavior({ userDataDir: dir })).toEqual({
      behavior: "tray",
      source: "default",
    });
  });

  it("写入后再读回一致（quit）", async () => {
    const dir = await tempDir();
    const result = await writeCloseBehavior({ userDataDir: dir, behavior: "quit" });
    expect(result).toEqual({ behavior: "quit", saved: true });
    expect(readCloseBehavior({ userDataDir: dir })).toEqual({ behavior: "quit", source: "file" });
  });

  it("读取失败（注入一个非 ENOENT 的错误）→ tray / invalid 并带原因，不抛", async () => {
    const dir = await tempDir();
    const readFile = vi.fn(() => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    });
    const result = readCloseBehavior({ userDataDir: dir, readFile });
    expect(result.behavior).toBe("tray");
    expect(result.source).toBe("invalid");
    expect(result.reason).toContain("EACCES");
    expect(readFile).toHaveBeenCalledWith(path.join(dir, CLOSE_BEHAVIOR_FILE), "utf8");
  });

  it("坏文件在磁盘上时也回到 tray，而不是让启动失败", async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, CLOSE_BEHAVIOR_FILE), "{ nope", "utf8");
    const result = readCloseBehavior({ userDataDir: dir });
    expect(result.behavior).toBe("tray");
    expect(result.source).toBe("invalid");
  });

  it("没有 userDataDir → tray / default 并说明", () => {
    expect(readCloseBehavior({ userDataDir: "" })).toMatchObject({ behavior: "tray", source: "default" });
    expect(readCloseBehavior({}).behavior).toBe("tray");
  });
});

describe("writeCloseBehavior（临时目录）", () => {
  it("写入 → 读回一致，文件就是 { closeBehavior } 这一份", async () => {
    const dir = await tempDir();
    expect(await writeCloseBehavior({ userDataDir: dir, behavior: "tray" })).toEqual({
      behavior: "tray",
      saved: true,
    });
    const text = await readFile(path.join(dir, CLOSE_BEHAVIOR_FILE), "utf8");
    expect(JSON.parse(text)).toEqual({ closeBehavior: "tray" });
  });

  it("父目录不存在时自己建出来", async () => {
    const dir = path.join(await tempDir(), "a", "b", "c");
    const result = await writeCloseBehavior({ userDataDir: dir, behavior: "quit" });
    expect(result.saved).toBe(true);
    expect(existsSync(path.join(dir, CLOSE_BEHAVIOR_FILE))).toBe(true);
    expect(readCloseBehavior({ userDataDir: dir })).toEqual({ behavior: "quit", source: "file" });
  });

  it("重复写入是覆盖，不是追加", async () => {
    const dir = await tempDir();
    await writeCloseBehavior({ userDataDir: dir, behavior: "tray" });
    await writeCloseBehavior({ userDataDir: dir, behavior: "quit" });
    const text = await readFile(path.join(dir, CLOSE_BEHAVIOR_FILE), "utf8");
    expect(JSON.parse(text)).toEqual({ closeBehavior: "quit" });
    expect(text).not.toContain("tray");
  });

  it("非法值不落盘：saved=false、带原因、目录里什么都不多", async () => {
    const dir = await tempDir();
    const result = await writeCloseBehavior({ userDataDir: dir, behavior: "TRay" });
    expect(result.saved).toBe(false);
    expect(result.behavior).toBe("tray");
    expect(result.error).toContain("TRay");
    await expect(readdir(dir)).resolves.toEqual([]);
  });

  it("undefined / null 也不写：没有选择过不等于选过 tray", async () => {
    const dir = await tempDir();
    expect((await writeCloseBehavior({ userDataDir: dir, behavior: null })).saved).toBe(false);
    expect((await writeCloseBehavior({ userDataDir: dir, behavior: undefined })).saved).toBe(false);
    await expect(readdir(dir)).resolves.toEqual([]);
  });

  it("写到一半失败 → saved=false，不留下目标文件、也不留下临时文件", async () => {
    const dir = await tempDir();
    // 模拟「已经写了一部分然后磁盘满」：临时文件被创建、内容半截、随后抛错。
    // 真正的 fs.writeFile 通过 import 拿，避免与被注入的名字重名。
    const writeFileFake = vi.fn(async (file) => {
      const { writeFile: realWriteFile } = await import("node:fs/promises");
      await realWriteFile(file, '{"closeBehav');
      throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    });
    const result = await writeCloseBehavior({
      userDataDir: dir,
      behavior: "quit",
      writeFile: writeFileFake,
    });
    expect(result.saved).toBe(false);
    expect(result.behavior).toBe("quit");
    expect(result.error).toContain("ENOSPC");
    expect(existsSync(path.join(dir, CLOSE_BEHAVIOR_FILE))).toBe(false);
    await expect(readdir(dir)).resolves.toEqual([]);
  });

  it("rename 失败 → 旧文件内容原样保留，临时文件被清掉", async () => {
    const dir = await tempDir();
    await writeCloseBehavior({ userDataDir: dir, behavior: "tray" });
    const result = await writeCloseBehavior({
      userDataDir: dir,
      behavior: "quit",
      rename: async () => {
        throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
      },
    });
    expect(result.saved).toBe(false);
    expect(result.error).toContain("EPERM");
    const text = await readFile(path.join(dir, CLOSE_BEHAVIOR_FILE), "utf8");
    expect(JSON.parse(text)).toEqual({ closeBehavior: "tray" });
    await expect(readdir(dir)).resolves.toEqual([CLOSE_BEHAVIOR_FILE]);
  });

  it("没有 userDataDir → saved=false，不抛", async () => {
    const result = await writeCloseBehavior({ userDataDir: "", behavior: "quit" });
    expect(result.saved).toBe(false);
    expect(typeof result.error).toBe("string");
  });

  it("临时文件名带注入的 id，说明它不会与目标文件同名", async () => {
    const dir = await tempDir();
    const seen = [];
    const { writeFile: realWriteFile } = await import("node:fs/promises");
    await writeCloseBehavior({
      userDataDir: dir,
      behavior: "quit",
      newId: () => "fixed-id",
      writeFile: async (file, text, options) => {
        seen.push({ file, options });
        return realWriteFile(file, text, options);
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].file).toBe(path.join(dir, `${CLOSE_BEHAVIOR_FILE}.fixed-id.tmp`));
    expect(seen[0].options).toEqual({ encoding: "utf8", flag: "wx" });
  });
});

describe("trayMenuTemplate", () => {
  const labels = (template) => template.filter((item) => item.type !== "separator").map((item) => item.label);

  it("顺序固定：显示主窗口 / 关闭行为 / 退出", () => {
    expect(trayMenuTemplate({ behavior: "tray", locale: "en" }).map((item) => item.id ?? item.type)).toEqual([
      "show",
      "separator",
      "close-behavior",
      "separator",
      "quit",
    ]);
  });

  it("英文文案", () => {
    expect(labels(trayMenuTemplate({ behavior: "tray", locale: "en" }))).toEqual([
      "Show main window",
      "Close button: minimize to tray",
      "Quit",
    ]);
    expect(labels(trayMenuTemplate({ behavior: "quit", locale: "en" }))).toEqual([
      "Show main window",
      "Close button: quit the app",
      "Quit",
    ]);
  });

  it("中文文案", () => {
    expect(labels(trayMenuTemplate({ behavior: "tray", locale: "zh" }))).toEqual([
      "显示主窗口",
      "关闭按钮：最小化到托盘",
      "退出",
    ]);
    expect(labels(trayMenuTemplate({ behavior: "quit", locale: "zh" }))).toEqual([
      "显示主窗口",
      "关闭按钮：退出应用",
      "退出",
    ]);
  });

  it("关闭行为那一项是禁用的（切换入口只放在设置页），且不带 click", () => {
    for (const behavior of ["tray", "quit"]) {
      const item = trayMenuTemplate({ behavior, locale: "en" }).find((entry) => entry.id === "close-behavior");
      expect(item.enabled).toBe(false);
      expect(item.click).toBeUndefined();
    }
  });

  it("点「显示主窗口」/「退出」分别调到各自回调", () => {
    const onShow = vi.fn();
    const onQuit = vi.fn();
    const template = trayMenuTemplate({ behavior: "tray", locale: "en", onShow, onQuit });
    template.find((item) => item.id === "show").click();
    template.find((item) => item.id === "quit").click();
    expect(onShow).toHaveBeenCalledTimes(1);
    expect(onQuit).toHaveBeenCalledTimes(1);
  });

  it("回调缺失时点击不抛", () => {
    const template = trayMenuTemplate({ behavior: "tray", locale: "en" });
    expect(() => {
      template.find((item) => item.id === "show").click();
      template.find((item) => item.id === "quit").click();
    }).not.toThrow();
  });

  it("未知 locale / 非法 behavior 有确定答案：英文 + tray 文案", () => {
    expect(labels(trayMenuTemplate({ behavior: "tray", locale: "fr" }))).toEqual([
      "Show main window",
      "Close button: minimize to tray",
      "Quit",
    ]);
    expect(labels(trayMenuTemplate({ behavior: "nonsense", locale: "en" }))).toEqual([
      "Show main window",
      "Close button: minimize to tray",
      "Quit",
    ]);
  });
});

describe("trayHintText", () => {
  it("中英各一份，都说清「已最小化到托盘，可从托盘恢复」", () => {
    expect(trayHintText("zh")).toEqual({
      title: "Embedded AI Master",
      body: "已最小化到系统托盘，可从托盘图标恢复窗口。",
    });
    expect(trayHintText("en").body).toContain("system tray");
    expect(trayHintText("en").body).toContain("tray icon");
  });

  it("未知 locale 回落英文；返回的是副本，改它不会污染下一次调用", () => {
    expect(trayHintText("fr")).toEqual(trayHintText("en"));
    const first = trayHintText("zh");
    first.body = "mutated";
    expect(trayHintText("zh").body).not.toBe("mutated");
  });
});

describe("trayFailureText", () => {
  it("托盘建不出来时说明窗口保持打开，并给出退出路径", () => {
    expect(trayFailureText("zh").title).toBe("无法最小化到托盘");
    expect(trayFailureText("zh").body).toContain("窗口保持打开");
    expect(trayFailureText("en").body).toContain("stays open");
  });

  it("未知 locale 回落英文；返回副本", () => {
    expect(trayFailureText("fr")).toEqual(trayFailureText("en"));
    const first = trayFailureText("en");
    first.title = "mutated";
    expect(trayFailureText("en").title).not.toBe("mutated");
  });
});

/**
 * `main.js` 的接线断言。
 *
 * 没有 GUI 的单测环境，`main.js` 加载不了（它 `import { app } from
 * "electron"`）。纯函数的部分上面已经测过，剩下这几条不变量只体现在**接线**
 * 上——`isQuitting` 有没有在 `before-quit` 置位、`close` 有没有先看它、托盘
 * 有没有在 `will-quit` 销毁。文本级断言比"没有测试"强，但它证明的是「代码这么
 * 写了」，不是「运行时真的这样」；这一点写在报告里，别当成运行时证据。
 */
describe("desktop/main.js 的接线（静态）", () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(path.resolve(HERE, "../../desktop/main.js"), "utf8");
  const pkg = JSON.parse(readFileSync(path.resolve(HERE, "../../desktop/package.json"), "utf8"));

  /** 按大括号配对取函数体（与 `main-scope.test.js` 同一思路）。 */
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

  it("isQuitting 在模块作用域声明，并在 before-quit 里置 true", () => {
    expect(source).toMatch(/^let isQuitting = false;$/m);
    const handler = /app\.on\("before-quit",\s*\(\)\s*=>\s*\{([\s\S]*?)\}\);/.exec(source);
    expect(handler, "找不到 before-quit 处理器").not.toBeNull();
    expect(handler[1]).toContain("isQuitting = true");
  });

  it("close 的决策走纯函数 shouldHideOnClose，参数含 isQuitting", () => {
    const body = functionBody("startWindow");
    expect(body).toContain('win.on("close"');
    expect(body).toContain("shouldHideOnClose({ behavior: closeBehavior, isQuitting })");
    expect(body).toContain("event.preventDefault()");
    expect(body).toContain("win.hide()");
  });

  it("托盘在 will-quit 里销毁（Windows 上否则留死图标）", () => {
    const handler = /app\.on\("will-quit",\s*\(\)\s*=>\s*\{([\s\S]*?)\n\}\);/.exec(source);
    expect(handler, "找不到 will-quit 处理器").not.toBeNull();
    expect(handler[1]).toContain("tray.destroy()");
  });

  it("任何模式（含开发形态）都建托盘，且在 whenReady 里、开窗前", () => {
    const ready = /app\.whenReady\(\)\.then\(\(\)\s*=>\s*\{([\s\S]*?)\n\}\);/.exec(source);
    expect(ready, "找不到 whenReady 处理器").not.toBeNull();
    const body = ready[1];
    expect(body).toContain("ensureTray()");
    expect(body).not.toMatch(/isPackaged/);
    expect(body.indexOf("ensureTray()")).toBeLessThan(body.indexOf("startWindow()"));
    expect(body.indexOf("loadCloseBehavior()")).toBeLessThan(body.indexOf("startWindow()"));
  });

  it("托盘图标按 DPI 在 tray-16 / tray-32 之间选，不 resize，失败要出声", () => {
    const body = functionBody("trayIcon");
    expect(body).toContain("screen.getPrimaryDisplay()");
    expect(body).toContain("scaleFactor");
    expect(body).toContain('"tray-32.png"');
    expect(body).toContain('"tray-16.png"');
    expect(body).not.toContain(".resize(");
    expect(body).not.toContain("mark.png");
    expect(body).not.toContain("build");
    expect(body).toContain("nativeImage.createEmpty()");
    expect(body).toContain("console.warn");
  });

  it("只在 menu 模板里用 closeBehavior，且两处菜单项文字来自同一份模板", () => {
    expect(functionBody("refreshTrayMenu")).toContain("trayMenuTemplate(");
    // 托盘菜单禁用项的文案由纯函数给出，main.js 不自己拼字符串。
    expect(source).not.toMatch(/label:\s*"显示主窗口"/);
  });

  it("打包清单里有 close-behavior.js（否则 asar 里 main.js 的 import 找不到）", () => {
    expect(pkg.build.files).toContain("close-behavior.js");
  });
});
