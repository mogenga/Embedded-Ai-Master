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

describe("<input type=\"range\"> 是无障碍底座", () => {
  it("index.html 里有 range 的六格刻度，且带 aria-label", () => {
    const html = read("index.html");
    const start = html.indexOf('id="effort-range"');
    expect(start, "#effort-range missing").toBeGreaterThan(-1);
    const tagStart = html.lastIndexOf("<input", start);
    const tag = html.slice(tagStart, html.indexOf("/>", start) + 2);
    // Whitespace-normalised: the attributes are split across lines for width.
    expect(tag.replace(/\s+/g, " ")).toContain('type="range" min="0" max="5" step="1"');
    expect(tag).toContain('aria-label="');
    // The stop count is the tier count; a 7th stop would silently mislabel.
    expect(Number(tag.match(/max="(\d+)"/)[1])).toBe(EFFORT_TIERS.length - 1);
  });

  it("#effort-control 的 id 保留，旧的 #effort-menu 不再存在", () => {
    const html = read("index.html");
    expect(html).toContain('id="effort-control"');
    expect(html).toContain('id="effort-panel"');
    expect(html).not.toContain('id="effort-menu"');
    const app = read("app.js");
    expect(app).not.toContain('$("effort-menu")');
    expect(app).not.toContain("renderEffortMenu");
  });

  it("六个档位标签都在面板里，且都带 data-tier-index", () => {
    const html = read("index.html");
    for (let index = 0; index < EFFORT_TIERS.length; index += 1) {
      expect(html, `stop ${index}`).toContain(`data-tier-index="${index}"`);
    }
    expect(html).toContain('data-i18n="effortTierGalaxy"');
  });

  it("轨道可视化由 --tier 驱动，且不接指针事件", () => {
    const app = read("app.js");
    expect(app).toContain('setProperty("--tier"');
    const css = effortCss();
    expect(css).toContain("var(--tier");
    // The visual layer sits under the real input; taking pointer events would
    // make the thumb undraggable.
    const visual = css.slice(css.indexOf(".effort-visual {"), css.indexOf(".effort-rail {"));
    expect(visual).toContain("pointer-events: none");
  });
});

describe("不自绘键盘处理，方向键交给原生 range", () => {
  it("滑块只有一个发送点；另一个发送者是 Ctrl+E 循环，不是方向键", () => {
    const app = read("app.js");
    // Two senders exist and no more: the slider's `commitEffort` and the
    // long-standing Ctrl+E cycle. Neither is an ArrowLeft/ArrowRight branch.
    expect(app.match(/cmd: "setEffort"/g)).toHaveLength(2);
    const commit = bodyOf(app, "function commitEffort(tier) {");
    expect(commit).toContain('cmd: "setEffort"');
    // The cycle's sender lives in the `key === "e"` branch of the shortcut
    // handler; pin it there so a future "make arrows work by hand" edit has to
    // move an assertion rather than slip in.
    const cycle = bodyOf(app, '} else if (key === "e") {');
    expect(cycle).toContain('cmd: "setEffort"');

    const calls = [...app.matchAll(/commitEffort\(/g)].map((match) => match.index);
    // One definition plus one call per listener: `change` on the range and
    // `click` on the auto button.
    expect(calls).toHaveLength(3);
    const rangeChange = app.indexOf('effortRange.addEventListener("change"');
    const autoClick = app.indexOf('$("effort-auto").addEventListener("click"');
    expect(rangeChange).toBeGreaterThan(-1);
    expect(autoClick).toBeGreaterThan(-1);
    const callSites = calls.slice(1);
    for (const site of callSites) {
      const inside =
        (site > rangeChange && site < rangeChange + 300) || (site > autoClick && site < autoClick + 300);
      expect(inside, `commitEffort at ${site} is outside a change/click listener`).toBe(true);
    }
  });

  it("effort 的 keydown 分支不处理 ArrowLeft / ArrowRight", () => {
    const app = read("app.js");
    const block = bodyOf(app, 'effortControl.addEventListener("keydown"');
    expect(block).not.toContain("ArrowLeft");
    expect(block).not.toContain("ArrowRight");
    // Escape is the only key it takes: a panel that traps Escape would sit on
    // top of the composer until the user clicked elsewhere.
    expect(block).toContain('"Escape"');
  });

  it("range 的 input 只重绘 ramp，不发命令（拖动不会排队上百条 setEffort）", () => {
    const app = read("app.js");
    const input = bodyOf(app, 'effortRange.addEventListener("input"');
    expect(input).toContain("paintEffortTrack(");
    expect(input).not.toContain("commitEffort(");
    expect(input).not.toContain('cmd: "setEffort"');
  });
});

describe("降低动效时关掉粒子与脉动", () => {
  it("有一段 prefers-reduced-motion: reduce 覆盖粒子与光晕", () => {
    const css = effortCss();
    const start = css.indexOf("@media (prefers-reduced-motion: reduce)");
    expect(start, "no reduced-motion block in the slider's styles").toBeGreaterThan(-1);
    const block = css.slice(start, css.indexOf("\n}", css.indexOf(".effort-lit", start)) + 2);
    expect(block).toContain(".effort-particles");
    expect(block).toContain("animation: none");
    expect(block).toContain(".effort-glow");
    // The particles are hidden outright, not merely stopped: a frozen dot is
    // still decoration the setting asked not to see.
    expect(block).toContain("display: none");
  });

  it("脉动与漂浮动画确实只挂在最高档上", () => {
    const css = effortCss();
    const pulse = css.slice(css.indexOf(".effort-panel[data-tier=\"5\"] .effort-glow"));
    expect(pulse.slice(0, 200)).toContain("animation: effort-pulse");
    const particles = css.slice(css.indexOf('.effort-panel[data-tier="5"] .effort-particles'));
    expect(particles.slice(0, 200)).toContain("opacity: 1");
    // Below the top tier the particles layer is transparent, so no drifting
    // dot draws at Low..Max.
    expect(css).toContain(".effort-particles {\n  position: absolute;\n  inset: 0;\n  opacity: 0;");
    expect(css).toContain("@keyframes effort-pulse");
    expect(css).toContain("@keyframes effort-drift");
  });

  it("CSS 只用设计令牌，没有写死颜色", () => {
    // The stylesheet's header says literal values are allowed only in the
    // token block. A hex colour here would also break the light themes.
    const css = effortCss();
    const offenders = css.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    // Two exceptions, both inside the dot layer's mask gradient: a mask's
    // middle stop has to be fully opaque, and there is no token for "opaque".
    expect(offenders).toStrictEqual(["#000", "#000", "#000", "#000"]);
    // Everything that paints — rail, lit segment, dots, glow, particles, thumb
    // — goes through a token.
    expect(css).toContain("background: var(--surface)");
    expect(css).toContain("var(--accent)");
    expect(css).toContain("var(--accent-text)");
    expect(css).toContain("var(--accent-soft)");
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

  it("app.js 通过同一个键模式取名字，两种语言切换后标签跟着换", () => {
    const app = read("app.js");
    expect(app).toContain("effortTier${fallback}");
    // The chip's label and the panel's stops are repainted from `t` on every
    // locale change, not left as whatever the DOM was born with. The repaint
    // goes through `setEffort`, which also rewrites the chip text.
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
