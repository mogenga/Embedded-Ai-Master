import type { JSX } from "preact";
import { Icon } from "../../icons.js";

export type ConversationStatus = "idle" | "diagnosing" | "done" | "interrupted";

const STATUS_LABEL: Record<ConversationStatus, string> = {
  idle: "待开始",
  diagnosing: "诊断中",
  done: "已完成",
  interrupted: "已中断",
};

export function ConversationHeader({
  title,
  status,
  onNewSession,
}: {
  title: string;
  status: ConversationStatus;
  onNewSession?: () => void;
}): JSX.Element {
  return (
    <header class="cnv-head">
      <div class="cnv-title">
        <h1 class="cnv-title-text" title={title}>
          {title}
        </h1>
        <span class="status" data-s={status}>
          <span class="dot" aria-hidden="true" />
          {STATUS_LABEL[status]}
        </span>
      </div>
      <div class="cnv-actions">
        {onNewSession === undefined ? null : (
          <button type="button" class="btn-ghost" onClick={onNewSession}>
            <Icon name="i-plus" size={14} />
            <span>新会话</span>
          </button>
        )}
        <button type="button" class="btn-ghost">
          <Icon name="i-refresh" size={14} />
          <span>回放</span>
        </button>
        <button type="button" class="btn-ghost">
          <Icon name="i-copy" size={14} />
          <span>导出 transcript</span>
        </button>
      </div>
    </header>
  );
}
