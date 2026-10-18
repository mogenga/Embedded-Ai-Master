import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { Icon } from "../../icons.js";
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

export const DEMO_REGISTERS: Register[] = [
  { name: "RCC_CFGR", value: "0x0000_0000", warn: true },
  { name: "USART2_BRR", value: "0x0000_002E" },
  { name: "USART2_SR", value: "0x0000_00C0" },
  { name: "SCB->CFSR", value: "0x0000_0000" },
];

export const DEMO_LOG_LINES: LogLine[] = [
  { time: "21:40:02", mark: "kv", text: 'kb_lookup "STM32 UART 乱码" → 命中 protocols/uart-stm32-baud.md' },
  { time: "21:40:05", mark: "tx", text: "mem_read 0x40023808 → 0x00000000 (12ms)" },
  { time: "21:40:07", mark: "tx", text: "mem_read 0x40004408 → 0x0000002E (11ms)" },
  { time: "21:40:09", mark: "rx", text: "serial_read 512B → 乱码 96% · 校验错误 312" },
  { time: "21:40:11", mark: "err", text: "写内存请求 USART2->BRR = 0x0009 · 等待确认（规则 R2）" },
];

type SectionKey = "device" | "port" | "log";

export function Dock({
  logLines,
  registers,
}: {
  logLines: LogLine[];
  registers: Register[];
}): JSX.Element {
  const [expanded, setExpanded] = useState<Record<SectionKey, boolean>>({
    device: true,
    port: true,
    log: true,
  });

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
        onClick={(event) => {
          event.currentTarget.setAttribute("aria-expanded", open ? "false" : "true");
          setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
        }}
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
      <div class="dock-body">
        <section class="dock-sec">
          {head("device", "i-cpu", "设备监控", "ok", registers.length)}
          <div class="dock-sec-body">
            <DeviceMonitor registers={registers} />
          </div>
        </section>
        <section class="dock-sec">
          {head("port", "i-plug", "端口设置", "ok")}
          <div class="dock-sec-body">
            <PortSettings />
          </div>
        </section>
        <section class="dock-sec">
          {head("log", "i-log", "调试日志", "warn", logLines.length)}
          <div class="dock-sec-body">
            <DebugLog lines={logLines} />
          </div>
        </section>
      </div>
    </>
  );
}