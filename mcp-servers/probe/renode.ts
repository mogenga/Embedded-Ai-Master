import { spawn } from "node:child_process";
import net from "node:net";

export const DEFAULT_RENODE_PATH = "C:/Program Files/Renode/bin/Renode.exe";
export const DEFAULT_MONITOR_PORT = 1234;
export const DEFAULT_COMMAND_TIMEOUT_MS = 5_000;
export const CONNECT_RETRIES = 60;
export const CONNECT_RETRY_DELAY_MS = 250;
export const STOP_EXIT_TIMEOUT_MS = 2_000;

const PROMPT_PATTERN = /\(machine-\d+\)/g;
const PROMPT_PREFIX = /^\(machine-\d+\)\s*/;
const ERROR_PATTERNS = [
  "No such command",
  "There was an error executing command",
  "does not provide",
  "Parameters did not match",
  "Renode is quitting",
] as const;

export interface MonitorSocket {
  write(data: string): void;
  onData(listener: (chunk: string) => void): void;
  onClose(listener: () => void): void;
  close(): void;
}

export interface RenodeProcess {
  kill(): void;
  onExit(listener: () => void): void;
}

export interface RenodeMonitorOptions {
  renodePath?: string;
  monitorPort?: number;
  platform?: string;
  spawnImpl?: (command: string, args: string[]) => RenodeProcess;
  connectImpl?: (port: number) => Promise<MonitorSocket>;
  commandTimeoutMs?: number;
}

export class RenodeCommandError extends Error {
  readonly command: string;
  readonly output: string;

  constructor(command: string, output: string, detail?: string) {
    const message = detail ?? `Renode 命令执行失败: ${command}`;
    super(output ? `${message}\n${output}` : message);
    this.name = "RenodeCommandError";
    this.command = command;
    this.output = output;
  }
}

interface PendingCommand {
  command: string;
  buffer: string;
  timer: NodeJS.Timeout;
  resolve(value: string): void;
  reject(error: Error): void;
}

interface PromptMatch {
  start: number;
  end: number;
}

function lastPrompt(buffer: string): PromptMatch | undefined {
  const pattern = new RegExp(PROMPT_PATTERN.source, "g");
  let last: RegExpExecArray | undefined;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(buffer)) !== null) last = match;
  if (!last) return undefined;
  return { start: last.index, end: last.index + last[0].length };
}

