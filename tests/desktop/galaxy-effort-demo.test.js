import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 独立演示页 `desktop/renderer/galaxy-effort-demo.html` 的静态断言。
 *
 * 事实源是 `docs/specs/galaxy-effort-slider.md` §1（舞台 945×516、`#111111`、居中）
 * 与 §6（`ResizeObserver` 缩放且不重置状态；同页两个实例）。
 *
 * **仓库没有浏览器测试框架，也不需要为此引入依赖**（用户未批准）。所以这里能断言
 * 的只有文本：路径、尺寸、缩放接线、实例数量、无远程素材。**它不证明页面能打开**——
 * 真窗口里跑一次的证据在 Task 4 报告里（Electron 探针的原始输出），不在这份文件里。
 * 把这份绿灯读成"演示页可用"是误读。
 *
 * 内联 module 脚本**不在** `npm run check:js` 的扫描范围（那个脚本只收 `.js` /
 * `.mjs` / `.cjs` 文件），所以这里额外钉住内联脚本的几条关键接线与错误上屏。
 */

const ROOT = path.join(import.meta.dirname, "..", "..");
const RENDERER = path.join(ROOT, "desktop", "renderer");
const DEMO = path.join(RENDERER, "galaxy-effort-demo.html");

const HTML = readFileSync(DEMO, "utf8");

/** 去掉 HTML 注释后的文本：注释里可以自由讨论，断言只针对真正生效的部分。 */
const BODY = HTML.replace(/<!--[\s\S]*?-->/g, "");

describe("演示页文件与引用", () => {
  it("文件存在", () => {
    expect(existsSync(DEMO)).toBe(true);
  });

  it("用相对路径引用同目录的样式表与模块", () => {
    expect(BODY).toContain('<link rel="stylesheet" href="./galaxy-effort.css"');
    expect(BODY).toContain('import { createGalaxyEffort } from "./galaxy-effort.js";');
  });

  it("被引用的两个文件真的在同一个目录里", () => {
    expect(existsSync(path.join(RENDERER, "galaxy-effort.css"))).toBe(true);
    expect(existsSync(path.join(RENDERER, "galaxy-effort.js"))).toBe(true);
  });

  it("脚本是 module，否则 import 语句不成立", () => {
    expect(BODY).toContain('<script type="module">');
  });
});

