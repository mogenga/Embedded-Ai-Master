import type { ProbeToolResult, ProbeToolSpec } from "../probe/tools.js";
import { frameFields, unquote } from "../cubeide/gdbMi.js";
import {
  ESP_DEBUG_ACTIONS,
  ESP_BUILD_ACTIONS,
  ESP_EVIDENCE_ACTIONS,
  ESP_DESTRUCTIVE_ACTIONS,
  DEBUG_DESCRIPTION,
  BUILD_DESCRIPTION,
  espDebugInputSchema,
  espBuildInputSchema,
} from "./actions.js";
import { declarationFor } from "./declarations.js";
import { describeIdf, findIdfTools, type IdfTools } from "./idfEnv.js";
import { appElf, isIdfProject, idfBuild, idfClean, readProjectDescription } from "./idfBuild.js";
import { chipProbe, eraseFlash, flashProject } from "./idfFlash.js";
import { activeEspSession, closeEspSession, openEspSession } from "./espSession.js";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * `esp_debug` / `esp_build`。与 cubeide/tools.ts 同构。
 * 调试动作直接对 GdbMi 发 MI 命令（协议层在 cubeide/gdbMi.ts，共用）。
 */

const hex = (value: number) => `0x${value.toString(16)}`;

function fail(code: string, message: string): ProbeToolResult {
  return { content: [{ type: "text", text: message }], structuredContent: { code, message }, isError: true };
}

function ok(lines: string[], data?: Record<string, unknown>, extra: Partial<ProbeToolResult> = {}): ProbeToolResult {
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    ...(data ? { structuredContent: data } : {}),
    ...extra,
  };
}

/** 解析工程参数；esp 工程就是目录（CMakeLists.txt 所在层）。 */
function resolveProject(input: { project?: string }): { dir?: string; error?: string } {
  const explicit = input.project;
  if (explicit) {
    if (isIdfProject(explicit)) return { dir: explicit };
    return { error: `${explicit} is not an ESP-IDF project (its CMakeLists.txt does not include tools/cmake/project.cmake)` };
  }
  const cwd = process.cwd();
  if (isIdfProject(cwd)) return { dir: cwd };
  return { error: `no ESP-IDF project in the working directory (CMakeLists.txt lacks the project.cmake include); pass \`project\`` };
}

function toolsOrFail(): IdfTools | ProbeToolResult {
  const tools = findIdfTools();
  if (!tools) {
    return fail(
      "espidf_not_installed",
      "ESP-IDF is not found: set IDF_PATH to the install root (or install to C:\\Espressif\\frameworks\\esp-idf-*), " +
        "and make sure ~\\.espressif holds python_env + tools (the default IDF_TOOLS_PATH). Everything here comes from the IDF install; nothing is bundled.",
    );
  }
  return tools;
}

const WIDTH_BYTES: Record<string, number> = { u8: 1, u16: 2, u32: 4 };

class SessionRequired extends Error {}

