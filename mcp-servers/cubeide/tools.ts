import type { ProbeToolResult, ProbeToolSpec } from "../probe/tools.js";
import {
  CUBEIDE_DEBUG_ACTIONS,
  CUBEIDE_BUILD_ACTIONS,
  CUBEIDE_EVIDENCE_ACTIONS,
  CUBEIDE_DESTRUCTIVE_ACTIONS,
  DEBUG_DESCRIPTION,
  BUILD_DESCRIPTION,
  cubeideDebugInputSchema,
  cubeideBuildInputSchema,
} from "./actions.js";
import { declarationFor } from "./declarations.js";
import { findCubeIdeTools, type CubeIdeTools } from "./cubeideInstall.js";
import { findCubeMx, mxGenerate, mxRunScript } from "./cubeMx.js";
import { findEclipseProjects, readEclipseName } from "./eclipseProject.js";
import { headlessBuild } from "./cubeideBuild.js";
import { chipErase, flashImage, probeTarget, summarizeProbeList } from "./cubeideFlash.js";
import {
  activeSession,
  closeSession,
  currentFrame,
  listBreakpoints,
  listCubeIdeSessions,
  openSession,
} from "./gdbSession.js";
import { GdbMiError, frameFields, unquote } from "./gdbMi.js";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * `cubeide_debug` / `cubeide_build` 两个工具。
 *
 * 与 keil/tools.ts 同构：动作面在 actions.ts，会话在 gdbSession.ts，协议在
 * gdbMi.ts。返回形状直接是 ProbeToolResult（这里没有 A 侧遗留形状要兼容）。
 */

const hex = (value: number) => `0x${value.toString(16)}`;

function fail(code: string, message: string): ProbeToolResult {
  const structuredContent = { code, message };
  return {
    content: [{ type: "text", text: message }],
    structuredContent,
    isError: true,
  };
}

function ok(lines: string[], data?: Record<string, unknown>, extra: Partial<ProbeToolResult> = {}): ProbeToolResult {
  const text = lines.join("\n");
  const structuredContent = data ? { ...data } : undefined;
  return {
    content: [{ type: "text", text }],
    ...(structuredContent ? { structuredContent } : {}),
    ...extra,
  };
}

/** 解析工程参数：显式目录 → 自动识别。返回工程目录与工程名。 */
function resolveProject(input: { project?: string }): { dir?: string; name?: string; error?: string } {
  const explicit = input.project;
  if (explicit) {
    if (existsSync(join(explicit, ".project")) && existsSync(join(explicit, ".cproject"))) {
      const name = readEclipseName(join(explicit, ".project"));
      return name ? { dir: explicit, name } : { error: `cannot read the project name from ${explicit}/.project` };
    }
    // 允许传 .project 文件路径
    if (explicit.endsWith(".project")) {
      const dir = join(explicit, "..");
      const name = readEclipseName(explicit);
      return name ? { dir, name } : { error: `cannot read the project name from ${explicit}` };
    }
    return { error: `${explicit} has no .project/.cproject pair — this is not a CubeIDE (Eclipse CDT) project` };
  }
  const found = findEclipseProjects(process.cwd());
  if (found.length === 0) return { error: "no CubeIDE project found in the working directory (no .project/.cproject pair); pass `project`" };
  if (found.length > 1) {
    return {
      error: `several CubeIDE projects here: ${found.map((entry) => entry.name).join(", ")}; pass \`project\` with the one you mean`,
    };
  }
  return { dir: found[0]!.dir, name: found[0]!.name };
}

function toolsOrError(): CubeIdeTools | ProbeToolResult {
  const tools = findCubeIdeTools();
  if (!tools) {
    return fail(
      "cubeide_not_installed",
      "STM32CubeIDE is not installed (or CUBEIDE_HOME does not point at an install root with stm32cubeidec.exe and plugins/). " +
        "The bundled gdb, ST-LINK gdbserver and STM32_Programmer_CLI all come from the IDE install; nothing here works without it.",
    );
  }
  return tools;
}

// ---- cubeide_debug ----------------------------------------------------------

const WIDTH_BYTES: Record<string, number> = { u8: 1, u16: 2, u32: 4 };

