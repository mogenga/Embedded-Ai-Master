/**
 * Galaxy 档位的两个 Canvas 图层：轨道里的像素网格、卡片上方的放射粒子。
 *
 * 每个数值都是 `docs/specs/galaxy-effort-slider.md` §5 的逐字抄写，没有在这里
 * 重新推导或"优化"过。那份规格是用户的验收依据——调参是改规格的事。
 *
 * `hash01` / `PIXEL_PALETTE` / `clamp` 都从 `./galaxy-effort-core.js` 取，本文件
 * 不复制一份：色板一旦漂移，两个图层会画出肉眼可见的两套紫蓝色；`clamp` 复制一份
 * 则会让"钳到 0..1"在两个文件里悄悄变成两种语义。
 *
 * 顶层只有 import、常量和函数声明，不碰 `document` / `window` / canvas：
 * `tests/desktop/*` 静态 import 本文件时没有 DOM 可用。
 */
import { PIXEL_PALETTE, clamp, hash01 } from "./galaxy-effort-core.js";

/** 像素层的逻辑尺寸。canvas 的 width/height 由调用方设，这里只用于清屏与坐标。 */
const PIXEL_WIDTH = 392;
const PIXEL_HEIGHT = 40;
const PIXEL_COLS = 49;
const PIXEL_ROWS = 5;

/** 放射层的逻辑尺寸。 */
const RADIAL_WIDTH = 640;
const RADIAL_HEIGHT = 390;
const RAY_COUNT = 26;
const DOTS_PER_RAY = 7;
/** 黄金角，让 26 条射线看起来不重复；多一位小数都会让纹理在几秒内改变。 */
const RAY_ANGLE_STEP = 2.399963;

/**
 * 画一个方块：有 `roundRect` 就用它，没有就退化成直角 `fillRect`。
 *
 * 退化不是兜底而是等价的：1.3px 的圆角在 5px 的方块上看不出区别，而假 ctx、
 * 旧渲染器与部分 2D 实现都没有 `roundRect`。两条路径画出的方块**数量**必须一致，
 * `tests/desktop/galaxy-effort-layers.test.js` 钉着这一点。
 *
 * `roundRect` 只构建路径，所以要配对 `beginPath` + `fill`；少了 `fill` 就一个
 * 像素都不会出现，而且不会报错。
 */
function fillSquare(ctx, x, y, size, radius) {
  if (typeof ctx.roundRect === "function") {
    ctx.beginPath();
    ctx.roundRect(x, y, size, size, radius);
    ctx.fill();
    return;
  }
  ctx.fillRect(x, y, size, size);
}

/**
 * 轨道像素层：49 列 × 5 行，右密左疏并持续闪动。
 *
 * `ctx` 可省略；省略时向 `canvas` 要 2D 上下文。测试传入假 ctx，所以构造函数里
 * 不能对 ctx 做任何假设性调用（假 ctx 是合法对象，只是没有真实绘图能力）。
 *
 * @param {HTMLCanvasElement} canvas
 * @param {CanvasRenderingContext2D} [ctx]
 */