function cleanOutput(raw: string, command: string): string {
  const lines = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  if (lines.length > 0) {
    const echo = lines[0].replace(PROMPT_PREFIX, "").trim();
    if (echo === command.trim()) lines.shift();
  }
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.join("\n").trim();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitWithTimeout(promise: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  await Promise.race([promise, timeout]);
  if (timer) clearTimeout(timer);
}

function createSocket(port: number): Promise<MonitorSocket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    const dataListeners: ((chunk: string) => void)[] = [];
    const closeListeners: (() => void)[] = [];
    let established = false;

    socket.on("data", (chunk) => {
      const text = String(chunk);
      for (const listener of dataListeners) listener(text);
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

function spawnRenode(command: string, args: string[]): RenodeProcess {
  const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
  const exitListeners: (() => void)[] = [];
  let exited = false;

  const emitExit = (): void => {
    if (exited) return;
    exited = true;
    for (const listener of exitListeners) listener();
    exitListeners.length = 0;
  };

  child.once("exit", emitExit);
  child.once("error", emitExit);

  return {
    kill: () => {
      child.kill();
    },
    onExit: (listener) => {
      if (exited) {
        listener();
        return;
      }
      exitListeners.push(listener);
    },
  };
}

export class RenodeMonitor {
  private readonly renodePath: string;
  private readonly monitorPort: number;
  private readonly platform: string;
  private readonly spawnImpl: (command: string, args: string[]) => RenodeProcess;
  private readonly connectImpl: (port: number) => Promise<MonitorSocket>;
  private readonly commandTimeoutMs: number;

  private child?: RenodeProcess;
  private childExit?: Promise<void>;
  private socket?: MonitorSocket;
  private pending?: PendingCommand;
  private connectedFlag = false;
  private queue: Promise<unknown> = Promise.resolve();
  private startPromise?: Promise<void>;
  private stopPromise?: Promise<void>;

  constructor(options: RenodeMonitorOptions = {}) {
    this.renodePath = options.renodePath ?? DEFAULT_RENODE_PATH;
    this.monitorPort = options.monitorPort ?? DEFAULT_MONITOR_PORT;
    this.platform = options.platform ?? "";
    this.spawnImpl = options.spawnImpl ?? spawnRenode;
    this.connectImpl = options.connectImpl ?? createSocket;
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  }

  get connected(): boolean {
    return this.connectedFlag && this.socket !== undefined;
  }

  start(): Promise<void> {
    if (this.connected) return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.doStart().finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  send(command: string): Promise<string> {
    const run = this.queue.then(
      () => this.execute(command),
      () => this.execute(command),
    );
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.doStop();
    return this.stopPromise;
  }

  private async doStart(): Promise<void> {
    this.stopPromise = undefined;
    const child = this.spawnImpl(this.renodePath, [
      "-P",
      String(this.monitorPort),
      "--disable-gui",
      "--hide-log",
      "--plain",
    ]);
    this.child = child;
    this.childExit = new Promise<void>((resolve) => {
      child.onExit(() => {
        if (this.child === child) this.child = undefined;
        this.handleClose();
        resolve();
      });
    });

    let socket: MonitorSocket | undefined;
    let lastError: unknown;
    for (let attempt = 0; attempt < CONNECT_RETRIES; attempt++) {
      try {
        socket = await this.connectImpl(this.monitorPort);
        break;
      } catch (error) {
        lastError = error;
        await delay(CONNECT_RETRY_DELAY_MS);
      }
    }

    if (!socket) {
      this.child = undefined;
      this.childExit = undefined;
      child.kill();
      const reason = lastError instanceof Error ? lastError.message : String(lastError);
      throw new Error(`无法连接 Renode monitor 端口 ${this.monitorPort}: ${reason}`);
    }

    if (this.child !== child) {
      socket.close();
      throw new Error("Renode monitor 在启动过程中被停止");
    }

    this.socket = socket;
    this.connectedFlag = true;
    socket.onData((chunk) => this.handleData(chunk));
    socket.onClose(() => this.handleClose());
  }

  private execute(command: string): Promise<string> {
    const socket = this.socket;
    if (!socket || !this.connectedFlag) {
      return Promise.reject(new RenodeCommandError(command, "", "Renode monitor 未连接"));
    }

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.timer !== timer) return;
        const current = this.pending;
        this.pending = undefined;
        reject(
          new RenodeCommandError(
            command,
            current.buffer,
            `Renode 命令超时(${this.commandTimeoutMs}ms): ${command}`,
          ),
        );
      }, this.commandTimeoutMs);

      this.pending = { command, buffer: "", timer, resolve, reject };
      socket.write(`${command}\n`);
    });
  }

  private handleData(chunk: string): void {
    const pending = this.pending;
    if (!pending) return;

    pending.buffer += chunk;
    const prompt = lastPrompt(pending.buffer);
    if (!prompt) return;
    if (pending.buffer.slice(prompt.end).trim() !== "") return;

    this.pending = undefined;
    clearTimeout(pending.timer);

    const output = cleanOutput(pending.buffer.slice(0, prompt.start), pending.command);
    const failure = ERROR_PATTERNS.find((pattern) => output.includes(pattern));
    if (failure) {
      pending.reject(
        new RenodeCommandError(
          pending.command,
          output,
          `Renode 命令执行失败(${failure}): ${pending.command}`,
        ),
      );
      return;
    }
    pending.resolve(output);
  }

  private handleClose(): void {
    this.connectedFlag = false;
    const pending = this.pending;
    if (!pending) return;
    this.pending = undefined;
    clearTimeout(pending.timer);
    pending.reject(
      new RenodeCommandError(pending.command, pending.buffer, "Renode monitor 连接已关闭"),
    );
  }

  private async doStop(): Promise<void> {
    const pending = this.pending;
    this.pending = undefined;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(
        new RenodeCommandError(pending.command, pending.buffer, "Renode monitor 已停止"),
      );
    }

    this.connectedFlag = false;
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      try {
        socket.close();
      } catch {
        // 关闭失败不阻塞清理。
      }
    }

    const child = this.child;
    const exited = this.childExit;
    this.child = undefined;
    this.childExit = undefined;
    if (!child) return;

    try {
      child.kill();
    } catch {
      // 进程可能已自行退出。
    }
    if (exited) await waitWithTimeout(exited, STOP_EXIT_TIMEOUT_MS);
  }
}