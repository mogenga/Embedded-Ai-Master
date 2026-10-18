import type { JSX } from "preact";
import { Icon } from "../../icons.js";

export function PortSettings({ serial }: { serial: string }): JSX.Element {
  const connected = serial !== "unknown" && serial !== "";

  return (
    <>
      <div class="port-grid">
        <label for="dock-port">端口</label>
        <select id="dock-port" disabled>
          <option>{connected ? serial : "未检测到串口"}</option>
        </select>
        <label for="dock-baud">波特率</label>
        <select id="dock-baud" defaultValue="115200" disabled>
          <option>115200</option>
          <option>230400</option>
          <option>9600</option>
          <option>38400</option>
        </select>
        <label for="dock-frame">数据帧</label>
        <input id="dock-frame" value="8 N 1 · 无流控" readOnly />
      </div>
      <div class="btn-row">
        <button type="button" class="btn btn--primary" disabled>
          <Icon name="i-plug" size={14} />
          <span>打开端口</span>
        </button>
        <button type="button" class="btn" disabled>
          <Icon name="i-x" size={14} />
          <span>关闭</span>
        </button>
      </div>
      <p class="pane-empty">串口控制尚未接入</p>
      <div class="io-stats">
        <div class="stat">
          <div class="stat-k">接收</div>
          <div class="stat-v">—</div>
        </div>
        <div class="stat">
          <div class="stat-k">发送</div>
          <div class="stat-v">—</div>
        </div>
        <div class="stat">
          <div class="stat-k">错误帧</div>
          <div class="stat-v">—</div>
        </div>
      </div>
    </>
  );
}
