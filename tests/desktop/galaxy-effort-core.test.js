import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  FOLD_LEVELS,
  PIXEL_PALETTE,
  TIER_NAMES,
  TRACK_PALETTES,
  clamp,
  foldReveal,
  foldVisibleCount,
  galaxyState,
  hash01,
  stepSpring,
  tierIndex,
  tierName,
  trackFillOpacity,
  trackFillStops,
  trackX,
} from "../../desktop/renderer/galaxy-effort-core.js";

/**
 * 脑形滑块的纯函数核心（`docs/specs/galaxy-effort-slider.md` §2 / §4 / §5）。
 *
 * 仓库没有 jsdom，也不打算为此引入依赖，所以这个组件能被自动验证的部分就是这些：
 * 弹簧会不会停、褶皱在某一档该露出几条、轨道前缘取的是哪两组色板、Galaxy 的
 * 爆发怎么衰减。视觉结果（脑形怎么长出来、粒子怎么闪）只有真实窗口能看见，
 * 那部分不在这里假装覆盖。
 *
 * 断言里的数字分成两类，故意区分开：一类是从规格原文抄来的**字面值**（2/4/6/8/12/16、
 * 四组色板、六档名），改它们等于改验收标准；另一类是**从常量推导**的期望
 * （例如 16 条路径 = 2 + Σ paths×2），它们跟着数据结构走，不会在表被改动后
 * 悄悄说旧话。
 */

const SOURCE = readFileSync(
  path.join(import.meta.dirname, "..", "..", "desktop", "renderer", "galaxy-effort-core.js"),
  "utf8",
);

/**
 * 去掉注释后的源码。
 *
 * 注释里提到 `document` 是在**解释**为什么不能碰它，不是碰了它。按纯文本搜索会
 * 把说明文字当成违规，于是唯一让检查变绿的办法是删掉解释——那正好删掉了最有用的
 * 部分。这里先剥注释再搜，搜的才是代码。
 */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

describe("常量是规格的逐字抄写", () => {
  it("六档名与轨道的六格同序", () => {
    expect(TIER_NAMES).toStrictEqual(["Low", "Medium", "High", "Extra", "Max", "Galaxy"]);
  });

  it("FOLD_LEVELS 与规格 §2 的 JSON 逐项相同", () => {
    expect(FOLD_LEVELS).toStrictEqual([
      { level: 1, width: 2.8, paths: ["M29 25Q28 21 24 21C20 21 18 17 21 14"] },
      { level: 2, width: 2.6, paths: ["M28 42C23 39 19 41 20 45Q21 48 25 47"] },
      { level: 3, width: 2.5, paths: ["M12 28C15 25 19 26 20 29Q21 33 17 34"] },
      { level: 4, width: 2.2, paths: ["M21 21Q18 19 15 22", "M20 53Q24 55 27 51"] },
      { level: 5, width: 1.9, paths: ["M10 36Q13 34 16 37", "M24 35Q27 37 25 40"] },
    ]);
  });

  it("TRACK_PALETTES 是四组五色标，首标四组都是 #312a2d 的 (49,42,45)", () => {
    expect(TRACK_PALETTES).toStrictEqual([
      [[49, 42, 45], [86, 57, 76], [125, 73, 112], [161, 89, 146], [175, 94, 157]],
      [[49, 42, 45], [81, 55, 76], [112, 69, 107], [143, 83, 139], [153, 87, 150]],
      [[49, 42, 45], [78, 56, 74], [108, 69, 110], [129, 84, 149], [136, 90, 163]],
      [[49, 42, 45], [77, 56, 74], [102, 67, 111], [118, 84, 153], [124, 90, 167]],
    ]);
    // 左侧始终保持暗灰紫是规格 §4 的明文要求，所以四组的第一标必须是同一个颜色——
    // 哪天有人给某组单独改首标，低档位就会在起点处跳色。
    for (const palette of TRACK_PALETTES) expect(palette).toHaveLength(5);
    expect(new Set(TRACK_PALETTES.map((palette) => palette[0].join(","))).size).toBe(1);
  });

  it("PIXEL_PALETTE 是规格 §5 的六个十六进制色", () => {
    expect(PIXEL_PALETTE).toStrictEqual([
      "#80d5d8", "#dc8cd5", "#b3a3e8", "#7061b5", "#f4c1eb", "#6656a0",
    ]);
  });

  it("import 时不碰 DOM（顶层只有常量与函数声明）", () => {
    // 本文件的顶层 import 已经证明了这一点；这条断言防的是以后有人往模块顶层
    // 加一句 `document.createElement` —— 那会让所有静态 import 这个模块的测试炸掉。
    for (const name of ["document", "window", "requestAnimationFrame"]) {
      expect(CODE, name).not.toContain(name);
    }
  });
});

