import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EFFORT_TIERS as KERNEL_TIERS } from "../../src/config/providers.js";
import { dictionaries } from "../../desktop/renderer/i18n.js";
import { EFFORT_TIERS } from "../../desktop/renderer/effort-tiers.js";

/**
 * The six-tier effort slider (Task 2 of the effort-tiers plan).
 *
 * There is no jsdom in this repository and adding one is a dependency the user
 * has not approved, so these are the two kinds of check this codebase can
 * honestly make about a renderer: pure-function assertions over the tier
 * vocabulary, and static assertions over the wiring — which element carries
 * which handler, whether the range is the accessible base, whether the
 * reduced-motion branch exists.
 *
 * What a static check cannot prove, stated here so nobody reads a green run as
 * more than it is: the visual result (a draggable thumb, the lit ramp, the
 * top-tier pulse) is not exercised. Only the real window can show that.
 */
const ROOT = path.join(import.meta.dirname, "..", "..");
const RENDERER = path.join(ROOT, "desktop", "renderer");
const read = (name) => readFileSync(path.join(RENDERER, name), "utf8");

/**
 * The block starting at `header`, up to the line that closes it.
 *
 * Same rule as `settings-draft-guard.test.js`: the end is the first line at the
 * header's own indentation that starts with `}`. Brace counting is unusable
 * here — the sources are full of `}` inside template literals.
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

/* 这里原本有一个 `effortCss()` 辅助函数，2026-11-10 清理时删除：它最后一个调用方
   随原生 range 一起在 `e70db21` 退场，而且它切片的起点标记 `/* The six-tier
   panel.` 早已不在样式表里。 */

describe("六档常量与内核一致", () => {
  it("渲染层的 EFFORT_TIERS 与 src/config/providers.ts 逐项相同", () => {
    // The renderer cannot import the TypeScript constant (no bundler), so it
    // keeps its own copy. This import is the pin that keeps the copy honest:
    // add a tier in one place only and this fails. It is also the only reason
    // `desktop/renderer/effort-tiers.js` still exists — nothing in `desktop/`
    // imports it any more (2026-11-10).
    expect(EFFORT_TIERS).toStrictEqual([...KERNEL_TIERS]);
    expect(EFFORT_TIERS).toHaveLength(6);
    // Order is the contract, not membership: the track reads left to right, so
    // a reordered list would relabel every stop.
    expect(EFFORT_TIERS).toStrictEqual(["low", "medium", "high", "extra", "max", "galaxy"]);
  });
});

