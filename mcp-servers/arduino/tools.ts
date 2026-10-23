import { join } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import type { ProbeToolResult, ProbeToolSpec } from "../probe/tools.js";
import {
  ARDUINO_ACTIONS,
  ARDUINO_EVIDENCE_ACTIONS,
  ARDUINO_DESTRUCTIVE_ACTIONS,
  DESCRIPTION,
  arduinoInputSchema,
} from "./actions.js";
import { declarationFor } from "./declarations.js";
import { coreList, findArduinoCli, findSketch, runCli, type ArduinoCli } from "./arduinoCli.js";

/**
 * `arduino_build`：编译 + 烧录 + 板卡/库查询。无调试（actions.ts 注释）。
 */

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

/** sketch 解析：显式目录 → 父目录下找同名 sketch → cwd 即 sketch。 */
export function resolveSketch(input: { project?: string }): { sketch?: ReturnType<typeof findSketch>; error?: string } {
  const explicit = input.project;
  if (explicit) {
    if (existsSync(join(explicit, `${explicit.split(/[\\/]/).filter(Boolean).pop()}.ino`))) {
      return { sketch: findSketch(explicit)! };
    }
    // 给的是父目录：找唯一/第一个 sketch 子目录。
    if (existsSync(explicit)) {
      try {
        for (const entry of readdirSync(explicit, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const found = findSketch(join(explicit, entry.name));
          if (found) return { sketch: found };
        }
      } catch {
        /* fall through */
      }
    }
    return { error: `${explicit} does not contain a sketch (a directory with a matching .ino)` };
  }
  const cwd = process.cwd();
  const sketch = findSketch(cwd);
  if (sketch) return { sketch };
  // cwd 的子目录里找（Arduino IDE 把多个 sketch 平铺在一个根下）。
  try {
    for (const entry of readdirSync(cwd, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const found = findSketch(join(cwd, entry.name));
      if (found) return { sketch: found };
    }
  } catch {
    /* fall through */
  }
  return { error: "no sketch in the working directory (no <name>/<name>.ino); pass `project`" };
}

const arduinoTool: ProbeToolSpec = {
  name: "arduino_build",
  description: DESCRIPTION,
  inputSchema: arduinoInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: true },
  meta: {
    evidence: true,
    evidenceActions: [...ARDUINO_EVIDENCE_ACTIONS],
    destructiveActions: [...ARDUINO_DESTRUCTIVE_ACTIONS],
  },
  handler: async (args: unknown): Promise<ProbeToolResult> => {
    const input = (args ?? {}) as Record<string, unknown>;
    const action = String(input.action);
    const cli = findArduinoCli();
    if (!cli) {
      return fail(
        "arduino_cli_not_found",
        "arduino-cli is not found: install the Arduino IDE (it bundles the CLI) or the standalone arduino-cli, " +
          "or set ARDUINO_CLI to the executable path. Nothing here is bundled.",
      );
    }
    try {
      switch (action) {
        case "info": {
          const sketch = resolveSketch(input);
          if (sketch.error || !sketch.sketch) return fail("bad_project", sketch.error ?? "no sketch");
          return ok([`sketch: ${sketch.sketch.name}`, `directory: ${sketch.sketch.dir}`, `cli: ${cli.path} (${cli.version})`]);
        }
        case "version":
          return ok([`arduino-cli ${cli.version} at ${cli.path}`]);
        case "capabilities":
          return ok([
            "compile: available (arduino-cli compile --output-dir, produces .elf/.hex/.bin)",
            "upload: available (arduino-cli upload -p <port> --verify)",
            "boards: live list of installed cores (`boards` action)",
            "debug: NOT available — AVR boards have no debug hardware; arduino-cli debug check reports unsupported. This tool does not pretend otherwise.",
            "serial monitor: not here — use the probe backend's serial tools",
          ]);
        case "boards": {
          const cores = await coreList(cli);
          if (cores.length === 0) return ok(["(no cores installed — run `arduino-cli core install <id>`, e.g. arduino:avr)"]);
          return ok(cores.map((core) => `${core.id}  ${core.installed ? `installed ${core.installed}` : "(not installed)"}  ${core.name}`));
        }
        case "search_board": {
          const query = input.query ? String(input.query) : "";
          if (!query) return fail("missing_query", "search_board needs a `query` (e.g. `uno`, `nano`, `esp32s3`)");
          const result = await runCli(cli, ["board", "listall", query, "--format", "json"], { timeoutMs: 60_000 });
          try {
            const parsed = JSON.parse(result.out) as { boards?: Array<{ name?: string; Name?: string; fqbn?: string; FQBN?: string }> };
            const boards = parsed.boards ?? [];
            return ok(boards.length > 0 ? boards.map((board) => `${board.fqbn ?? board.FQBN}  ${board.name ?? board.Name}`) : [`no board matching ${JSON.stringify(query)}`]);
          } catch {
            return ok(result.out.split(/\r?\n/).filter(Boolean).slice(0, 20));
          }
        }
        case "libs": {
          const query = input.query ? String(input.query).toLowerCase() : "";
          // arduino-cli 的 lib list 过滤词是精确名匹配（实测 "Adafruit Neo" 匹配
          // 不到 "Adafruit NeoPixel"），所以全量拉回来在本地做子串过滤。
          const result = await runCli(cli, ["lib", "list", "--format", "json"], { timeoutMs: 60_000 });
          try {
            const parsed = JSON.parse(result.out) as { installed_libraries?: Array<{ library?: { name?: string; version?: string } }> };
            const libs = (parsed.installed_libraries ?? [])
              .filter((entry) => !query || (entry.library?.name ?? "").toLowerCase().includes(query));
            return ok(
              libs.length > 0
                ? libs.map((entry) => `${entry.library?.name ?? "?"} ${entry.library?.version ?? "?"}`)
                : ["(no matching libraries installed)"],
            );
          } catch {
            return ok(result.out.split(/\r?\n/).filter(Boolean).slice(0, 20));
          }
        }
        case "compile": {
          const sketch = resolveSketch(input);
          if (sketch.error || !sketch.sketch) return fail("bad_project", sketch.error ?? "no sketch");
          const fqbn = input.fqbn ? String(input.fqbn) : "";
          if (!fqbn) return fail("missing_fqbn", "compile needs an `fqbn` (fully-qualified board name, e.g. arduino:avr:uno — `search_board` finds them)");
          const outDir = join(sketch.sketch.dir, "build", fqbn.replace(/:/g, "."));
          const result = await runCli(
            cli,
            ["compile", "-b", fqbn, "--output-dir", outDir, sketch.sketch.dir],
            { timeoutMs: 10 * 60_000 },
          );
          const lines = result.out.split(/\r?\n/).filter(Boolean);
          if (result.ok) {
            const usage = lines.filter((line) => /bytes \(/.test(line));
            return ok([`compiled ${sketch.sketch.name} for ${fqbn}`, `artifacts: ${outDir}`, ...usage], { tool: "arduino_build", action, fqbn, outDir });
          }
          return fail("compile_failed", [`compile FAILED (exit ${result.exitCode})`, ...lines.slice(-12)].join("\n"));
        }
        case "upload": {
          const sketch = resolveSketch(input);
          if (sketch.error || !sketch.sketch) return fail("bad_project", sketch.error ?? "no sketch");
          const fqbn = input.fqbn ? String(input.fqbn) : "";
          const port = input.port ? String(input.port) : "";
          if (!fqbn) return fail("missing_fqbn", "upload needs an `fqbn` (e.g. arduino:avr:uno)");
          if (!port) return fail("missing_port", "upload needs a `port` (e.g. COM3)");
          // 先有产物：upload 用 --input-dir 指向 compile 的输出，避免二次编译。
          const outDir = join(sketch.sketch.dir, "build", fqbn.replace(/:/g, "."));
          if (!existsSync(outDir)) {
            return fail("not_compiled", `no build output at ${outDir} — run \`compile\` with the same fqbn first (upload refuses to compile implicitly so the artifacts are never stale)`);
          }
          const args = ["upload", "-b", fqbn, "-p", port, "--input-dir", outDir];
          if (input.verify !== false) args.push("--verify");
          const result = await runCli(cli, args, { timeoutMs: 5 * 60_000 });
          const lines = result.out.split(/\r?\n/).filter(Boolean);
          return ok(
            result.ok ? [`uploaded ${sketch.sketch.name} → ${port} (verified)`] : [`upload FAILED:`, ...lines.slice(-8)],
            { tool: "arduino_build", action },
            result.ok ? {} : { isError: true },
          );
        }
        default:
          return fail("unknown_action", `unknown action \`${action}\`; actions: ${ARDUINO_ACTIONS.join(", ")}`);
      }
    } catch (error) {
      return fail("arduino_error", error instanceof Error ? error.message : String(error));
    }
  },
};

export function createArduinoTools(): ProbeToolSpec[] {
  return [arduinoTool];
}

// 测试别名：resolveSketch 的稳定导出名。
export const resolveSketchShape = resolveSketch;

export { findArduinoCli, findSketch };