describe("clamp / tierIndex / tierName / trackX", () => {
  it("clamp 两端都钳，中间原样", () => {
    expect(clamp(-1, 0, 5)).toBe(0);
    expect(clamp(6, 0, 5)).toBe(5);
    expect(clamp(2.5, 0, 5)).toBe(2.5);
    // 值本身就在区间内时也要返回**同一个数**，不能因为走了一遍 min/max 就变形。
    expect(clamp(0, 0, 5)).toBe(0);
    expect(clamp(5, 0, 5)).toBe(5);
  });

  it("tierIndex 取最近的档，超出轨道钳到两端", () => {
    expect(tierIndex(0)).toBe(0);
    expect(tierIndex(0.4)).toBe(0);
    // 半格就换档：脑形停在正中时标签必须已经往右一格，否则标签比位置慢半拍。
    expect(tierIndex(0.5)).toBe(1);
    expect(tierIndex(2.5)).toBe(3);
    expect(tierIndex(5)).toBe(5);
    expect(tierIndex(-2)).toBe(0);
    expect(tierIndex(9)).toBe(5);
  });

  it("tierName 覆盖六档，越界与畸形值都钳到两端", () => {
    TIER_NAMES.forEach((name, index) => expect(tierName(index)).toBe(name));
    expect(tierName(-1)).toBe("Low");
    expect(tierName(99)).toBe("Galaxy");
    // 标签里绝不能出现 `undefined`（R3）：NaN 落到 Low，而不是打印一个空档。
    expect(tierName(Number.NaN)).toBe("Low");
    expect(tierName(2.7)).toBe("Extra");
  });

  it("trackX 是 16 + position/5×358，两端与中点对得上刻度", () => {
    expect(trackX(0)).toBe(16);
    expect(trackX(5)).toBe(374);
    expect(trackX(2.5)).toBe(195);
    // 六个刻度圆点的横坐标来自同一条映射（规格 §1：16 + i×358/5）。
    // 逐个 toBeCloseTo 而不是整体 toStrictEqual：这一串是二进制不能精确表示的小数
    // （87.6 算出来是 87.60000000000001），逐位相等只会钉住浮点尾数。
    const stops = [0, 1, 2, 3, 4, 5].map(trackX);
    [16, 87.6, 159.2, 230.8, 302.4, 374].forEach((expected, index) => {
      expect(stops[index], `stop ${index}`).toBeCloseTo(expected, 9);
    });
    // 越界钳位：轨道外的手指位置不该把脑形推出去。
    expect(trackX(-3)).toBe(16);
    expect(trackX(8)).toBe(374);
  });
});

