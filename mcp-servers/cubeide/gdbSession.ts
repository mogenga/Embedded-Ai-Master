import { join } from "node:path";
import { existsSync } from "node:fs";
import { GdbMi, GdbMiError, frameFields, unquote } from "./gdbMi.js";
import { reuseOrStartGdbServer, stopGdbServer, type GdbServerHandle } from "./gdbserver.js";
import type { CubeIdeTools } from "./cubeideInstall.js";

/**
 * 调试会话（单会话模型，语义对齐 keilSession 但实现走 GDB/MI）。
 *
 * 生命周期：open（起 gdbserver → spawn gdb → target-select remote → 若带
 * 镜像则 file+load）→ 动作 → close（gdb-exit → 关 gdbserver 树）。
 *
 * 会话在工具调用之间保持：重新 attach 会复位目标、丢断点，跨调用重建
 * 会让 set-and-run 变得不可能（与 keil 侧同一条实测教训）。
 */

export interface CubeIdeSession {
  key: string;
  tools: CubeIdeTools;
  gdb: GdbMi;
  server: GdbServerHandle;
  /** gdb 加载的 ELF（file 命令的参数），符号与断点解析靠它。 */
  elf?: string;
  /** target-select 时的扩展信息，供 status 汇报。 */
  openedAt: number;
}

const sessions = new Map<string, CubeIdeSession>();

export function listCubeIdeSessions(): CubeIdeSession[] {
  return [...sessions.values()];
}

export function activeSession(): CubeIdeSession | undefined {
  return [...sessions.values()].at(-1);
}

export interface OpenOptions {
  tools: CubeIdeTools;
  /** 工程目录（含 .project）；用于找构建产物 ELF。 */
  projectDir?: string;
  /** 显式指定 ELF；不给就在工程目录下找 .elf。 */
  elf?: string;
  port?: number;
  /** 是否下载镜像到目标（默认 true：CubeIDE 工作流的"进调试"含下载）。 */
  load?: boolean;
}

export interface OpenResult {
  ok: boolean;
  key?: string;
  reason?: string;
  log: string[];
}

function findElf(projectDir: string | undefined, explicit: string | undefined): string | undefined {
  if (explicit) return existsSync(explicit) ? explicit : undefined;
  if (!projectDir) return undefined;
  // CubeIDE 生成的工程把产物放在 Debug/ 或 Release/ 下，与配置同名。
  for (const config of ["Debug", "Release"]) {
    for (const entry of [`${config}.elf`, "firmware.elf", "application.elf"]) {
      const candidate = join(projectDir, config, entry);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

export async function openSession(options: OpenOptions): Promise<OpenResult> {
  const log: string[] = [];
  try {
    const server = await reuseOrStartGdbServer({ tools: options.tools, port: options.port });
    log.push(`gdbserver on port ${server.port}`);
    const gdb = new GdbMi({ gdbPath: options.tools.gdb });
    await gdb.command("-gdb-set pagination off");
    await gdb.command("-gdb-set confirm off");
    const elf = findElf(options.projectDir, options.elf);
    if (elf) {
      await gdb.command(`-file-exec-and-symbols "${elf.replace(/\\/g, "/")}"`);
      log.push(`symbols: ${elf}`);
    }
    await gdb.command(`-target-select remote 127.0.0.1:${server.port}`, 20_000);
    log.push("attached to gdbserver");
    if (elf && options.load !== false) {
      await gdb.command("-target-download", 120_000);
      log.push(`downloaded ${elf}`);
    }
    const key = `cubeide-${Date.now().toString(36)}`;
    const session: CubeIdeSession = {
      key,
      tools: options.tools,
      gdb,
      server,
      ...(elf ? { elf } : {}),
      openedAt: Date.now(),
    };
    sessions.set(key, session);
    return { ok: true, key, log };
  } catch (error) {
    const reason = error instanceof GdbMiError || error instanceof Error ? error.message : String(error);
    log.push(reason);
    return { ok: false, reason, log };
  }
}

export async function closeSession(key?: string): Promise<{ closed: number; reason?: string }> {
  const targets = key ? [...sessions.entries()].filter(([id]) => id === key) : [...sessions.entries()];
  let closed = 0;
  let reason: string | undefined;
  for (const [id, session] of targets) {
    try {
      session.gdb.kill();
      sessions.delete(id);
      closed++;
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
  }
  if (sessions.size === 0 && stopGdbServer()) closed += 0; // gdbserver stop is reported via return below
  return { closed, ...(reason ? { reason } : {}) };
}

/** 当前停帧（stack-list-frames 的第 0 层），status / 各读数动作的定位用。 */
export async function currentFrame(session: CubeIdeSession): Promise<Record<string, string>> {
  const reply = await session.gdb.command("-stack-list-frames 0 0");
  const raw = reply.values["frame"];
  return frameFields(raw ?? "");
}

export async function listBreakpoints(session: CubeIdeSession): Promise<Record<string, string>[]> {
  const reply = await session.gdb.command("-break-list");
  const body = reply.values["body"] ?? "[]";
  // body 是 [bkpt={...},bkpt={...}] 形状；按 bkpt={...} 切开。
  const out: Record<string, string>[] = [];
  for (const match of body.matchAll(/bkpt=\{([^{}]*)\}/g)) {
    const fields: Record<string, string> = {};
    for (const [key, value] of Object.entries(parseFlat(match[1] ?? ""))) {
      fields[key] = unquote(value);
    }
    out.push(fields);
  }
  return out;
}

function parseFlat(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i < text.length) {
    const eq = text.indexOf("=", i);
    if (eq === -1) break;
    const key = text.slice(i, eq).trim();
    i = eq + 1;
    let value: string;
    if (text[i] === '"') {
      const start = i;
      i++;
      while (i < text.length) {
        if (text[i] === "\\") i++;
        else if (text[i] === '"') { i++; break; }
        i++;
      }
      value = text.slice(start, i);
    } else {
      const comma = text.indexOf(",", i);
      value = text.slice(i, comma === -1 ? text.length : comma);
      i = comma === -1 ? text.length : comma;
    }
    if (key) out[key] = value;
    if (text[i] === ",") i++;
  }
  return out;
}
