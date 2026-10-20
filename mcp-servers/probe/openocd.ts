import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import { isAbsolute } from "node:path";
import { ProbeBackendError } from "./backend.js";
import type {
  AttachOptions,
  Declaration,
  DeviceStatus,
  MemoryReadResult,
  ProbeBackend,
  SerialStatus,
} from "./backend.js";

export const DEFAULT_OPENOCD_PATH = "openocd";
export const DEFAULT_OPENOCD_HOST = "127.0.0.1";
export const DEFAULT_OPENOCD_TELNET_PORT = 4444;
export const DEFAULT_TELNET_TIMEOUT_MS = 5_000;
export const MAX_MEMORY_LENGTH = 256;

const MAX_ADDRESS = 0xffff_ffff;
const PROMPT = "> ";
const ERROR_LINE = /^Error(?::|\s|$)/;

export interface TelnetTransport {
  send(command: string): Promise<string>;
  close(): Promise<void>;
}

export interface OpenOcdBackendOptions {
  transportFactory?: (host: string, port: number) => Promise<TelnetTransport>;
  existsImpl?: (path: string) => boolean;
  resolveImpl?: (name: string) => boolean;
  openocdPath?: string;
  host?: string;
  monitorPort?: number;
  commandTimeoutMs?: number;
}