const espDebugTool: ProbeToolSpec = {
  name: "esp_debug",
  description: DEBUG_DESCRIPTION,
  inputSchema: espDebugInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: true },
  meta: {
    evidence: true,
    evidenceActions: [...ESP_EVIDENCE_ACTIONS],
    destructiveActions: [...ESP_DESTRUCTIVE_ACTIONS],
  },
  handler: async (args: unknown): Promise<ProbeToolResult> => {
    const input = (args ?? {}) as Record<string, unknown>;
    const action = String(input.action);
    const toolsResult = toolsOrFail();
    if (isResult(toolsResult)) return toolsResult;
    const tools = toolsResult;

    const sessionFor = () => {
      const session = activeEspSession();
      if (!session) throw new SessionRequired();
      return session;
    };

    try {
      switch (action) {
        case "open": {
          const project = resolveProject(input);
          if (project.error) return fail("bad_project", project.error);
          const opened = await openEspSession({
            tools,
            projectDir: project.dir!,
            ...(input.board_cfg ? { boardCfg: String(input.board_cfg) } : {}),
            ...(input.reuse_openocd !== undefined ? { reuseOpenOcd: input.reuse_openocd === true } : {}),
          });
          return opened.ok ? ok([`opened ESP debug session`, ...opened.log]) : fail("open_failed", [`could not open:`, opened.reason ?? "", ...opened.log].filter(Boolean).join("\n"));
        }
        case "close": {
          const closed = await closeEspSession();
          return ok([closed.closed ? "closed ESP debug session" : closed.reason ?? "nothing to close"]);
        }
        case "sessions": {
          const session = activeEspSession();
          return ok(session ? [`openocd :${session.port}, gdb MI attached`] : ["(no open ESP session)"]);
        }
        case "status": {
          const session = sessionFor();
          const reply = await session.gdb.command("-stack-list-frames 0 0");
          const frame = frameFields(reply.values["frame"] ?? "");
          return ok(frame["addr"] ? [`stopped at ${frame["func"] ?? "?"} (${frame["file"] ?? "?"}:${frame["line"] ?? "?"}) ${frame["addr"]}`] : ["running (halt to inspect)"]);
        }
        case "run":
        case "continue": {
          const session = sessionFor();
          await session.gdb.command("-exec-continue");
          return ok(["running; `halt` to stop it"]);
        }
        case "halt": {
          const session = sessionFor();
          await session.gdb.command("-exec-interrupt");
          const stop = await session.gdb.waitForStop(input.timeout_ms ? Number(input.timeout_ms) : 5000);
          const frame = frameFields(String(stop.values["frame"] ?? ""));
          return ok([`halted at ${frame["func"] ?? "?"} (${frame["addr"] ?? "?"})`]);
        }
        case "reset": {
          const session = sessionFor();
          await session.gdb.command("-interpreter-exec console \"monitor reset halt\"");
          const stop = await session.gdb.waitForStop(input.timeout_ms ? Number(input.timeout_ms) : 5000);
          return ok([`reset, halted at ${frameFields(String(stop.values["frame"] ?? "")).addr ?? "?"}`]);
        }
        case "step":
        case "step_into":
        case "step_instruction":
        case "step_out": {
          const session = sessionFor();
          const op = action === "step" ? "-exec-step" : action === "step_into" ? "-exec-step" : action === "step_instruction" ? "-exec-step-instruction" : "-exec-finish";
          await session.gdb.command(op);
          const stop = await session.gdb.waitForStop(input.timeout_ms ? Number(input.timeout_ms) : 10_000);
          const frame = frameFields(String(stop.values["frame"] ?? ""));
          return ok([`at ${frame["func"] ?? "?"} (${frame["file"] ?? "?"}:${frame["line"] ?? "?"})`]);
        }
        case "breakpoints": {
          const session = sessionFor();
          const reply = await session.gdb.command("-break-list");
          const body = reply.values["body"] ?? "[]";
          const out: string[] = [];
          for (const match of body.matchAll(/bkpt=\{([^{}]*)\}/g)) out.push(match[1]!.replace(/"/g, "").replace(/,/g, " "));
          return ok(out.length > 0 ? out : ["(no breakpoints)"]);
        }
        case "breakpoint_add": {
          if (!input.location) return fail("missing_location", "breakpoint_add needs a `location` (function or file:line)");
          const session = sessionFor();
          await session.gdb.command(`-break-insert ${String(input.location)}`);
          return ok([`breakpoint set at ${String(input.location)}`]);
        }
        case "breakpoint_delete": {
          if (!input.value && !input.location) return fail("missing_argument", "breakpoint_delete needs `value` = breakpoint number");
          const session = sessionFor();
          await session.gdb.command(`-break-delete ${String(input.value ?? input.location)}`);
          return ok([`deleted ${String(input.value ?? input.location)}`]);
        }
        case "registers": {
          const session = sessionFor();
          const names = await session.gdb.command("-data-list-register-names");
          const list = (names.values["register-names"] ?? "[]").replace(/^\[|\]$/g, "").split(",").filter((entry) => entry && entry !== "''").map((entry) => unquote(entry.trim()));
          const values = await session.gdb.command("-data-list-register-values x");
          const matches = [...(values.values["register-values"] ?? "[]").matchAll(/number="(\d+)"\s*,\s*value="([^"]*)"/g)];
          const pairs = list.slice(0, matches.length).map((name, index) => `${name}=${matches[index]![2]}`);
          return ok(pairs.length > 0 ? pairs : ["(no register values — halt first)"]);
        }
        case "variables": {
          const session = sessionFor();
          const reply = await session.gdb.command("-stack-list-variables --simple-values");
          const names = [...(reply.values["variables"] ?? "[]").matchAll(/name="([^"]*)"\s*,\s*(?:value="([^"]*)"\s*,\s*)?type="([^"]*)"/g)];
          return ok(names.slice(0, 80).map((match) => `${match[1]} = ${match[2] ? unquote(match[2]) : "(complex)"}`));
        }
        case "evaluate": {
          if (!input.expression) return fail("missing_expression", "evaluate needs an `expression`");
          const session = sessionFor();
          const reply = await session.gdb.command(`-data-evaluate-expression ${String(input.expression)}`);
          return ok([`${input.expression} = ${unquote(reply.values["value"] ?? "?")}`]);
        }
        case "stack": {
          const session = sessionFor();
          const reply = await session.gdb.command("-stack-list-frames");
          const frames = [...(reply.values["stack"] ?? "[]").matchAll(/frame=\{([^{}]*)\}/g)].map((match) => frameFields(`{${match[1]}}`));
          return ok(frames.map((frame, index) => `#${index} ${frame["func"] ?? "??"} at ${frame["file"] ?? "?"}:${frame["line"] ?? "?"} (${frame["addr"]})`));
        }
        case "where": {
          const session = sessionFor();
          const reply = await session.gdb.command("-stack-list-frames 0 0");
          const frame = frameFields(reply.values["frame"] ?? "");
          return ok([`${frame["func"] ?? "??"} at ${frame["file"] ?? "?"}:${frame["line"] ?? "?"} (${frame["addr"]})`]);
        }
        case "read": {
          if (input.address === undefined) return fail("missing_address", "read needs an `address`");
          const session = sessionFor();
          const width = WIDTH_BYTES[String(input.width ?? "u32")] ?? 4;
          const count = input.count !== undefined ? Number(input.count) : 1;
          const reply = await session.gdb.command(`-data-read-memory-bytes -o 0 ${hex(Number(input.address))} ${width * count}`);
          const contentMatch = /contents="([^"]*)"/.exec(reply.values["memory"] ?? "");
          if (!contentMatch?.[1]) return fail("read_failed", "gdb returned no memory contents");
          const bytes = (contentMatch[1].match(/[0-9a-fA-F]{2}/g) ?? []).map((pair) => parseInt(pair, 16));
          return ok([`${hex(Number(input.address))}: ${bytes.map((b) => b.toString(16).padStart(2, "0")).join(" ")}`], { address: input.address, bytes });
        }
        case "write": {
          if (input.address === undefined || input.value === undefined) return fail("missing_argument", "write needs `address` and `value`");
          const session = sessionFor();
          const width = WIDTH_BYTES[String(input.width ?? "u32")] ?? 4;
          const bytes: string[] = [];
          for (let i = 0; i < width; i++) bytes.push((((Number(input.value) >>> 0) >>> (8 * i)) & 0xff).toString(16).padStart(2, "0"));
          await session.gdb.command(`-data-write-memory-bytes ${hex(Number(input.address))} "${bytes.join("")}"`);
          const verify = await session.gdb.command(`-data-read-memory-bytes ${hex(Number(input.address))} ${width}`);
          const readBack = (/contents="([^"]*)"/.exec(verify.values["memory"] ?? "")?.[1]?.match(/[0-9a-fA-F]{2}/g) ?? []).map((pair) => parseInt(pair, 16));
          let readValue = 0;
          for (let i = 0; i < readBack.length; i++) readValue += readBack[i]! * 2 ** (8 * i);
          const expected = (Number(input.value) >>> 0) % 2 ** (8 * width);
          if ((readValue >>> 0) !== expected) return fail("verify_failed", `wrote but read back ${hex(readValue >>> 0)}, expected ${hex(expected)}`);
          return ok([`${hex(Number(input.address))} = ${hex(expected)} (verified)`], { address: input.address });
        }
        case "disassemble": {
          const session = sessionFor();
          const where = input.location ? String(input.location) : "$pc";
          const reply = await session.gdb.command(`-data-disassemble -s ${where} -e "${where},+32" 0`);
          const insns = [...(reply.values["asm_insns"] ?? "[]").matchAll(/address="([^"]*)"[^>]*?inst="([^"]*)"/g)];
          return ok(insns.map((match) => `${match[1]}  ${unquote(match[2])}`));
        }
        default:
          return fail("unknown_action", `unknown action \`${action}\`; debug actions: ${ESP_DEBUG_ACTIONS.join(", ")}`);
      }
    } catch (error) {
      if (error instanceof SessionRequired) return fail("not_open", "no ESP debug session is open — call `open` first");
      return fail("esp_error", error instanceof Error ? error.message : String(error));
    }
  },
};