describe("foldReveal 的展开窗口", () => {
  it("第 1 层在 0.15～0.85 之间展开，两端正好是 0 与 1", () => {
    // 规格 §4 逐字：「第 1 层在 0.15 到 0.85 展开」。
    expect(foldReveal(0.15, 1)).toBe(0);
    expect(foldReveal(0.85, 1)).toBe(1);
    expect(foldReveal(0.15, 1)).toBe(0);
    // 窗口正中是 smoothstep 的对称点，值是 .5。
    expect(foldReveal(0.5, 1)).toBeCloseTo(0.5, 12);
  });

  it("停在六档时：第 1 档只开第 1 层，第 2 层为 0", () => {
    expect(foldReveal(1, 1)).toBe(1);
    expect(foldReveal(1, 2)).toBe(0);
    expect(foldReveal(1, 3)).toBe(0);
  });

  it("停在 Galaxy 时五层全开", () => {
    for (const tier of FOLD_LEVELS) expect(foldReveal(5, tier.level)).toBe(1);
  });

  it("每一层的窗口是 level-0.85 → level-0.15，起点前与终点后都饱和", () => {
    // 规格 §4 的例子：「第 2 层在 1.15 到 1.85 展开」。窗口宽 0.7（公式里的分母），
    // 所以终点是 level-0.15 而不是 level+0.15；再往后只是钳在 1 上。
    for (const tier of FOLD_LEVELS) {
      // 下沿用 toBeCloseTo：`level - 0.85` 在二进制里落不到精确的 0（第 5 层算出来
      // 是 6.8e-31），那是浮点尾数，不是没钳住。
      expect(foldReveal(tier.level - 0.85, tier.level), `level ${tier.level}`).toBeCloseTo(0, 10);
      expect(foldReveal(tier.level - 0.15, tier.level), `level ${tier.level}`).toBe(1);
      // 起点再往前、终点再往后都必须是平的：窗口之外还在动，就意味着两层会同时
      // 半透明地叠在一起。
      expect(foldReveal(tier.level - 1.2, tier.level), `level ${tier.level}`).toBe(0);
      expect(foldReveal(tier.level + 0.5, tier.level), `level ${tier.level}`).toBe(1);
    }
  });

  it("六档之间的窗口互不重叠（最多只有一层在生长）", () => {
    // 第 N 层在 N-0.15 收笔，第 N+1 层要到 N+0.15 才起笔，中间空 0.3。
    for (let level = 1; level < FOLD_LEVELS.length; level += 1) {
      const gap = (level + 0.15) - (level - 0.15);
      expect(gap).toBeCloseTo(0.3, 12);
      for (let p = level - 0.15; p <= level + 0.15; p += 0.01) {
        expect(foldReveal(p, FOLD_LEVELS[level - 1].level), `level ${level} at ${p.toFixed(2)}`).toBe(1);
        expect(foldReveal(p, FOLD_LEVELS[level].level), `level ${level + 1} at ${p.toFixed(2)}`).toBe(0);
      }
    }
  });

  it("随位置单调不减，值域始终在 [0, 1]", () => {
    for (const tier of FOLD_LEVELS) {
      let previous = -1;
      for (let p = 0; p <= 5; p += 0.01) {
        const reveal = foldReveal(p, tier.level);
        expect(reveal, `level ${tier.level} at ${p.toFixed(2)}`).toBeGreaterThanOrEqual(previous);
        expect(reveal).toBeGreaterThanOrEqual(0);
        expect(reveal).toBeLessThanOrEqual(1);
        previous = reveal;
      }
    }
  });

  it("回拉对称：拖过去再拖回来，同一位置给出同一个值", () => {
    // 规格 §4「回拉用相同公式反向收回」。这里真的走一遍：先 0→5 记录每格，
    // 再 5→0 记录一次，逐点比对。写成 `f(p, l) === f(p, l)` 是自证，什么都测不到。
    const STEPS = 50;
    const forward = new Map();
    for (let i = 0; i <= STEPS; i += 1) {
      const p = (i / STEPS) * 5;
      forward.set(p, foldReveal(p, 3));
    }
    for (let i = STEPS; i >= 0; i -= 1) {
      const p = (i / STEPS) * 5;
      expect(foldReveal(p, 3), `p=${p}`).toBe(forward.get(p));
    }
  });

  it("越界位置钳到轨道两端，不会算出负的 reveal", () => {
    expect(foldReveal(-5, 1)).toBe(0);
    expect(foldReveal(9, 5)).toBe(1);
  });
});

