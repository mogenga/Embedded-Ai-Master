import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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

  it("单次回读上限 0x2000：请求更大也只比 8192 字节，并标注 spot", async () => {
    const image = pattern(FLASH_VERIFY_MAX_BYTES + 808);
    const result = await verifyFlash(sessionEchoing(image), writeHex(dir, image), 100_000);
    expect(result.scope).toBe("spot");
    expect(result.bytes).toBe(FLASH_VERIFY_MAX_BYTES);
    expect(result.imageBytes).toBe(image.length);
    expect(result.requestedBytes).toBe(100_000);
    expect(result.detail).toContain(`first ${FLASH_VERIFY_MAX_BYTES} of ${image.length}`);
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
