import type { JSX } from "preact";
import { useState } from "preact/hooks";
import { Icon } from "../../icons.js";
import type { GuardModel } from "../../view/transcript.js";

type GuardState = GuardModel["state"] | "执行中";

const STATE_NOTE: Record<GuardState, string> = {
  "待确认": "按规则 R2，需先声明目标地址与写入值并获得确认后才会执行——本次尚未发起写入。",
  "已拒绝": "操作已拒绝，未写入目标地址。",
  "执行中": "已确认，执行中，等待工具结果。工具返回前状态保持不变。",
  "已执行": "已执行：目标地址已写入。",
};

export function GuardNotice({
  guard,
  onConfirm,
  onReject,
}: {
  guard: GuardModel;
  onConfirm?: (guard: GuardModel) => void;
  onReject?: (guard: GuardModel) => void;
}): JSX.Element {
  const [local, setLocal] = useState<GuardState>(guard.state);
  const state: GuardState = guard.state !== "待确认" ? guard.state : local;

  return (
    <div class="guard" data-state={state} role="status">
      <Icon name="i-alert" size={15} />
      <div>
        <p class="guard-text">
          {guard.action} <code>{guard.address}</code> = <code>{guard.value}</code> · {state}
        </p>
        <p class="guard-note">{STATE_NOTE[state]}</p>
        {state === "待确认" ? (
          <div class="guard-actions">
            <button
              type="button"
              class="btn btn--danger"
              onClick={() => {
                setLocal("执行中");
                onConfirm?.(guard);
              }}
            >
              <Icon name="i-check" size={14} />
              <span>确认写入</span>
            </button>
            <button
              type="button"
              class="btn"
              onClick={() => {
                setLocal("已拒绝");
                onReject?.(guard);
              }}
            >
              <Icon name="i-x" size={14} />
              <span>拒绝</span>
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}