describe("foldVisibleCount：六档 2/4/6/8/12/16 条路径", () => {
  it("停在六档时分别是 2、4、6、8、12、16", () => {
    // 规格 §4 的字面值。含左右两条基础复合路径，不计脑形轮廓。
    expect([0, 1, 2, 3, 4, 5].map(foldVisibleCount)).toStrictEqual([2, 4, 6, 8, 12, 16]);
  });

  it("16 这个数是算出来的，不是查表：2 + Σ paths×2", () => {
    // 这张表一旦加一层或给某层加一条路径，上面那条断言就该跟着变；这里的等式
    // 让"变"是可解释的，而不是让实现去迁就一个旧数字。
    const fromData = 2 + FOLD_LEVELS.reduce((sum, tier) => sum + tier.paths.length * 2, 0);
    expect(foldVisibleCount(5)).toBe(fromData);
    expect(fromData).toBe(16);
  });

  it("计数在相邻两档的正中切换，拖到一半就已经算作下一档", () => {
    // reveal = .5 恰好落在 position = level - .5，也就是相邻两档的中点。
    expect(foldVisibleCount(0.4999)).toBe(2);
    expect(foldVisibleCount(0.5)).toBe(4);
    expect(foldVisibleCount(1.4999)).toBe(4);
    expect(foldVisibleCount(1.5)).toBe(6);
    expect(foldVisibleCount(2.5)).toBe(8);
    expect(foldVisibleCount(3.5)).toBe(12);
    expect(foldVisibleCount(4.5)).toBe(16);
  });

  it("两端之外不越界（拖出轨道不会多出路径）", () => {
    expect(foldVisibleCount(-1)).toBe(2);
    expect(foldVisibleCount(7)).toBe(16);
  });

  it("路径数只增不减，且每个取值都是偶数（左右对称）", () => {
    let previous = -1;
    for (let p = 0; p <= 5; p += 0.01) {
      const count = foldVisibleCount(p);
      expect(count).toBeGreaterThanOrEqual(previous);
      expect(count % 2, `p=${p.toFixed(2)} 的路径数 ${count} 不是偶数`).toBe(0);
      previous = count;
    }
  });
});

describe("hash01 是确定性的伪随机", () => {
  it("同输入同输出", () => {
    for (const n of [0, 1, 7, 94, 211, 1000]) expect(hash01(n)).toBe(hash01(n));
  });

  it("值域落在 [0, 1)，1000 个输入无 NaN", () => {
    let minimum = 1;
    let maximum = 0;
    for (let n = 0; n < 1000; n += 1) {
      const value = hash01(n);
      expect(Number.isFinite(value), `n=${n}`).toBe(true);
      expect(value, `n=${n}`).toBeGreaterThanOrEqual(0);
      expect(value, `n=${n}`).toBeLessThan(1);
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
    }
    // 值域要真的铺开：[0,1) 内几乎顶到两端，否则"右密左疏"会退化成一条平带。
    expect(minimum).toBeLessThan(0.01);
    expect(maximum).toBeGreaterThan(0.99);
  });

  it("负数与小数的输入也留在 [0,1)：用 fract 而不是取模", () => {
    // `x % 1` 对负的 sin 返回负数，值域会被悄悄撑成 (-1,1)，密度与色板索引都会算错。
    for (const n of [-1, -37.5, 1e-7, 1e6]) {
      const value = hash01(n);
      expect(value, String(n)).toBeGreaterThanOrEqual(0);
      expect(value, String(n)).toBeLessThan(1);
    }
  });

  it("相邻输入不聚团（不是一条常数函数）", () => {
    const values = new Set();
    for (let n = 0; n < 50; n += 1) values.add(hash01(n).toFixed(9));
    expect(values.size).toBe(50);
  });
});

