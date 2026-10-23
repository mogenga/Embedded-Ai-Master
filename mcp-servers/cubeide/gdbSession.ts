import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GdbMi, GdbMiError, frameFields, unquote } from "./gdbMi.js";
import { reuseOrStartGdbServer, stopGdbServer, shutdownOpenOcdGracefully, findPyOcd, activeGdbServer, type GdbServerHandle } from "./gdbserver.js";
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
  /** OpenOCD 回退用的 target cfg 名（如 stm32f4x）；不给就从 cproject 推。 */
  targetCfg?: string;
}

/**
 * OpenOCD 回退：ST gdbserver 被 S7 固件挡时用 OpenOCD（espidf 那份，带全量
 * scripts）。target 从 .cproject 的 target_mcu 推（STM32F429 → stm32f4x 等）。
 */
function findOpenOcdFallback(projectDir: string | undefined, explicitCfg: string | undefined): { openocd: string; scripts: string; target: string } | null {
  if (!explicitCfg && !projectDir) return null;
  let target = explicitCfg ?? "";
  if (!target && projectDir) {
    try {
      const cproject = readFileSync(join(projectDir, ".cproject"), "utf8");
      // 两种实测格式：CubeMX 生成 `target_mcu.value.stm32...`（option id 里带
      // value），GUI 建的 `option target_mcu" ... value="STM32F429IGTx"`。
      // 直接找 value="STM32..." 的属性值最稳。
      const mcu = /value\s*=\s*"(STM32\w+?)"/.exec(cproject)?.[1] ?? "";
      // STM32F429IGTx → stm32f4x；STM32H743 → stm32h7x；STM32L476 → stm32l4x
      const family = /^stm32([fhlguw])(\d)/i.exec(mcu);
      if (family) {
        const letter = family[1]!.toLowerCase();
        const digit = family[2]!;
        target = letter === "h" ? "stm32h7x" : `stm32${letter}${digit}x`;
      }
    } catch {
      return null;
    }
  }
  if (!target) return null;
  // espidf 那份 openocd（带全量 scripts）：
  const toolsPath = process.env.IDF_TOOLS_PATH ?? join(homedir(), ".espressif");
  const openocdBase = join(toolsPath, "tools", "openocd-esp32");
  try {
    const versions = readdirSync(openocdBase, { withFileTypes: true })
      .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
    if (versions.length === 0) return null;
    const openocd = join(openocdBase, versions[0]!, "openocd-esp32", "bin", "openocd.exe");
    const scripts = join(openocdBase, versions[0]!, "openocd-esp32", "share", "openocd", "scripts");
    if (!existsSync(openocd) || !existsSync(join(scripts, "target", `${target}.cfg`))) return null;
    return { openocd, scripts, target };
  } catch {
    return null;
  }
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
  // CubeIDE 的产物名 = .project 的 <name>（实测：工程 test → Debug/test.elf；
  // 第一版只猜 Debug.elf 等固定名，真实工程全都匹配不上 → 符号没加载）。
  let projectName = "";
  try {
    projectName = /<name>([^<]+)<\/name>/.exec(readFileSync(join(projectDir, ".project"), "utf8"))?.[1] ?? "";
  } catch {
    /* no .project */
  }
  for (const config of ["Debug", "Release"]) {
    const candidates = [
      ...(projectName ? [join(projectDir, config, `${projectName}.elf`)] : []),
      join(projectDir, config, "firmware.elf"),
      join(projectDir, config, "application.elf"),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
    // 兜底：目录里唯一的 .elf
    try {
      const elves = readdirSync(join(projectDir, config)).filter((name) => name.endsWith(".elf"));
      if (elves.length === 1) return join(projectDir, config, elves[0]!);
    } catch {
      /* no such dir */
    }
  }
  return undefined;
}

export async function openSession(options: OpenOptions): Promise<OpenResult> {
  const log: string[] = [];
  try {
    // server 优先级：pyOCD（S7 克隆唯一稳定）→ ST gdbserver（官方探针）→
    // OpenOCD 兜底。pyOCD 的 target 用 cortex_m 通用型（全功能）。
    const pyocd = findPyOcd();
    const openocd = findOpenOcdFallback(options.projectDir, options.targetCfg);
    const server = await reuseOrStartGdbServer({
      tools: options.tools,
      port: options.port,
      ...(pyocd ? { pyocdFallback: { pyocd, target: "cortex_m" } } : {}),
      ...(openocd ? { openocdFallback: openocd } : {}),
    });
    const serverKind = pyocd ? "pyocd" : openocd ? "openocd fallback" : "st gdbserver";
    log.push(`gdbserver on port ${server.port} (${serverKind})`);
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
    // esp-gdb 17.1 的死锁窗口（实测，OpenOCD/pyOCD server 都中）：attach 后的
    // 第一次停如果是**断点命中**，gdb 会卡死到后续任何命令（连 -break-list 这种
    // 纯本地命令都不回）。attach 后立刻做一次 -exec-interrupt 确定性停再继续，
    // 之后断点停就正常了。目标本来就停时 interrupt 无副作用。
    try {
      await gdb.command("-exec-interrupt", 5000);
      await gdb.waitForStop(4000);
    } catch {
      /* 目标本来就停着：没有 stop 帧可等 */
    }
    log.push("settled (interrupt-first, esp-gdb deadlock workaround)");
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
      // 关闭顺序（实测教训，按因果排）：
      // 1. **先删全部断点**——硬件断点（FPB）残留在目标里，detach 后程序一旦
      //    跑到断点地址，目标进调试故障、SWD 整个死掉（实测反复断电才恢复）；
      // 2. 若目标停着，continue 让它离开停态（detach-resume 语义）；
      // 3. gdb-exit（内部 detach）；pyocd/openocd 进程随后由 stopGdbServer 收。
      try {
        // -break-delete 必须带断点号（MI 语法），裸命令会被 gdb 拒绝——断点
        // 没删掉、continue 立刻又命中同一个断点，detach 后 FPB 残留把目标拉死。
        // 先 -break-list 取全部编号再逐个删。
        const list = await session.gdb.command("-break-list", 3000);
        const body = String(list.values["body"] ?? "");
        for (const match of body.matchAll(/number="(\d+)"/g)) {
          await session.gdb.command(`-break-delete ${match[1]}`, 3000).catch(() => {});
        }
      } catch {
        /* 没有断点 */
      }
      try {
        await session.gdb.command("-exec-continue", 2000);
      } catch {
        /* 已经在跑或已停连——继续关 */
      }
      session.gdb.kill();
      sessions.delete(id);
      closed++;
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
  }
  if (sessions.size === 0) {
    // pyOCD 是长驻 server（--persist）：不杀进程，留给下次 open 复用。实测
    // （Windows）kill 掉 pyocd 进程后探针 USB 层残留坏状态，SWD 随之失联——
    // 进程退出本身是死亡事件的强相关项。close 只收 gdb，server 常驻空闲。
    const handle = activeGdbServer();
    if (handle && !handle.process) {
      // 外部起的 server（我们没 spawn）——什么都不做。
    } else if (handle?.process && /pyocd/i.test(handle.process.spawnfile ?? "")) {
      // pyocd 常驻：跳过 kill。
    } else {
      await shutdownOpenOcdGracefully().catch(() => false);
      stopGdbServer();
    }
  }
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
