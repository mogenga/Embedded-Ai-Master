import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { Icon } from "../../icons.js";
import type { Register } from "./dock.js";

type ResetState = "idle" | "confirming" | "executed";

export function DeviceMonitor({ registers }: { registers: Register[] }): JSX.Element {
  const [reset, setReset] = useState<ResetState>("idle");

  return (
    <>
      <dl class="field">
        <dt>目标</dt>
        <dd>
          STM32F407ZGT6 <span class="sub">Cortex-M4 · 168 MHz</span>
        </dd>
        <dt>探针</dt>
        <dd>
          <span class="pill" data-s="ok">
            OpenOCD · ST-Link V2 已连接
          </span>
        </dd>
        <dt>CPU 状态</dt>
        <dd class="mono">Halted @ 0x0800_1A2C</dd>
        <dt>仿真后端</dt>
        <dd>
          <span class="pill">Renode 未启用</span>
        </dd>
      </dl>
      <div class="btn-row">
        <button type="button" class="btn btn--primary">
          <Icon name="i-pause" size={14} />
          <span>暂停</span>
        </button>
        <button type="button" class="btn">
          <Icon name="i-play" size={14} />
          <span>继续</span>
        </button>
        <button type="button" class="btn btn--danger" onClick={() => setReset("confirming")}>
          <Icon name="i-power" size={14} />
          <span>复位</span>
        </button>
      </div>
      {reset === "confirming" ? (
        <div class="confirm">
          <p>
            复位目标 <strong>STM32F407ZGT6</strong>，写入 <code>AIRCR.SYSRESETREQ = 1</code>。
          </p>
          <div class="btn-row">
            <button type="button" class="btn btn--danger" onClick={() => setReset("executed")}>
              <Icon name="i-check" size={14} />
              <span>确认复位</span>
            </button>
            <button type="button" class="btn" onClick={() => setReset("idle")}>
              <span>取消</span>
            </button>
          </div>
        </div>
      ) : null}
      {reset === "executed" ? (
        <p class="confirm-done">
          <Icon name="i-check" size={14} />
          <span>已执行复位</span>
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
            registers.map((register) => (
              <tr key={register.name}>
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