function isToolResult(value: CubeIdeTools | ProbeToolResult): value is ProbeToolResult {
  return (value as ProbeToolResult).isError !== undefined || !(value as CubeIdeTools).gdb;
}

class SessionRequired extends Error {}

async function requireSession(): Promise<{ session: NonNullable<ReturnType<typeof activeSession>> } | ProbeToolResult> {
  const session = activeSession();
  if (!session) return fail("not_open", "no CubeIDE debug session is open — call `open` first");
  return { session };
}

const cubeideDebugTool: ProbeToolSpec = {
  name: "cubeide_debug",
  description: DEBUG_DESCRIPTION,
  inputSchema: cubeideDebugInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: true },
  meta: {
    evidence: true,
    evidenceActions: [...CUBEIDE_EVIDENCE_ACTIONS],
    destructiveActions: [...CUBEIDE_DESTRUCTIVE_ACTIONS],
  },
  handler: async (args: unknown): Promise<ProbeToolResult> => {
    const input = (args ?? {}) as Record<string, unknown>;
    const action = String(input.action);
    const toolsResult = toolsOrError();
    if (isToolResult(toolsResult)) return toolsResult;
    const tools = toolsResult;

    const sessionFor = async (): Promise<NonNullable<ReturnType<typeof activeSession>>> => {
      const session = activeSession();
      if (!session) throw new SessionRequired();
      return session;
    };

    try {
      switch (action) {
        case "open": {
          const project = resolveProject(input);
          if (project.error) return fail("bad_project", project.error);
          const opened = await openSession({
            tools,
            ...(project.dir ? { projectDir: project.dir } : {}),
            ...(input.elf ? { elf: String(input.elf) } : {}),
            ...(input.port !== undefined ? { port: Number(input.port) } : {}),
            ...(input.load !== undefined ? { load: input.load === true } : {}),
          });
          return opened.ok
            ? ok([`opened ${project.name}`, ...opened.log], { tool: "cubeide_debug", action, session: opened.key })
            : fail("open_failed", [`could not open a debug session:`, ...opened.log].join("\n"));
        }
        case "close": {
          const closed = await closeSession(input.key ? String(input.key) : undefined);
          return ok([`closed ${closed.closed} session(s)`, ...(closed.reason ? [closed.reason] : [])]);
        }
        case "sessions": {
          const listed = listCubeIdeSessions();
          return ok(listed.length > 0 ? listed.map((entry) => `${entry.key}  elf=${entry.elf ?? "(none)"}  port=${entry.server.port}`) : ["(no open sessions)"]);
        }
        case "status": {
          const session = await sessionFor();
          
          const frame = await currentFrame(session);
          return ok(
            frame["addr"]
              ? [`stopped at ${frame["func"] ?? "?"} (${frame["file"] ?? "?"}:${frame["line"] ?? "?"}) ${hex(Number(frame["addr"]))}`]
              : ["running (no frame — halt first to inspect)"],
            { tool: "cubeide_debug", action, frame },
          );
        }
        case "run":
        case "continue": {
          const session = await sessionFor();
          
          await session.gdb.command("-exec-continue");
          return ok(["running; `halt` to stop it, or set a breakpoint first"]);
        }
        case "halt": {
          const session = await sessionFor();
          
          await session.gdb.command("-exec-interrupt");
          const stop = await session.gdb.waitForStop(input.timeout_ms ? Number(input.timeout_ms) : 5000);
          const frame = frameFields(String(stop.values["frame"] ?? ""));
          return ok([`halted at ${frame["func"] ?? "?"} (${hex(Number(frame["addr"] ?? 0))})`], { tool: "cubeide_debug", action, frame });
        }
        case "reset": {
          const session = await sessionFor();
          
          // monitor reset 走 console 通道：gdbserver 支持 `monitor reset`。
          await session.gdb.command("-interpreter-exec console \"monitor reset halt\"");
          const stop = await session.gdb.waitForStop(input.timeout_ms ? Number(input.timeout_ms) : 5000);
          return ok([`reset, halted at ${hex(Number(frameFields(String(stop.values["frame"] ?? "")).addr ?? 0))}`]);
        }
        case "run_to": {
          if (!input.location) return fail("missing_location", "run_to needs a `location` (function or file:line)");
          const session = await sessionFor();
          
          const location = String(input.location);
          await session.gdb.command(`-break-insert -t ${location}`);
          await session.gdb.command("-exec-continue");
          const stop = await session.gdb.waitForStop(input.timeout_ms ? Number(input.timeout_ms) : 30_000);
          const frame = frameFields(String(stop.values["frame"] ?? ""));
          return ok([`stopped at ${frame["func"] ?? "?"} (${frame["file"] ?? "?"}:${frame["line"] ?? "?"})`], { tool: "cubeide_debug", action, frame });
        }
        case "step":
        case "step_into":
        case "step_instruction":
        case "step_out": {
          const session = await sessionFor();
          
          const op =
            action === "step" ? "-exec-step"
            : action === "step_into" ? "-exec-step"
            : action === "step_instruction" ? "-exec-step-instruction"
            : "-exec-finish";
          await session.gdb.command(op);
          const stop = await session.gdb.waitForStop(input.timeout_ms ? Number(input.timeout_ms) : 10_000);
          const frame = frameFields(String(stop.values["frame"] ?? ""));
          return ok([`at ${frame["func"] ?? "?"} (${frame["file"] ?? "?"}:${frame["line"] ?? "?"})`], { tool: "cubeide_debug", action, frame });
        }
        case "breakpoints": {
          const session = await sessionFor();
          
          const listed = await listBreakpoints(session);
          return ok(listed.map((entry) => `${entry["number"]} ${entry["enabled"] === "y" ? "" : "(disabled) "}${entry["addr"]} ${entry["what"] ?? ""}`));
        }
        case "breakpoint_add": {
          if (!input.location) return fail("missing_location", "breakpoint_add needs a `location` (function or file:line)");
          const session = await sessionFor();
          
          const reply = await session.gdb.command(`-break-insert ${String(input.location)}`);
          return ok([`breakpoint ${reply.values["bkpt"] ? "" : ""}set at ${String(input.location)}`], { tool: "cubeide_debug", action });
        }
        case "breakpoint_delete": {
          if (!input.value && !input.location) return fail("missing_argument", "breakpoint_delete needs `value` = the breakpoint number");
          const session = await sessionFor();
          
          await session.gdb.command(`-break-delete ${String(input.value ?? input.location)}`);
          return ok([`deleted breakpoint ${String(input.value ?? input.location)}`]);
        }
        case "registers": {
          const session = await sessionFor();
          
          const names = await session.gdb.command("-data-list-register-names");
          const rawNames = names.values["register-names"] ?? "[]";
          const list = rawNames.replace(/^\[|\]$/g, "").split(",").filter((entry) => entry && entry !== "''").map((entry) => unquote(entry.trim()));
          const values = await session.gdb.command("-data-list-register-values x");
          const rawValues = values.values["register-values"] ?? "[]";
          const pairs: string[] = [];
          const valueMatches = [...rawValues.matchAll(/number="(\d+)"\s*,\s*value="([^"]*)"/g)];
          for (let i = 0; i < list.length && i < valueMatches.length; i++) {
            pairs.push(`${list[i]}=${valueMatches[i]![2]}`);
          }
          return ok(pairs.length > 0 ? pairs : ["(no register values — the target must be halted)"]);
        }
        case "register_read": {
          if (!input.expression) return fail("missing_expression", "register_read needs an `expression` (e.g. `pc`, `$sp`)");
          const session = await sessionFor();
          
          const reply = await session.gdb.command(`-data-evaluate-expression \$${String(input.expression).replace(/^\$/, "")}`);
          return ok([`${input.expression} = ${unquote(reply.values["value"] ?? "?")}`]);
        }
        case "variables": {
          const session = await sessionFor();
          
          const frame = await currentFrame(session);
          const reply = await session.gdb.command("-stack-list-variables --simple-values");
          const body = reply.values["variables"] ?? "[]";
          const names = [...body.matchAll(/name="([^"]*)"\s*,\s*(?:value="([^"]*)"\s*,\s*)?type="([^"]*)"/g)];
          return ok(
            names.slice(0, 80).map((match) => `${match[1]} = ${match[2] ? unquote(match[2]) : "(complex)"}`),
            { tool: "cubeide_debug", action, frame },
          );
        }
        case "evaluate": {
          if (!input.expression) return fail("missing_expression", "evaluate needs an `expression`");
          const session = await sessionFor();
          
          const reply = await session.gdb.command(`-data-evaluate-expression ${String(input.expression)}`);
          return ok([`${input.expression} = ${unquote(reply.values["value"] ?? "?")}`]);
        }
        case "stack": {
          const session = await sessionFor();
          
          const reply = await session.gdb.command("-stack-list-frames");
          const body = reply.values["stack"] ?? "[]";
          const frames = [...body.matchAll(/frame=\{([^{}]*)\}/g)].map((match) => frameFields(`{${match[1]}}`));
          return ok(frames.map((frame, index) => `#${index} ${frame["func"] ?? "??"} at ${frame["file"] ?? "?"}:${frame["line"] ?? "?"} (${frame["addr"]})`));
        }
        case "where": {
          const session = await sessionFor();
          
          const frame = await currentFrame(session);
          return ok([`${frame["func"] ?? "??"} at ${frame["file"] ?? "?"}:${frame["line"] ?? "?"} (${frame["addr"]})`]);
        }
        case "read": {
          if (input.address === undefined) return fail("missing_address", "read needs an `address`");
          const session = await sessionFor();
          
          const width = WIDTH_BYTES[String(input.width ?? "u32")] ?? 4;
          const count = input.count !== undefined ? Number(input.count) : 1;
          const size = width * count;
          const reply = await session.gdb.command(`-data-read-memory-bytes -o 0 ${hex(Number(input.address))} ${size}`);
          const body = reply.values["memory"] ?? "[]";
          const contentMatch = /contents="([^"]*)"/.exec(body);
          if (!contentMatch?.[1]) return fail("read_failed", "gdb returned no memory contents");
          const bytes = (contentMatch[1].match(/[0-9a-fA-F]{2}/g) ?? []).map((pair) => parseInt(pair, 16));
          const lines = bytes.length > 0 ? [`${hex(Number(input.address))}: ${bytes.map((b) => b.toString(16).padStart(2, "0")).join(" ")}`] : ["(no bytes returned)"];
          return ok(lines, { tool: "cubeide_debug", action, address: input.address, bytes });
        }
        case "write": {
          if (input.address === undefined || input.value === undefined) {
            return fail("missing_argument", "write needs an `address` and a `value`");
          }
          const session = await sessionFor();
          
          const width = WIDTH_BYTES[String(input.width ?? "u32")] ?? 4;
          const setCommand =
            width === 1 ? "-data-write-memory-bytes" : "-data-write-memory-bytes";
          if (setCommand === "-data-write-memory-bytes") {
            const hexValue = Number(input.value) >>> 0;
            const byteWidth = width;
            const bytes: string[] = [];
            for (let i = 0; i < byteWidth; i++) bytes.push(((hexValue >>> (8 * i)) & 0xff).toString(16).padStart(2, "0"));
            await session.gdb.command(`${setCommand} ${hex(Number(input.address))} "${bytes.join("")}"`);
          }
          // 写后回读校验（R3：不信任写命令的应答）。
          const verify = await session.gdb.command(`-data-read-memory-bytes -o 0 ${hex(Number(input.address))} ${width}`);
          const contentMatch = /contents="([^"]*)"/.exec(verify.values["memory"] ?? "");
          const readBack = (contentMatch?.[1]?.match(/[0-9a-fA-F]{2}/g) ?? []).map((pair) => parseInt(pair, 16));
          let readValue = 0;
          for (let i = 0; i < readBack.length; i++) readValue += readBack[i]! * 2 ** (8 * i);
          const expected = (Number(input.value) >>> 0) % 2 ** (8 * width);
          if ((readValue >>> 0) !== expected) {
            return fail("verify_failed", `wrote but read back ${hex(readValue >>> 0)}, expected ${hex(expected)}`);
          }
          return ok([`${hex(Number(input.address))} = ${hex(expected)} (verified)`], { tool: "cubeide_debug", action, address: input.address });
        }
        case "disassemble": {
          const session = await sessionFor();
          
          const where = input.location ? String(input.location) : "$pc";
          const reply = await session.gdb.command(`-data-disassemble -s ${where} -e "${where},+32" 0`);
          const body = reply.values["asm_insns"] ?? "[]";
          const insns = [...body.matchAll(/address="([^"]*)"[^>]*?inst="([^"]*)"/g)];
          return ok(insns.map((match) => `${match[1]}  ${unquote(match[2])}`));
        }
        default:
          return fail("unknown_action", `unknown action \`${action}\`; the debug actions are: ${CUBEIDE_DEBUG_ACTIONS.join(", ")}`);
      }
    } catch (error) {
      return fail("cubeide_error", error instanceof Error ? error.message : String(error));
    }
  },
};

