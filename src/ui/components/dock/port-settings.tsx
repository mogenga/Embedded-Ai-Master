import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { Icon } from "../../icons.js";

const DEMO_STATS = { rx: "1.24k", tx: "86", err: 312 };

export function PortSettings(): JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <>
      <div class="port-grid">
        <label for="dock-port">端口</label>
        <select id="dock-port" defaultValue="COM3 · USB-SERIAL CH340">
          <option>COM3 · USB-SERIAL CH340</option>
          <option>COM7 · STLink Virtual COM</option>
          <option>仿真 UART · Renode socket</option>
        </select>
        <label for="dock-baud">波特率</label>
        <select id="dock-baud" defaultValue="115200">
          <option>115200</option>
          <option>230400</option>
          <option>9600</option>
          <option>38400</option>
        </select>
        <label for="dock-frame">数据帧</label>
        <input id="dock-frame" value="8 N 1 · 无流控" readOnly />
      </div>
      <div class="btn-row">
        <button type="button" class="btn btn--primary" onClick={() => setOpen(true)}>
          <Icon name="i-plug" size={14} />
          <span>打开端口</span>
        </button>
        <button type="button" class="btn" onClick={() => setOpen(false)}>
          <Icon name="i-x" size={14} />
          <span>关闭</span>
        </button>
      </div>
      <div class="io-stats">
        <div class="stat">
          <div class="stat-k">接收</div>
          <div class="stat-v">{open ? DEMO_STATS.rx : "—"}</div>
        </div>
        <div class="stat">
          <div class="stat-k">发送</div>
          <div class="stat-v">{open ? DEMO_STATS.tx : "—"}</div>
        </div>
        <div class="stat">
          <div class="stat-k">错误帧</div>
          <div class="stat-v" data-s={open && DEMO_STATS.err !== 0 ? "danger" : undefined}>
            {open ? DEMO_STATS.err : "—"}
          </div>
        </div>
      </div>
    </>
  );
}