describe("面板换成脑形滑块之后，接线仍然完整", () => {
  it("#effort-control / #effort-panel 的 id 保留，旧的 range 与下拉菜单都已移除", () => {
    const html = read("index.html");
    expect(html).toContain('id="effort-control"');
    expect(html).toContain('id="effort-panel"');
    expect(html).not.toContain('id="effort-menu"');
    // 2026-11-09：原生 range 整个让位给组件。留着它只会是一个没人绑定、
    // 也没人看的隐藏输入框——而它过去正是「控件到底存不存在」的判据。
    expect(html).not.toContain('id="effort-range"');
    expect(html).not.toContain("data-tier-index");
    const app = read("app.js");
    expect(app).not.toContain('$("effort-menu")');
    expect(app).not.toContain("renderEffortMenu");
    expect(app).not.toContain("effortRange");
    expect(app).not.toContain("paintEffortTrack");
  });

  it("面板里只剩挂载点与一句补充说明，Auto 按钮与声明句都已退场", () => {
    const html = read("index.html");
    // The component builds its own DOM inside this element; nothing here may
    // duplicate the card's internals, or there would be two tracks.
    expect(html).toContain('id="effort-galaxy-mount"');
    // 2026-11-09 自适应映射之后：
    // - `auto` 成了滑块最左一档，所以那个独立按钮没有了；
    // - 轨道的长度就是能力声明，所以那句“这个模型收不到”的说明也没有了。
    expect(html).not.toContain('id="effort-auto"');
    expect(html).not.toContain('id="effort-note"');
    // 留下的只有“实际会发什么”的补充说明，它挂在挂载点之后。
    expect(html).toContain('id="effort-auto-hint"');
    expect(html.indexOf('id="effort-auto-hint"')).toBeGreaterThan(html.indexOf('id="effort-galaxy-mount"'));
  });

  it("组件按挂载点创建，且只创建一次（懒加载）", () => {
    const app = read("app.js");
    expect(app).toContain('from "./galaxy-effort.js"');
    const ensure = bodyOf(app, "function ensureEffortSlider() {");
    // Guarded on the instance AND on the factory: a renderer that somehow did
    // not get the module must degrade to "no slider", not throw on every open.
    expect(ensure).toContain("effortSlider !== null");
    expect(ensure).toContain('createGalaxyEffort({');
    expect(ensure).toContain('mount: $("effort-galaxy-mount")');
    // Created on first open, not at module load: two canvases plus a RAF loop
    // is a real cost for a conversation that never touches the slider.
    const setPanel = bodyOf(app, "function setEffortPanel(open) {");
    expect(setPanel).toContain("ensureEffortSlider()");
  });

  it("宿主按等比缩小放进弹层，规格里的数字一个都不改", () => {
    const app = read("app.js");
    const css = read("styles.css");
    // 2026-11-09 用户原话「太大了，等比缩小」。规格的 440×258 是逐条核对的
    // 验收值，所以缩小只能发生在宿主这一层：给组件根节点一个 --ge-scale，
    // 整块 transform，内部尺寸一律不动。谁把 galaxy-effort.css 里的 440 改小，
    // 验收表就和实现对不上了。
    expect(css).toContain("--ge-scale: 0.55");
    expect(css).toContain("#effort-galaxy-mount");
    // transform 不改变父级布局盒：不给占位尺寸的话，弹层会按 440×258 留白。
    // 占位盒 = 卡片逻辑尺寸 × 缩放系数，两个数字必须一起改——所以这里从
    // `--ge-scale` 推回期望值，而不是再抄一份字面量。
    const scale = Number(css.match(/--ge-scale:\s*([0-9.]+)/)[1]);
    const mount = css.slice(css.indexOf("#effort-galaxy-mount {"), css.indexOf("}", css.indexOf("#effort-galaxy-mount {")));
    expect(mount).toContain(`width: ${Math.round(440 * scale)}px`);
    // 高度容许取整误差（258 × .55 = 141.9，写的是 142）。
    expect(mount).toMatch(/height:\s*14[12]px/);
    // 卡片高度不再需要为 extras 生长：那块只剩一行说明，字号已经抵掉缩放，
    // 不会溢出。`layoutEffortExtras` 连同它的副作用一起删除了。
    expect(app).not.toContain("layoutEffortExtras");
    // 组件那一侧只认变量、有自己的默认值，演示页因此仍是 1:1。
    const galaxy = read("galaxy-effort.css");
    expect(galaxy).toContain("scale(var(--ge-scale, 1))");
    expect(galaxy).toContain("width: 440px");
    expect(galaxy).toContain("height: 258px");
    // 缩放系数只有一个定义处（样式表）。app.js 不再参与——它以前要读这个值
    // 去算卡片高度，现在 extras 只剩一行说明，不需要量。
    expect(app).not.toContain("--ge-scale");
  });

  it("滑块按宿主给的 stops 创建，宿主换档位就重建", () => {
    const app = read("app.js");
    const ensure = bodyOf(app, "function ensureEffortSlider() {");
    // 2026-11-09 自适应映射：档位列表是宿主的答案，组件不再自己决定有六档。
    expect(ensure).toContain("stops,");
    expect(ensure).toContain("effortStops()");
    // 换模型可能改变列表长度，而列表是构造参数，所以要比对签名后重建。
    expect(ensure).toContain("signature");
    expect(ensure).toContain("effortSliderStops");
    expect(ensure).toContain("destroy()");
    // 组件的提交通知是 `{ index, value, label }`；上线的是 `value`。
    expect(ensure).toContain("commitEffort(detail.value)");
  });

  it("样式表两处都 link 了（应用与演示页看的是同一张卡片）", () => {
    const html = read("index.html");
    expect(html).toContain('href="galaxy-effort.css"');
    const demo = read("galaxy-effort-demo.html");
    expect(demo).toContain('href="./galaxy-effort.css"');
  });
});