describe("stepSpring 三级子步的纯函数积分", () => {
  const K = 420;
  const DAMPING = 32;

  it("一帧 32ms 的落点与手算的三次子步一致", () => {
    // 单步欧拉在同样一帧会冲到 2.1504；三次子步只到 1.0865。这个数就是
    // "规格里的三次子步"是否真的在代码里的证据。
    const [position] = stepSpring(0, 0, 5, 0.032, K, DAMPING);
    expect(position).toBeCloseTo(1.086465, 6);
    expect(position).toBeLessThan(1.5);
  });

  it("从 0 出发朝 5 单调上升，直到第一次到达目标", () => {
    let position = 0;
    let velocity = 0;
    let previous = 0;
    let firstCross = -1;
    for (let frame = 0; frame < 60; frame += 1) {
      [position, velocity] = stepSpring(position, velocity, 5, 1 / 60, K, DAMPING);
      if (firstCross === -1) {
        expect(position, `frame ${frame}`).toBeGreaterThan(previous);
        previous = position;
        if (position >= 5) firstCross = frame;
      }
    }
    expect(firstCross).toBeGreaterThan(0);
  });

  it("过冲有界并最终吸附到 [target, 0]", () => {
    // 规格给的 k=420、damping=32 换算成阻尼比约 0.78，**不是**临界阻尼：解析解
    // 的过冲约 1.97%，所以"全程不过冲"与规格参数互斥。这条断言钉的是真实性质：
    // 过冲小于 2.5%（肉眼不可见），且最终精确吸附。
    let position = 0;
    let velocity = 0;
    let peak = 0;
    let settled = false;
    for (let frame = 0; frame < 400; frame += 1) {
      [position, velocity] = stepSpring(position, velocity, 5, 1 / 60, K, DAMPING);
      peak = Math.max(peak, position);
      if (position === 5 && velocity === 0) {
        settled = true;
        break;
      }
    }
    expect(settled).toBe(true);
    expect((peak - 5) / 5).toBeLessThan(0.025);
    expect(position).toBe(5);
    expect(velocity).toBe(0);
  });

  it("吸附后停在目标上不再漂移", () => {
    let position = 5;
    let velocity = 0;
    for (let frame = 0; frame < 10; frame += 1) {
      [position, velocity] = stepSpring(position, velocity, 5, 1 / 60, K, DAMPING);
      expect([position, velocity]).toStrictEqual([5, 0]);
    }
  });

  it("dt = 0 时两个值都不动", () => {
    expect(stepSpring(2.25, 13.5, 5, 0, K, DAMPING)).toStrictEqual([2.25, 13.5]);
    // 已经吸附的状态在 dt=0 下也不会被写成别的值。
    expect(stepSpring(5, 0, 5, 0, K, DAMPING)).toStrictEqual([5, 0]);
  });

  it("快速反向只换目标：速度的帧间变化随 dt 一起趋零（连续性）", () => {
    // 先把弹簧推到半路，再掉头，模拟拖到一半松手往回拽。
    let position = 0;
    let velocity = 0;
    for (let frame = 0; frame < 6; frame += 1) {
      [position, velocity] = stepSpring(position, velocity, 5, 1 / 60, K, DAMPING);
    }
    const before = velocity;
    const [, fast] = stepSpring(position, before, 0, 1 / 60, K, DAMPING);
    const [, finer] = stepSpring(position, before, 0, 1 / 120, K, DAMPING);
    const [, finest] = stepSpring(position, before, 0, 1 / 240, K, DAMPING);
    expect(fast).toBeLessThan(before);
    // 加速度有界 ⇒ 一帧的速度变化 ∝ dt。若实现里做了硬跳变（直接把 v 设成 0 或
    // 符号翻转），三个数会一样大。
    expect(Math.abs(finer - before)).toBeLessThan(Math.abs(fast - before) * 0.6);
    expect(Math.abs(finest - before)).toBeLessThan(Math.abs(finer - before) * 0.6);
    // 单帧位移也保持在一格的一小部分，不会瞬移。
    const [moved] = stepSpring(position, before, 0, 1 / 60, K, DAMPING);
    expect(Math.abs(moved - position)).toBeLessThan(0.25);
  });

  it("是纯函数：同参数同结果，不依赖模块级状态", () => {
    const first = stepSpring(1.2, 9.5, 4, 1 / 60, K, DAMPING);
    // 中间插入一次完全不同的调用，看第一次的结果会不会被影响。
    stepSpring(0, 0, 0, 0.032, 190, 25);
    const again = stepSpring(1.2, 9.5, 4, 1 / 60, K, DAMPING);
    expect(again).toStrictEqual(first);
    expect(first).toHaveLength(2);
  });

  it("Galaxy 弹簧（k=190、damping=25）同样会停", () => {
    let value = 0;
    let velocity = 0;
    for (let frame = 0; frame < 400; frame += 1) {
      [value, velocity] = stepSpring(value, velocity, 1, 1 / 60, 190, 25);
    }
    expect([value, velocity]).toStrictEqual([1, 0]);
  });
});

