import { describe, expect, it } from "vitest";
import {
  createPixelLayer,
  createRadialLayer,
} from "../../desktop/renderer/galaxy-effort-layers.js";
import { PIXEL_PALETTE } from "../../desktop/renderer/galaxy-effort-core.js";

/**
 * Galaxy 档位的两个 Canvas 图层（`docs/specs/galaxy-effort-slider.md` §5）。
 *
 * 仓库没有 jsdom，也不想为此引入依赖，所以这里不造真实 canvas，而是喂一个
 * **假 ctx**：它只记录 `clearRect` / `fillRect` / `roundRect` / `beginPath` /
 * `fill` 的调用，以及每次画方块时生效的 `fillStyle` 与 `globalAlpha`。
 * 断言因此落在"画了几个、画在哪、用什么颜色、多透明"上——这些正是规格给出的数；
 * 真实渲染出来长什么样，只有窗口里能看见。
 *
 * 假 ctx 刻意做得**没有**绘图能力：如果被测代码对 ctx 做了真实上下文才有的假设
 * （调私有属性、依赖返回值），这些用例会直接炸，而不是悄悄全绿。
 */

/**
 * 一个记录调用序列的假 2D 上下文。
 *
 * `roundRect` 可选：两条分支都要能画（规格要求在缺少它时退化成 `fillRect`），
 * 而两种分支画出的方块**数量**必须一样，否则同一个 clock 在两个渲染器上会出现
 * 两种疏密。
 */
function fakeContext({ roundRect = true } = {}) {
  const calls = [];
  const ctx = {
    fillStyle: null,
    globalAlpha: 1,
    clearRect(...args) {
      calls.push({ type: "clearRect", args: [...args] });
    },
    fillRect(...args) {
      calls.push({
        type: "fillRect",
        args: [...args],
        fillStyle: ctx.fillStyle,
        globalAlpha: ctx.globalAlpha,
      });
    },
    beginPath() {
      calls.push({ type: "beginPath", args: [] });
    },
    fill() {
      calls.push({ type: "fill", args: [] });
    },
  };
  if (roundRect) {
    ctx.roundRect = function roundRectCall(...args) {
      calls.push({
        type: "roundRect",
        args: [...args],
        fillStyle: ctx.fillStyle,
        globalAlpha: ctx.globalAlpha,
      });
    };
  }
  return { ctx, calls };
}

/** 一次 draw 里画出的方块。`roundRect` 与 `fillRect` 都算，取决于是哪条分支。 */
function squares(calls) {
  return calls.filter((call) => call.type === "fillRect" || call.type === "roundRect");
}

/** 方块左上角的坐标；两条分支的参数前两个都是 x / y。 */
function at(square) {
  return { x: square.args[0], y: square.args[1] };
}

/**
 * 方块边长与圆角。
 *
 * 两条分支的参数位置不同：`fillRect(x, y, w, h)` 的边长在 `[2]` 且没有圆角，
 * `roundRect(x, y, w, h, r)` 的圆角在 `[4]`。直接解构会把 `roundRect` 的圆角读成
 * `w`/`h` 之外的空位，断言"圆角 1.3"就会永远失败（或永远错着通过）。
 */
function geometryOf(square) {
  if (square.type === "roundRect") {
    return { size: square.args[2], radius: square.args[4] };
  }
  return { size: square.args[2], radius: undefined };
}

const PIXEL_CANVAS = { width: 392, height: 40 };
const RADIAL_CANVAS = { width: 640, height: 390 };

/**
 * 脑形中心的两个极端位置（规格 §4：`16 + position/5×358`，加卡片与命中区的固定偏移）。
 *
 * 测试两端而不是只测起点：粒子跟着脑形走，Galaxy 时中心在最右侧，
 * 那才是"会不会画到画布外"最容易出问题的位置。
 */
const CENTER_LEFT = { x: 138, y: 229 };
const CENTER_RIGHT = { x: 138 + 358, y: 229 };

