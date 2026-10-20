import { describe, expect, it } from "vitest";
import { ProbeBackendError } from "../backend.js";
import type {
  AttachOptions,
  Declaration,
  DeviceStatus,
  MemoryReadResult,
  ProbeBackend,
  ProbeBackendKind,
  SerialStatus,
} from "../backend.js";
import { probeTools } from "../tools.js";
import type { ProbeToolSpec } from "../tools.js";

const EXPECTED_TOOL_NAMES = [
  "attach",
  "detach",
  "device_list",
  "device_status",
  "halt",
  "mem_read",
  "mem_write",
  "reset",
  "resume",
  "serial_close",
  "serial_open",
  "serial_read",
  "serial_status",
  "serial_write",
];

function findTool(tools: ProbeToolSpec[], name: string): ProbeToolSpec {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`工具不存在: ${name}`);
  return tool;
}

function errorCode(result: Awaited<ReturnType<ProbeToolSpec["handler"]>>): unknown {
  return (result.structuredContent as { code?: unknown } | undefined)?.code;
}

class FakeBackend implements ProbeBackend {
  readonly kind: ProbeBackendKind;
  readonly calls: string[] = [];
  readonly attachOptions: AttachOptions[] = [];

  private attached = false;
  private cpu: DeviceStatus["cpu"] = "unknown";
  private failing = new Map<string, Error>();

  constructor(kind: ProbeBackendKind) {
    this.kind = kind;
  }

  failOn(operation: string, error: Error): this {
    this.failing.set(operation, error);
    return this;
  }

  async attach(options: AttachOptions = {}): Promise<DeviceStatus> {
    this.calls.push("attach");
    this.attachOptions.push(options);
    this.throwIfFailing("attach");
    this.attached = true;
    return this.status();
  }

  async detach(): Promise<void> {
    this.calls.push("detach");
    this.throwIfFailing("detach");
    this.attached = false;
    this.cpu = "unknown";
  }

  async halt(): Promise<void> {
    this.calls.push("halt");
    this.throwIfFailing("halt");
    this.requireAttached();
    this.cpu = "halted";
  }

  async resume(): Promise<void> {
    this.calls.push("resume");
    this.throwIfFailing("resume");
    this.requireAttached();
    this.cpu = "running";
  }

  async reset(): Promise<{ declaration: Declaration }> {
    this.calls.push("reset");
    this.throwIfFailing("reset");
    this.requireAttached();
    this.cpu = "unknown";
    return {
      declaration: { operation: "reset", effect: "reset target CPU and peripherals" },
    };
  }

  async readMemory(address: number, length: number): Promise<MemoryReadResult> {
    this.calls.push(`mem_read:${address}:${length}`);
    this.throwIfFailing("readMemory");
    this.requireAttached();
    return {
      address,
      bytes: Array.from({ length }, () => 0x11),
      hex: "11".repeat(length),
      allZero: false,
    };
  }

  async writeMemory(
    address: number,
    bytes: number[],
  ): Promise<{ declaration: Declaration; verified: MemoryReadResult }> {
    this.calls.push(`mem_write:${address}:${bytes.length}`);
    this.throwIfFailing("writeMemory");
    this.requireAttached();
    const declaration: Declaration = {
      operation: "mem_write",
      address,
      length: bytes.length,
      effect: "overwrite target memory",
    };
    return {
      declaration,
      verified: { address, bytes, hex: "", allZero: false },
    };
  }

  async serialOpen(host: string, port: number): Promise<SerialStatus> {
    this.calls.push(`serial_open:${host}:${port}`);
    this.throwIfFailing("serialOpen");
    this.requireAttached();
    return { open: true, host, port, bytesRead: 0, bytesWritten: 0 };
  }

  async serialRead(
    maxBytes: number,
    timeoutMs: number,
  ): Promise<{ bytes: number[]; hex: string; text: string; timedOut: boolean; warning?: string }> {
    this.calls.push(`serial_read:${maxBytes}:${timeoutMs}`);
    this.throwIfFailing("serialRead");
    this.requireAttached();
    return { bytes: [0x70], hex: "70", text: "p", timedOut: false };
  }

  async serialWrite(data: Buffer): Promise<{ declaration: Declaration; bytesWritten: number }> {
    this.calls.push(`serial_write:${data.toString("utf8")}`);
    this.throwIfFailing("serialWrite");
    this.requireAttached();
    return {
      declaration: { operation: "serial_write", effect: "write serial bytes" },
      bytesWritten: data.length,
    };
  }

