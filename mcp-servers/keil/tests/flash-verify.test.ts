import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FLASH_VERIFY_BUDGET_MS,
  FLASH_VERIFY_MAX_BYTES,
  FLASH_VERIFY_SPOT_BYTES,
  verifyFlash,
  type KeilSession,
} from "../keilSession.js";
import { OP, type Reply } from "../uvsock.js";

/**
 * `verifyFlash` 说话必须带范围：默认只比镜像起始处 64 字节，却被当作「整镜像
 * 回读校验」报告过（OPT-06 / R3）。这里全部用假会话与临时 `.hex`，不连 Keil。
 */

const IMAGE_START = 0x08000000;

function hexLine(type: number, offset: number, bytes: number[]): string {
  const body = [bytes.length, (offset >> 8) & 0xff, offset & 0xff, type, ...bytes];
  const checksum = (-body.reduce((sum, byte) => sum + byte, 0)) & 0xff;
  return ":" + [...body, checksum].map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

/** An Intel HEX file holding `image`, mapped at `start`. */
function writeHex(dir: string, image: number[], start = IMAGE_START): string {
  const upper = (start >>> 16) & 0xffff;
  const lines = [hexLine(0x04, 0, [(upper >> 8) & 0xff, upper & 0xff])];
  // 16-byte records, and the images in these tests stay below one 64 KiB
  // window, so the low offset never wraps.
  for (let offset = 0; offset < image.length; offset += 16) {
    lines.push(hexLine(0x00, (start & 0xffff) + offset, image.slice(offset, offset + 16)));
  }
  const file = join(dir, "DEMO.hex");
  writeFileSync(file, lines.join("\n") + "\n", "latin1");
  return file;
}

function memoryReply(address: number, bytes: number[], errorAddress?: number): Reply {
  const data = Buffer.alloc(24 + bytes.length);
  data.writeBigUInt64LE(BigInt(address), 0);
  data.writeUInt32LE(bytes.length, 8);
  data.writeBigUInt64LE(BigInt(errorAddress ?? 0), 12);
  data.writeUInt32LE(errorAddress === undefined ? 0 : 1, 20);
  bytes.forEach((byte, index) => {
    data[24 + index] = byte;
  });
  return { status: 0, statusName: "SUCCESS", ok: true, data };
}

function sessionReturning(handler: (address: number, length: number) => Reply): KeilSession {
  return {
    client: {
      closed: false,
      send: async (command: number, payload: Buffer) => {
        expect(command).toBe(OP.DBG_MEM_READ);
        return handler(Number(payload.readBigUInt64LE(0)), payload.readUInt32LE(8));
      },
    } as unknown as KeilSession["client"],
    project: "C:/proj/DEMO.uvprojx",
    debugging: true,
    target: "hardware",
    extended: false,
    openedAt: 0,
  };
}

/** A session whose flash reads back the same bytes the `.hex` holds. */
function sessionEchoing(image: number[]): KeilSession {
  return sessionReturning((address, length) =>
    memoryReply(address, Array.from({ length }, (_, index) => image[address - IMAGE_START + index] ?? 0)),
  );
}

const pattern = (length: number): number[] => Array.from({ length }, (_, index) => (index + 1) & 0xff);

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "keil-verify-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("verifyFlash 报告的是实际比对范围", () => {
  it("默认 64 字节，结果必须写清「前 64 / 共 256，其余未比对」", async () => {
    const image = pattern(256);
    const result = await verifyFlash(sessionEchoing(image), writeHex(dir, image));
    expect(result.ok).toBe(true);
    expect(result.scope).toBe("spot");
    expect(result.bytes).toBe(FLASH_VERIFY_SPOT_BYTES);
    expect(result.imageBytes).toBe(256);
    expect(result.requestedBytes).toBe(FLASH_VERIFY_SPOT_BYTES);
    expect(result.detail).toContain("first 64 of 256 image byte(s)");
    expect(result.detail).toContain("NOT compared");
  });

  it("调用方显式要求全部镜像时，scope 才允许是 full", async () => {
    const image = pattern(256);
    const result = await verifyFlash(sessionEchoing(image), writeHex(dir, image), 256);
    expect(result.ok).toBe(true);
    expect(result.scope).toBe("full");
    expect(result.bytes).toBe(256);
    expect(result.imageBytes).toBe(256);
    expect(result.detail).toContain("every byte of the image (256)");
  });

  it("镜像本身不足 64 字节时，默认请求已经覆盖整张镜像，如实标 full", async () => {
    const image = pattern(10);
    const result = await verifyFlash(sessionEchoing(image), writeHex(dir, image));
    expect(result.scope).toBe("full");
    expect(result.bytes).toBe(10);
    expect(result.imageBytes).toBe(10);
  });

  it("请求超过 0x2000 时按段读完整张镜像，scope 是 segmented-full", async () => {
    const image = pattern(FLASH_VERIFY_MAX_BYTES + 808);
    const result = await verifyFlash(sessionEchoing(image), writeHex(dir, image), 100_000);
    expect(result.ok).toBe(true);
    expect(result.scope).toBe("segmented-full");
    expect(result.bytes).toBe(image.length);
    expect(result.segments).toBe(2);
    expect(result.imageBytes).toBe(image.length);
    expect(result.requestedBytes).toBe(100_000);
  });

  it("不一致时说明第几个字节，并标明只是抽检", async () => {
    const image = pattern(256);
    const corrupted = [...image];
    corrupted[3] = 0xee;
    const result = await verifyFlash(sessionEchoing(corrupted), writeHex(dir, image));
    expect(result.ok).toBe(false);
    expect(result.scope).toBe("spot");
    expect(result.detail).toContain("byte 4 of 64 compared");
    expect(result.detail).toContain("spot check only");
    expect(result.expected).toBeDefined();
    expect(result.got).toBeDefined();
  });

  it("读不回时 scope 是 none，不能伪装成抽检通过", async () => {
    const image = pattern(256);
    const session = sessionReturning(() => ({
      status: 5,
      statusName: "NOT_DEBUGGING",
      ok: false,
      data: Buffer.alloc(0),
      message: "NOT_DEBUGGING",
    }));
    const result = await verifyFlash(session, writeHex(dir, image));
    expect(result.ok).toBe(false);
    expect(result.scope).toBe("none");
    expect(result.bytes).toBe(0);
    expect(result.detail).toContain("could not read flash");
  });
});

