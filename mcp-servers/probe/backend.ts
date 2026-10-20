export type ProbeBackendKind = "renode" | "openocd";

export interface Declaration {
  operation: string;
  effect: string;
  address?: number;
  length?: number;
}

export interface MemoryReadResult {
  address: number;
  bytes: number[];
  hex: string;
  allZero: boolean;
  warning?: string;
}

export interface SerialStatus {
  open: boolean;
  host?: string;
  port?: number;
  bytesRead: number;
  bytesWritten: number;
}

export interface DeviceStatus {
  backend: ProbeBackendKind | "none";
  probe: "attached" | "detached";
  cpu: "halted" | "running" | "unknown";
  serial: "open" | "closed";
}

export interface AttachOptions {
  backend?: ProbeBackendKind;
  platform?: string;
  monitorPort?: number;
  renodePath?: string;
  openocdConfig?: string;
}

export type ProbeErrorCode =
  | "not_attached"
  | "not_implemented"
  | "invalid_argument"
  | "serial_already_open"
  | "verification_failed"
  | "backend_unavailable"
  | "backend_error";

export class ProbeBackendError extends Error {
  readonly code: ProbeErrorCode;

  constructor(code: ProbeErrorCode, message: string) {
    super(message);
    this.name = "ProbeBackendError";
    this.code = code;
  }
}

export interface ProbeBackend {
  readonly kind: ProbeBackendKind;
  attach(options: AttachOptions): Promise<DeviceStatus>;
  detach(): Promise<void>;
  halt(): Promise<void>;
  resume(): Promise<void>;
  reset(): Promise<{ declaration: Declaration }>;
  readMemory(address: number, length: number): Promise<MemoryReadResult>;
  writeMemory(
    address: number,
    bytes: number[],
  ): Promise<{ declaration: Declaration; verified: MemoryReadResult }>;
  serialOpen(host: string, port: number): Promise<SerialStatus>;
  serialRead(
    maxBytes: number,
    timeoutMs: number,
  ): Promise<{ bytes: number[]; hex: string; text: string; timedOut: boolean; warning?: string }>;
  serialWrite(data: Buffer): Promise<{ declaration: Declaration; bytesWritten: number }>;
  serialClose(): Promise<SerialStatus>;
  serialStatus(): SerialStatus;
  status(): DeviceStatus;
}