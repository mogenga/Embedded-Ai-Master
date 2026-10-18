import type { JSX } from "preact";
import { Icon } from "../../icons.js";
import type { GuardModel } from "../../view/transcript.js";

const STATE_NOTE: Record<GuardModel["state"], string> = {
  "待确认": "按规则 R2，需先声明目标地址与写入值并获得确认后才会执行——本次尚未发起写入。",
  "已拒绝": "操作已拒绝，未写入目标地址。",
  "已执行": "已执行：目标地址已写入。",
};

export function GuardNotice({ guard }: { guard: GuardModel }): JSX.Element {
  return (
    <div class="guard" data-state={guard.state} role="status">
      <Icon name="i-alert" size={15} />
      <div>
        <p class="guard-text">
          {guard.action} <code>{guard.address}</code> = <code>{guard.value}</code> · {guard.state}
        </p>
        <p class="guard-note">{STATE_NOTE[guard.state]}</p>
      </div>
    </div>
  );
}