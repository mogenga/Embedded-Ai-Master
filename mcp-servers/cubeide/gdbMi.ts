import { spawn, type ChildProcess } from "node:child_process";

/**
 * GDB/MI v2 客户端（over stdio）。
 *
 * 与 uvsock.ts 同等地位的一层：进程内的协议编解码。区别在于 GDB/MI 是
 * **公开文档的文本协议**（GDB 手册 §GDB/MI），不逆向、不需要版本偏移表。
 *
 * 帧格式：
 *   <token><result-class>…\n          — result-record（^done/^error/^running/^exit）
 *   <token>*<async-class>…\n          — exec-async（*stopped 等）
 *   ~"…"\n  &"…"\n  @"…"\n            — console/log/target 流输出
 *
 * token 是我们发起命令时带上、GDB 原样回显的数字，靠它把应答对回命令。
 * MI 字符串值是 C 风格转义的引号字符串，这里做解码；元组/列表用轻量解析
 * （只解析调试动作面用得到的形状，不做完整 MI 语法树）。
 */

export interface MiResult {
  token: number;
  resultClass: "done" | "running" | "connected" | "error" | "exit";
  /** result-record 的属性（^done,frame={...} → { frame: "..." }）值保留原文。 */
  values: Record<string, string>;
  /** 随这条应答一起到达的流输出（console/log），已去引号。 */
  streams: string[];
  /** 已到达但属于别的 token 的 exec-async 记录（一般是 *stopped）。 */
  async: MiAsync[];
}

export interface MiAsync {
  kind: "exec" | "status" | "notify";
  resultClass: string;
  values: Record<string, string>;
}

export class GdbMiError extends Error {
  constructor(message: string, readonly raw?: string) {
    super(message);
  }
}

/** MI 的 C 风格字符串解码（处理 \" \\ \n \t \xNN）。 */
export function unquote(text: string): string {
  if (!text.startsWith('"')) return text;
  let out = "";
  let i = 1;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') break;
    if (ch === "\\") {
      const next = text[i + 1];
      if (next === "n") { out += "\n"; i += 2; continue; }
      if (next === "t") { out += "\t"; i += 2; continue; }
      if (next === "r") { out += "\r"; i += 2; continue; }
      if (next === "\\") { out += "\\"; i += 2; continue; }
      if (next === '"') { out += '"'; i += 2; continue; }
      if (next === "x" && /[0-9a-fA-F]{2}/.test(text.slice(i + 2, i + 4))) {
        out += String.fromCharCode(parseInt(text.slice(i + 2, i + 4), 16));
        i += 4;
        continue;
      }
      out += next ?? "";
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** MI 字符串编码（值进 -data-evaluate-expression / break-insert 之前）。 */
export function miQuote(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/**
 * 解析一条 MI 行；解析不了的返回 null（例如 --mumble 提示行）。
 */
export function parseMiLine(line: string): MiResult | MiAsync | null {
  if (!line) return null;
  let i = 0;
  while (i < line.length && line[i]! >= "0" && line[i]! <= "9") i++;
  const token = i > 0 ? Number(line.slice(0, i)) : 0;
  const marker = line[i];
  const rest = line.slice(i + 1);
  if (marker === "*" || marker === "=" || marker === "+") {
    // async-class 的边界是空格或逗号：`*stopped,reason=...` 也合法。
    const end = /[, ]/.exec(rest)?.index ?? rest.length;
    const resultClass = rest.slice(0, end);
    return {
      kind: marker === "*" ? "exec" : marker === "=" ? "notify" : "status",
      resultClass,
      values: end >= rest.length ? {} : parseCsv(rest.slice(end + 1)),
    };
  }
  if (marker === "^") {
    const end = /[, ]/.exec(rest)?.index ?? rest.length;
    const resultClass = rest.slice(0, end);
    return {
      token,
      resultClass: resultClass as MiResult["resultClass"],
      values: end >= rest.length ? {} : parseCsv(rest.slice(end + 1)),
      streams: [],
      async: [],
    };
  }
  return null;
}

/**
 * 解析 MI 的 result/value 串：`a="1",b={x="2"},c=["3","4"]`。
 * 只做一层深度即可满足动作面的需要；value 保留**原文**（含引号），
 * 由取用方决定 unquote。这比写完整解析器便宜，也更容易保持诚实——
 * 解析失败时原文还在。
 */
export function parseCsv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  const readValue = (): string => {
    const start = i;
    let depth = 0;
    let inString = false;
    while (i < text.length) {
      const ch = text[i]!;
      if (inString) {
        if (ch === "\\") i++;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) { i++; break; }
      } else if (ch === "," && depth === 0) break;
      i++;
    }
    return text.slice(start, i);
  };
  while (i < text.length) {
    const eq = text.indexOf("=", i);
    if (eq === -1) break;
    const key = text.slice(i, eq).trim();
    i = eq + 1;
    const value = readValue();
    if (key) out[key] = value;
    if (text[i] === ",") i++;
  }
  return out;
}

/** 从 frame={...} 的值里抽出扁平字段（供 stack/stop 报告）。 */
export function frameFields(raw: string): Record<string, string> {
  if (!raw.startsWith("{")) return {};
  const inner = raw.slice(1, raw.endsWith("}") ? -1 : undefined);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parseCsv(inner))) {
    out[key] = unquote(value);
  }
  return out;
}