describe("两个发送点：组件的提交与 Ctrl+E 循环", () => {
  it("恰好两个 setEffort 发送者，且组件的提交走 onChange", () => {
    const app = read("app.js");
    // The slider no longer has a `change` listener of its own: the component
    // dispatches `effort-change` on commit and this is the single adapter.
    expect(app.match(/cmd: "setEffort"/g)).toHaveLength(2);
    const ensure = bodyOf(app, "function ensureEffortSlider() {");
    expect(ensure).toContain("onChange:");
    expect(ensure).toContain("commitEffort(");
    const commit = bodyOf(app, "function commitEffort(tier) {");
    expect(commit).toContain('cmd: "setEffort"');
    // The cycle lives in the `key === "e"` branch of the shortcut handler.
    const cycle = bodyOf(app, '} else if (key === "e") {');
    expect(cycle).toContain('cmd: "setEffort"');
  });

  it("画到一半的拖动不会发命令（组件只在提交时派发事件）", () => {
    // The component's own contract, asserted in galaxy-effort.test.js: `commit`
    // is the only dispatcher and drags call `setTarget`, not `commit`. Here we
    // only pin the adapter: `ensureEffortSlider` wires exactly one callback,
    // `onChange` on commit — not a per-pixel `input`/`pointermove` of its own.
    const app = read("app.js");
    const ensure = bodyOf(app, "function ensureEffortSlider() {");
    expect(ensure).not.toContain('addEventListener("input"');
    expect(ensure).not.toContain("pointermove");
    expect(ensure.match(/onChange:/g)).toHaveLength(1);
  });

  it("Escape 先关面板并阻止冒泡，不让组件同时把档位拉回 Low", () => {
    const app = read("app.js");
    const block = bodyOf(app, "effortPanel.addEventListener(\"keydown\"");
    // Capture phase: the component's own keydown handler sits on a node this
    // one does not own, so a bubble-phase listener would run after it — the
    // tier would jump to Low and the panel would close on the same key.
    expect(block).toContain("true);");
    expect(block).toContain("stopPropagation()");
    expect(block).toContain("preventDefault()");
    expect(block).toContain("setEffortPanel(false)");
  });
});

