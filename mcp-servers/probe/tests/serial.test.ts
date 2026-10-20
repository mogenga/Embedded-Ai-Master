import { describe, expect, it } from "vitest";
import { ProbeBackendError } from "../backend.js";
import { MAX_SERIAL_BUFFER_BYTES, SERIAL_OVERFLOW_WARNING, TcpSerial } from "../serial.js";
import type { SerialSocket } from "../serial.js";

class FakeSocket implements SerialSocket {
  readonly writes: Buffer[] = [];
  closed = false;

  private readonly dataListeners: Array<(chunk: Buffer) => void> = [];
  private readonly closeListeners: Array<() => void> = [];

  write(data: Buffer): void {
    this.writes.push(Buffer.from(data));
  }

  onData(listener: (chunk: Buffer) => void): void {
    this.dataListeners.push(listener);
  }

  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  close(): void {
    this.closed = true;
    for (const listener of this.closeListeners) listener();
  }

  emitData(chunk: Buffer | number[]): void {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    for (const listener of this.dataListeners) listener(data);
  }
}

interface Harness {
  serial: TcpSerial;
  sockets: FakeSocket[];
  connections: Array<{ host: string; port: number }>;
}

function createHarness(): Harness {
  const sockets: FakeSocket[] = [];
  const connections: Array<{ host: string; port: number }> = [];
  const serial = new TcpSerial(async (host, port) => {
    connections.push({ host, port });
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  });
  return { serial, sockets, connections };
}

async function opened(): Promise<{ harness: Harness; socket: FakeSocket }> {
  const harness = createHarness();
  await harness.serial.open("127.0.0.1", 4321);
  const socket = harness.sockets[0];
  if (!socket) throw new Error("未创建 fake socket");
  return { harness, socket };
}

describe("TcpSerial", () => {
  it("open 连接指定 host/port 并报告 open 状态", async () => {
    const { harness, socket } = await opened();

    expect(harness.connections).toEqual([{ host: "127.0.0.1", port: 4321 }]);
    expect(harness.serial.status()).toEqual({
      open: true,
      host: "127.0.0.1",
      port: 4321,
      bytesRead: 0,
      bytesWritten: 0,
    });

    await harness.serial.open("127.0.0.1", 4321);
    expect(harness.connections).toHaveLength(1);
    expect(socket.closed).toBe(false);
  });

  it("read 等待分片数据并保留未消费字节", async () => {
    const { harness, socket } = await opened();

    const pending = harness.serial.read(4, 100);
    socket.emitData([0x41]);
    socket.emitData([0x42, 0x43]);

    await expect(pending).resolves.toEqual({ bytes: [0x41], timedOut: false });
    await expect(harness.serial.read(4, 100)).resolves.toEqual({
      bytes: [0x42, 0x43],
      timedOut: false,
    });
  });

  it("read 返回最多 maxBytes，剩余留在缓冲", async () => {
    const { harness, socket } = await opened();
    socket.emitData([1, 2, 3, 4, 5]);

    await expect(harness.serial.read(2, 10)).resolves.toEqual({
      bytes: [1, 2],
      timedOut: false,
    });
    await expect(harness.serial.read(2, 10)).resolves.toEqual({
      bytes: [3, 4],
      timedOut: false,
    });
    await expect(harness.serial.read(2, 10)).resolves.toEqual({
      bytes: [5],
      timedOut: false,
    });
  });

  it("无数据时 read 超时返回 timedOut 且字节为空", async () => {
    const { harness } = await opened();

    const result = await harness.serial.read(8, 10);

    expect(result).toEqual({ bytes: [], timedOut: true });
  });

  it("write 返回写入长度并透传给 socket", async () => {
    const { harness, socket } = await opened();

    const written = await harness.serial.write(Buffer.from("ping"));

    expect(written).toBe(4);
    expect(socket.writes.map((chunk) => chunk.toString("utf8"))).toEqual(["ping"]);
    expect(harness.serial.status().bytesWritten).toBe(4);
  });

  it("close 关闭 socket 后 status().open 为 false", async () => {
    const { harness, socket } = await opened();
    socket.emitData([7]);

    await harness.serial.close();

    expect(socket.closed).toBe(true);
    expect(harness.serial.status().open).toBe(false);
    await expect(harness.serial.read(1, 10)).rejects.toBeInstanceOf(ProbeBackendError);
  });

  it("缓冲超过 64 KiB 时丢弃最旧数据并标注 overflow warning", async () => {
    const { harness, socket } = await opened();
    const total = MAX_SERIAL_BUFFER_BYTES + 3;
    const chunk = Buffer.alloc(total);
    for (let index = 0; index < total; index += 1) chunk[index] = index & 0xff;

    socket.emitData(chunk);
    const result = await harness.serial.read(4, 10);

    expect(result.bytes).toEqual(Array.from(chunk.subarray(3, 7)));
    expect(result.timedOut).toBe(false);
    expect(result.warning).toBe(SERIAL_OVERFLOW_WARNING);

    const next = await harness.serial.read(4, 10);
    expect(next.warning).toBeUndefined();
  });

  it("未打开时 read/write 抛 backend_error", async () => {
    const harness = createHarness();

    for (const call of [
      harness.serial.read(1, 1),
      harness.serial.write(Buffer.from("x")),
    ]) {
      const error = await call.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ProbeBackendError);
      expect((error as ProbeBackendError).code).toBe("backend_error");
    }
  });

  it("连接关闭时挂起的 read 显式报错", async () => {
    const { harness, socket } = await opened();

    const pending = harness.serial.read(4, 1000);
    socket.close();

    await expect(pending).rejects.toBeInstanceOf(ProbeBackendError);
    expect(harness.serial.status().open).toBe(false);
  });
});