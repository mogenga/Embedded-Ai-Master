import { describe, expect, it } from "vitest";
import { ProbeBackendError } from "../backend.js";
import type { SerialStatus } from "../backend.js";
import { RenodeBackend } from "../renode-backend.js";
import type { RenodeMonitorLike, SerialClientLike } from "../renode-backend.js";
import { RenodeCommandError } from "../renode.js";
import type { RenodeMonitorOptions } from "../renode.js";

const DEFAULT_PLATFORM_COMMAND =
  "machine LoadPlatformDescription @platforms/boards/stm32f4_discovery-kit.repl";

type CommandHandler = (command: string) => string | Promise<string>;

class FakeMonitor implements RenodeMonitorLike {
  readonly commands: string[] = [];
  readonly options: RenodeMonitorOptions;
  connected = false;
  startCount = 0;
  stopCount = 0;

  constructor(
    private readonly handler: CommandHandler,
    options: RenodeMonitorOptions,
  ) {
    this.options = options;
  }

  async start(): Promise<void> {
    this.startCount += 1;
    this.connected = true;
  }

  async send(command: string): Promise<string> {
    this.commands.push(command);
    return this.handler(command);
  }

  async stop(): Promise<void> {
    this.stopCount += 1;
    this.connected = false;
  }
}

class FakeSerial implements SerialClientLike {
  readonly openCalls: Array<{ host: string; port: number }> = [];
  readonly writes: Buffer[] = [];
  closeCount = 0;
  readResult: { bytes: number[]; timedOut: boolean; warning?: string } = {
    bytes: [0x41],
    timedOut: false,
  };

  private socketOpen = false;
  private host?: string;
  private port?: number;

  async open(host: string, port: number): Promise<void> {
    this.openCalls.push({ host, port });
    this.socketOpen = true;
    this.host = host;
    this.port = port;
  }

  async read(): Promise<{ bytes: number[]; timedOut: boolean; warning?: string }> {
    return this.readResult;
  }

  async write(data: Buffer): Promise<number> {
    this.writes.push(Buffer.from(data));
    return data.length;
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    this.socketOpen = false;
  }

  status(): SerialStatus {
    return {
      open: this.socketOpen,
      host: this.host,
      port: this.port,
      bytesRead: 0,
      bytesWritten: this.writes.reduce((sum, chunk) => sum + chunk.length, 0),
    };
  }
}

interface Harness {
  backend: RenodeBackend;
  monitors: FakeMonitor[];
  options: RenodeMonitorOptions[];
}

function createHarness(
  handler: CommandHandler,
  serialFactory?: () => SerialClientLike,
): Harness {
  const monitors: FakeMonitor[] = [];
  const options: RenodeMonitorOptions[] = [];
  const backend = new RenodeBackend({
    renodePath: "C:/fake/Renode.exe",
    serialFactory,
    monitorFactory: (monitorOptions) => {
      options.push(monitorOptions);
      const monitor = new FakeMonitor(handler, monitorOptions);
      monitors.push(monitor);
      return monitor;
    },
  });
  return { backend, monitors, options };
}

function readByteHandler(initial: ReadonlyMap<number, number>): CommandHandler {
  const memory = new Map(initial);
  return (command) => {
    const write = /^sysbus WriteByte 0x([0-9a-f]+) 0x([0-9a-f]+)$/.exec(command);
    if (write) {
      memory.set(Number.parseInt(write[1], 16), Number.parseInt(write[2], 16));
      return "";
    }
    const read = /^sysbus ReadByte 0x([0-9a-f]+)$/.exec(command);
    if (read) {
      const value = memory.get(Number.parseInt(read[1], 16)) ?? 0;
      return `0x${value.toString(16)}`;
    }
    return "";
  };
}