describe("像素层：49×5 网格，右密左疏，跟着 g 一起退干净", () => {
  it("g=0 时只清屏，一个方块都不画", () => {
    const { ctx, calls } = fakeContext();
    const layer = createPixelLayer(PIXEL_CANVAS, ctx);
    layer.draw(1.25, 0);
    // 离开 Galaxy 要"退干净"：留下任何一块残留像素，都是界面在说这里还有 Galaxy。
    expect(calls.map((call) => call.type)).toStrictEqual(["clearRect"]);
    expect(calls[0].args).toStrictEqual([0, 0, 392, 40]);
  });

  it("g=1 时方块数有界：> 50 且 < 245", () => {
    const { ctx, calls } = fakeContext();
    createPixelLayer(PIXEL_CANVAS, ctx).draw(2.7, 1);
    const count = squares(calls).length;
    // 上限是网格本身（245 格）；下限挡住"跳过条件写反、几乎全跳"的回归。
    // 期望值约 100–120（密度 0.14 → 0.92 的加权）。
    expect(count).toBeGreaterThan(50);
    expect(count).toBeLessThan(245);
  });

  it("每个方块都是 5.1 或 5.7 见方、圆角 1.3，且整体落在 392×40 内", () => {
    const { ctx, calls } = fakeContext();
    createPixelLayer(PIXEL_CANVAS, ctx).draw(0.9, 1);
    const drawn = squares(calls);
    expect(drawn.length).toBeGreaterThan(0);
    for (const square of drawn) {
      const { x, y } = at(square);
      const { size, radius } = geometryOf(square);
      expect([5.1, 5.7]).toContain(size);
      expect(radius).toBe(1.3);
      // 位置是左上角，方块本身也要在界内：x + size ≤ 392、y + size ≤ 40。
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x + size).toBeLessThanOrEqual(392);
      expect(y + size).toBeLessThanOrEqual(40);
    }
  });

  it("位置严格落在 8px 网格上（col*8+1, row*8+.5）", () => {
    const { ctx, calls } = fakeContext();
    createPixelLayer(PIXEL_CANVAS, ctx).draw(3.1, 1);
    for (const square of squares(calls)) {
      const { x, y } = at(square);
      // 反解列号与行号，必须是整数：格子一旦有半格偏移，49 列就画不满轨道。
      const col = (x - 1) / 8;
      const row = (y - 0.5) / 8;
      expect(Number.isInteger(col), `col=${col}`).toBe(true);
      expect(Number.isInteger(row), `row=${row}`).toBe(true);
      expect(col).toBeGreaterThanOrEqual(0);
      expect(col).toBeLessThan(49);
      expect(row).toBeGreaterThanOrEqual(0);
      expect(row).toBeLessThan(5);
    }
  });

  it("颜色只取 PIXEL_PALETTE，不自己拼 rgba", () => {
    const { ctx, calls } = fakeContext();
    createPixelLayer(PIXEL_CANVAS, ctx).draw(1.7, 1);
    const drawn = squares(calls);
    expect(drawn.length).toBeGreaterThan(0);
    for (const square of drawn) {
      expect(PIXEL_PALETTE).toContain(square.fillStyle);
    }
    // 色板确实用到了不止一种：全部同一色说明 floor(hash*6) 退化了。
    expect(new Set(drawn.map((square) => square.fillStyle)).size).toBeGreaterThan(1);
  });

  it("alpha 与 g 成正比，且始终落在 0..1", () => {
    const full = fakeContext();
    createPixelLayer(PIXEL_CANVAS, full.ctx).draw(2.2, 1);
    const half = fakeContext();
    createPixelLayer(PIXEL_CANVAS, half.ctx).draw(2.2, 0.5);
    const fullSquares = squares(full.calls);
    const halfSquares = squares(half.calls);
    // 同一 clock 下跳过条件与 g 无关，所以两次的方块必须逐项对齐。
    expect(halfSquares.map(at)).toStrictEqual(fullSquares.map(at));
    fullSquares.forEach((square, index) => {
      expect(square.globalAlpha).toBeGreaterThan(0);
      expect(square.globalAlpha).toBeLessThanOrEqual(1);
      expect(halfSquares[index].globalAlpha).toBeCloseTo(square.globalAlpha / 2, 10);
    });
  });

  it("同一 clock 两次 draw 逐项相同；不同 clock 不同（在动）", () => {
    const first = fakeContext();
    createPixelLayer(PIXEL_CANVAS, first.ctx).draw(4.2, 1);
    const second = fakeContext();
    createPixelLayer(PIXEL_CANVAS, second.ctx).draw(4.2, 1);
    expect(second.calls).toStrictEqual(first.calls);

    const later = fakeContext();
    createPixelLayer(PIXEL_CANVAS, later.ctx).draw(4.9, 1);
    // 只比坐标不够：同一个格子在不同时刻可能还在，所以比整条调用序列
    // （包含透明度与颜色）才能证明它真的在闪。
    expect(later.calls).not.toStrictEqual(first.calls);
  });

  it("没有 roundRect 的 ctx 退化为 fillRect，方块数不变", () => {
    const modern = fakeContext();
    createPixelLayer(PIXEL_CANVAS, modern.ctx).draw(3.4, 1);
    const legacy = fakeContext({ roundRect: false });
    createPixelLayer(PIXEL_CANVAS, legacy.ctx).draw(3.4, 1);
    expect(squares(legacy.calls).map(at)).toStrictEqual(squares(modern.calls).map(at));
    // 退化分支不能再调 beginPath / fill：那对方法在假 ctx 上什么也画不出来，
    // 真上下文里则会留下一条没填充的空路径。
    expect(legacy.calls.some((call) => call.type === "beginPath")).toBe(false);
  });

  it("省略 ctx 时向 canvas 要 2d 上下文，且构造时不画任何东西", () => {
    const { ctx, calls } = fakeContext({ roundRect: false });
    const asked = [];
    const canvas = {
      width: 392,
      height: 40,
      getContext(type) {
        asked.push(type);
        return ctx;
      },
    };
    const layer = createPixelLayer(canvas);
    expect(asked).toStrictEqual(["2d"]);
    expect(calls).toStrictEqual([]);
    layer.draw(0.5, 1);
    expect(squares(calls).length).toBeGreaterThan(0);
  });

  it("draw 返回 undefined（调用方不靠返回值驱动循环）", () => {
    const { ctx } = fakeContext();
    expect(createPixelLayer(PIXEL_CANVAS, ctx).draw(0, 1)).toBeUndefined();
  });
});