interface PendingCommand {
  command: string;
  resolve(value: string): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

function toHex(address: number): string {
  return `0x${address.toString(16)}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function resolveOnPath(name: string): boolean {
  const command = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(command, [name], { stdio: "ignore", windowsHide: true });
  return result.status === 0;
}

function findCommandError(output: string): string | undefined {
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (ERROR_LINE.test(trimmed)) return trimmed;
  }
  return undefined;
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

function toHexByte(value: number): string {
  return value.toString(16).padStart(2, "0");
}

function buildReadResult(address: number, bytes: number[]): MemoryReadResult {
  return {
    address,
    bytes,
    hex: bytes.map(toHexByte).join(""),
    allZero: bytes.every((byte) => byte === 0),
  };
}

function collectHexTokens(output: string): string[] {
  const tokens: string[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    const match = /^\s*0x[0-9a-f]+:\s*(.*)$/i.exec(rawLine);
    if (!match) continue;
    for (const token of match[1].split(/\s+/)) {
      if (/^[0-9a-f]+$/i.test(token)) tokens.push(token);
    }
  }
  return tokens;
}

function parseWords(output: string, expected: number): number[] {
  const tokens = collectHexTokens(output);
  if (tokens.length < expected) {
    throw new ProbeBackendError(
      "backend_error",
      `无法解析 mdw 输出: 期望 ${expected} 个 word，实际 ${tokens.length} 个; output=${output.trim()}`,
    );
  }
  return tokens.slice(0, expected).map((token) => {
    if (token.length > 8) {
      throw new ProbeBackendError("backend_error", `mdw 返回非法 word: ${token}`);
    }
    const value = Number.parseInt(token, 16);
    if (!Number.isInteger(value) || value < 0) {
      throw new ProbeBackendError("backend_error", `mdw 返回非法 word: ${token}`);
    }
    return value;
  });
}

function parseBytes(output: string, expected: number): number[] {
  const tokens = collectHexTokens(output);
  if (tokens.length < expected) {
    throw new ProbeBackendError(
      "backend_error",
      `无法解析 mdb 输出: 期望 ${expected} 个字节，实际 ${tokens.length} 个; output=${output.trim()}`,
    );
  }
  return tokens.slice(0, expected).map((token) => {
    if (token.length > 2) {
      throw new ProbeBackendError("backend_error", `mdb 返回非法字节: ${token}`);
    }
    const value = Number.parseInt(token, 16);
    if (!Number.isInteger(value) || value < 0 || value > 0xff) {
      throw new ProbeBackendError("backend_error", `mdb 返回非法字节: ${token}`);
    }
    return value;
  });
}

function createTelnetTransport(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<TelnetTransport> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    socket.setEncoding("utf8");

    let buffer = "";
    let pending: PendingCommand | undefined;
    let established = false;
    let closed = false;

    const failPending = (error: Error): void => {
      const current = pending;
      pending = undefined;
      if (!current) return;
      clearTimeout(current.timer);
      current.reject(error);
    };

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const current = pending;
      if (!current) return;
      const index = buffer.lastIndexOf(PROMPT);
      if (index === -1) return;
      pending = undefined;
      clearTimeout(current.timer);
      const raw = buffer.slice(0, index);
      buffer = buffer.slice(index + PROMPT.length);
      current.resolve(raw.replace(/\r\n/g, "\n").trim());
    });

    socket.once("error", (error) => {
      if (!established) {
        reject(error);
        return;
      }
      failPending(error);
    });

    socket.once("close", () => {
      closed = true;
      failPending(new Error("telnet 连接已关闭"));
    });

    socket.once("connect", () => {
      established = true;
      resolve({
        send: (command) =>
          new Promise<string>((resolveSend, rejectSend) => {
            if (closed) {
              rejectSend(new Error("telnet 连接已关闭"));
              return;
            }
            buffer = "";
            const timer = setTimeout(() => {
              if (pending?.command !== command) return;
              pending = undefined;
              rejectSend(new Error(`telnet 命令超时(${timeoutMs}ms)`));
            }, timeoutMs);
            pending = { command, resolve: resolveSend, reject: rejectSend, timer };
            socket.write(`${command}\n`);
          }),
        close: async () => {
          socket.destroy();
        },
      });
    });
  });
}

export class OpenOcdBackend implements ProbeBackend {
  readonly kind = "openocd" as const;

  private readonly transportFactory: (host: string, port: number) => Promise<TelnetTransport>;
  private readonly existsImpl: (path: string) => boolean;
  private readonly resolveImpl: (name: string) => boolean;
  private readonly openocdPath: string;
  private readonly host: string;
  private readonly monitorPort: number;
  private readonly commandTimeoutMs: number;

  private transport?: TelnetTransport;
  private attached = false;
  private cpu: DeviceStatus["cpu"] = "unknown";
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: OpenOcdBackendOptions = {}) {
    this.openocdPath = options.openocdPath ?? DEFAULT_OPENOCD_PATH;
    this.host = options.host ?? DEFAULT_OPENOCD_HOST;
    this.monitorPort = options.monitorPort ?? DEFAULT_OPENOCD_TELNET_PORT;
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_TELNET_TIMEOUT_MS;
    this.existsImpl = options.existsImpl ?? ((path) => existsSync(path));
    this.resolveImpl = options.resolveImpl ?? resolveOnPath;
    this.transportFactory =
      options.transportFactory ??
      ((host, port) => createTelnetTransport(host, port, this.commandTimeoutMs));
  }

  available(): boolean {
    if (isAbsolute(this.openocdPath)) return this.existsImpl(this.openocdPath);
    const fromEnv = process.env.OPENOCD_PATH?.trim();
    if (fromEnv) return this.existsImpl(fromEnv);
    return this.resolveImpl(DEFAULT_OPENOCD_PATH);
  }

  async attach(options: AttachOptions = {}): Promise<DeviceStatus> {
    if (this.attached && this.transport) return this.status();

    const stale = this.transport;
    this.transport = undefined;
    this.attached = false;
    if (stale) {
      try {
        await stale.close();
      } catch {
        // 旧连接清理失败不阻塞重新 attach。
      }
    }

    if (!this.available()) {
      throw new ProbeBackendError(
        "backend_unavailable",
        `OpenOCD 不可用: ${this.openocdPath} 不存在`,
      );
    }

    const port = options.monitorPort ?? this.monitorPort;
    let transport: TelnetTransport;
    try {
      transport = await this.transportFactory(this.host, port);
    } catch (error) {
      throw new ProbeBackendError(
        "backend_unavailable",
        `连接 OpenOCD telnet 失败(${this.host}:${port}): ${errorMessage(error)}`,
      );
    }

    this.transport = transport;
    this.attached = true;
    this.cpu = "unknown";
    return this.status();
  }

  async detach(): Promise<void> {
    const transport = this.transport;
    this.transport = undefined;
    this.attached = false;
    this.cpu = "unknown";
    if (!transport) return;
    await transport.close();
  }

  async halt(): Promise<void> {
    await this.sendCommand("halt");
    this.cpu = "halted";
  }

  async resume(): Promise<void> {
    await this.sendCommand("resume");
    this.cpu = "running";
  }

  async reset(): Promise<{ declaration: Declaration }> {
    await this.sendCommand("reset halt");
    this.cpu = "halted";
    return {
      declaration: {
        operation: "reset",
        effect: "reset target CPU and peripherals",
      },
    };
  }

  async readMemory(address: number, length: number): Promise<MemoryReadResult> {
    assertRange(address, length);
    const bytes: number[] = [];
    let offset = 0;

    while (length - offset >= 4 && (address + offset) % 4 === 0) {
      const words = Math.floor((length - offset) / 4);
      const output = await this.sendCommand(`mdw ${toHex(address + offset)} ${words}`);
      for (const word of parseWords(output, words)) {
        bytes.push(word & 0xff, (word >>> 8) & 0xff, (word >>> 16) & 0xff, (word >>> 24) & 0xff);
      }
      offset += words * 4;
    }

    if (offset < length) {
      const remaining = length - offset;
      const output = await this.sendCommand(`mdb ${toHex(address + offset)} ${remaining}`);
      bytes.push(...parseBytes(output, remaining));
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

    const length = bytes.length;
    const declaration: Declaration = {
      operation: "mem_write",
      address,
      length,
      effect: "overwrite target memory",
    };

    let offset = 0;
    while (length - offset >= 4 && (address + offset) % 4 === 0) {
      const word =
        (bytes[offset] |
          (bytes[offset + 1] << 8) |
          (bytes[offset + 2] << 16) |
          (bytes[offset + 3] << 24)) >>>
        0;
      await this.sendCommand(
        `mww ${toHex(address + offset)} 0x${word.toString(16).padStart(8, "0")}`,
      );
      offset += 4;
    }

    while (offset < length) {
      await this.sendCommand(
        `mwb ${toHex(address + offset)} 0x${toHexByte(bytes[offset])}`,
      );
      offset += 1;
    }

    const verified = await this.readMemory(address, length);
    const mismatch = verified.bytes.findIndex((byte, index) => byte !== bytes[index]);
    if (verified.bytes.length !== length || mismatch !== -1) {
      throw new ProbeBackendError(
        "verification_failed",
        `写后回读校验失败: address=${toHex(address)} length=${length} mismatchIndex=${mismatch}`,
      );
    }

    return { declaration, verified };
  }

  async serialOpen(_host: string, _port: number): Promise<SerialStatus> {
    throw this.serialUnsupported();
  }

  async serialRead(
    _maxBytes: number,
    _timeoutMs: number,
  ): Promise<{ bytes: number[]; hex: string; text: string; timedOut: boolean; warning?: string }> {
    throw this.serialUnsupported();
  }

  async serialWrite(_data: Buffer): Promise<{ declaration: Declaration; bytesWritten: number }> {
    throw this.serialUnsupported();
  }

  async serialClose(): Promise<SerialStatus> {
    throw this.serialUnsupported();
  }

  serialStatus(): SerialStatus {
    throw this.serialUnsupported();
  }

  status(): DeviceStatus {
    const attached = this.attached && this.transport !== undefined;
    return {
      backend: attached ? this.kind : "none",
      probe: attached ? "attached" : "detached",
      cpu: attached ? this.cpu : "unknown",
      serial: "closed",
    };
  }

  private serialUnsupported(): ProbeBackendError {
    return new ProbeBackendError("not_supported", "OpenOCD 后端不负责串口，请使用 Renode 后端");
  }

  private requireAttached(): TelnetTransport {
    if (!this.attached || !this.transport) {
      throw new ProbeBackendError("not_attached", "设备尚未 attach");
    }
    return this.transport;
  }

  private sendCommand(command: string): Promise<string> {
    const transport = this.requireAttached();
    const run = this.queue.then(
      () => this.execute(transport, command),
      () => this.execute(transport, command),
    );
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async execute(transport: TelnetTransport, command: string): Promise<string> {
    let output: string;
    try {
      output = await transport.send(command);
    } catch (error) {
      if (error instanceof ProbeBackendError) throw error;
      throw new ProbeBackendError(
        "backend_error",
        `OpenOCD 命令执行失败(${command}): ${errorMessage(error)}`,
      );
    }

    const failure = findCommandError(output);
    if (failure) {
      throw new ProbeBackendError(
        "backend_error",
        `OpenOCD 命令返回错误(${command}): ${failure}; output=${output.trim()}`,
      );
    }
    return output;
  }
}
