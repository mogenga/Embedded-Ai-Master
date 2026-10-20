import { existsSync } from "node:fs";
import { ProbeBackendError } from "./backend.js";
import type {
  AttachOptions,
  Declaration,
  DeviceStatus,
  MemoryReadResult,
  ProbeBackend,
  SerialStatus,
} from "./backend.js";
import { DEFAULT_RENODE_PATH, RenodeMonitor } from "./renode.js";
import type { RenodeMonitorOptions } from "./renode.js";
import { DEFAULT_SERIAL_HOST, TcpSerial } from "./serial.js";
import type { SerialReadResult } from "./serial.js";

export const DEFAULT_RENODE_PLATFORM = "platforms/boards/stm32f4_discovery-kit.repl";
export const ALL_ZERO_WARNING = "renode_all_zero_or_unmapped";
export const RENODE_UART_WARNING = "renode_uart_uninitialized";
export const MAX_MEMORY_LENGTH = 256;

const MAX_ADDRESS = 0xffff_ffff;

export interface RenodeMonitorLike {
  readonly connected: boolean;
  start(): Promise<void>;
  send(command: string, signal?: AbortSignal): Promise<string>;
  stop(): Promise<void>;
}

export interface SerialClientLike {
  open(host: string, port: number): Promise<void>;
  read(maxBytes: number, timeoutMs: number, signal?: AbortSignal): Promise<SerialReadResult>;
  write(data: Buffer): Promise<number>;
  close(): Promise<void>;
  status(): SerialStatus;
}

export interface RenodeBackendEnv {
  renodePath?: string;
  existsImpl?: (path: string) => boolean;
  monitorFactory?: (options: RenodeMonitorOptions) => RenodeMonitorLike;
  serialFactory?: () => SerialClientLike;
}

function normalizePlatform(platform: string): string {
  return platform.startsWith("@") ? platform : `@${platform}`;
}

function assertAddress(address: number): void {
  if (!Number.isInteger(address) || address < 0 || address > MAX_ADDRESS) {
    throw new ProbeBackendError(
      "invalid_argument",
      `address 必须是 0..0xffffffff 的整数: ${address}`,
    );
  }
}

function assertRange(address: number, length: number): void {
  assertAddress(address);
  if (!Number.isInteger(length) || length < 1 || length > MAX_MEMORY_LENGTH) {
    throw new ProbeBackendError(
      "invalid_argument",
      `length 必须是 1..${MAX_MEMORY_LENGTH} 的整数: ${length}`,
    );
  }
  if (address + length - 1 > MAX_ADDRESS) {
    throw new ProbeBackendError("invalid_argument", "访问范围超出 32 位地址空间");
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new ProbeBackendError("aborted", "请求已取消");
  }
}

async function sendMemoryCommand(
  monitor: RenodeMonitorLike,
  command: string,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  let output: string;
  try {
    output = await monitor.send(command, signal);
  } catch (error) {
    if (signal?.aborted === true) {
      throw new ProbeBackendError("aborted", "请求已取消");
    }
    throw error;
  }
  throwIfAborted(signal);
  return output;
}

function parseByteOutput(address: number, output: string): number {
  const match = /^(?:0x)?([0-9a-f]+)$/i.exec(output.trim());
  const value = match ? Number.parseInt(match[1], 16) : Number.NaN;
  if (!match || !Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new ProbeBackendError(
      "backend_error",
      `无法解析 sysbus ReadByte 0x${address.toString(16)} 的输出: ${output}`,
    );
  }
  return value;
}

function toHexByte(value: number): string {
  return value.toString(16).padStart(2, "0");
}

function buildReadResult(address: number, bytes: number[]): MemoryReadResult {
  const allZero = bytes.every((byte) => byte === 0);
  const result: MemoryReadResult = {
    address,
    bytes,
    hex: bytes.map(toHexByte).join(""),
    allZero,
  };
  if (allZero) result.warning = ALL_ZERO_WARNING;
  return result;
}

export class RenodeBackend implements ProbeBackend {
  readonly kind = "renode" as const;

  readonly renodePath?: string;
  private readonly existsImpl: (path: string) => boolean;
  private readonly monitorFactory: (options: RenodeMonitorOptions) => RenodeMonitorLike;
  private readonly serialFactory: () => SerialClientLike;

