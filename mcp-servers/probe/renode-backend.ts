import { ProbeBackendError } from "./backend.js";
import type {
  AttachOptions,
  Declaration,
  DeviceStatus,
  MemoryReadResult,
  ProbeBackend,
  SerialStatus,
} from "./backend.js";
import { RenodeMonitor } from "./renode.js";
import type { RenodeMonitorOptions } from "./renode.js";

export const DEFAULT_RENODE_PLATFORM = "platforms/boards/stm32f4_discovery-kit.repl";
export const ALL_ZERO_WARNING = "renode_all_zero_or_unmapped";
export const MAX_MEMORY_LENGTH = 256;

const MAX_ADDRESS = 0xffff_ffff;

export interface RenodeMonitorLike {
  readonly connected: boolean;
  start(): Promise<void>;
  send(command: string): Promise<string>;
  stop(): Promise<void>;
}

export interface RenodeBackendEnv {
  renodePath?: string;
  monitorFactory?: (options: RenodeMonitorOptions) => RenodeMonitorLike;
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

  private readonly renodePath?: string;
  private readonly monitorFactory: (options: RenodeMonitorOptions) => RenodeMonitorLike;

  private monitor?: RenodeMonitorLike;
  private attached = false;
  private cpu: DeviceStatus["cpu"] = "unknown";

  constructor(env: RenodeBackendEnv = {}) {
    this.renodePath = env.renodePath;
    this.monitorFactory = env.monitorFactory ?? ((options) => new RenodeMonitor(options));
  }

  async attach(options: AttachOptions = {}): Promise<DeviceStatus> {
    if (this.attached && this.monitor?.connected) return this.status();

    if (this.monitor) {
      const stale = this.monitor;
      this.monitor = undefined;
      this.attached = false;
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

  async readMemory(address: number, length: number): Promise<MemoryReadResult> {
    assertRange(address, length);
    const monitor = this.requireAttached();

    const bytes: number[] = [];
    for (let offset = 0; offset < length; offset += 1) {
      const current = address + offset;
      const output = await monitor.send(`sysbus ReadByte 0x${current.toString(16)}`);
      bytes.push(parseByteOutput(current, output));
    }
    return buildReadResult(address, bytes);
  }

  async writeMemory(
    address: number,
    bytes: number[],
  ): Promise<{ declaration: Declaration; verified: MemoryReadResult }> {
    assertRange(address, bytes.length);
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
      const current = address + offset;
      await monitor.send(
        `sysbus WriteByte 0x${current.toString(16)} 0x${bytes[offset].toString(16)}`,
      );
    }

    const verified = await this.readMemory(address, length);
    const mismatch = verified.bytes.findIndex((byte, index) => byte !== bytes[index]);
    if (verified.bytes.length !== length || mismatch !== -1) {
      throw new ProbeBackendError(
        "verification_failed",
        `写后回读校验失败: address=0x${address.toString(16)} length=${length} mismatchIndex=${mismatch}`,
      );
    }

    return { declaration, verified };
  }

  async serialOpen(_host: string, _port: number): Promise<SerialStatus> {
    throw new ProbeBackendError("not_implemented", "Renode 串口通道将在 Task 5 实现");
  }

  async serialRead(
    _maxBytes: number,
    _timeoutMs: number,
  ): Promise<{ bytes: number[]; hex: string; text: string; timedOut: boolean; warning?: string }> {
    throw new ProbeBackendError("not_implemented", "Renode 串口通道将在 Task 5 实现");
  }

  async serialWrite(_data: Buffer): Promise<{ declaration: Declaration; bytesWritten: number }> {
    throw new ProbeBackendError("not_implemented", "Renode 串口通道将在 Task 5 实现");
  }

  async serialClose(): Promise<SerialStatus> {
    throw new ProbeBackendError("not_implemented", "Renode 串口通道将在 Task 5 实现");
  }

  serialStatus(): SerialStatus {
    throw new ProbeBackendError("not_implemented", "Renode 串口通道将在 Task 5 实现");
  }

  status(): DeviceStatus {
    const attached = this.attached && this.monitor?.connected === true;
    return {
      backend: attached ? this.kind : "none",
      probe: attached ? "attached" : "detached",
      cpu: attached ? this.cpu : "unknown",
      serial: "closed",
    };
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