/**
 * 整镜像分段回读（D-223）：一次 `DBG_MEM_READ` 只能取 0x2000 字节，所以更大的
 * 请求必须分段——否则后段损坏（烧录掉电、flash 坏块）永远看不见。
 */
describe("verifyFlash 按 0x2000 分段读完整张镜像", () => {
  const SEGMENT = FLASH_VERIFY_MAX_BYTES;

  /** How many reads the session received, and at which addresses. */
  function countingSession(image: number[], onRead?: (address: number) => Reply | undefined) {
    const reads: { address: number; length: number }[] = [];
    const session = sessionReturning((address, length) => {
      reads.push({ address, length });
      return onRead?.(address) ?? memoryReply(address, Array.from({ length }, (_, index) => image[address - IMAGE_START + index] ?? 0));
    });
    return { session, reads };
  }

  it("32 KiB 镜像按 4 段全部比完，scope 是 segmented-full", async () => {
    const image = pattern(32 * 1024);
    const { session, reads } = countingSession(image);
    const result = await verifyFlash(session, writeHex(dir, image), 32 * 1024);
    expect(result.ok).toBe(true);
    expect(result.scope).toBe("segmented-full");
    expect(result.bytes).toBe(32 * 1024);
    expect(result.segments).toBe(4);
    expect(result.imageBytes).toBe(32 * 1024);
    // Each read is one 0x2000-byte segment, in ascending address order.
    expect(reads).toEqual([
      { address: IMAGE_START, length: SEGMENT },
      { address: IMAGE_START + SEGMENT, length: SEGMENT },
      { address: IMAGE_START + 2 * SEGMENT, length: SEGMENT },
      { address: IMAGE_START + 3 * SEGMENT, length: SEGMENT },
    ]);
    // Nothing to quote back when every byte matches: a whole-image dump is
    // 65 536 hex characters and says nothing more than the detail does.
    expect(result.expected).toBeUndefined();
    expect(result.got).toBeUndefined();
  });

  it("第 3 段有一字节损坏时，offset 是镜像内的全局位置", async () => {
    const image = pattern(32 * 1024);
    const corrupted = [...image];
    const corruptAt = 2 * SEGMENT + 0x100; // inside the third segment
    corrupted[corruptAt] = 0xee;
    const { session, reads } = countingSession(corrupted);
    const result = await verifyFlash(session, writeHex(dir, image), 32 * 1024);
    expect(result.ok).toBe(false);
    // The verdict is decided at the first bad byte, so the read stops there:
    // three of four segments were covered, which is a spot check, not a
    // whole-image comparison.
    expect(result.scope).toBe("spot");
    expect(result.bytes).toBe(3 * SEGMENT);
    expect(reads).toHaveLength(3);
    // Not 0x100 (segment-relative): the message must name a flash address.
    expect(result.detail).toContain(`0x${(IMAGE_START + corruptAt).toString(16)}`);
    expect(result.detail).toContain(`byte ${corruptAt + 1} of ${3 * SEGMENT} compared`);
    expect(result.detail).toContain("3 segment(s) of 4 read back");
    // The dump is the offending segment only, not the whole image.
    expect(result.expected!.split(" ")).toHaveLength(SEGMENT);
    expect(result.got!.split(" ")).toHaveLength(SEGMENT);
    expect(result.expected!.split(" ")[0x100]).toBe(image[corruptAt]!.toString(16).padStart(2, "0"));
    expect(result.got!.split(" ")[0x100]).toBe("ee");
  });

  it("第 2 段读不回时 scope 是 none，bytes 是第 1 段已经比对的字节数", async () => {
    const image = pattern(32 * 1024);
    const { session, reads } = countingSession(image, (address) =>
      address === IMAGE_START + SEGMENT
        ? { status: 5, statusName: "NOT_DEBUGGING", ok: false, data: Buffer.alloc(0), message: "NOT_DEBUGGING" }
        : undefined,
    );
    const result = await verifyFlash(session, writeHex(dir, image), 32 * 1024);
    expect(result.ok).toBe(false);
    expect(result.scope).toBe("none");
    expect(result.bytes).toBe(SEGMENT);
    expect(result.segments).toBe(2);
    expect(result.detail).toContain(`0x${(IMAGE_START + SEGMENT).toString(16)}`);
    expect(result.detail).toContain("segment 2 of 4 could not be read back after 8192 byte(s) were compared");
    // It stopped at the failed segment: the third was never requested.
    expect(reads).toHaveLength(2);
  });

  it("镜像中间有地址空洞时停在空洞前，scope 是 spot 并说明只覆盖到哪", async () => {
    // Two record runs in the same `.hex`: 3 × 0x2000 of data, a 0x100-byte
    // hole, then 1 KiB. The comparison stops at the hole and the bytes past
    // it are not compared.
    const head = pattern(3 * SEGMENT);
    const hole = 0x100;
    const tail = pattern(1024).map((byte) => (byte + 7) & 0xff);
    const file = join(dir, "DEMO.hex");
    const upper = (IMAGE_START >>> 16) & 0xffff;
    const lines = [hexLine(0x04, 0, [(upper >> 8) & 0xff, upper & 0xff])];
    for (let offset = 0; offset < head.length; offset += 16) {
      lines.push(hexLine(0x00, (IMAGE_START & 0xffff) + offset, head.slice(offset, offset + 16)));
    }
    for (let offset = 0; offset < tail.length; offset += 16) {
      lines.push(hexLine(0x00, (IMAGE_START & 0xffff) + head.length + hole + offset, tail.slice(offset, offset + 16)));
    }
    writeFileSync(file, lines.join("\n") + "\n", "latin1");
    const memory = [...head, ...new Array<number>(hole).fill(0), ...tail];
    const result = await verifyFlash(sessionEchoing(memory), file, 32 * 1024);
    expect(result.ok).toBe(true);
    expect(result.scope).toBe("spot");
    expect(result.bytes).toBe(head.length);
    // Three 0x2000 segments up to the hole; the bytes past it were never read.
    expect(result.segments).toBe(3);
    expect(result.imageBytes).toBe(head.length + tail.length);
    expect(result.detail).toContain(`the first ${head.length} of ${head.length + tail.length} image byte(s)`);
    expect(result.detail).toContain(`the image has an address gap at 0x${(IMAGE_START + head.length).toString(16)}`);
  });

  it("count 超过镜像长度时只比镜像内的地址，且仍算完整", async () => {
    const image = pattern(2 * SEGMENT + 100);
    const { session, reads } = countingSession(image);
    const result = await verifyFlash(session, writeHex(dir, image), 100_000);
    expect(result.ok).toBe(true);
    expect(result.scope).toBe("segmented-full");
    expect(result.bytes).toBe(image.length);
    expect(result.imageBytes).toBe(image.length);
    expect(result.segments).toBe(3);
    // The last read asks for the remainder, not for a whole segment past the end.
    expect(reads[2]).toEqual({ address: IMAGE_START + 2 * SEGMENT, length: 100 });
  });

  it("请求 5000（< 0x2000）与今天完全一致，不出现 segmented-full 与 segments", async () => {
    const image = pattern(10_000);
    const { session, reads } = countingSession(image);
    const result = await verifyFlash(session, writeHex(dir, image), 5000);
    expect(result.ok).toBe(true);
    expect(result.scope).toBe("spot");
    expect(result.bytes).toBe(5000);
    expect(result.imageBytes).toBe(image.length);
    expect(result.segments).toBeUndefined();
    // One read, exactly as before the segmentation existed.
    expect(reads).toEqual([{ address: IMAGE_START, length: 5000 }]);
  });

  it("总预算到点后停止继续读，按部分处理并说明停在第几段", async () => {
    const image = pattern(4 * SEGMENT);
    const { session, reads } = countingSession(image);
    // A budget of 0 is spent before the second read; the first always happens.
    const result = await verifyFlash(session, writeHex(dir, image), 4 * SEGMENT, 0);
    expect(result.ok).toBe(true);
    expect(result.scope).toBe("spot");
    expect(result.bytes).toBe(SEGMENT);
    expect(result.segments).toBe(1);
    expect(reads).toHaveLength(1);
    expect(result.detail).toContain(`stopped at the 0 ms read-back budget after 1 segment(s)`);
  });
});