describe("舞台尺寸与底色", () => {
  it("945×516 的逻辑尺寸作为常量出现", () => {
    expect(BODY).toContain("const STAGE_WIDTH = 945;");
    expect(BODY).toContain("const STAGE_HEIGHT = 516;");
    expect(BODY).toContain("width: 945px;");
    expect(BODY).toContain("height: 516px;");
  });

  it("外层底色是 #111111，且铺满视口、不出现滚动条", () => {
    expect(BODY).toContain("background: #111111;");
    // 视口高度铺满
    expect(BODY).toMatch(/html,\s*body\s*\{\s*height:\s*100%;\s*\}/);
    // 滚动条不允许出现：html 与 body 各自都写了 overflow: hidden。
    expect((BODY.match(/overflow:\s*hidden;/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("缩放系数就是 min(可用宽/945, 可用高/516)", () => {
    expect(BODY).toMatch(
      /Math\.min\(\s*width \/ STAGE_WIDTH,\s*height \/ STAGE_HEIGHT\s*\)/,
    );
  });

  it("transform-origin 是 center，且用 translate 做水平垂直居中", () => {
    expect(BODY).toContain("transform-origin: center;");
    expect(BODY).toContain("transform: translate(-50%, -50%) scale(");
  });

  it("场景边界裁切（规格 §1：卡片允许粒子溢出，舞台裁切）", () => {
    // #demo-stage 的规则块里必须有 overflow: hidden
    const stageRule = BODY.match(/#demo-stage\s*\{[\s\S]*?\}/)?.[0] ?? "";
    expect(stageRule).toContain("overflow: hidden;");
  });
});

describe("ResizeObserver 缩放且不重置状态", () => {
  it("用 ResizeObserver 监听并更新缩放", () => {
    expect(BODY).toContain("new ResizeObserver(fitStage)");
    expect(BODY).toContain("resizeObserver.observe(document.documentElement)");
  });

  it("缩放只改 transform，不在缩放路径里 destroy / 重建实例", () => {
    // `fitStage` 的函数体里只有读尺寸与写 transform，没有 destroy / createGalaxyEffort。
    const fit = BODY.match(/function fitStage\(\)\s*\{[\s\S]*?\n {8}\}/)?.[0] ?? "";
    expect(fit).not.toBe("");
    expect(fit).toContain("stage.style.transform");
    expect(fit).not.toContain("destroy");
    expect(fit).not.toContain("createGalaxyEffort");
    // 全页只有两处 createGalaxyEffort 调用（两个实例），没有"缩放时重建"的第三条。
    expect((BODY.match(/createGalaxyEffort\(/g) ?? []).length).toBe(2);
  });
});

describe("同页两个实例", () => {
  it("两个挂载槽 + 两次 createGalaxyEffort", () => {
    expect(BODY).toContain('id="demo-slot-a"');
    expect(BODY).toContain('id="demo-slot-b"');
    expect((BODY.match(/createGalaxyEffort\(/g) ?? []).length).toBe(2);
  });

  it("第一个 value: 0（Low），第二个 value: 5（Galaxy）并显式全动态", () => {
    expect(BODY).toContain(
      'createGalaxyEffort({ mount: slots[0].node, value: 0 })',
    );
    expect(BODY).toContain(
      'createGalaxyEffort({ mount: slots[1].node, value: 5, reducedMotion: false })',
    );
  });

  it("每个实例各挂一个 effort-change 监听器（不是共用一个）", () => {
    // 监听注册在 forEach 的槽位上，事件因此能归属到具体实例。
    expect(BODY).toContain("slots.forEach((slot) => {");
    expect(BODY).toContain('slot.node.addEventListener("effort-change"');
    // 事件名只能以字符串字面量出现一次（一处注册），避免抄成两个名字不同的监听。
    expect((BODY.match(/"effort-change"/g) ?? []).length).toBe(1);
  });

  it("页面上显示最近一次 detail 的 value 与 level", () => {
    expect(BODY).toContain('id="demo-last"');
    expect(BODY).toMatch(/event\.detail\.value/);
    expect(BODY).toMatch(/event\.detail\.level/);
    expect(BODY).toContain("最近一次 effort-change");
  });
});

describe("错误上屏与字体", () => {
  it("内联 module 里有 try/catch，异常写进 #demo-error", () => {
    expect(BODY).toContain('<pre id="demo-error">');
    expect(BODY).toMatch(/try\s*\{/);
    expect(BODY).toMatch(/\}\s*catch\s*\(error\)\s*\{\s*report\(error\);/);
    expect(BODY).toContain('const errorBox = document.getElementById("demo-error");');
    // report 必须真的写文本，而不是只 console.error
    expect(BODY).toMatch(/function report\(error\)\s*\{\s*errorBox\.textContent =/);
  });

  it("模块加载期的失败也上屏（捕获阶段的 window error 监听）", () => {
    expect(BODY).toContain('window.addEventListener("error"');
    expect(BODY).toContain('document.getElementById("demo-error")');
    // **必须是捕获阶段**：脚本 / import 的加载错误不冒泡，冒泡阶段收不到。
    // 用 Electron 实测过：冒泡阶段时 import 路径不存在 -> 页面一片空白、error 为空。
    expect(BODY).toMatch(/\},\s*true\);/);
  });

  it("有 1 秒兜底：模块没跑起来时明确上屏，而不是留一张空白页", () => {
    expect(BODY).toContain("window.galaxyEffortDemo === undefined");
    expect(BODY).toContain("演示页未能初始化");
  });

  it("字体栈是规格的 Arial, Helvetica, sans-serif", () => {
    expect(BODY).toContain("font-family: Arial, Helvetica, sans-serif;");
  });
});

describe("零外部依赖", () => {
  it("没有任何 http:// 或 https:// 引用", () => {
    expect(BODY).not.toMatch(/https?:\/\//);
  });

  it("没有远程字体、图标或图片", () => {
    expect(BODY).not.toMatch(/<img\b/i);
    expect(BODY).not.toMatch(/@import\s+url/i);
    expect(BODY).not.toMatch(/@font-face/i);
    expect(BODY).not.toMatch(/url\(\s*["']?(?:https?:)?\/\//i);
    // 唯一的 url( 是 data: 图标，或者根本没有。
    for (const match of BODY.matchAll(/url\(([^)]*)\)/gi)) {
      expect(match[1].trim()).toMatch(/^["']?data:/);
    }
  });
});