describe("放射层：26 条射线向外流动，随后按 age 收束", () => {
  it("g=0 时只清屏，一个方块都不画", () => {
    const { ctx, calls } = fakeContext();
    createRadialLayer(RADIAL_CANVAS, ctx).draw(1, 0, 0, CENTER_LEFT.x, CENTER_LEFT.y);
    expect(calls.map((call) => call.type)).toStrictEqual(["clearRect"]);
    expect(calls[0].args).toStrictEqual([0, 0, 640, 390]);
  });

  it("g=1、age=0 时画满 26×7=182 个方块", () => {
    const { ctx, calls } = fakeContext();
    createRadialLayer(RADIAL_CANVAS, ctx).draw(0, 1, 0, CENTER_LEFT.x, CENTER_LEFT.y);
    // 放射层没有跳过条件：规格里每条射线固定 7 个方块，上限即实际值。
    expect(squares(calls)).toHaveLength(26 * 7);
  });

  it("两个极端中心下，所有方块都落在 640×390 内", () => {
    for (const center of [CENTER_LEFT, CENTER_RIGHT]) {
      for (const clock of [0, 1.3, 7.9]) {
        const { ctx, calls } = fakeContext();
        createRadialLayer(RADIAL_CANVAS, ctx).draw(clock, 1, 0, center.x, center.y);
        for (const square of squares(calls)) {
          const [x, y, size] = square.args;
          expect(x, `x at clock=${clock}`).toBeGreaterThanOrEqual(0);
          expect(y, `y at clock=${clock}`).toBeGreaterThanOrEqual(0);
          expect(x + size, `x+size at clock=${clock}`).toBeLessThanOrEqual(640);
          expect(y + size, `y+size at clock=${clock}`).toBeLessThanOrEqual(390);
        }
      }
    }
  });

  it("边长只有 2 与 3 两种，颜色按 (ray+dot)%6 循环", () => {
    const { ctx, calls } = fakeContext();
    createRadialLayer(RADIAL_CANVAS, ctx).draw(2.5, 1, 0, CENTER_LEFT.x, CENTER_LEFT.y);
    const drawn = squares(calls);
    for (const square of drawn) expect([2, 3]).toContain(square.args[2]);
    // 六个色值全部出现，且每个都在色板里：循环取模写错会退化成单一颜色。
    const used = new Set(drawn.map((square) => square.fillStyle));
    expect(used.size).toBe(6);
    for (const color of used) expect(PIXEL_PALETTE).toContain(color);
  });

  it("方块是直角 fillRect（规格只给像素层写了圆角）", () => {
    const { ctx, calls } = fakeContext();
    createRadialLayer(RADIAL_CANVAS, ctx).draw(1, 1, 0, CENTER_LEFT.x, CENTER_LEFT.y);
    expect(calls.some((call) => call.type === "roundRect")).toBe(false);
  });

  it("age 变大后透明度整体衰减（爆发是短的，流动是长的）", () => {
    for (const clock of [0, 1, 2.5, 7.3]) {
      const fresh = fakeContext();
      createRadialLayer(RADIAL_CANVAS, fresh.ctx).draw(clock, 1, 0, CENTER_LEFT.x, CENTER_LEFT.y);
      const settled = fakeContext();
      createRadialLayer(RADIAL_CANVAS, settled.ctx).draw(clock, 1, 5, CENTER_LEFT.x, CENTER_LEFT.y);
      const sum = (calls) => squares(calls).reduce((total, square) => total + square.globalAlpha, 0);
      // 比总和，**不比逐个方块**：`decay` 同时进半径，半径又进 `fade`，年龄变大时
      // 有些方块反而因为落到 fade 更大的半径上而变亮（实测 clock=0、age=0→5 时有
      // 32/182 个）。规格要的是整层随爆发结束而收束，逐项单调不是它的含义。
      expect(squares(fresh.calls)).toHaveLength(squares(settled.calls).length);
      expect(sum(settled.calls), `clock=${clock}`).toBeLessThan(sum(fresh.calls) * 0.8);
    }
  });

  it("同一组参数两次 draw 逐项相同；不同 clock 不同", () => {
    const first = fakeContext();
    createRadialLayer(RADIAL_CANVAS, first.ctx).draw(3.3, 1, 0.4, CENTER_LEFT.x, CENTER_LEFT.y);
    const second = fakeContext();
    createRadialLayer(RADIAL_CANVAS, second.ctx).draw(3.3, 1, 0.4, CENTER_LEFT.x, CENTER_LEFT.y);
    expect(second.calls).toStrictEqual(first.calls);

    const later = fakeContext();
    createRadialLayer(RADIAL_CANVAS, later.ctx).draw(3.8, 1, 0.4, CENTER_LEFT.x, CENTER_LEFT.y);
    expect(later.calls).not.toStrictEqual(first.calls);
  });

  it("中心移动时整层跟着平移（粒子跟随脑形）", () => {
    const left = fakeContext();
    createRadialLayer(RADIAL_CANVAS, left.ctx).draw(0, 1, 0, CENTER_LEFT.x, CENTER_LEFT.y);
    const right = fakeContext();
    createRadialLayer(RADIAL_CANVAS, right.ctx).draw(0, 1, 0, CENTER_RIGHT.x, CENTER_RIGHT.y);
    const dx = CENTER_RIGHT.x - CENTER_LEFT.x;
    squares(left.calls).forEach((square, index) => {
      // 颜色与边长由 (ray+dot) 与 seed 决定，与中心无关；只有坐标平移。
      expect(squares(right.calls)[index].args[0] - square.args[0]).toBeCloseTo(dx, 10);
      expect(squares(right.calls)[index].args[1]).toBeCloseTo(square.args[1], 10);
    });
  });

  it("省略 ctx 时向 canvas 要 2d 上下文，且构造时不画任何东西", () => {
    const { ctx, calls } = fakeContext();
    const asked = [];
    const canvas = {
      width: 640,
      height: 390,
      getContext(type) {
        asked.push(type);
        return ctx;
      },
    };
    const layer = createRadialLayer(canvas);
    expect(asked).toStrictEqual(["2d"]);
    expect(calls).toStrictEqual([]);
    layer.draw(0, 1, 0, CENTER_LEFT.x, CENTER_LEFT.y);
    expect(squares(calls)).toHaveLength(26 * 7);
  });

  it("draw 返回 undefined", () => {
    const { ctx } = fakeContext();
    expect(createRadialLayer(RADIAL_CANVAS, ctx).draw(0, 1, 0, 0, 0)).toBeUndefined();
  });
});