  private monitor?: RenodeMonitorLike;
  private serial?: SerialClientLike;
  private terminalPort?: number;
  private attached = false;
  private cpu: DeviceStatus["cpu"] = "unknown";

  constructor(env: RenodeBackendEnv = {}) {
    this.renodePath = env.renodePath;
    this.existsImpl = env.existsImpl ?? ((path) => existsSync(path));
    this.monitorFactory = env.monitorFactory ?? ((options) => new RenodeMonitor(options));
    this.serialFactory = env.serialFactory ?? (() => new TcpSerial());
  }

  available(): boolean {
    const target = this.renodePath?.trim() || DEFAULT_RENODE_PATH;
    return this.existsImpl(target);
  }

  async attach(options: AttachOptions = {}): Promise<DeviceStatus> {
    if (this.attached && this.monitor?.connected) return this.status();

    if (this.monitor) {
      const stale = this.monitor;
      this.monitor = undefined;
      this.attached = false;
      await this.closeSerialSilently();
      try {
        await stale.stop();
      } catch {
        // 旧连接清理失败不阻塞重新 attach。
      }
    }

    const platform = options.platform?.trim() || DEFAULT_RENODE_PLATFORM;
    const monitor = this.monitorFactory({
      renodePath: options.renodePath ?? this.renodePath,
      monitorPort: options.monitorPort,
      platform,
    });
    this.monitor = monitor;

    try {
      await monitor.start();
      await monitor.send("mach create");
      await monitor.send(`machine LoadPlatformDescription ${normalizePlatform(platform)}`);
    } catch (error) {
      this.monitor = undefined;
      this.attached = false;
      try {
        await monitor.stop();
      } catch {
        // 启动失败后的清理不覆盖原始错误。
      }
      throw error;
    }

    this.attached = true;
    this.cpu = "unknown";
    return this.status();
  }

  async detach(): Promise<void> {
    const monitor = this.monitor;
    this.monitor = undefined;
    this.attached = false;
    this.cpu = "unknown";
    await this.closeSerialSilently();
    if (!monitor) return;

    try {
      await monitor.send("quit");
    } catch {
      // detach 对 quit 失败容错，仍继续关闭连接。
    }
    await monitor.stop();
  }

  async halt(): Promise<void> {
    const monitor = this.requireAttached();
    await monitor.send("pause");
    this.cpu = "halted";
  }

  async resume(): Promise<void> {
    const monitor = this.requireAttached();
    await monitor.send("start");
    this.cpu = "running";
  }

  async reset(): Promise<{ declaration: Declaration }> {
    const monitor = this.requireAttached();
    await monitor.send("machine Reset");
    this.cpu = "unknown";
    return {
      declaration: {
        operation: "reset",
        effect: "reset target CPU and peripherals",
      },
    };
  }

