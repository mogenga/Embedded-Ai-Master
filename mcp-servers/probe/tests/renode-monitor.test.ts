import { describe, expect, it } from "vitest";
import {
  DEFAULT_MONITOR_PORT,
  DEFAULT_RENODE_PATH,
  RenodeCommandError,
  RenodeMonitor,
} from "../renode.js";
import type { MonitorSocket, RenodeMonitorOptions } from "../renode.js";

class FakeSocket implements MonitorSocket {
  readonly writes: string[] = [];
  closed = false;
  private dataListeners: ((chunk: string) => void)[] = [];
  private closeListeners: (() => void)[] = [];

  write(data: string): void {
    this.writes.push(data);
  }

  onData(listener: (chunk: string) => void): void {
    this.dataListeners.push(listener);
  }

  onClose(listener: () => void): void {
    this.closeListeners.push(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.closeListeners) listener();
  }

  emit(chunk: string): void {
    for (const listener of this.dataListeners) listener(chunk);
  }
}

interface FakeSpawn {
  calls: { command: string; args: string[] }[];
  killCount: () => number;
  spawnImpl: (command: string, args: string[]) => { kill(): void; onExit(listener: () => void): void };
}

function createFakeSpawn(): FakeSpawn {
  const calls: { command: string; args: string[] }[] = [];
  const exitListeners: (() => void)[] = [];
  let killed = 0;
  let exited = false;
  return {
    calls,
    killCount: () => killed,
    spawnImpl: (command, args) => {
      calls.push({ command, args });
      return {
        kill: () => {
          killed += 1;
          if (exited) return;
          exited = true;
          for (const listener of exitListeners) listener();
        },
        onExit: (listener) => {
          if (exited) {
            listener();
            return;
          }
          exitListeners.push(listener);
        },
      };
    },
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function createMonitor(options: Partial<RenodeMonitorOptions> = {}) {
  const spawn = createFakeSpawn();
  const first = new FakeSocket();
  const sockets: FakeSocket[] = [first];
  let firstUsed = false;
  const monitor = new RenodeMonitor({
    monitorPort: DEFAULT_MONITOR_PORT,
    platform: "test-platform",
    spawnImpl: spawn.spawnImpl,
    connectImpl: async () => {
      if (!firstUsed) {
        firstUsed = true;
        return first;
      }
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    ...options,
  });
  return { monitor, spawn, sockets, socket: first };
}

describe("RenodeMonitor", () => {
  it("start 使用默认 Renode 路径与参数", async () => {
    const { monitor, spawn } = createMonitor();
    await monitor.start();

    expect(monitor.connected).toBe(true);
    expect(spawn.calls).toEqual([
      {
        command: DEFAULT_RENODE_PATH,
        args: ["-P", String(DEFAULT_MONITOR_PORT), "--disable-gui", "--hide-log", "--plain"],
      },
    ]);

    await monitor.stop();
  });

  it("send 串行执行，前一条完成前不写第二条", async () => {
    const { monitor, socket } = createMonitor();
    await monitor.start();

    const first = monitor.send("version");
    await flush();
    expect(socket.writes).toEqual(["version\n"]);

    const second = monitor.send("machine");
    await flush();
    expect(socket.writes).toEqual(["version\n"]);

    socket.emit("(machine-0) version\r\nRenode 1.14\r\n(machine-0) ");
    await expect(first).resolves.toBe("Renode 1.14");
    await flush();
    expect(socket.writes).toEqual(["version\n", "machine\n"]);

    socket.emit("(machine-0) machine\r\nname: machine-0\r\n(machine-0) ");
    await expect(second).resolves.toBe("name: machine-0");

    await monitor.stop();
  });

  it("提示符分片到达也能结束命令", async () => {
    const { monitor, socket } = createMonitor();
    await monitor.start();

    const result = monitor.send("info");
    await flush();

    socket.emit("(machine-0) info\r\narch: cortex-m\r\n(machine-0");
    const state = await Promise.race([
      result.then(() => "resolved"),
      flush().then(() => "pending"),
    ]);
    expect(state).toBe("pending");

    socket.emit(") ");
    await expect(result).resolves.toBe("arch: cortex-m");

    await monitor.stop();
  });

  it("去掉命令回显与尾部提示符", async () => {
    const { monitor, socket } = createMonitor();
    await monitor.start();

    const result = monitor.send("machine");
    await flush();
    socket.emit("(machine-0) machine\r\nline-1\r\nline-2\r\n(machine-0) ");
    await expect(result).resolves.toBe("line-1\nline-2");

    await monitor.stop();
  });

  it.each([
    "No such command 'foo'.",
    "There was an error executing command",
    "Peripheral does not provide such register",
    "Parameters did not match",
    "Renode is quitting",
  ])("输出含 %s 时 reject 并携带 command 与 output", async (pattern) => {
    const { monitor, socket } = createMonitor();
    await monitor.start();

    const pending = monitor.send("foo");
    await flush();
    socket.emit(`(machine-0) foo\r\n${pattern}\r\n(machine-0) `);

    const error = await pending.catch((err: unknown) => err);
    expect(error).toBeInstanceOf(RenodeCommandError);
    const renodeError = error as RenodeCommandError;
    expect(renodeError.command).toBe("foo");
    expect(renodeError.output).toContain(pattern);

    await monitor.stop();
  });

  it("命令超时 reject，重连后丢弃迟到响应", async () => {
    const { monitor, sockets } = createMonitor({ commandTimeoutMs: 20 });
    await monitor.start();

    const slow = monitor.send("slow");
    await expect(slow).rejects.toBeInstanceOf(RenodeCommandError);

    const next = monitor.send("version");
    await flush();
    expect(sockets).toHaveLength(2);
    expect(sockets[0].closed).toBe(true);

    sockets[0].emit("(machine-0) slow\r\nSTALE-TIMEOUT\r\n(machine-0) ");
    sockets[1].emit("(machine-0) version\r\nok\r\n(machine-0) ");
    await expect(next).resolves.toBe("ok");

    await monitor.stop();
  });

  it("send 在途 abort 后立即 reject 并在下一条命令前重连", async () => {
    const controller = new AbortController();
    const { monitor, sockets } = createMonitor();
    await monitor.start();

    const pending = monitor.send("version", controller.signal);
    await flush();
    expect(sockets[0].writes).toEqual(["version\n"]);

    controller.abort();
    await expect(pending).rejects.toThrow(/取消/);

    const next = monitor.send("machine");
    await flush();
    expect(sockets).toHaveLength(2);
    expect(sockets[0].closed).toBe(true);
    expect(sockets[0].writes).toEqual(["version\n"]);
    expect(sockets[1].writes).toEqual(["machine\n"]);

    sockets[0].emit("(machine-0) version\r\nSTALE-ABORT\r\n(machine-0) ");
    sockets[1].emit("(machine-0) machine\r\nname: m\r\n(machine-0) ");
    await expect(next).resolves.toBe("name: m");

    await monitor.stop();
  });

  it("abort 后重连失败时明确报错，不静默继续", async () => {
    const controller = new AbortController();
    const socket = new FakeSocket();
    let connectCalls = 0;
    const { monitor } = createMonitor({
      connectImpl: async () => {
        connectCalls += 1;
        if (connectCalls === 1) return socket;
        throw new Error("ECONNREFUSED");
      },
      connectRetries: 1,
      connectRetryDelayMs: 0,
    });
    await monitor.start();

    const pending = monitor.send("version", controller.signal);
    await flush();
    controller.abort();
    await expect(pending).rejects.toThrow(/取消/);

    await expect(monitor.send("machine")).rejects.toThrow(/重连失败/);
    expect(connectCalls).toBe(2);
    expect(socket.writes).toEqual(["version\n"]);

    await monitor.stop();
  });

  it("未启动时 send 直接 reject", async () => {
    const { monitor } = createMonitor();
    await expect(monitor.send("version")).rejects.toBeInstanceOf(RenodeCommandError);
  });

  it("stop 关闭 socket、kill 进程且可重复调用", async () => {
    const { monitor, spawn, socket } = createMonitor();
    await monitor.start();

    await monitor.stop();
    expect(socket.closed).toBe(true);
    expect(spawn.killCount()).toBe(1);
    expect(monitor.connected).toBe(false);

    await expect(monitor.stop()).resolves.toBeUndefined();
    expect(spawn.killCount()).toBe(1);
    expect(socket.closed).toBe(true);
  });

  it("stop 使进行中的命令失败", async () => {
    const { monitor, socket } = createMonitor();
    await monitor.start();

    const pending = monitor.send("version");
    await flush();
    socket.emit("(machine-0) version\r\npartial");
    await expect(monitor.stop()).resolves.toBeUndefined();

    await expect(pending).rejects.toBeInstanceOf(RenodeCommandError);
  });
});