export function createPixelLayer(canvas, ctx) {
  const context = ctx ?? canvas.getContext("2d");
  return {
    /**
     * 画一帧。
     *
     * @param {number} clock 秒
     * @param {number} g Galaxy 强度，调用方已钳到 [0,1]
     */
    draw(clock, g) {
      // 清屏用逻辑尺寸而不是 `canvas.width/height`：调用方按 DPR 缩放时应当
      // `ctx.scale`，那时 392×40 在设备像素里就是整块画布；反过来读
      // `canvas.width` 会在缩放后只清掉左半边。
      context.clearRect(0, 0, PIXEL_WIDTH, PIXEL_HEIGHT);
      // 严格等于 0 就是"完全离开 Galaxy"，只留清屏，好让像素彻底退干净。
      // g 由调用方钳过，所以浮点残值不会被误判成 0 或非 0。
      if (g === 0) return;
      for (let row = 0; row < PIXEL_ROWS; row += 1) {
        for (let col = 0; col < PIXEL_COLS; col += 1) {
          const n = row * PIXEL_COLS + col;
          const seed = hash01(n + 7);
          const wave = 0.5 + 0.5 * Math.sin(clock * (2 + 3 * seed) + n * 1.618);
          const density = 0.14 + 0.78 * (col / 48) ** 1.6;
          if (seed > density + 0.16 * Math.sin(clock * 1.8 + col * 0.2)) continue;
          // 透明度进 globalAlpha、颜色进 fillStyle：色板是十六进制字符串，
          // 再拼一个 rgba 等于在色板之外又造一份颜色。
          context.globalAlpha = g * (0.18 + 0.72 * wave) * (0.22 + 0.78 * col / 48);
          context.fillStyle = PIXEL_PALETTE[Math.floor(hash01(n + 211) * 6)];
          fillSquare(context, col * 8 + 1, row * 8 + 0.5, seed > 0.74 ? 5.7 : 5.1, 1.3);
        }
      }
      // 还原成默认值：图层共用上下文时，留下一个 0.3 的全局透明度会让下一层的
      // 每一笔都变淡，而且不报错。
      context.globalAlpha = 1;
    },
  };
}

/**
 * 放射粒子层：26 条射线、每条 7 个方块，从脑形中心向外流动。
 *
 * 与像素层一样，`ctx` 可省略。中心与 `age` 由调用方算好后传入——本图层不持有
 * 任何状态，同一组参数画出的结果一定相同。
 *
 * @param {HTMLCanvasElement} canvas
 * @param {CanvasRenderingContext2D} [ctx]
 */
export function createRadialLayer(canvas, ctx) {
  const context = ctx ?? canvas.getContext("2d");
  return {
    /**
     * 画一帧。
     *
     * @param {number} clock 秒
     * @param {number} g Galaxy 强度，调用方已钳到 [0,1]
     * @param {number} age 进入 Galaxy 后的秒数，用来算爆发衰减
     * @param {number} centerX 中心 x（逻辑坐标）
     * @param {number} centerY 中心 y（逻辑坐标）
     */
    draw(clock, g, age, centerX, centerY) {
      // 整块清屏：粒子会飘到卡片之外，上一帧留下的任何一点都得先抹掉。
      context.clearRect(0, 0, RADIAL_WIDTH, RADIAL_HEIGHT);
      if (g === 0) return;
      // 爆发衰减只算一次：它同时进半径、透明度和 fades，三处用同一个数才是同一次爆发。
      const decay = Math.exp(-age * 5);
      for (let ray = 0; ray < RAY_COUNT; ray += 1) {
        const angle = ray * RAY_ANGLE_STEP;
        const seed = hash01(ray + 94);
        const speed = 15 + 24 * seed;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        for (let dot = 0; dot < DOTS_PER_RAY; dot += 1) {
          // 半径对 87 取模：方块流到外圈就从内圈重新出现，于是"持续流动"不需要
          // 第二套生命周期状态。
          const radius = 27 + ((dot * 13 + clock * speed + seed * 40) % 87) + decay * dot * 3;
          const fade = (1 - clamp((radius - 27) / 110, 0, 1)) ** 1.6;
          const pulse = 0.45 + 0.55 * Math.sin(clock * 4 + ray + dot) ** 2;
          const size = seed > 0.65 ? 3 : 2;
          context.globalAlpha = g * fade * pulse * (0.4 + 0.35 * decay);
          context.fillStyle = PIXEL_PALETTE[(ray + dot) % 6];
          // 位置是方块左上角，与像素层同一约定；规格 §5 只给像素层写了圆角，
          // 所以粒子是直角方块。
          context.fillRect(centerX + cos * radius, centerY + sin * radius, size, size);
        }
      }
      context.globalAlpha = 1;
    },
  };
}
