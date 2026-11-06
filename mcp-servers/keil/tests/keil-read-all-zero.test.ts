import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKeilTools, KEIL_ALL_ZERO_WARNING } from "../tools.js";
import {
  registerSessionForTest,
  resetSessionsForTest,
  setUv4PathForTest,
  type KeilSession,
} from "../keilSession.js";
import { OP, type Reply } from "../uvsock.js";

/**
 * Keil 的 `read` 缺全 0 警告，与 probe 两个后端不一致（OPT-06 / R3）。
 * 这里用注入的假会话走真实 `keil_debug` handler，不连 4823、不启动 UV4。
 */

const tools = createKeilTools();
const debug = tools.find((tool) => tool.name === "keil_debug")!;

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

interface Calls {
  commands: number[];
}

/**
 * A registered, in-debug session whose memory read is answered by `answer`.
 * `openKeilSession` reuses it, so the real tool path runs end to end offline.
 */
function installSession(project: string, answer: (address: number, length: number) => Reply | null): Calls {
  const calls: Calls = { commands: [] };
  const session: KeilSession = {
    client: {
      closed: false,
      mark: 0,
      send: async (command: number, payload: Buffer) => {
        calls.commands.push(command);
        if (command !== OP.DBG_MEM_READ) return { status: 0, statusName: "SUCCESS", ok: true, data: Buffer.alloc(0) };
        const reply = answer(Number(payload.readBigUInt64LE(0)), payload.readUInt32LE(8));
        return reply ?? { status: 5, statusName: "NOT_DEBUGGING", ok: false, data: Buffer.alloc(0), message: "NOT_DEBUGGING" };
      },
    } as unknown as KeilSession["client"],
    project,
    debugging: true,
    target: "hardware",
    extended: true,
    openedAt: 0,
  };
  registerSessionForTest(session);
  return calls;
}

let dir: string;
let project: string;
beforeEach(() => {
  resetSessionsForTest();
  setUv4PathForTest("C:/fake-keil/UV4/UV4.exe");
  dir = mkdtempSync(join(tmpdir(), "keil-read-"));
  project = join(dir, "DEMO.uvprojx");
  writeFileSync(project, "<Project/>", "utf8");
});
afterEach(() => {
  resetSessionsForTest();
  setUv4PathForTest(undefined);
  rmSync(dir, { recursive: true, force: true });
});

type Structured = { memoryRead?: { address: number; bytes: number[]; allZero?: boolean; warning?: string; reliable?: boolean; errorAddress?: number } };

describe("keil read 的全 0 语义与 probe 一致", () => {
  it("全 0：文本与结构化结果都带警告，且标 reliable: false", async () => {
    installSession(project, (address) => memoryReply(address, [0, 0, 0, 0]));
    const result = await debug.handler({ action: "read", project, address: 0x20000000, width: "u32", count: 1 });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toMatchObject({ type: "text" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("warning");
    expect(text).toContain(KEIL_ALL_ZERO_WARNING);
    expect(text).toContain("not evidence the value is 0");
    const structured = result.structuredContent as Structured;
    expect(structured.memoryRead).toMatchObject({
      address: 0x20000000,
      allZero: true,
      warning: KEIL_ALL_ZERO_WARNING,
      reliable: false,
    });
  });

  it("非全 0：没有警告，reliable 为 true", async () => {
    installSession(project, (address) => memoryReply(address, [0x08, 0x00, 0x00, 0x20]));
    const result = await debug.handler({ action: "read", project, address: 0x20000000, width: "u32", count: 1 });
    const text = (result.content[0] as { text: string }).text;
    expect(text).not.toContain(KEIL_ALL_ZERO_WARNING);
    expect(text).not.toContain("warning");
    const structured = result.structuredContent as Structured;
    expect(structured.memoryRead).toMatchObject({ reliable: true });
    expect(structured.memoryRead?.allZero).toBeUndefined();
    expect(structured.memoryRead?.warning).toBeUndefined();
  });

  it("全 0 且带 errorAddress：警告里点名被拒绝的地址，并保持 reliable: false", async () => {
    installSession(project, (address) => memoryReply(address, [0, 0, 0, 0], 0x20001000));
    const result = await debug.handler({ action: "read", project, address: 0x20000000, width: "u32", count: 1 });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain(KEIL_ALL_ZERO_WARNING);
    expect(text).toContain("the bus refused access at 0x20001000");
    const structured = result.structuredContent as Structured;
    expect(structured.memoryRead?.errorAddress).toBe(0x20001000);
    expect(structured.memoryRead?.reliable).toBe(false);
  });

  it("读失败仍然显式报错，不被全 0 逻辑吞掉", async () => {
    installSession(project, () => null);
    const result = await debug.handler({ action: "read", project, address: 0x20000000, width: "u32", count: 1 });
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("could not read 4 byte(s) at 0x20000000");
    expect((result.structuredContent as Structured).memoryRead).toBeUndefined();
  });

  it("空回复不是全 0：不给全 0 警告，但也不得标成 reliable", async () => {
    installSession(project, (address) => memoryReply(address, []));
    const result = await debug.handler({ action: "read", project, address: 0x20000000, width: "u32", count: 1 });
    const text = (result.content[0] as { text: string }).text;
    expect(text).not.toContain(KEIL_ALL_ZERO_WARNING);
    const structured = result.structuredContent as Structured;
    expect(structured.memoryRead).toMatchObject({ reliable: false });
  });
});