function isResult(value: unknown): value is ProbeToolResult {
  return typeof value === "object" && value !== null && "isError" in value && (value as ProbeToolResult).isError === true && !("esptool" in value as never);
}

const espBuildTool: ProbeToolSpec = {
  name: "esp_build",
  description: BUILD_DESCRIPTION,
  inputSchema: espBuildInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: true },
  meta: {
    evidence: true,
    evidenceActions: [...ESP_EVIDENCE_ACTIONS],
    destructiveActions: [...ESP_DESTRUCTIVE_ACTIONS],
  },
  handler: async (args: unknown): Promise<ProbeToolResult> => {
    const input = (args ?? {}) as Record<string, unknown>;
    const action = String(input.action);
    const toolsResult = toolsOrFail();
    if (isResult(toolsResult)) return toolsResult;
    const tools = toolsResult;
    try {
      switch (action) {
        case "info": {
          const project = resolveProject(input);
          if (project.error) return fail("bad_project", project.error);
          const desc = readProjectDescription(project.dir!);
          const elf = appElf(project.dir!);
          return ok(
            [
              `project: ${project.dir}`,
              ...(desc?.target ? [`target: ${desc.target}`] : []),
              ...(elf ? [`app ELF: ${elf}`] : ["(not built yet — `build` first)"]),
            ],
            { tool: "esp_build", action, ...(desc?.target ? { target: desc.target } : {}) },
          );
        }
        case "version":
          return ok(describeIdf(tools));
        case "capabilities":
          return ok([
            "build/rebuild/clean: available (idf.py build/fullclean)",
            "flash: available (esptool write-flash from flasher_args.json, verified)",
            "erase (full-chip): available (esptool erase-flash)",
            "debug: available (openocd-esp32 + esp-gdb over GDB/MI) — needs JTAG or built-in USB-JTAG; plain UART boards can only be flashed",
            "probe: available (esptool chip-id over the serial port)",
          ]);
        case "probe": {
          const port = input.port ? String(input.port) : "";
          if (!port) return fail("missing_port", "probe needs a `port` (e.g. COM3 or /dev/ttyUSB0)");
          const result = await chipProbe(tools, port);
          return ok(
            result.ok ? result.log.split(/\r?\n/).filter(Boolean).slice(-8) : [`probe failed: ${result.log.split(/\r?\n/).filter(Boolean).slice(-3).join(" | ")}`],
            { tool: "esp_build", action },
            result.ok ? {} : { isError: true },
          );
        }
        case "build":
        case "rebuild":
        case "clean": {
          const project = resolveProject(input);
          if (project.error) return fail("bad_project", project.error);
          if (action === "clean") {
            const result = await idfClean(tools, project.dir!);
            return ok([`fullclean: ${result.ok ? "ok" : "FAILED"}`, `exit ${result.exitCode}`], { tool: "esp_build", action }, result.ok ? {} : { isError: true });
          }
          const result = await idfBuild(tools, project.dir!, {
            ...(action === "rebuild" || input.target ? { target: input.target ? String(input.target) : undefined } : {}),
          });
          const lines = [`${action}: ${result.ok ? "ok" : "FAILED"}`, `exit ${result.exitCode} in ${(result.durationMs / 1000).toFixed(1)}s`];
          if (!result.ok) {
            lines.push(...(result.errors ?? []));
            lines.push(`log tail: ${result.log.split(/\r?\n/).filter(Boolean).slice(-10).join(" | ")}`);
          }
          return ok(lines, { tool: "esp_build", action, exitCode: result.exitCode, durationMs: result.durationMs }, result.ok ? {} : { isError: true });
        }
        case "flash": {
          const project = resolveProject(input);
          if (project.error) return fail("bad_project", project.error);
          const port = input.port ? String(input.port) : "";
          if (!port) return fail("missing_port", "flash needs a `port` (e.g. COM3)");
          const closed = await closeEspSession();
          const lines: string[] = [];
          if (closed.closed) lines.push("closed the ESP debug session first");
          const result = await flashProject(tools, project.dir!, { port, ...(input.baud !== undefined ? { baud: Number(input.baud) } : {}), ...(input.verify !== undefined ? { verify: input.verify === true } : {}) });
          lines.push(result.ok ? `flashed ${project.dir} → ${port} (verified)` : `flash FAILED: ${result.log.split(/\r?\n/).filter(Boolean).slice(-6).join(" | ")}`);
          return ok(lines, { tool: "esp_build", action }, result.ok ? {} : { isError: true });
        }
        case "erase": {
          const project = resolveProject(input);
          if (project.error) return fail("bad_project", project.error);
          const port = input.port ? String(input.port) : "";
          if (!port) return fail("missing_port", "erase needs a `port` (e.g. COM3)");
          const closed = await closeEspSession();
          const lines: string[] = [];
          if (closed.closed) lines.push("closed the ESP debug session first");
          const result = await eraseFlash(tools, port);
          lines.push(result.ok ? `chip erased (${port})` : `erase FAILED: ${result.log.split(/\r?\n/).filter(Boolean).slice(-6).join(" | ")}`);
          return ok(lines, { tool: "esp_build", action }, result.ok ? {} : { isError: true });
        }
        default:
          return fail("unknown_action", `unknown action \`${action}\`; build actions: ${ESP_BUILD_ACTIONS.join(", ")}`);
      }
    } catch (error) {
      return fail("esp_error", error instanceof Error ? error.message : String(error));
    }
  },
};

export function createEspIdfTools(): ProbeToolSpec[] {
  return [espDebugTool, espBuildTool];
}

// keep join referenced for future project-path helpers
void join;
