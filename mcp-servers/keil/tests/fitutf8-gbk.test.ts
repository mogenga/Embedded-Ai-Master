import { describe, expect, it } from "vitest";
import { encodeGbk, decodeGbk } from "../gbk.js";
import { fitUtf8, sstr, readSstr } from "../uvsock.js";

/**
 * T-021 的离线锁定：fitUtf8 在 GBK 边界截断时不得劈断双字节字符。
 * 旧实现用 UTF-8 continuation 判据 `(b & 0xc0) === 0x80`——GBK trail 范围
 * 0x40–0xFE 大量不满足，常用汉字（trail ≥ 0xC0，如 中/文/测/组）被劈成
 * 半截，孤立 lead byte 在远端吃掉终止符。
 */

/** 「中」的 GBK 编码是 D6 D0：trail 0xD0 ≥ 0xC0，旧判据恰好漏掉。 */
const ZHONG = "中";
/** 「亐」的 GBK 编码 trail 在 0x80–0xBF，旧判据会多退一格吞掉整字。 */
const YU = "亐";

/**
 * 截断产物必须是「合法的 GBK 前缀」：要么以 ASCII 结尾，要么以完整的
 * 双字节字符结尾（末字节不是悬空 lead byte）。孤立 lead byte 在远端
 * 会把后续字节（包括终止符）配对吞掉，比 U+FFFD 更隐蔽，所以直接
 * 检查字节形状，而不是依赖 decodeGbk 报错。
 */
function cutsOnBoundary(fitted: Buffer): boolean {
  if (fitted.length === 0) return true;
  const last = fitted[fitted.length - 1]!;
  if (last < 0x80) return true;
  // 末字节是高位字节：向前数连续高位字节的个数，奇数 = 悬空 lead。
  let run = 0;
  let index = fitted.length;
  while (index > 0 && fitted[index - 1]! >= 0x80) {
    run += 1;
    index -= 1;
  }
  return run % 2 === 0;
}

function roundTrips(text: string, size: number): boolean {
  return cutsOnBoundary(fitUtf8(text, size));
}

describe("fitUtf8 GBK 边界截断（T-021）", () => {
  it("trail ≥ 0xC0 的常用汉字不被劈断（旧实现劈）", () => {
    // D6 D0：size=1 时旧实现留下孤立 lead byte D6。
    expect(encodeGbk(ZHONG)).toEqual(Buffer.from([0xd6, 0xd0]));
    expect(roundTrips(ZHONG + "a".repeat(10), 1)).toBe(true);
    expect(roundTrips(ZHONG.repeat(5) + "a".repeat(10), 6)).toBe(true);
  });

  it("trail 在 0x80–0xBF 的字符不被整字吞掉", () => {
    const bytes = encodeGbk(YU);
    expect(bytes.length).toBe(2);
    expect(roundTrips(YU + "a".repeat(10), 1)).toBe(true);
  });

  it("各种 size 下截断产物都切在字符边界（扫 100 个 size × 常用字）", () => {
    const sample = "中文测试组名嵌入式调试串口调试寄存器断点仿真固件";
    for (let size = 1; size <= 100; size++) {
      const fitted = fitUtf8(sample.repeat(3), size);
      expect(cutsOnBoundary(fitted), `size=${size} ends with a dangling lead byte`).toBe(true);
    }
  });

  it("不超长时原样返回，不丢任何字节", () => {
    expect(fitUtf8("中文", 16)).toEqual(encodeGbk("中文"));
    expect(fitUtf8("ascii", 16)).toEqual(Buffer.from("ascii", "latin1"));
  });

  it("sstr 的长度字段与内容一致且可读回（截断点在边界）", () => {
    const text = "中文组名" + "x".repeat(300); // 强制截断
    const payload = sstr(text, 16);
    const declared = payload.readInt32LE(0);
    const back = readSstr(payload, 0);
    // 长度字段按字节（含终止符）；读回的是文本，字节数 = declared - 1。
    expect(encodeGbk(back).length + 1).toBe(declared);
    expect(cutsOnBoundary(encodeGbk(back))).toBe(true);
  });
});