describe("trackFillStops：四组色板按连续位置插值", () => {
  const RGB = /^rgb\(\d{1,3}, \d{1,3}, \d{1,3}\)$/;

  it("position = 1（Medium）就是第一组原色", () => {
    expect(trackFillStops(1)).toStrictEqual([
      "rgb(49, 42, 45)", "rgb(86, 57, 76)", "rgb(125, 73, 112)",
      "rgb(161, 89, 146)", "rgb(175, 94, 157)",
    ]);
  });

  it("position = 4（Max）就是第四组原色", () => {
    expect(trackFillStops(4)).toStrictEqual([
      "rgb(49, 42, 45)", "rgb(77, 56, 74)", "rgb(102, 67, 111)",
      "rgb(118, 84, 153)", "rgb(124, 90, 167)",
    ]);
  });

  it("Max 的三个点位对上规格 §4 自己给的十六进制近似值", () => {
    // 规格原文：「Max 的中段约 #66436f、90% 处约 #765499、最前缘约 #7c5aa7」。
    // 这三个是**规格自己的抽查值**，不是从色板推的——它们能把"色板顺序反了"
    // 或"第几组取错"这类错误抓出来，而纯粹对照 JSON 的断言抓不到。
    const hex = (stop) => `#${(stop.match(/\d+/g) ?? [])
      .map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`;
    const stops = trackFillStops(4).map(hex);
    expect(stops[2]).toBe("#66436f");
    expect(stops[3]).toBe("#765499");
    expect(stops[4]).toBe("#7c5aa7");
    expect(stops[0]).toBe("#312a2d");
  });

  it("position = 2.5 是第二组与第三组各半", () => {
    // t = 1.5 ⇒ index = 1、blend = .5，所以混的是 TRACK_PALETTES[1] 与 [2]。
    const low = TRACK_PALETTES[1];
    const high = TRACK_PALETTES[2];
    const expected = low.map((stop, i) => `rgb(${Math.round((stop[0] + high[i][0]) / 2)}, ${
      Math.round((stop[1] + high[i][1]) / 2)}, ${Math.round((stop[2] + high[i][2]) / 2)})`);
    expect(trackFillStops(2.5)).toStrictEqual(expected);
    expect(trackFillStops(2.5)[1]).toBe("rgb(80, 56, 75)");
  });

  it("Low 以下全用第一组：position = 0 的首标是 rgb(49, 42, 45)", () => {
    expect(trackFillStops(0)[0]).toBe("rgb(49, 42, 45)");
    // t 被钳在 0，所以 Low 到 Medium 整段是同一个颜色，不随 0→1 漂移。
    expect(trackFillStops(0)).toStrictEqual(trackFillStops(1));
    expect(trackFillStops(0)[4]).toBe("rgb(175, 94, 157)");
  });

  it("Max 以上停在第四组：position = 5 与 4 相同", () => {
    expect(trackFillStops(5)).toStrictEqual(trackFillStops(4));
  });

  it("每个色标都是合法的 rgb() 字符串，五个一组", () => {
    for (const position of [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5]) {
      const stops = trackFillStops(position);
      expect(stops, `position ${position}`).toHaveLength(5);
      for (const stop of stops) expect(stop, `position ${position}`).toMatch(RGB);
    }
  });

  it("颜色随位置连续变化，不只在档位切换时跳色", () => {
    const at = (position) => trackFillStops(position)[4];
    // 一档之内（2 到 3 之间）也要有四个互不相同的颜色：只在档位切换时换色，
    // 拖到一半反向就会先跳色再回来。
    expect(at(1.75)).not.toBe(at(2));
    expect(at(2.25)).not.toBe(at(2));
    expect(at(2.5)).not.toBe(at(2.25));
    expect(at(2.75)).not.toBe(at(2.5));
    // 连续区间的中间值必须夹在两端之间：逐通道比较，不能出现回跳。
    const channel = (stop, i) => Number(stop.match(/\d+/g)[i]);
    for (let i = 0; i < 3; i += 1) {
      const a = channel(at(2.25), i);
      const b = channel(at(2.5), i);
      const c = channel(at(2.75), i);
      expect(b, `通道 ${i}`).toBeGreaterThanOrEqual(Math.min(a, c));
      expect(b, `channel ${i}`).toBeLessThanOrEqual(Math.max(a, c));
    }
  });
});