  async serialClose(): Promise<SerialStatus> {
    this.calls.push("serial_close");
    this.throwIfFailing("serialClose");
    this.requireAttached();
    return { open: false, bytesRead: 0, bytesWritten: 0 };
  }

  serialStatus(): SerialStatus {
    this.calls.push("serial_status");
    this.throwIfFailing("serialStatus");
    this.requireAttached();
    return { open: false, bytesRead: 0, bytesWritten: 0 };
  }

  status(): DeviceStatus {
    return {
      backend: this.attached ? this.kind : "none",
      probe: this.attached ? "attached" : "detached",
      cpu: this.attached ? this.cpu : "unknown",
      serial: "closed",
    };
  }

  private throwIfFailing(operation: string): void {
    const error = this.failing.get(operation);
    if (error) throw error;
  }

  private requireAttached(): void {
    if (!this.attached) {
      throw new ProbeBackendError("not_attached", "设备尚未 attach");
    }
  }
}

describe("probeTools 工具面", () => {
  it("注册 14 个工具且名称集合稳定", () => {
    const tools = probeTools({ renode: new FakeBackend("renode") });

    expect(tools).toHaveLength(14);
    expect(tools.map((tool) => tool.name).sort()).toEqual(EXPECTED_TOOL_NAMES);
  });

  it("只读工具标注 readOnlyHint，写工具标注 destructiveHint", () => {
    const tools = probeTools({ renode: new FakeBackend("renode") });

    for (const name of ["device_list", "device_status", "attach", "detach", "halt", "resume"]) {
      expect(findTool(tools, name).annotations?.readOnlyHint, name).toBe(true);
    }
    for (const name of ["reset", "mem_write", "serial_write"]) {
      expect(findTool(tools, name).annotations?.destructiveHint, name).toBe(true);
    }
    expect(findTool(tools, "mem_read").meta?.evidence).toBe(true);
    expect(findTool(tools, "serial_read").meta?.evidence).toBe(true);
  });

  it("device_list 报告 renode 可用、openocd 未配置", async () => {
    const tools = probeTools({ renode: new FakeBackend("renode") });

    const result = await findTool(tools, "device_list").handler({});

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      backends: [
        { kind: "renode", available: true },
        { kind: "openocd", available: false },
      ],
    });
  });

  it("device_status 始终返回 structuredContent.deviceStatus", async () => {
    const renode = new FakeBackend("renode");
    const tools = probeTools({ renode });

    const detached = await findTool(tools, "device_status").handler({});
    expect(detached.isError).toBeUndefined();
    expect((detached.structuredContent as { deviceStatus: DeviceStatus }).deviceStatus).toEqual({
      backend: "none",
      probe: "detached",
      cpu: "unknown",
      serial: "closed",
    });

    await findTool(tools, "attach").handler({ backend: "renode", platform: "custom.repl" });
    const attached = await findTool(tools, "device_status").handler({});
    expect((attached.structuredContent as { deviceStatus: DeviceStatus }).deviceStatus).toEqual({
      backend: "renode",
      probe: "attached",
      cpu: "unknown",
      serial: "closed",
    });
    expect(renode.attachOptions[0]).toEqual({
      backend: "renode",
      platform: "custom.repl",
      monitorPort: undefined,
    });
  });

  it("未 attach 时设备操作返回 not_attached", async () => {
    const renode = new FakeBackend("renode");
    const tools = probeTools({ renode });

    for (const [name, args] of [
      ["halt", {}],
      ["resume", {}],
      ["reset", {}],
      ["mem_read", { address: 0x20000000, length: 4 }],
      ["mem_write", { address: 0x20000000, bytes: [1] }],
      ["serial_status", {}],
    ] as const) {
      const result = await findTool(tools, name).handler(args);
      expect(result.isError, name).toBe(true);
      expect(errorCode(result), name).toBe("not_attached");
    }

    expect(renode.calls).toEqual([]);
  });

  it("attach 未配置 openocd 时返回 backend_unavailable", async () => {
    const tools = probeTools({ renode: new FakeBackend("renode") });

    const result = await findTool(tools, "attach").handler({ backend: "openocd" });

    expect(result.isError).toBe(true);
    expect(errorCode(result)).toBe("backend_unavailable");
  });

  it("attach 选择已配置的 openocd backend", async () => {
    const renode = new FakeBackend("renode");
    const openocd = new FakeBackend("openocd");
    const tools = probeTools({ renode, openocd });

    const result = await findTool(tools, "attach").handler({ backend: "openocd" });
    expect(result.isError).toBeUndefined();
    expect(openocd.calls).toEqual(["attach"]);
    expect(renode.calls).toEqual([]);
    expect((result.structuredContent as { deviceStatus: DeviceStatus }).deviceStatus.backend).toBe(
      "openocd",
    );
  });

  it("参数非法返回 invalid_argument 且不触达后端", async () => {
    const renode = new FakeBackend("renode");
    const tools = probeTools({ renode });
    await findTool(tools, "attach").handler({});
    renode.calls.length = 0;

    for (const [name, args] of [
      ["mem_read", { address: 0x20000000, length: 0 }],
      ["mem_read", { address: -1, length: 1 }],
      ["mem_write", { address: 0x20000000, bytes: [256] }],
      ["mem_write", { address: 0x20000000, bytes: [] }],
      ["serial_open", { host: "127.0.0.1", port: 0 }],
      ["attach", { backend: "jlink" }],
    ] as const) {
      const result = await findTool(tools, name).handler(args);
      expect(result.isError, name).toBe(true);
      expect(errorCode(result), name).toBe("invalid_argument");
    }

    expect(renode.calls).toEqual([]);
  });

  it("后端异常原样转为 backend_error，不吞错", async () => {
    const renode = new FakeBackend("renode");
    const tools = probeTools({ renode });
    await findTool(tools, "attach").handler({});
    renode.failOn("halt", new Error("monitor disconnected"));

    const result = await findTool(tools, "halt").handler({});

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      code: "backend_error",
      message: "monitor disconnected",
    });
  });

  it("保留后端 ProbeBackendError 的错误码", async () => {
    const renode = new FakeBackend("renode");
    const tools = probeTools({ renode });
    await findTool(tools, "attach").handler({});
    renode.failOn("writeMemory", new ProbeBackendError("verification_failed", "回读不一致"));

    const result = await findTool(tools, "mem_write").handler({
      address: 0x20000000,
      bytes: [0xde],
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({
      code: "verification_failed",
      message: "回读不一致",
    });
  });

  it("mem_read 成功返回内存与十六进制，reset/mem_write 返回 declaration", async () => {
    const renode = new FakeBackend("renode");
    const tools = probeTools({ renode });
    await findTool(tools, "attach").handler({});

    const read = await findTool(tools, "mem_read").handler({ address: 0x20000000, length: 2 });
    expect(read.isError).toBeUndefined();
    expect((read.structuredContent as { memory: MemoryReadResult }).memory).toEqual({
      address: 0x20000000,
      bytes: [0x11, 0x11],
      hex: "1111",
      allZero: false,
    });

    const write = await findTool(tools, "mem_write").handler({
      address: 0x20000000,
      bytes: [0xde, 0xad],
    });
    expect((write.structuredContent as { declaration: Declaration }).declaration).toEqual({
      operation: "mem_write",
      address: 0x20000000,
      length: 2,
      effect: "overwrite target memory",
    });

    const reset = await findTool(tools, "reset").handler({});
    expect((reset.structuredContent as { declaration: Declaration }).declaration).toEqual({
      operation: "reset",
      effect: "reset target CPU and peripherals",
    });
  });

  it("串口工具已注册；后端未实现时返回 not_implemented", async () => {
    const renode = new FakeBackend("renode");
    const tools = probeTools({ renode });
    await findTool(tools, "attach").handler({});
    for (const operation of ["serialOpen", "serialRead", "serialWrite", "serialClose", "serialStatus"]) {
      renode.failOn(operation, new ProbeBackendError("not_implemented", "Task 5 实现"));
    }

    const calls = [
      ["serial_open", { host: "127.0.0.1", port: 4321 }],
      ["serial_status", {}],
      ["serial_read", { maxBytes: 16, timeoutMs: 100 }],
      ["serial_write", { data: "ping" }],
      ["serial_close", {}],
    ] as const;

    for (const [name, args] of calls) {
      const result = await findTool(tools, name).handler(args);
      expect(result.isError, name).toBe(true);
      expect(errorCode(result), name).toBe("not_implemented");
    }
  });
});