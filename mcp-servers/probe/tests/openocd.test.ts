import { afterEach, describe, expect, it, vi } from "vitest";
import { ProbeBackendError } from "../backend.js";
import { OpenOcdBackend } from "../openocd.js";
import type { OpenOcdBackendOptions, TelnetTransport } from "../openocd.js";
import { RenodeBackend } from "../renode-backend.js";

type CommandHandler = (command: string) => string | Promise<string>;

class FakeTransport implements TelnetTransport {
  readonly commands: string[] = [];
  closeCount = 0;

  constructor(private readonly handler: CommandHandler) {}

  async send(command: string): Promise<string> {
    this.commands.push(command);
    return this.handler(command);
  }

  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

function setup(
  handler: CommandHandler,
  options: Omit<OpenOcdBackendOptions, "transportFactory"> = {},
): { backend: OpenOcdBackend; transport: FakeTransport } {
  const transport = new FakeTransport(handler);
  const backend = new OpenOcdBackend({
    existsImpl: () => true,
    resolveImpl: () => true,
    transportFactory: async () => transport,
    ...options,
  });
  return { backend, transport };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

async function codeOf(action: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await action();
    return undefined;
  } catch (error) {
    if (error instanceof ProbeBackendError) return error.code;
    throw error;
  }
}

const READ_WORD = "mdw 0x20000000 1";
const READ_BYTES = "mdb 0x20000000 3";
const READ_TAIL = "mdb 0x20000004 2";

function readHandler(command: string): string {
  if (command === READ_WORD) return "0x20000000: 12345678";
  if (command === READ_BYTES) return "0x20000000: 78 56 34";
  if (command === READ_TAIL) return "0x20000004: 9a bc";
  throw new Error(`unexpected command: ${command}`);
}

describe("OpenOcdBackend 命令映射", () => {
  it("halt/resume/reset 映射到 OpenOCD 命令并更新 CPU 状态", async () => {
    const { backend, transport } = setup(() => "");
    await backend.attach({ monitorPort: 4444 });

    await backend.halt();
    expect(backend.status().cpu).toBe("halted");

    await backend.resume();
    expect(backend.status().cpu).toBe("running");

    const { declaration } = await backend.reset();
    expect(declaration.operation).toBe("reset");
    expect(transport.commands).toEqual(["halt", "resume", "reset halt"]);
  });

  it("attach 通过注入的 transportFactory 建立连接，detach 关闭 transport", async () => {
    const calls: Array<{ host: string; port: number }> = [];
    const transport = new FakeTransport(() => "");
    const backend = new OpenOcdBackend({
      existsImpl: () => true,
      resolveImpl: () => true,
      transportFactory: async (host, port) => {
        calls.push({ host, port });
        return transport;
      },
    });

    const status = await backend.attach({ monitorPort: 5555 });
    expect(calls).toEqual([{ host: "127.0.0.1", port: 5555 }]);
    expect(status).toEqual({
      backend: "openocd",
      probe: "attached",
      cpu: "unknown",
      serial: "closed",
    });

    await backend.detach();
    expect(transport.closeCount).toBe(1);
    expect(backend.status().probe).toBe("detached");
  });

  it("openocd 不可用时 attach 抛 backend_unavailable 且不建立 transport", async () => {
    let factoryCalls = 0;
    const backend = new OpenOcdBackend({
      openocdPath: "C:/missing/openocd.exe",
      existsImpl: () => false,
      transportFactory: async () => {
        factoryCalls += 1;
        return new FakeTransport(() => "");
      },
    });

    expect(backend.available()).toBe(false);
    expect(await codeOf(() => backend.attach())).toBe("backend_unavailable");
    expect(factoryCalls).toBe(0);
  });

  it("available 由注入的 existsImpl 与 openocdPath 决定", () => {
    const checked: string[] = [];
    const backend = new OpenOcdBackend({
      openocdPath: "C:/tools/openocd.exe",
      existsImpl: (path) => {
        checked.push(path);
        return path.endsWith("openocd.exe");
      },
    });

    expect(backend.available()).toBe(true);
    expect(checked).toEqual(["C:/tools/openocd.exe"]);
  });

  it("非绝对 openocdPath 时优先使用 OPENOCD_PATH", () => {
    const checked: string[] = [];
    let resolved = 0;
    vi.stubEnv("OPENOCD_PATH", "C:/custom/openocd.exe");
    const backend = new OpenOcdBackend({
      openocdPath: "openocd-custom",
      existsImpl: (path) => {
        checked.push(path);
        return path === "C:/custom/openocd.exe";
      },
      resolveImpl: () => {
        resolved += 1;
        return false;
      },
    });

    expect(backend.available()).toBe(true);
    expect(checked).toEqual(["C:/custom/openocd.exe"]);
    expect(resolved).toBe(0);
  });

  it("无 OPENOCD_PATH 时用注入的 resolveImpl 查 PATH", () => {
    vi.stubEnv("OPENOCD_PATH", "");
    let resolved = 0;
    let existsCalls = 0;
    const backend = new OpenOcdBackend({
      existsImpl: () => {
        existsCalls += 1;
        return false;
      },
      resolveImpl: () => {
        resolved += 1;
        return true;
      },
    });

    expect(backend.available()).toBe(true);
    expect(resolved).toBe(1);
    expect(existsCalls).toBe(0);
  });
});

describe("OpenOcdBackend 内存读取", () => {
  it("mdw 输出按小端转换为字节", async () => {
    const { backend, transport } = setup(readHandler);
    await backend.attach();

    const result = await backend.readMemory(0x20000000, 4);

    expect(transport.commands).toEqual([READ_WORD]);
    expect(result.bytes).toEqual([0x78, 0x56, 0x34, 0x12]);
    expect(result.hex).toBe("78563412");
    expect(result.allZero).toBe(false);
  });

  it("非 4 字节整数倍时用 mdb 读取尾字节", async () => {
    const { backend, transport } = setup(readHandler);
    await backend.attach();

    const tail = await backend.readMemory(0x20000000, 3);
    expect(tail.bytes).toEqual([0x78, 0x56, 0x34]);
    expect(transport.commands).toEqual([READ_BYTES]);

    transport.commands.length = 0;
    const mixed = await backend.readMemory(0x20000000, 6);
    expect(mixed.bytes).toEqual([0x78, 0x56, 0x34, 0x12, 0x9a, 0xbc]);
    expect(transport.commands).toEqual([READ_WORD, READ_TAIL]);
  });

  it("忽略输出中的非十六进制文本", async () => {
    const { backend } = setup(() => "0x20000000: Warning: something\n0x20000000: 12345678");
    await backend.attach();

    const result = await backend.readMemory(0x20000000, 4);
    expect(result.bytes).toEqual([0x78, 0x56, 0x34, 0x12]);
  });

  it("解析不到足够数据时抛 backend_error", async () => {
    const { backend } = setup(() => "Error: cannot access memory");
    await backend.attach();

    expect(await codeOf(() => backend.readMemory(0x20000000, 4))).toBe("backend_error");
  });

  it("全 0 标记 allZero 与 warning，不解码为无故障", async () => {
    const { backend } = setup(() => "0x20000000: 00000000");
    await backend.attach();

    const result = await backend.readMemory(0x20000000, 4);
    expect(result.allZero).toBe(true);
    expect(result.warning).toBe("openocd_all_zero_or_unmapped");
    expect(result.bytes).toEqual([0, 0, 0, 0]);
  });

  it("非全 0 不附加 warning", async () => {
    const { backend } = setup(() => "0x20000000: 01000000");
    await backend.attach();

    const result = await backend.readMemory(0x20000000, 4);
    expect(result.allZero).toBe(false);
    expect(result.warning).toBeUndefined();
  });
});

describe("OpenOcdBackend 内存写入", () => {
  it("按 mww/mwb 写入并回读校验", async () => {
    const bytes = [0x78, 0x56, 0x34, 0x12, 0xab, 0xcd];
    const { backend, transport } = setup((command) => {
      if (command === "mww 0x20000000 0x12345678") return "";
      if (command === "mwb 0x20000004 0xab") return "";
      if (command === "mwb 0x20000005 0xcd") return "";
      if (command === READ_WORD) return "0x20000000: 12345678";
      if (command === READ_TAIL) return "0x20000004: ab cd";
      throw new Error(`unexpected command: ${command}`);
    });
    await backend.attach();

    const result = await backend.writeMemory(0x20000000, bytes);

    expect(transport.commands).toEqual([
      "mww 0x20000000 0x12345678",
      "mwb 0x20000004 0xab",
      "mwb 0x20000005 0xcd",
      READ_WORD,
      READ_TAIL,
    ]);
    expect(result.declaration).toEqual({
      operation: "mem_write",
      address: 0x20000000,
      length: 6,
      effect: "overwrite target memory",
    });
    expect(result.verified.bytes).toEqual(bytes);
  });

  it("写后回读不一致时抛 verification_failed", async () => {
    const { backend } = setup((command) => {
      if (command.startsWith("mww")) return "";
      if (command === READ_WORD) return "0x20000000: deadbeef";
      throw new Error(`unexpected command: ${command}`);
    });
    await backend.attach();

    expect(await codeOf(() => backend.writeMemory(0x20000000, [1, 2, 3, 4]))).toBe(
      "verification_failed",
    );
  });

  it("拒绝非法地址与字节值", async () => {
    const { backend, transport } = setup(() => "");
    await backend.attach();

    expect(await codeOf(() => backend.readMemory(-1, 1))).toBe("invalid_argument");
    expect(await codeOf(() => backend.readMemory(0x20000000, 0))).toBe("invalid_argument");
    expect(await codeOf(() => backend.writeMemory(0x20000000, [256]))).toBe(
      "invalid_argument",
    );
    expect(transport.commands).toEqual([]);
  });
});

describe("OpenOcdBackend 错误输出", () => {
  it("输出含 Error: 时 halt/read 均抛 backend_error 并附命令与输出", async () => {
    const { backend } = setup(() => "Error: target not halted");
    await backend.attach();

    expect(await codeOf(() => backend.halt())).toBe("backend_error");
    await expect(backend.halt()).rejects.toThrow(/halt/);
    await expect(backend.halt()).rejects.toThrow(/Error: target not halted/);
    await expect(backend.readMemory(0x20000000, 4)).rejects.toThrow(/mdw 0x20000000 1/);
  });

  it("兼容行首 Error 无冒号，并保持大小写敏感", async () => {
    const { backend: plain } = setup(() => "Error target not halted");
    await plain.attach();
    expect(await codeOf(() => plain.halt())).toBe("backend_error");

    const { backend: lower } = setup(() => "error: warning only");
    await lower.attach();
    await expect(lower.halt()).resolves.toBeUndefined();
  });
});

describe("OpenOcdBackend 错误传播", () => {
  it("未 attach 时所有设备命令抛 not_attached", async () => {
    let factoryCalls = 0;
    const backend = new OpenOcdBackend({
      existsImpl: () => true,
      transportFactory: async () => {
        factoryCalls += 1;
        return new FakeTransport(() => "");
      },
    });

    for (const action of [
      () => backend.halt(),
      () => backend.resume(),
      () => backend.reset(),
      () => backend.readMemory(0x20000000, 4),
      () => backend.writeMemory(0x20000000, [1]),
    ]) {
      expect(await codeOf(action)).toBe("not_attached");
    }
    expect(factoryCalls).toBe(0);
  });

  it("transport 报错时拒绝并保留命令名", async () => {
    const { backend } = setup(() => {
      throw new Error("socket closed");
    });
    await backend.attach();

    await expect(backend.halt()).rejects.toThrow(/halt/);
    await expect(backend.readMemory(0x20000000, 4)).rejects.toThrow(/mdw 0x20000000 1/);
  });

  it("readMemory 在途命令 abort 后立即取消且不发送后续命令", async () => {
    const controller = new AbortController();
    const { backend, transport } = setup((command) => {
      if (!command.startsWith("mdw")) return "";
      return new Promise<string>(() => {
        // 模拟 telnet 命令一直等不到 prompt。
      });
    });
    await backend.attach();

    const pending = backend.readMemory(0x20000000, 8, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();

    expect(await codeOf(() => pending)).toBe("aborted");
    expect(transport.commands).toEqual(["mdw 0x20000000 2"]);
  });

  it("writeMemory 中途 abort 后不再写剩余字节或回读", async () => {
    const controller = new AbortController();
    const { backend, transport } = setup((command) => {
      if (command.startsWith("mww")) controller.abort();
      return "";
    });
    await backend.attach();

    expect(
      await codeOf(() =>
        backend.writeMemory(0x20000000, [1, 2, 3, 4], controller.signal),
      ),
    ).toBe("aborted");
    expect(transport.commands).toEqual(["mww 0x20000000 0x04030201"]);
  });

  it("attach 时 transportFactory 失败会传播且保持未连接", async () => {
    const backend = new OpenOcdBackend({
      existsImpl: () => true,
      resolveImpl: () => true,
      transportFactory: async () => {
        throw new Error("connect ECONNREFUSED");
      },
    });

    await expect(backend.attach()).rejects.toThrow(/ECONNREFUSED/);
    expect(backend.status().probe).toBe("detached");
  });

  it("串口方法返回 not_supported", async () => {
    const { backend } = setup(() => "");
    await backend.attach();

    expect(await codeOf(() => backend.serialOpen("127.0.0.1", 4444))).toBe("not_supported");
    expect(await codeOf(() => backend.serialRead(1, 1))).toBe("not_supported");
    expect(await codeOf(() => backend.serialWrite(Buffer.from("a")))).toBe("not_supported");
    expect(await codeOf(() => backend.serialClose())).toBe("not_supported");
    expect(await codeOf(async () => backend.serialStatus())).toBe("not_supported");
    expect(backend.status().serial).toBe("closed");
  });
});

describe("probe server 接线", () => {
  it("device_list 按 OpenOcdBackend.available() 报告可用性", async () => {
    const { probeTools } = await import("../tools.js");
    const { RenodeBackend } = await import("../renode-backend.js");

    for (const [exists, expected] of [
      [false, false],
      [true, true],
    ] as const) {
      const tools = probeTools({
        renode: new RenodeBackend(),
        openocd: new OpenOcdBackend({
          openocdPath: "C:/test/openocd.exe",
          existsImpl: () => exists,
        }),
      });
      const result = await tools.find((tool) => tool.name === "device_list")?.handler({});
      const backends = (result?.structuredContent as { backends: Array<{ kind: string; available: boolean }> })
        .backends;
      expect(backends.find((entry) => entry.kind === "openocd")?.available).toBe(expected);
    }
  });

  it("构造 OpenOCD 后端并注入工具面不崩溃", async () => {
    const { createProbeServer, createProbeTools } = await import("../server.js");

    expect(() => createProbeServer()).not.toThrow();

    const tools = createProbeTools({
      renode: new RenodeBackend(),
      openocd: new OpenOcdBackend({ resolveImpl: () => true }),
    });
    const deviceList = tools.find((tool) => tool.name === "device_list");
    expect(deviceList).toBeDefined();

    const result = await deviceList?.handler({});
    expect(result?.isError).toBeUndefined();
    const backends = (result?.structuredContent as { backends: Array<{ kind: string }> }).backends;
    expect(backends.map((entry) => entry.kind)).toEqual(["renode", "openocd"]);
  });
});