// ---- cubeide_build ----------------------------------------------------------

const cubeideBuildTool: ProbeToolSpec = {
  name: "cubeide_build",
  description: BUILD_DESCRIPTION,
  inputSchema: cubeideBuildInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: true },
  meta: {
    evidence: true,
    evidenceActions: [...CUBEIDE_EVIDENCE_ACTIONS],
    destructiveActions: [...CUBEIDE_DESTRUCTIVE_ACTIONS],
  },
  handler: async (args: unknown): Promise<ProbeToolResult> => {
    const input = (args ?? {}) as Record<string, unknown>;
    const action = String(input.action);
    const toolsResult = toolsOrError();
    if (isToolResult(toolsResult)) return toolsResult;
    const tools = toolsResult;
    try {
      switch (action) {
        case "info": {
          const project = resolveProject(input);
          if (project.error) return fail("bad_project", project.error);
          return ok([`project: ${project.name}`, `directory: ${project.dir}`, `backend: STM32CubeIDE (Eclipse CDT headlessbuild + gdb/MI + STM32_Programmer_CLI)`]);
        }
        case "version":
          return ok([`CubeIDE root: ${tools.root}`, `gdb: ${tools.gdb}`, `gdbserver: ${tools.stlinkGdbServer}`, `programmer: ${tools.programmerCli}`]);
        case "generate": {
          const mx = findCubeMx();
          if (!mx) return fail("cubemx_not_installed", "STM32CubeMX is not found: set CUBEMX_HOME to the install root (the directory holding STM32CubeMX.exe and db/). CubeMX generates the project; CubeIDE builds it; CubeProgrammer flashes it — all three are expected.");
          const mcu = input.mcu ? String(input.mcu) : "";
          const name = input.name ? String(input.name) : "";
          const path = input.path ? String(input.path) : "";
          if (!mcu || !name || !path) return fail("missing_argument", "generate needs `mcu` (part number, e.g. STM32F429IGTx), `name` (project name) and `path` (output directory)");
          const result = await mxGenerate(mx, { mcu, name, path, ...(input.toolchain ? { toolchain: input.toolchain as never } : {}) });
          if (!result.ok) return fail("generate_failed", `${result.reason}`);
          return ok([
            `generated ${name} (${mcu}) in ${path}`,
            `ioc: ${result.iocPath}`,
            `cubeide project: ${result.projectDir} — pass THIS directory to build`,
            `took ${(result.durationMs / 1000).toFixed(1)}s`,
          ], { tool: "cubeide_build", action, ioc: result.iocPath, projectDir: result.projectDir });
        }
        case "ioc_generate": {
          const mx = findCubeMx();
          if (!mx) return fail("cubemx_not_installed", "STM32CubeMX is not found: set CUBEMX_HOME.");
          const ioc = input.project ? String(input.project) : "";
          if (!ioc || !ioc.endsWith(".ioc") || !existsSync(ioc)) return fail("bad_ioc", "ioc_generate needs `project` = the .ioc file path");
          const { dirname, basename } = await import("node:path");
          const script = ["config load", ioc, "project generate", "exit"].join("\n");
          const result = await mxRunScript(mx, script);
          if (!result.ok) return fail("generate_failed", result.reason ?? "CubeMX generation failed");
          return ok([`regenerated from ${basename(ioc)}`, ...(result.log ? [] : [])], { tool: "cubeide_build", action });
        }
        case "capabilities":
          return ok([
            "build/rebuild/clean: available (Eclipse headlessbuild)",
            "flash: available (STM32_Programmer_CLI -w with verify)",
            "erase (full-chip): available (STM32_Programmer_CLI -e all) — this is the action the Keil backend cannot do",
            "debug: available (arm-none-eabi-gdb over GDB/MI + ST-LINK_gdbserver)",
            "simulator: not available (CubeIDE has no instruction-set simulator; use the probe or a QEMU/Renode setup)",
          ]);
        case "probe": {
          const listed = await probeTarget(tools);
          const summary = summarizeProbeList(listed.log);
          return ok(
            [
              ...(listed.ok ? [] : [`probe list exited ${listed.exitCode}`]),
              ...summary.lines,
              ...(summary.stlink ? [] : ["no ST-Link detected"]),
            ],
            { tool: "cubeide_build", action, stlink: summary.stlink, jlink: summary.jlink },
          );
        }
        case "build":
        case "rebuild":
        case "clean": {
          const project = resolveProject(input);
          if (project.error) return fail("bad_project", project.error);
          const clean = action === "clean";
          const result = await headlessBuild({
            tools,
            projectDir: project.dir!,
            projectName: project.name!,
            ...(input.config ? { config: String(input.config) } : {}),
            ...(clean ? { clean: true } : {}),
          });
          const lines = [
            `${action}: ${result.ok ? "ok" : "FAILED"}`,
            `exit ${result.exitCode} in ${(result.durationMs / 1000).toFixed(1)}s`,
            ...(result.errors ?? []),
          ];
          if (!result.ok) {
            lines.push(`log tail: ${result.log.split(/\r?\n/).filter(Boolean).slice(-12).join(" | ")}`);
            // Eclipse 的完整诊断在 workspace 的 .metadata/.log 里，stdout 不带。
            if ("workspace" in result && typeof result.workspace === "string") {
              lines.push(`eclipse workspace log: ${result.workspace}\\.metadata\\.log`);
            }
          }
          return ok(lines, { tool: "cubeide_build", action, exitCode: result.exitCode, durationMs: result.durationMs }, result.ok ? {} : { isError: true });
        }
        case "flash": {
          const image = input.image ? String(input.image) : undefined;
          if (!image) return fail("missing_image", "flash needs an `image` (the .hex/.bin/.elf from the build; pass it or note the build output path)");
          if (!existsSync(image)) return fail("bad_image", `${image} does not exist`);
          // 探针独占：烧录前关调试会话（同 keil 的 forDownload 语义）。
          const closed = await closeSession();
          const lines: string[] = [];
          if (closed.closed > 0) lines.push(`closed ${closed.closed} debug session(s) first — breakpoints are lost; re-open after flashing`);
          const result = await flashImage(tools, image, {
            ...(input.address !== undefined ? { address: Number(input.address) } : {}),
            ...(input.verify !== undefined ? { verify: input.verify === true } : {}),
          });
          lines.push(result.ok ? `flashed ${image} (verified)` : `flash FAILED: ${result.log.split(/\r?\n/).filter(Boolean).slice(-6).join(" | ")}`);
          return ok(lines, { tool: "cubeide_build", action }, result.ok ? {} : { isError: true });
        }
        case "erase": {
          const closed = await closeSession();
          const lines: string[] = [];
          if (closed.closed > 0) lines.push(`closed ${closed.closed} debug session(s) first`);
          const result = await chipErase(tools);
          lines.push(result.ok ? "chip erased (-e all)" : `erase FAILED: ${result.log.split(/\r?\n/).filter(Boolean).slice(-6).join(" | ")}`);
          return ok(lines, { tool: "cubeide_build", action }, result.ok ? {} : { isError: true });
        }
        default:
          return fail("unknown_action", `unknown action \`${action}\`; the build actions are: ${CUBEIDE_BUILD_ACTIONS.join(", ")}`);
      }
    } catch (error) {
      return fail("cubeide_error", error instanceof Error ? error.message : String(error));
    }
  },
};

export function createCubeIdeTools(): ProbeToolSpec[] {
  return [cubeideDebugTool, cubeideBuildTool];
}

export { declarationFor as cubeideDeclarationFor };
