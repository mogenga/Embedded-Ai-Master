import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type { DeviceStatus } from "../../api/client.js";
import { Icon } from "../../icons.js";
import type { TranscriptView } from "../../view/transcript.js";
import { DebugLog } from "./debug-log.js";
import { DeviceMonitor } from "./device-monitor.js";
import { PortSettings } from "./port-settings.js";

export type LogMark = "tx" | "rx" | "kv" | "err";

export type LogLine = {
  time: string;
  mark: LogMark;
  text: string;
};

export type Register = {
  name: string;
  value: string;
  warn?: boolean;
};

export function deriveLogLines(view: TranscriptView): LogLine[] {
  const lines: LogLine[] = [];
  for (const event of view.events) {
    if (event.kind !== "tool") continue;
    lines.push({
      time: "—",
      mark: event.tool.ok ? "tx" : "err",
      text: `${event.tool.name} ${event.tool.args} · ${event.tool.ok ? "ok" : "error"}`,
    });
  }
  return lines;
}

export function deriveRegisters(view: TranscriptView): Register[] {
  const registers: Register[] = [];
  for (const event of view.events) {
    if (event.kind !== "tool") continue;
    if (event.tool.evidence !== undefined) {
      for (const row of event.tool.evidence) {
        registers.push({ name: row.name, value: row.value, warn: row.verdict !== "ok" });
      }
    }
    if (event.tool.readout !== undefined) {
      for (const row of event.tool.readout) {
        registers.push({ name: row.label, value: row.value });
      }
    }
  }
  return registers;
}

type SectionKey = "device" | "port" | "log";

export function Dock({
  view,
  device,
  state = "ready",
}: {
  view: TranscriptView;
  device: DeviceStatus;
  state?: "loading" | "ready" | "error";
}): JSX.Element {
  const [expanded, setExpanded] = useState<Record<SectionKey, boolean>>({
    device: true,
    port: true,
    log: true,
  });

  const logLines = deriveLogLines(view);
  const registers = deriveRegisters(view);

  function head(
    key: SectionKey,
    icon: string,
    title: string,
    dot: "ok" | "warn",
    count?: number,
  ): JSX.Element {
    const open = expanded[key];
    return (
      <button
        type="button"
        class="dock-sec-head"
        aria-expanded={open}
        onClick={() => setExpanded((prev) => ({ ...prev, [key]: !prev[key] }))}
      >
        <Icon name={icon} size={15} />
        <span class="t">{title}</span>
        <span class="spacer" />
        {count === undefined ? null : <span class="count">{count}</span>}
        <span class="dot" data-s={dot} aria-hidden="true" />
        <Icon name="i-chevron-down" size={14} className="chev" />
      </button>
    );
  }

  return (
    <>
      <header class="pane-head">
        <Icon name="i-terminal" size={14} />
        <span>调试坞</span>
        <span class="count">按需展开</span>
      </header>
      {state === "loading" ? <p class="pane-empty">加载中…</p> : null}
      {state === "error" ? <p class="pane-empty">调试数据加载失败</p> : null}
      {state === "ready" ? <div class="dock-body">
        <section class="dock-sec">
          {head("device", "i-cpu", "设备监控", "ok", registers.length)}
          <div class="dock-sec-body">
            <DeviceMonitor device={device} registers={registers} />
          </div>
        </section>
        <section class="dock-sec">
          {head("port", "i-plug", "端口设置", "ok")}
          <div class="dock-sec-body">
            <PortSettings serial={device.serial} />
          </div>
        </section>
        <section class="dock-sec">
          {head("log", "i-log", "调试日志", "warn", logLines.length)}
          <div class="dock-sec-body">
            <DebugLog lines={logLines} />
          </div>
        </section>
      </div> : null}
    </>
  );
}
