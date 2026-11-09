import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EFFORT_TIERS as KERNEL_TIERS } from "../../src/config/providers.js";
import { dictionaries } from "../../desktop/renderer/i18n.js";
import {
  EFFORT_TIERS,
  EFFORT_TIER_LABELS,
  effortTierAt,
  effortTierIndex,
} from "../../desktop/renderer/effort-tiers.js";

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

/** The CSS section that styles the slider, from its comment to the end of the
 *  motion overrides. Sliced so the token/colour and motion assertions below
 *  cannot be satisfied by some unrelated rule elsewhere in the file. */
function effortCss() {
  const css = read("styles.css");
  const start = css.indexOf("/* The six-tier panel.");
  expect(start, "the effort panel's style block is missing").toBeGreaterThan(-1);
  const end = css.indexOf(':root[data-motion="reduced"] .effort-particles', start);
  expect(end, "the effort panel's style block has no end marker").toBeGreaterThan(start);
  return css.slice(start, end + 200);
}

describe("六档常量与内核一致", () => {
  it("渲染层的 EFFORT_TIERS 与 src/config/providers.ts 逐项相同", () => {
    // The renderer cannot import the TypeScript constant (no bundler), so it
    // keeps its own copy. This import is the pin that keeps the copy honest:
    // add a tier in one place only and this fails.
    expect(EFFORT_TIERS).toStrictEqual([...KERNEL_TIERS]);
  });

  it("EFFORT_TIER_LABELS 有六个，且与 EFFORT_TIERS 同序", () => {
    expect(EFFORT_TIER_LABELS).toHaveLength(6);
    expect(EFFORT_TIERS).toHaveLength(6);
    expect(EFFORT_TIER_LABELS).toStrictEqual(["Low", "Medium", "High", "Extra", "Max", "Galaxy"]);
    // Order is the contract, not membership: the track reads left to right, so
    // a reordered list would relabel every stop.
    expect(EFFORT_TIERS).toStrictEqual(["low", "medium", "high", "extra", "max", "galaxy"]);
  });
});