describe("减少动态：应用内开关要能传到组件", () => {
  it("构造时传 reducedMotion，且它读的是 data-motion", () => {
    const app = read("app.js");
    const ensure = bodyOf(app, "function ensureEffortSlider() {");
    expect(ensure).toContain("reducedMotion:");
    expect(ensure).toContain('dataset.motion === "reduced"');
  });

  it("data-motion 变化时重建实例（组件看不出非媒体查询的开关）", () => {
    const app = read("app.js");
    // The component only reads `prefers-reduced-motion`; the app's own switch
    // is an attribute. Rebuilding is how the two stay one setting instead of
    // two — see the comment at the MutationObserver.
    const at = app.indexOf('attributeFilter: ["data-motion"]');
    expect(at).toBeGreaterThan(-1);
    // The observer is registered right above the filter it names, so slice
    // backwards to the `new MutationObserver(` that owns it.
    const start = app.lastIndexOf("new MutationObserver(", at);
    expect(start).toBeGreaterThan(-1);
    const block = app.slice(start, at);
    expect(block).toContain("destroy()");
    expect(block).toContain("ensureEffortSlider()");
  });
});
describe("思考强度始终显示；不支持时靠说明，不靠隐藏（2026-11-09 用户决定）", () => {
  it("模型未声明支持时只剩一档，芯片仍在，标签来自宿主那一条 stop", () => {
    const app = read("app.js");
    // 2026-11-09 用户决定：自适应映射 +「只剩一档，拖不动」。
    // 控件不消失（「思考强度应该始终显示」仍然成立），拖不动就说明一切。
    const body = bodyOf(app, "function syncEffortControl() {");
    expect(body).toContain("effortStops().length === 0");
    expect(body).toContain("effortControl.hidden");
    const stops = bodyOf(app, "function effortStops() {");
    expect(stops).toContain("state.effortChoices");
    expect(stops).toContain("stops");
    // 芯片的字来自宿主那一条档位的 label，不再由渲染层拼。
    const chip = bodyOf(app, "function effortChipLabel() {");
    expect(chip).toContain("stops[index].label");
    // 没有 `auto` 那一格之后，「没选过」不能再拿第一档的名字冒充 ——
    // 芯片要说 `Auto`，那是词不是档位（2026-11-10）。
    expect(chip).toContain('state.effort === "auto"');
    expect(chip).toContain("t.effortAuto");
    // Markup starts hidden: before the host has spoken there is nothing to
    // paint, and a slider shown at that moment would be a guess.
    const html = read("index.html");
    const tag = html.slice(html.indexOf('id="effort-control"') - 40, html.indexOf('id="effort-control"') + 40);
    expect(tag).toContain("hidden");
  });

  it("隐藏时 setEffort 仍然跑到，所以状态不会只画一半", () => {
    const app = read("app.js");
    const body = bodyOf(app, "function setEffort(effort) {");
    expect(body).toContain("syncEffortControl()");
    expect(body).toContain("renderEffortPanel()");
  });

  it("控件隐藏时面板跟着收起，换回推理模型不会自动弹开", () => {
    const app = read("app.js");
    const body = bodyOf(app, "function syncEffortControl() {");
    expect(body).toContain('$("effort-panel").hidden = true');
    expect(body).toContain('setAttribute("aria-expanded", "false")');
  });

  it("宿主拒绝时把滑块拉回已确认的档位，不让拇指停在拖到的位置", () => {
    // A refused `setEffort` answers with a warn and no `state`. Without this
    // the thumb stays where the drag left it while the next request carries
    // the old tier — the same "shows a value the request does not carry" lie
    // the old dropdown was fixed for.
    const app = read("app.js");
    const commit = bodyOf(app, "function commitEffort(tier) {");
    expect(commit).toContain("effortPending = true");
    const notice = bodyOf(app, 'case "notice":');
    expect(notice).toContain("effortPending");
    expect(notice).toContain("renderEffortPanel()");
    // Guarded on the flag, so an unrelated notice cannot yank a thumb the
    // user is still dragging.
    expect(notice).toContain("if (effortPending)");
    // A `state` answer settles it either way.
    const setEffortBody = bodyOf(app, "function setEffort(effort) {");
    expect(setEffortBody).toContain("effortPending = false");
  });

});