describe("trackFillOpacity 收的是 g，不是 position", () => {
  it("两端与中点：1-g", () => {
    expect(trackFillOpacity(0)).toBe(1);
    expect(trackFillOpacity(1)).toBe(0);
    expect(trackFillOpacity(0.25)).toBeCloseTo(0.75, 12);
  });

  it("越界的 g 钳到 [0,1]，不会算出负透明度", () => {
    expect(trackFillOpacity(-1)).toBe(1);
    expect(trackFillOpacity(2)).toBe(0);
  });
});

describe("galaxyState：爆发、缩放与震动", () => {
  it("g = 0：scale = 1、shake = 0、填充是粉色原色", () => {
    const state = galaxyState(0, 10, 3);
    expect(state.g).toBe(0);
    expect(state.burst).toBe(0);
    expect(state.scale).toBe(1);
    expect(state.shake).toBe(0);
    expect(state.fill).toBe("rgb(255, 146, 206)");
    expect(state.stroke).toBe("rgb(101, 14, 60)");
    expect(state.glow).toStrictEqual([4, 9]);
  });

  it("g = 1、age = 0：爆发全开，scale = 1.45", () => {
    const state = galaxyState(1, 5, 5);
    expect(state.age).toBe(0);
    expect(state.burst).toBe(1);
    expect(state.scale).toBeCloseTo(1.45, 12);
    expect(state.shake).toBeCloseTo(2.38, 12);
    expect(state.glow).toStrictEqual([14, 24]);
    expect(state.fill).toBe("rgb(170, 150, 245)");
    expect(state.stroke).toBe("rgb(56, 16, 137)");
  });

  it("age 很大时 burst→0、shake→.28，只剩常驻的那点微震", () => {
    const state = galaxyState(1, 100, 0);
    expect(state.burst).toBeCloseTo(0, 20);
    expect(state.scale).toBeCloseTo(1.25, 6);
    expect(state.shake).toBeCloseTo(0.28, 6);
    expect(state.glow[0]).toBeCloseTo(4, 6);
    expect(state.glow[1]).toBeCloseTo(9, 6);
  });

  it("burst 单调衰减：进入 Galaxy 后只会更弱", () => {
    let previous = Infinity;
    for (let age = 0; age <= 2; age += 0.05) {
      const { burst } = galaxyState(1, age, 0);
      expect(burst).toBeLessThan(previous);
      previous = burst;
    }
  });

  it("clock 早于 enteredAt 时 age 取 0（暂停恢复不会把爆发放大）", () => {
    // 负的 age 会让 exp(-age*6) 大于 1，卡片会越震越猛。
    const state = galaxyState(1, 2, 9);
    expect(state.age).toBe(0);
    expect(state.burst).toBe(1);
    expect(state.shake).toBeCloseTo(2.38, 12);
  });

  it("galaxy 值钳到 [0,1]，传进越界值不会画出非法颜色", () => {
    const over = galaxyState(2, 0, 0);
    const atOne = galaxyState(1, 0, 0);
    expect(over.g).toBe(1);
    expect(over.fill).toBe(atOne.fill);
    const under = galaxyState(-1, 0, 0);
    expect(under.g).toBe(0);
    expect(under.fill).toBe("rgb(255, 146, 206)");

    const RGB = /^rgb\(\d{1,3}, \d{1,3}, \d{1,3}\)$/;
    for (const g of [0, 0.2, 0.5, 0.8, 1]) {
      const state = galaxyState(g, 1, 0);
      expect(state.fill).toMatch(RGB);
      expect(state.stroke).toMatch(RGB);
    }
  });

  it("fill / stroke 是连续插值，不是五个档位各一张色卡", () => {
    // 规格 §4 给的是线性的 rgb 表达式；拖到一半反向时必须从当时的颜色走，
    // 所以中间值必须与两端都不同。
    const fill = (g) => galaxyState(g, 0, 0).fill;
    expect(fill(0.5)).not.toBe(fill(0));
    expect(fill(0.5)).not.toBe(fill(1));
    expect(fill(0.25)).not.toBe(fill(0.5));
  });
});