describe("档位与索引互逆，越界钳位", () => {
  it("每一档的索引就是它在轨道上的位置", () => {
    EFFORT_TIERS.forEach((tier, index) => {
      expect(effortTierIndex(tier)).toBe(index);
    });
  });

  it("索引 → 档位是档位 → 索引的逆", () => {
    EFFORT_TIERS.forEach((tier) => {
      expect(effortTierAt(effortTierIndex(tier))).toBe(tier);
    });
  });

  it("不是档位的值得到 -1，不是 0", () => {
    // `auto` and a protocol-only level (`minimal`) are the absence of a tier,
    // not the low end. Returning 0 would light "Low" for a request that sends
    // nothing of the sort.
    for (const value of ["auto", "minimal", "none", "", null, undefined, 3]) {
      expect(effortTierIndex(value), String(value)).toBe(-1);
    }
  });

  it("越界索引钳到两端，NaN 落到低端", () => {
    expect(effortTierAt(-1)).toBe("low");
    expect(effortTierAt(-99)).toBe("low");
    expect(effortTierAt(6)).toBe("galaxy");
    expect(effortTierAt(99)).toBe("galaxy");
    // A range always hands over an integer string, but a malformed value must
    // not paint `undefined` into a label.
    expect(effortTierAt("3")).toBe("extra");
    expect(effortTierAt(Number.NaN)).toBe("low");
  });

  it("钳位是写明了的决定，不是静默兜底", () => {
    // The acceptance row asks for the clamp to be explicit. The code says so
    // in `effortTierAt`'s own doc comment, where the next reader will look.
    const source = read("effort-tiers.js");
    const doc = bodyOf(source, "export function effortTierAt(index)");
    const comment = source.slice(source.indexOf("/**", source.indexOf("export function effortTierAt") - 1200),
      source.indexOf("export function effortTierAt"));
    expect(comment.toLowerCase()).toContain("clamp");
    expect(doc).toContain("Math.min(");
    expect(doc).toContain("Math.max(");
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

  it("面板里是组件的挂载点，Auto 与说明句在卡片之外", () => {
    const html = read("index.html");
    // The component builds its own DOM inside this element; nothing here may
    // duplicate the card's internals, or there would be two tracks.
    expect(html).toContain('id="effort-galaxy-mount"');
    expect(html).toContain('id="effort-auto"');
    expect(html).toContain('id="effort-note"');
    // `auto` is the absence of a tier, so it must not be a stop on the track —
    // hence a button beside the card, not a seventh label inside it.
    expect(html).not.toContain("effort-auto-hint\" hidden");
    const mountAt = html.indexOf('id="effort-galaxy-mount"');
    const autoAt = html.indexOf('id="effort-auto"');
    expect(autoAt).toBeGreaterThan(mountAt);
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
    expect(css).toContain("--ge-scale: 0.68");
    expect(css).toContain("#effort-galaxy-mount");
    // transform 不改变父级布局盒：不给占位尺寸的话，弹层会按 440×258 留白。
    // 高度不写死 —— 声明句多长它就得长多高，由 `layoutEffortNote()` 量出来写。
    const mount = css.slice(css.indexOf("#effort-galaxy-mount {"), css.indexOf("}", css.indexOf("#effort-galaxy-mount {")));
    expect(mount).toContain("width: 300px");
    const layout = bodyOf(app, "function layoutEffortNote() {");
    expect(layout).toContain("offsetHeight");
    expect(layout).toContain("mount.style.height");
    expect(layout).toContain("card.style.minHeight");
    // 组件那一侧只认变量、有自己的默认值，演示页因此仍是 1:1。
    const galaxy = read("galaxy-effort.css");
    expect(galaxy).toContain("scale(var(--ge-scale, 1))");
    expect(galaxy).toContain("width: 440px");
    expect(galaxy).toContain("height: 258px");
    // 缩放系数只能有一处定义。app.js 读数（占位高度要乘它），但那必须是
    // 从样式里读，不能自己再写一个 0.68 —— 两份数字迟早会分家。
    expect(app).toContain('getPropertyValue("--ge-scale")');
    // Strip comments first: the code may *talk* about 0.68, but it must not
    // compute with it. Searching the raw text would fail on the explanation.
    const code = app.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code.match(/0\.68/g) ?? []).toHaveLength(0);
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
  it("模型未声明支持时滑块仍在（宿主始终报六档）", () => {
    const app = read("app.js");
    const body = bodyOf(app, "function syncEffortControl() {");
    // The chip hides only when there is no model at all — `levels` empty for
    // real means the host said "no model", not "this model takes no effort".
    expect(body).toContain("effortLevels().length === 0");
    expect(body).toContain("effortControl.hidden");
    // `effortLevels()` is `state.effortChoices.levels` — the host's answer,
    // not a local list.
    const levels = bodyOf(app, "function effortLevels() {");
    expect(levels).toContain("state.effortChoices");
    expect(levels).toContain("levels");
    // Markup starts hidden: before the host has spoken there is nothing to
    // paint, and a slider shown at that moment would be a guess.
    const html = read("index.html");
    const tag = html.slice(html.indexOf('id="effort-control"') - 40, html.indexOf('id="effort-control"') + 40);
    expect(tag).toContain("hidden");
  });

  it("不支持时那条说明画在面板里，滑块不被收起", () => {
    const app = read("app.js");
    const body = bodyOf(app, "function renderEffortPanel() {");
    // The note is the disclosure channel; it is painted from the host's answer
    // and reaches `#effort-note` whether or not the model declared support.
    expect(body).toContain("choices.note");
    expect(body).toContain("effort-note");
    // Nothing in this function hides the control on `unsupported`.
    expect(body).not.toContain("effortControl.hidden");
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

  it("原因沿用宿主的 note 措辞，画在面板里", () => {
    const app = read("app.js");
    const body = bodyOf(app, "function renderEffortPanel() {");
    expect(body).toContain("choices.note");
    expect(body).toContain("effort-note");
    // `fixed` (a model locked to one level) reuses the existing sentence
    // rather than inventing a second one.
    expect(body).toContain("t.effortFixed");
    const html = read("index.html");
    expect(html).toContain('id="effort-note"');
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
   */
  const TIER_BY_LABEL = {
    Low: "effortTierLow",
    Medium: "effortTierMedium",
    High: "effortTierHigh",
    Extra: "effortTierExtra",
    Max: "effortTierMax",
    Galaxy: "effortTierGalaxy",
  };

  /** 控件里会渲染出来的每一项（不含 `effortSends`，那是一个函数）。 */
  const EFFORT_KEYS = [
    ...Object.values(TIER_BY_LABEL),
    "effortAuto",
    "effortLow",
    "effortMedium",
    "effortHigh",
    "effortLabel",
    "effortFixed",
  ];

  const CJK = /[㐀-鿿＀-￯]/;

  it("每套字典都有六个档位，且都不为空", () => {
    for (const locale of ["en", "zh"]) {
      for (const label of EFFORT_TIER_LABELS) {
        const key = TIER_BY_LABEL[label];
        const text = dictionaries[locale][key];
        expect(typeof text, `${locale}.${key}`).toBe("string");
        expect(text.trim(), `${locale}.${key}`).not.toBe("");
      }
    }
  });

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

  it("六个档位名互不相同（两种语言都一样）", () => {
    for (const locale of ["en", "zh"]) {
      const names = EFFORT_TIER_LABELS.map((label) => dictionaries[locale][TIER_BY_LABEL[label]]);
      expect(new Set(names).size, `${locale} has duplicate tier names`).toBe(6);
    }
  });

  it("芯片标签直接取英文常量，不经过字典（这一块整体不翻译）", () => {
    const app = read("app.js");
    const label = bodyOf(app, "function effortTierLabel(index) {");
    // 2026-11-09：`effortTier*` 这组字典键已随「思考强度用英文」一起退场，
    // 名字只剩一个来源 —— `EFFORT_TIER_LABELS`。再走一次 `t[...]` 就等于把
    // 一个逐字相同的查表留在热路径上，且给了它第二次漂移的机会。
    expect(label).toContain("EFFORT_TIER_LABELS");
    expect(label).not.toContain("t[");
    // 切语言仍要重画：`Auto` 与「sends high」那句还在字典里（两套都是英文，
    // 但换语言时重新走一遍 setEffort 才不依赖「值恰好没变」）。
    const applyLocale = bodyOf(app, "function applyLocale(locale, { announce = false } = {}) {");
    expect(applyLocale).toContain("setEffort(state.effort)");
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