describe("思考强度这一块两种语言都是英文（2026-11-09 用户决定）", () => {
  /**
   * 用户原话：「思考强度用英文，不用自动翻译」。
   *
   * 曾经 zh 字典里有一套中文名（低 / 中 / 高 / 加强 / 极强 / 星系），是上一轮
   * 子代理自己定的。问题不在翻译质量，在**同一档在三个地方有三个名字**：
   * 规格表写 Low…Galaxy，`run.json` 存 `low`…`galaxy`，`providers.json` 的
   * `effortMap` 键也是英文，只有界面显示中文。改成一个名字之后，界面、日志与
   * 配置说的是同一句话。
   *
   * 所以这组断言与「别的文案都要翻译」相反：这里要求 zh 与 en **逐字相同**。
   * 谁把它们翻成中文，这两条会红。
   *
   * **2026-11-10 起档位名不在字典里了**：标签由宿主的 `stops[i].label` 给出，
   * 六个 `effortTier*` 键随之删除。这里只剩控件自己仍在读的三条
   * （`effortAuto` / `effortLabel` / `effortSends`）——它们仍是英文，理由不变。
   */
  /** 控件里会渲染出来的每一项（不含 `effortSends`，那是一个函数）。 */
  const EFFORT_KEYS = ["effortAuto", "effortLabel"];

  const CJK = /[㐀-鿿＀-￯]/;

  it("zh 的每一个思考强度键都与 en 逐字相同", () => {
    for (const key of EFFORT_KEYS) {
      expect(dictionaries.zh[key], `zh.${key} 应当与 en 相同`).toBe(dictionaries.en[key]);
    }
    expect(dictionaries.zh.effortSends("high")).toBe(dictionaries.en.effortSends("high"));
  });

  it("这些键的值里没有中日韩字符（「不用自动翻译」的可执行形式）", () => {
    // 逐字相同只能抓「翻了但翻得一样」以外的情形；这一条抓的是「有人只改了
    // zh 那一份」。字符串里出现中文就是被翻译过了。
    for (const locale of ["en", "zh"]) {
      for (const key of EFFORT_KEYS) {
        expect(
          CJK.test(dictionaries[locale][key]),
          `${locale}.${key} 里出现了中文：${dictionaries[locale][key]}`,
        ).toBe(false);
      }
    }
  });

  it("档位名不是字典条目：六个 effortTier* 键已随标签改由宿主提供而删除", () => {
    for (const locale of ["en", "zh"]) {
      for (const tier of EFFORT_TIERS) {
        const key = `effortTier${tier[0].toUpperCase()}${tier.slice(1)}`;
        expect(Object.hasOwn(dictionaries[locale], key), `${locale}.${key}`).toBe(false);
      }
    }
  });

  it("芯片标签取宿主给的那一条 stop，不自己拼", () => {
    const app = read("app.js");
    const chip = bodyOf(app, "function effortChipLabel() {");
    // 2026-11-09：档位名来自宿主的 `stops[i].label`。渲染层不再有自己的
    // 词汇表，也就没有「两张表漂移」这件事可说。
    expect(chip).toContain("effortStops()");
    expect(chip).toContain(".label");
    expect(app).not.toContain("EFFORT_TIER_LABELS");
    // 切语言仍要重画：`sends high` 那句还在字典里，换语言时重新走一遍。
    const applyLocale = bodyOf(app, "function applyLocale(locale, { announce = false } = {}) {");
    expect(applyLocale).toContain("setEffort(state.effort)");
  });
});

describe("轨道固定六格（2026-11-10 用户决定：永远六格，映射做适配）", () => {
  it("宿主不再按发出去的值去重，六格全在", () => {
    const host = readFileSync(path.join(ROOT, "desktop", "host", "host.js"), "utf8");
    const body = bodyOf(host, "function effortChoices() {");
    // 以前是 `if (seen.has(sends)) continue;` —— 按值去重会让轨道长度随模型
    // 变化。固定尺度的做法是每格都画，把「这格发什么」放进 `sends`。
    expect(body).not.toContain("seen.has(sends)");
    expect(body).toContain("for (const tier of kernel.EFFORT_TIERS)");
    expect(body).toContain("sends:");
  });
});

describe("映射结果显示：三档默认落同一值时必须说出来", () => {
  it("宿主算的 resolved 被渲染层读了，而不是自己再算一遍", () => {
    const app = read("app.js");
    const body = bodyOf(app, "function renderEffortPanel() {");
    // The host folds a tier through the model's `effortMap`; deriving the same
    // answer here would be a second source of truth for one question.
    expect(body).toContain("choices.resolved?.");
    expect(body).toContain("t.effortSends");
  });

  it("只在映射值与档位名不同时才显示（同名时不重复说一遍）", () => {
    const app = read("app.js");
    const body = bodyOf(app, "function renderEffortPanel() {");
    // `low` sends `low`; printing "Low · sends low" would be noise.
    expect(body).toContain("resolved !== state.effort");
  });

  it("那句话带上真正要发的值，且两种语言说的是同一句", () => {
    for (const locale of ["en", "zh"]) {
      const text = dictionaries[locale].effortSends("high");
      expect(typeof text, locale).toBe("string");
      expect(text).toContain("high");
      expect(text.trim()).not.toBe("high");
    }
    // 三档默认落到同一个 high；这句话是滑块不假装有三种强度的那一半。
    // 它与档位名同属「思考强度用英文」的范围，所以两种语言逐字相同。
    expect(dictionaries.zh.effortSends("high")).toBe(dictionaries.en.effortSends("high"));
  });
});
