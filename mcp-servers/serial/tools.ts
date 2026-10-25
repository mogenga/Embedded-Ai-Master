/**
 * `embed_serial` —— agent 的串口工具，独立于任何厂商后端。
 *
 * 串口是平台级能力：面板（desktop host）持有唯一的 COM 句柄并把它镜像到
 * `<harnessHome>/serial/ring.json`；本工具读该镜像，或在面板未占用该口时
 * 自行开一个短窗口捕获。一个工具两条通道，冲突如实报错。
 *
 * 从 cubeide/tools.ts 拆出（2026-10-25）：串口不属于 CubeIDE，把 agent 的
 * 串口工具绑在某个厂商后端上，等于没装 CubeIDE 的机器就管不了串口。
 */
import type { ProbeToolResult, ProbeToolSpec } from "../probe/tools.js";
import {
  SERIAL_ACTIONS,
  SERIAL_EVIDENCE_ACTIONS,
  SERIAL_DESTRUCTIVE_ACTIONS,
  SERIAL_DESCRIPTION,
  serialInputSchema,
} from "./actions.js";
import { askHostSerial, captureSerialPort, captureThenWrite, listSerialPorts, readRingMirror, ringMirrorPath } from "./serial.js";

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

/**
 * The agent's window onto the serial monitor. The panel (desktop host) owns
 * the port and mirrors its ring to `<harnessHome>/serial/ring.json`; this
 * tool reads that mirror, or opens its own transient capture when the panel
 * is not using the port. One tool, two channels, honest conflict errors.
 */
