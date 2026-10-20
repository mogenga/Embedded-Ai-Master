import net from "node:net";
import { ProbeBackendError } from "./backend.js";
import type { SerialStatus } from "./backend.js";

export const MAX_SERIAL_BUFFER_BYTES = 64 * 1024;
export const SERIAL_OVERFLOW_WARNING = "serial_buffer_overflow";
export const DEFAULT_SERIAL_HOST = "127.0.0.1";

export interface SerialSocket {
  write(data: Buffer): void;
  onData(listener: (chunk: Buffer) => void): void;
  onClose(listener: () => void): void;
  close(): void;
}

export interface SerialReadResult {
  bytes: number[];
  timedOut: boolean;
  warning?: string;
}

export type SerialConnect = (host: string, port: number) => Promise<SerialSocket>;

interface PendingRead {
  wake(): void;
  reject(error: Error): void;
  cleanup(): void;
  timer: NodeJS.Timeout;
}

function connectTcp(host: string, port: number): Promise<SerialSocket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const dataListeners: Array<(chunk: Buffer) => void> = [];
    const closeListeners: Array<() => void> = [];
    let established = false;

    socket.on("data", (chunk: Buffer) => {
      for (const listener of dataListeners) listener(chunk);
    });
    socket.on("close", () => {
      for (const listener of closeListeners) listener();
    });
    socket.once("error", (error) => {
      if (established) return;
      socket.destroy();
      reject(error);
    });
    socket.once("connect", () => {
      established = true;
      resolve({
        write: (data) => {
          socket.write(data);
        },
        onData: (listener) => {
          dataListeners.push(listener);
        },
        onClose: (listener) => {
          closeListeners.push(listener);
        },
        close: () => {
          socket.destroy();
        },
      });
    });
  });
}

function assertReadArgs(maxBytes: number, timeoutMs: number): void {
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_SERIAL_BUFFER_BYTES) {
    throw new ProbeBackendError(
      "invalid_argument",
      `maxBytes 必须是 1..${MAX_SERIAL_BUFFER_BYTES} 的整数: ${maxBytes}`,
    );
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0) {
    throw new ProbeBackendError(
      "invalid_argument",
      `timeoutMs 必须是非负整数: ${timeoutMs}`,
    );
  }
}

export class TcpSerial {
  private readonly connectImpl: SerialConnect;

  private socket?: SerialSocket;
  private buffer: Buffer = Buffer.alloc(0);
  private overflow = false;
  private pending?: PendingRead;
  private host?: string;
  private port?: number;
  private bytesRead = 0;
  private bytesWritten = 0;

  constructor(connectImpl: SerialConnect = connectTcp) {
    this.connectImpl = connectImpl;
  }

  async open(host: string, port: number): Promise<void> {
    if (this.socket) return;

    const targetHost = host.trim() || DEFAULT_SERIAL_HOST;
    const socket = await this.connectImpl(targetHost, port);

    this.socket = socket;
    this.host = targetHost;
    this.port = port;
    this.buffer = Buffer.alloc(0);
    this.overflow = false;
    this.bytesRead = 0;
    this.bytesWritten = 0;

    socket.onData((chunk) => this.handleData(chunk));
    socket.onClose(() => this.handleClose());
  }

  async read(
    maxBytes: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<SerialReadResult> {
    assertReadArgs(maxBytes, timeoutMs);
    if (!this.socket) throw new ProbeBackendError("backend_error", "串口未打开");
    if (signal?.aborted === true) {
      throw new ProbeBackendError("aborted", "串口读取已取消");
    }
    if (this.pending) throw new ProbeBackendError("backend_error", "已有挂起的串口读取");

    if (this.buffer.length > 0) return this.consume(maxBytes, false);

    return new Promise<SerialReadResult>((resolve, reject) => {
      const onAbort = (): void => {
        if (this.pending !== entry) return;
        this.pending = undefined;
        entry.cleanup();
        reject(new ProbeBackendError("aborted", "串口读取已取消"));
      };
      const entry: PendingRead = {
        timer: setTimeout(() => {
          if (this.pending !== entry) return;
          this.pending = undefined;
          entry.cleanup();
          resolve(this.consume(maxBytes, true));
        }, timeoutMs),
        wake: () => {
          entry.cleanup();
          this.pending = undefined;
          resolve(this.consume(maxBytes, false));
        },
        reject: (error) => {
          entry.cleanup();
          reject(error);
        },
        cleanup: () => {
          clearTimeout(entry.timer);
          signal?.removeEventListener("abort", onAbort);
        },
      };
      this.pending = entry;
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  async write(data: Buffer): Promise<number> {
    if (!this.socket) throw new ProbeBackendError("backend_error", "串口未打开");
    if (data.length === 0) return 0;
    this.socket.write(data);
    this.bytesWritten += data.length;
    return data.length;
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = undefined;

    const pending = this.pending;
    this.pending = undefined;
    if (pending) pending.reject(new ProbeBackendError("backend_error", "串口连接已关闭"));

    this.buffer = Buffer.alloc(0);
    this.overflow = false;

    if (!socket) return;
    try {
      socket.close();
    } catch {
      // 关闭已失效的 socket 不阻塞状态收敛。
    }
  }

  status(): SerialStatus {
    return {
      open: this.socket !== undefined,
      host: this.host,
      port: this.port,
      bytesRead: this.bytesRead,
      bytesWritten: this.bytesWritten,
    };
  }

  private handleData(chunk: Buffer): void {
    if (!this.socket) return;

    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_SERIAL_BUFFER_BYTES) {
      this.buffer = this.buffer.subarray(this.buffer.length - MAX_SERIAL_BUFFER_BYTES);
      this.overflow = true;
    }

    const pending = this.pending;
    if (pending) pending.wake();
  }

  private handleClose(): void {
    if (!this.socket) return;
    this.socket = undefined;

    const pending = this.pending;
    this.pending = undefined;
    if (pending) pending.reject(new ProbeBackendError("backend_error", "串口连接已关闭"));
  }

  private consume(maxBytes: number, timedOut: boolean): SerialReadResult {
    const take = Math.min(maxBytes, this.buffer.length);
    const bytes = Array.from(this.buffer.subarray(0, take));
    this.buffer = this.buffer.subarray(take);
    this.bytesRead += take;

    const result: SerialReadResult = { bytes, timedOut };
    if (this.overflow) {
      result.warning = SERIAL_OVERFLOW_WARNING;
      this.overflow = false;
    }
    return result;
  }
}