  async readMemory(
    address: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<MemoryReadResult> {
    assertRange(address, length);
    throwIfAborted(signal);
    const monitor = this.requireAttached();

    const bytes: number[] = [];
    for (let offset = 0; offset < length; offset += 1) {
      throwIfAborted(signal);
      const current = address + offset;
      const output = await sendMemoryCommand(
        monitor,
        `sysbus ReadByte 0x${current.toString(16)}`,
        signal,
      );
      bytes.push(parseByteOutput(current, output));
    }
    return buildReadResult(address, bytes);
  }

  async writeMemory(
    address: number,
    bytes: number[],
    signal?: AbortSignal,
  ): Promise<{ declaration: Declaration; verified: MemoryReadResult }> {
    assertRange(address, bytes.length);
    throwIfAborted(signal);
    for (const byte of bytes) {
      if (!Number.isInteger(byte) || byte < 0 || byte > 0xff) {
        throw new ProbeBackendError("invalid_argument", `字节值必须是 0..255 的整数: ${byte}`);
      }
    }

    const monitor = this.requireAttached();
    const length = bytes.length;
    const declaration: Declaration = {
      operation: "mem_write",
      address,
      length,
      effect: "overwrite target memory",
    };

    for (let offset = 0; offset < length; offset += 1) {
      throwIfAborted(signal);
      const current = address + offset;
      await sendMemoryCommand(
        monitor,
        `sysbus WriteByte 0x${current.toString(16)} 0x${bytes[offset].toString(16)}`,
        signal,
      );
    }

    const verified = await this.readMemory(address, length, signal);
    const mismatch = verified.bytes.findIndex((byte, index) => byte !== bytes[index]);
    if (verified.bytes.length !== length || mismatch !== -1) {
      throw new ProbeBackendError(
        "verification_failed",
        `写后回读校验失败: address=0x${address.toString(16)} length=${length} mismatchIndex=${mismatch}`,
      );
    }

    return { declaration, verified };
  }

  async serialOpen(host: string, port: number): Promise<SerialStatus> {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ProbeBackendError("invalid_argument", `port 必须是 1..65535 的整数: ${port}`);
    }
    const monitor = this.requireAttached();
    const targetHost = host.trim() || DEFAULT_SERIAL_HOST;

    const current = this.serial?.status();
    if (current?.open) {
      if (current.host === targetHost && current.port === port) return current;
      throw new ProbeBackendError(
        "serial_already_open",
        `串口已打开(${current.host ?? DEFAULT_SERIAL_HOST}:${current.port})，` +
          `拒绝静默切换到 ${targetHost}:${port}；请先 serial_close`,
      );
    }

    if (this.terminalPort !== port) {
      const terminal = this.terminalPort === undefined ? "cli" : `cli-${port}`;
      await monitor.send(`emulation CreateServerSocketTerminal ${port} "${terminal}"`);
      await monitor.send(`connector Connect sysbus.usart2 ${terminal}`);
      this.terminalPort = port;
    }

    const serial = this.serial ?? this.serialFactory();
    this.serial = serial;
    await serial.open(targetHost, port);
    return serial.status();
  }

  async serialRead(
    maxBytes: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ bytes: number[]; hex: string; text: string; timedOut: boolean; warning?: string }> {
    throwIfAborted(signal);
    const serial = this.requireSerial();
    const result = await serial.read(maxBytes, timeoutMs, signal);

    const warnings = [RENODE_UART_WARNING];
    if (result.warning) warnings.push(result.warning);

    return {
      bytes: result.bytes,
      hex: result.bytes.map(toHexByte).join(""),
      text: Buffer.from(result.bytes).toString("utf8"),
      timedOut: result.timedOut,
      warning: warnings.join(";"),
    };
  }

  async serialWrite(data: Buffer): Promise<{ declaration: Declaration; bytesWritten: number }> {
    const serial = this.requireSerial();
    const bytesWritten = await serial.write(data);
    return {
      declaration: {
        operation: "serial_write",
        length: data.length,
        effect: "write bytes to serial peer",
      },
      bytesWritten,
    };
  }

  async serialClose(): Promise<SerialStatus> {
    const serial = this.serial;

    if (!serial) return this.serialStatus();
    await serial.close();
    return serial.status();
  }

  serialStatus(): SerialStatus {
    return this.serial?.status() ?? { open: false, bytesRead: 0, bytesWritten: 0 };
  }

  status(): DeviceStatus {
    const attached = this.attached && this.monitor?.connected === true;
    return {
      backend: attached ? this.kind : "none",
      probe: attached ? "attached" : "detached",
      cpu: attached ? this.cpu : "unknown",
      serial: this.serial?.status().open === true ? "open" : "closed",
    };
  }

  private requireSerial(): SerialClientLike {
    if (!this.serial || !this.serial.status().open) {
      throw new ProbeBackendError("backend_error", "串口未打开");
    }
    return this.serial;
  }

  private async closeSerialSilently(): Promise<void> {
    const serial = this.serial;
    this.serial = undefined;
    this.terminalPort = undefined;
    if (!serial) return;
    try {
      await serial.close();
    } catch {
      // 串口清理失败不阻塞 attach/detach。
    }
  }

  private requireAttached(): RenodeMonitorLike {
    if (!this.attached || !this.monitor) {
      throw new ProbeBackendError("not_attached", "设备尚未 attach");
    }
    if (!this.monitor.connected) {
      throw new ProbeBackendError("backend_unavailable", "Renode monitor 连接已断开");
    }
    return this.monitor;
  }
}