export interface GdbMiOptions {
  gdbPath: string;
  args?: string[];
  spawnImpl?: typeof spawn;
}

interface Pending {
  token: number;
  resolve(result: MiResult): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

/**
 * 一个 gdb --interpreter=mi2 进程的会话。
 *
 * 生命周期：spawn → (gdb 会自动到提示符) → 各命令 → `-gdb-exit` → 等退出。
 */
export class GdbMi {
  private child: ChildProcess;
  private buffer = "";
  private nextToken = 1;
  private pending = new Map<number, Pending>();
  /** 收到的 *stopped（供 run/continue 的 waitForStop 语义）。 */
  private stops: MiAsync[] = [];
  private stopWaiters: Array<(stop: MiAsync) => void> = [];
  private closed = false;
  readonly streams: string[] = [];

  constructor(options: GdbMiOptions) {
    const spawnImpl = options.spawnImpl ?? spawn;
    this.child = spawnImpl(options.gdbPath, ["--interpreter=mi2", "-nx", ...(options.args ?? [])], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => this.onData(chunk));
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (chunk: string) => this.streams.push(chunk));
    this.child.on("exit", () => {
      this.closed = true;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new GdbMiError("gdb exited"));
      }
      this.pending.clear();
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) break;
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      this.onLine(line);
    }
  }

  private onLine(line: string): void {
    if (!line) return;
    if (line.startsWith("~") || line.startsWith("&") || line.startsWith("@")) {
      this.streams.push(unquote(line.slice(1)));
      return;
    }
    const parsed = parseMiLine(line);
    if (!parsed) return;
    if ("token" in parsed) {
      const pending = this.pending.get(parsed.token);
      if (pending) {
        this.pending.delete(parsed.token);
        clearTimeout(pending.timer);
        parsed.streams = [];
        if (parsed.resultClass === "error") {
          pending.reject(new GdbMiError(unquote(parsed.values["msg"] ?? "gdb error"), line));
        } else {
          pending.resolve(parsed);
        }
      } else if (parsed.resultClass === "exit") {
        this.closed = true;
      }
      return;
    }
    if (parsed.kind === "exec" && parsed.resultClass === "stopped") {
      this.stops.push(parsed);
      const waiter = this.stopWaiters.shift();
      if (waiter) waiter(parsed);
    }
  }

  get exited(): boolean {
    return this.closed;
  }

  /** 等下一条 *stopped（带超时）。run/continue 的成功以停帧为准。 */
  async waitForStop(timeoutMs: number): Promise<{ reason: string; values: Record<string, string>; streams: string[] }> {
    const existing = this.stops.shift();
    if (existing) return { reason: existing.resultClass, values: existing.values, streams: [] };
    const stop = await new Promise<MiAsync>((resolve, reject) => {
      const timer = setTimeout(() => reject(new GdbMiError(`no stop within ${timeoutMs}ms`)), timeoutMs);
      this.stopWaiters.push((found) => {
        clearTimeout(timer);
        resolve(found);
      });
    });
    return { reason: stop.resultClass, values: stop.values, streams: [] };
  }

  /** 发一条 MI 命令，等它的 result-record。 */
  async command(text: string, timeoutMs = 15_000): Promise<MiResult> {
    if (this.closed) throw new GdbMiError("gdb session is closed");
    const token = this.nextToken++;
    const line = `${token}${text.startsWith("-") ? text : `-interpreter-exec console "${miQuote(text)}"`}`;
    const result = await new Promise<MiResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(token);
        reject(new GdbMiError(`gdb did not answer ${JSON.stringify(text)} within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(token, { token, resolve, reject, timer });
      this.child.stdin?.write(`${line}\n`);
    });
    result.token = token;
    return result;
  }

  kill(): void {
    try {
      this.child.stdin?.write("0-gdb-exit\n");
    } catch {
      /* stdin 已关 */
    }
    setTimeout(() => {
      try {
        this.child.kill();
      } catch {
        /* already gone */
      }
    }, 500);
  }
}