describe("RenodeBackend", () => {
  it("attach 发送 mach create 与平台描述命令并进入 attached", async () => {
    const harness = createHarness(() => "");
    const status = await harness.backend.attach();

    expect(status).toEqual({
      backend: "renode",
      probe: "attached",
      cpu: "unknown",
      serial: "closed",
    });
    expect(harness.monitors).toHaveLength(1);
    expect(harness.monitors[0].commands).toEqual(["mach create", DEFAULT_PLATFORM_COMMAND]);
    expect(harness.options[0].renodePath).toBe("C:/fake/Renode.exe");
    expect(harness.monitors[0].startCount).toBe(1);
  });

  it("attach 接受自定义 platform 并补全 @ 前缀", async () => {
    const harness = createHarness(() => "");
    await harness.backend.attach({ platform: "@platforms/boards/custom.repl" });

    expect(harness.monitors[0].commands[1]).toBe(
      "machine LoadPlatformDescription @platforms/boards/custom.repl",
    );
  });

  it("attach 幂等：已连接时不重复创建 monitor 或发送命令", async () => {
    const harness = createHarness(() => "");
    const first = await harness.backend.attach();
    const second = await harness.backend.attach();

    expect(second).toEqual(first);
    expect(harness.monitors).toHaveLength(1);
    expect(harness.monitors[0].commands).toEqual(["mach create", DEFAULT_PLATFORM_COMMAND]);
    expect(harness.monitors[0].startCount).toBe(1);
  });

  it("halt/resume/reset 发送 pause/start/machine Reset 并更新 CPU 状态", async () => {
    const harness = createHarness(() => "");
    await harness.backend.attach();

    await harness.backend.halt();
    expect(harness.monitors[0].commands.at(-1)).toBe("pause");
    expect(harness.backend.status().cpu).toBe("halted");

    await harness.backend.resume();
    expect(harness.monitors[0].commands.at(-1)).toBe("start");
    expect(harness.backend.status().cpu).toBe("running");

    const reset = await harness.backend.reset();
    expect(harness.monitors[0].commands.at(-1)).toBe("machine Reset");
    expect(reset.declaration).toEqual({
      operation: "reset",
      effect: "reset target CPU and peripherals",
    });
  });

  it("readMemory 逐字节发送 ReadByte，按地址升序返回字节与小端 u32", async () => {
    const harness = createHarness(
      readByteHandler(
        new Map([
          [0x20000000, 0x12],
          [0x20000001, 0x34],
          [0x20000002, 0x56],
          [0x20000003, 0x78],
        ]),
      ),
    );
    await harness.backend.attach();

    const result = await harness.backend.readMemory(0x20000000, 4);

    expect(result).toEqual({
      address: 0x20000000,
      bytes: [0x12, 0x34, 0x56, 0x78],
      hex: "12345678",
      allZero: false,
    });
    const [b0, b1, b2, b3] = result.bytes;
    const u32 = ((b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0) >>> 0;
    expect(u32).toBe(0x78563412);

    expect(harness.monitors[0].commands.slice(2)).toEqual([
      "sysbus ReadByte 0x20000000",
      "sysbus ReadByte 0x20000001",
      "sysbus ReadByte 0x20000002",
      "sysbus ReadByte 0x20000003",
    ]);
  });

  it("全 0 读取返回 allZero 与 warning，不推断无故障", async () => {
    const harness = createHarness(() => "0x00");
    await harness.backend.attach();

    const result = await harness.backend.readMemory(0x20000000, 4);

    expect(result.allZero).toBe(true);
    expect(result.warning).toBe("renode_all_zero_or_unmapped");
    expect(result.bytes).toEqual([0, 0, 0, 0]);
    expect(result.hex).toBe("00000000");
  });

  it("writeMemory 返回 declaration 并写后回读校验", async () => {
    const harness = createHarness(readByteHandler(new Map()));
    await harness.backend.attach();

    const result = await harness.backend.writeMemory(0x20000000, [0xde, 0xad]);

    expect(result.declaration).toEqual({
      operation: "mem_write",
      address: 0x20000000,
      length: 2,
      effect: "overwrite target memory",
    });
    expect(result.verified.bytes).toEqual([0xde, 0xad]);
    expect(harness.monitors[0].commands.slice(2)).toEqual([
      "sysbus WriteByte 0x20000000 0xde",
      "sysbus WriteByte 0x20000001 0xad",
      "sysbus ReadByte 0x20000000",
      "sysbus ReadByte 0x20000001",
    ]);
  });

  it("写后回读不一致时抛 verification_failed 而不是返回成功", async () => {
    const harness = createHarness((command) => {
      if (command.startsWith("sysbus WriteByte")) return "";
      if (command.startsWith("sysbus ReadByte")) return "0x00";
      return "";
    });
    await harness.backend.attach();

    const error = await harness.backend
      .writeMemory(0x20000000, [0xde, 0xad])
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProbeBackendError);
    expect((error as ProbeBackendError).code).toBe("verification_failed");
  });

  it("monitor 报错时原样 reject，不吞错", async () => {
    const boom = new RenodeCommandError("pause", "boom");
    const harness = createHarness((command) => {
      if (command === "pause") throw boom;
      return "";
    });
    await harness.backend.attach();

    const error = await harness.backend.halt().catch((caught: unknown) => caught);

    expect(error).toBe(boom);
  });

  it("ReadByte 输出无法解析时报 backend_error", async () => {
    const harness = createHarness((command) => {
      if (command.startsWith("sysbus ReadByte")) return "not-a-byte";
      return "";
    });
    await harness.backend.attach();

    const error = await harness.backend
      .readMemory(0x20000000, 1)
      .catch((caught: unknown) => caught);

    expect((error as ProbeBackendError).code).toBe("backend_error");
  });

  it("未 attach 调用设备方法抛 not_attached", async () => {
    const harness = createHarness(() => "");

    const error = await harness.backend
      .readMemory(0x20000000, 1)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProbeBackendError);
    expect((error as ProbeBackendError).code).toBe("not_attached");
    expect(harness.backend.status().probe).toBe("detached");
    expect(harness.monitors).toHaveLength(0);
  });

  it.each([
    { address: -1, length: 1 },
    { address: 0x1_0000_0000, length: 1 },
    { address: 1.5, length: 1 },
    { address: 0x20000000, length: 0 },
    { address: 0x20000000, length: 257 },
    { address: 0x20000000, length: 1.5 },
  ])("非法地址/长度 $address/$length 抛 invalid_argument", async ({ address, length }) => {
    const harness = createHarness(() => "0x00");
    await harness.backend.attach();

    const error = await harness.backend
      .readMemory(address, length)
      .catch((caught: unknown) => caught);

    expect((error as ProbeBackendError).code).toBe("invalid_argument");
    expect(harness.monitors[0].commands).toHaveLength(2);
  });

  it("detach 发送 quit、停止 monitor 并回到 detached", async () => {
    const harness = createHarness(() => "");
    await harness.backend.attach();

    await harness.backend.detach();

    expect(harness.monitors[0].commands.at(-1)).toBe("quit");
    expect(harness.monitors[0].stopCount).toBe(1);
    expect(harness.backend.status()).toEqual({
      backend: "none",
      probe: "detached",
      cpu: "unknown",
      serial: "closed",
    });

    await expect(harness.backend.detach()).resolves.toBeUndefined();
    expect(harness.monitors[0].stopCount).toBe(1);
  });

  it("serial_open 先创建 socket 终端并连接，重复 open 幂等", async () => {
    const serial = new FakeSerial();
    const harness = createHarness(() => "", () => serial);
    await harness.backend.attach();

    const status = await harness.backend.serialOpen("127.0.0.1", 4321);

    expect(status.open).toBe(true);
    expect(harness.monitors[0].commands.slice(2)).toEqual([
      'emulation CreateServerSocketTerminal 4321 "cli"',
      "connector Connect sysbus.usart2 cli",
    ]);
    expect(serial.openCalls).toEqual([{ host: "127.0.0.1", port: 4321 }]);
    expect(harness.backend.status().serial).toBe("open");

    const again = await harness.backend.serialOpen("127.0.0.1", 4321);
    expect(again.open).toBe(true);
    expect(harness.monitors[0].commands).toHaveLength(4);
    expect(serial.openCalls).toHaveLength(1);
  });

  it("serial_open 空 host 回退到 127.0.0.1", async () => {
    const serial = new FakeSerial();
    const harness = createHarness(() => "", () => serial);
    await harness.backend.attach();

    await harness.backend.serialOpen("", 4322);

    expect(serial.openCalls).toEqual([{ host: "127.0.0.1", port: 4322 }]);
  });

  it("serial_read 保留真实字节与 timedOut，并标注无固件 warning", async () => {
    const serial = new FakeSerial();
    serial.readResult = { bytes: [0x48, 0x69], timedOut: true };
    const harness = createHarness(() => "", () => serial);
    await harness.backend.attach();
    await harness.backend.serialOpen("127.0.0.1", 4321);

    const result = await harness.backend.serialRead(16, 50);

    expect(result).toEqual({
      bytes: [0x48, 0x69],
      hex: "4869",
      text: "Hi",
      timedOut: true,
      warning: "renode_uart_uninitialized",
    });
  });

  it("serial_read 同时保留缓冲区溢出 warning", async () => {
    const serial = new FakeSerial();
    serial.readResult = { bytes: [0x01], timedOut: false, warning: "serial_buffer_overflow" };
    const harness = createHarness(() => "", () => serial);
    await harness.backend.attach();
    await harness.backend.serialOpen("127.0.0.1", 4321);

    const result = await harness.backend.serialRead(16, 50);

    expect(result.warning).toBe("renode_uart_uninitialized;serial_buffer_overflow");
  });

  it("serial_write 返回 declaration 与写入长度", async () => {
    const serial = new FakeSerial();
    const harness = createHarness(() => "", () => serial);
    await harness.backend.attach();
    await harness.backend.serialOpen("127.0.0.1", 4321);

    const result = await harness.backend.serialWrite(Buffer.from("ping"));

    expect(result.declaration).toEqual({
      operation: "serial_write",
      length: 4,
      effect: "write bytes to serial peer",
    });
    expect(result.bytesWritten).toBe(4);
    expect(serial.writes.map((chunk) => chunk.toString("utf8"))).toEqual(["ping"]);
  });

  it("serial_close 关闭通道并回到 closed 状态", async () => {
    const serial = new FakeSerial();
    const harness = createHarness(() => "", () => serial);
    await harness.backend.attach();
    await harness.backend.serialOpen("127.0.0.1", 4321);

    const status = await harness.backend.serialClose();

    expect(status.open).toBe(false);
    expect(serial.closeCount).toBe(1);
    expect(harness.backend.status().serial).toBe("closed");
    expect(harness.backend.serialStatus()).toEqual({
      open: false,
      host: "127.0.0.1",
      port: 4321,
      bytesRead: 0,
      bytesWritten: 0,
    });
  });

  it("未打开串口时 serial_read/serial_write 显式报错", async () => {
    const serial = new FakeSerial();
    const harness = createHarness(() => "", () => serial);
    await harness.backend.attach();

    for (const call of [
      harness.backend.serialRead(16, 10),
      harness.backend.serialWrite(Buffer.from("ping")),
    ]) {
      const error = await call.catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ProbeBackendError);
      expect((error as ProbeBackendError).code).toBe("backend_error");
    }
  });

  it("detach 关闭串口并重置终端创建标记", async () => {
    const serial = new FakeSerial();
    const harness = createHarness(() => "", () => serial);
    await harness.backend.attach();
    await harness.backend.serialOpen("127.0.0.1", 4321);

    await harness.backend.detach();

    expect(serial.closeCount).toBe(1);
    expect(harness.backend.serialStatus().open).toBe(false);
  });
});