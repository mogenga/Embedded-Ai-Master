import type { JSX } from "preact";
import { Icon } from "../../icons.js";

type SessionState = "run" | "warn" | "idle";

type SessionRow = {
  id: string;
  title: string;
  meta: string;
  state: SessionState;
  active?: boolean;
};

const SESSION_GROUPS: ReadonlyArray<{ label: string; rows: ReadonlyArray<SessionRow> }> = [
  {
    label: "进行中",
    rows: [
      { id: "128", title: "STM32F407 UART 输出乱码", meta: "#128", state: "run", active: true },
      { id: "127", title: "ESP32 上电无输出", meta: "#127", state: "warn" },
    ],
  },
  {
    label: "历史",
    rows: [
      { id: "i2c", title: "I2C 传感器读回全 0xFF", meta: "2h", state: "idle" },
      { id: "kinetis", title: "Kinetis 看门狗反复复位", meta: "1d", state: "idle" },
      { id: "dma", title: "DMA 传输间歇丢帧", meta: "3d", state: "idle" },
    ],
  },
];

export function SessionPane(): JSX.Element {
  return (
    <section class="rail-bottom" aria-label="诊断会话">
      <div class="pane-head">
        <Icon name="i-chat" size={14} />
        <span>诊断会话</span>
        <button type="button" class="head-btn" title="新建诊断" aria-label="新建诊断">
          <Icon name="i-plus" size={14} />
        </button>
      </div>
      <ul class="sessions">
        {SESSION_GROUPS.map((group) => [
          <li key={group.label} class="session-group">
            {group.label}
          </li>,
          ...group.rows.map((row) => (
            <li key={row.id}>
              <button type="button" class={row.active ? "session is-active" : "session"}>
                <span class="dot" data-s={row.state} />
                <span class="session-title">{row.title}</span>
                <span class="session-meta">{row.meta}</span>
              </button>
            </li>
          )),
        ])}
      </ul>
    </section>
  );
}