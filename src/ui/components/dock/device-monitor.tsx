import type { JSX } from "preact";
import { useState } from "preact/hooks";
import type { DeviceStatus } from "../../api/client.js";
import { Icon } from "../../icons.js";
import type { Register } from "./dock.js";

type ResetState = "idle" | "confirming" | "executing";

function field(value: string): string {
  return value === "unknown" || value === "" ? "未接入" : value;
}

export function DeviceMonitor({
  device,
  registers,
}: {
  device: DeviceStatus;
  registers: Register[];
}): JSX.Element {
  const [reset, setReset] = useState<ResetState>("idle");
  const connected = device.cpu !== "unknown" && device.cpu !== "";

  return (
    <>
      <dl class="field">
        <dt>目标</dt>
        <dd>{field(device.cpu)}</dd>
        <dt>探针</dt>
        <dd>{field(device.probe)}</dd>
        <dt>CPU 状态</dt>
        <dd class="mono">{field(device.cpu)}</dd>
        <dt>仿真后端</dt>
        <dd>{field(device.backend)}</dd>
      </dl>
      <div class="btn-row">
        <button type="button" class="btn btn--primary" disabled={!connected}>
          <Icon name="i-pause" size={14} />
          <span>暂停</span>
        </button>
        <button type="button" class="btn" disabled={!connected}>
          <Icon name="i-play" size={14} />
          <span>继续</span>
        </button>
        <button
          type="button"
          class="btn btn--danger"
          disabled={!connected}
          onClick={() => setReset("confirming")}
        >
          <Icon name="i-power" size={14} />
          <span>复位</span>
        </button>
      </div>
      {reset === "confirming" ? (
        <div class="confirm">
          <p>
            复位目标 <strong>{field(device.cpu)}</strong>，写入 <code>AIRCR @ 0xE000_ED0C = 0x05FA_0004</code>。
          </p>
          <div class="btn-row">
            <button type="button" class="btn btn--danger" onClick={() => setReset("executing")}>
              <Icon name="i-check" size={14} />
              <span>确认复位</span>
            </button>
            <button type="button" class="btn" onClick={() => setReset("idle")}>
              <span>取消</span>
            </button>
          </div>
        </div>
      ) : null}
      {reset === "executing" ? (
        <p class="confirm-pending" role="status">
          <Icon name="i-play" size={14} />
          <span>执行中，等待工具结果</span>
        </p>
      ) : null}
      <table class="reg-table">
        <thead>
          <tr>
            <th>寄存器</th>
            <th>值</th>
          </tr>
        </thead>
        <tbody>
          {registers.length === 0 ? (
            <tr>
              <td class="reg-empty" colSpan={2}>
                暂无寄存器读数
              </td>
            </tr>
          ) : (
            registers.map((register, index) => (
              <tr key={`${register.name}-${index}`}>
                <td class="reg-name">{register.name}</td>
                <td class={register.warn ? "reg-val flag" : "reg-val"}>{register.value}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </>
  );
}