export const embedSerialTool: ProbeToolSpec = {
  name: "embed_serial",
  description: SERIAL_DESCRIPTION,
  inputSchema: serialInputSchema,
  annotations: { readOnlyHint: false, destructiveHint: true },
  meta: {
    evidence: true,
    evidenceActions: [...SERIAL_EVIDENCE_ACTIONS],
    destructiveActions: [...SERIAL_DESTRUCTIVE_ACTIONS],
  },
  handler: async (args: unknown): Promise<ProbeToolResult> => {
    const input = (args ?? {}) as Record<string, unknown>;
    const action = String(input.action);
    try {
      switch (action) {
        case "read": {
          const port = input.port ? String(input.port) : undefined;
          if (port === undefined) {
            // Panel channel: read the host's ring mirror.
            const mirror = readRingMirror();
            if (mirror === null) {
              return fail(
                "no_monitor",
                `没有串口监视器的缓冲可读（${ringMirrorPath()} 不存在）。桌面面板没开过串口，本进程也没写过镜像；要主动抓一段就用 read 带 port+baud+duration_ms。`,
              );
            }
            const entry = mirror.ports[0];
            if (entry === undefined) {
              return fail("no_monitor", "镜像里没有已打开的串口会话（面板可能刚关掉）；用 read 带 port+baud+duration_ms 主动抓。");
            }
            const maxLines = Number(input.max_lines ?? 80);
            const since = Number(input.since ?? 0);
            const start = since > 0 ? Math.min(since, entry.lines.length) : Math.max(0, entry.lines.length - maxLines);
            const lines = entry.lines.slice(start, start + maxLines);
            const text = [
              `port ${entry.port} @ ${entry.baud} (panel-owned, ring ${entry.lines.length} lines, ${entry.dropped} dropped early)`,
              ...lines.map((line) => `${new Date(line.at).toISOString().slice(11, 23)} ${line.text}`),
              since > 0 ? `(cursor ${start + lines.length}/${entry.lines.length})` : `(ring index ${entry.lines.length})`,
            ];
            return ok(text, {
              tool: "embed_serial",
              action,
              port: entry.port,
              baud: entry.baud,
              ringIndex: entry.lines.length,
              dropped: entry.dropped,
              lineCount: lines.length,
            });
          }
          // Transient channel: open our own capture window.
          const baud = Number(input.baud ?? 115200);
          const durationMs = Number(input.duration_ms ?? 2000);
          const ownership = mirrorHasPort(port);
          if (ownership) {
            // The panel owns the port. Its ring mirror IS this port's data, so
            // read from there rather than refusing: the user asked for what
            // the device said, not for which process owns the handle.
            const mirror = readRingMirror();
            const entry = mirror?.ports.find((candidate) => candidate.port === port);
            if (entry === undefined) {
              return fail("no_monitor", `面板持有 ${port}，但镜像里没有它的会话（可能刚关闭）`);
            }
            const maxLines = Number(input.max_lines ?? 200);
            const since = Number(input.since ?? 0);
            const start = since > 0 ? Math.min(since, entry.lines.length) : Math.max(0, entry.lines.length - maxLines);
            const lines = entry.lines.slice(start, start + maxLines);
            const text = [
              `${port} @ ${entry.baud} (panel-owned; ring ${entry.lines.length} lines, ${entry.dropped} dropped early)`,
              ...lines.map((line) => line.text),
              since > 0 ? `(cursor ${start + lines.length}/${entry.lines.length})` : `(ring index ${entry.lines.length})`,
            ];
            return ok(text, {
              tool: "embed_serial",
              action,
              port,
              baud: entry.baud,
              via: "panel",
              ringIndex: entry.lines.length,
              lineCount: lines.length,
            });
          }
          // The host owns the handle whenever the desktop app is running — it
          // is the only process that can show the data to the operator. Asking
          // it to open the port (rather than grabbing the port here) means the
          // panel lights up with the same session instead of failing to open
          // a port the agent already holds, which is what the user saw.
          const opened = await askHostSerial({ op: "open", port, baud, encoding: input.encoding });
          if (opened.ok === true) {
            // The open is detached on the host side; give it the ready timeout.
            const deadline = Date.now() + 8000;
            while (Date.now() < deadline) {
              const status = await askHostSerial({ op: "status", port }, 800);
              if (status.ok === true && status.ready === true) break;
              await new Promise((resolve) => setTimeout(resolve, 150));
            }
            // Wait out the capture window, then read the ring the panel filled.
            await new Promise((resolve) => setTimeout(resolve, durationMs));
            const mirror = readRingMirror();
            const entry = mirror?.ports.find((candidate) => candidate.port === port);
            if (entry !== undefined) {
              const maxLines = Number(input.max_lines ?? 200);
              const since = Number(input.since ?? 0);
              const start = since > 0 ? Math.min(since, entry.lines.length) : Math.max(0, entry.lines.length - maxLines);
              const lines = entry.lines.slice(start, start + maxLines);
              const text = [
                `${port} @ ${entry.baud} (panel-owned; ring ${entry.lines.length} lines, ${entry.dropped} dropped early)`,
                ...lines.map((line) => line.text),
                since > 0 ? `(cursor ${start + lines.length}/${entry.lines.length})` : `(ring index ${entry.lines.length})`,
              ];
              return ok(text, {
                tool: "embed_serial",
                action,
                port,
                baud: entry.baud,
                via: "panel",
                ringIndex: entry.lines.length,
                lineCount: lines.length,
              });
            }
          }
          // No desktop host answered (headless use): fall back to a transient
          // capture with our own handle, which is what this tool did before.
          const capture = await captureSerialPort(port, baud, durationMs);
          if (!capture.ok && capture.lines.length === 0) {
            return fail("capture_failed", capture.error ?? `${port} 捕获失败`);
          }
          const text = [
            `captured ${capture.lines.length} line(s) from ${port} @ ${baud} in ${durationMs}ms`,
            ...(capture.error ? [`warning: ${capture.error}`] : []),
            ...capture.lines.slice(-Number(input.max_lines ?? 200)).map((line) => line.text),
          ];
          return ok(text, { tool: "embed_serial", action, port, baud, lineCount: capture.lines.length });
        }
        case "write": {
          const data = input.data !== undefined ? String(input.data) : "";
          if (data === "") return fail("missing_argument", "write needs `data`");
          const port = input.port ? String(input.port) : undefined;
          if (port === undefined) {
            return fail("missing_argument", "write needs `port`（经面板打开的口写：传面板正在用的那个口；本工具没有常驻句柄，写入走一次性泵）");
          }
          const baud = Number(input.baud ?? 115200);
          // Route every write through the host, which owns the handle: if the
          // panel already has the port it lands in that session, and if it
          // does not, the host opens it so the operator watches the exchange
          // instead of hunting for the process that took the port.
          const opened = await askHostSerial({ op: "open", port, baud, encoding: input.encoding });
          if (opened.ok === true) {
            const deadline = Date.now() + 8000;
            while (Date.now() < deadline) {
              const status = await askHostSerial({ op: "status", port }, 800);
              if (status.ok === true && status.ready === true) break;
              await new Promise((resolve) => setTimeout(resolve, 150));
            }
            const reply = await askHostSerial({
              op: "write",
              port,
              data,
              hex: input.hex === true,
              source: "agent",
            });
            if (reply.ok !== true) {
              return fail("port_busy", String(reply.error ?? `面板拒绝了写入 ${port}`));
            }
            // Give the panel's echo a moment, then read what it received.
            await new Promise((resolve) => setTimeout(resolve, Number(input.duration_ms ?? 1500)));
            const mirror = readRingMirror();
            const entry = mirror?.ports.find((candidate) => candidate.port === port);
            const tail = (entry?.lines ?? []).slice(-Number(input.max_lines ?? 100));
            const text = [
              `wrote ${JSON.stringify(data.length > 60 ? `${data.slice(0, 60)}…` : data)} to ${port} @ ${baud} (through the panel's session)`,
              `panel ring: ${entry?.lines.length ?? 0} line(s)`,
              ...tail.map((line) => line.text),
            ];
            return ok(text, { tool: "embed_serial", action, port, baud, via: "panel", lineCount: tail.length });
          }
          // A write through a transient pump: open, write, brief settle for
          // the echo/reply, capture, exit. duration_ms applies to the reply
          // window, not the write. A pump write failure is a failed write —
          // reporting "wrote" here is exactly the fake success R3 forbids.
          const capture = await captureThenWrite(port, baud, data, Number(input.duration_ms ?? 1500), input.hex === true);
          if (capture.error !== undefined) {
            return fail("write_failed", `写入失败：${capture.error}`);
          }
          const text = [
            `wrote ${JSON.stringify(data.length > 60 ? `${data.slice(0, 60)}…` : data)} to ${port} @ ${baud}`,
            `captured ${capture.lines.length} line(s) in reply window (${Number(input.duration_ms ?? 1500)}ms)`,
            ...capture.lines.slice(-Number(input.max_lines ?? 100)).map((line: { text: string }) => line.text),
          ];
          return ok(text, { tool: "embed_serial", action, port, baud, lineCount: capture.lines.length });
        }
        case "open": {
          const port = input.port ? String(input.port) : undefined;
          if (port === undefined) return fail("missing_argument", "open needs `port`");
          const baud = Number(input.baud ?? 115200);
          const reply = await askHostSerial({ op: "open", port, baud, encoding: input.encoding });
          if (reply.ok !== true) {
            return fail("open_failed", String(reply.error ?? `无法打开 ${port}`));
          }
          return ok(
            [`opened ${port} @ ${baud} in the panel`, "(the desktop app now owns the port; this tool writes and reads through it)"],
            { tool: "embed_serial", action, port, baud, via: "panel" },
          );
        }
        case "close": {
          const port = input.port ? String(input.port) : undefined;
          if (port === undefined) return fail("missing_argument", "close needs `port`");
          const reply = await askHostSerial({ op: "close", port });
          if (reply.ok !== true) {
            return fail("close_failed", String(reply.error ?? `无法关闭 ${port}`));
          }
          return ok([`closed ${port}`], { tool: "embed_serial", action, port });
        }
        case "ports": {
          const ports = await listSerialPorts();
          const mirror = readRingMirror();
          const text = [
            ...(ports.length === 0 ? ["no COM ports present"] : ports.map((p) => `${p.path}  ${p.description}`)),
            ...(mirror?.ports.length ? [`panel holds: ${mirror.ports.map((p) => `${p.port}@${p.baud}`).join(", ")}`] : []),
          ];
          return ok(text, { tool: "embed_serial", action, ports, panelPorts: mirror?.ports.map((p) => p.port) ?? [] });
        }
        case "status": {
          const mirror = readRingMirror();
          if (mirror === null) return ok(["no serial monitor state (panel never opened a port this boot)"]);
          const text = mirror.ports.length === 0
            ? ["serial monitor idle (mirror exists but no open port)"]
            : mirror.ports.map((p) => `open: ${p.port} @ ${p.baud} (panel) · ring ${p.lines.length} lines · dropped ${p.dropped} · mirror updated ${new Date(mirror.updatedAt).toISOString()}`);
          return ok(text, { tool: "embed_serial", action, open: mirror.ports.length > 0 });
        }
        default:
          return fail("unknown_action", `unknown action \`${action}\`; serial actions are: ${SERIAL_ACTIONS.join(", ")}`);
      }
    } catch (error) {
      return fail("serial_error", error instanceof Error ? error.message : String(error));
    }
  },
};

/** True when the mirror says the panel currently holds `port`. */
function mirrorHasPort(port: string): boolean {
  const mirror = readRingMirror();
  return mirror?.ports.some((entry) => entry.port === port) ?? false;
}
