import type { JSX } from "preact";
import { useRef, useState } from "preact/hooks";
import { Icon } from "../../icons.js";

const MIN_HEIGHT = 22;
const MAX_HEIGHT = 120;

export function Composer({
  onSend,
  canSend = true,
  disabledReason,
}: {
  onSend?: (text: string) => void;
  canSend?: boolean;
  disabledReason?: string;
}): JSX.Element {
  const [text, setText] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);

  function resize(el: HTMLTextAreaElement): void {
    el.style.height = MIN_HEIGHT + "px";
    const next = Math.min(Math.max(el.scrollHeight, MIN_HEIGHT), MAX_HEIGHT);
    el.style.height = next + "px";
  }

  function scrollStreamToBottom(): void {
    const stream = document.querySelector(".cnv-stream");
    if (stream !== null) stream.scrollTop = stream.scrollHeight;
  }

  function send(): void {
    if (!canSend) return;
    const value = (field.current?.value ?? text).trim();
    if (!value) return;
    onSend?.(value);
    setText("");
    const el = field.current;
    if (el) {
      el.value = "";
      el.style.height = MIN_HEIGHT + "px";
      el.scrollTop = 0;
    }
    scrollStreamToBottom();
  }

  function onKeyDown(event: JSX.TargetedKeyboardEvent<HTMLTextAreaElement>): void {
    if (event.isComposing) return;
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    send();
  }

  return (
    <div class="composer">
      <div class="composer-box">
        <textarea
          ref={field}
          rows={1}
          value={text}
          aria-label="输入消息"
          placeholder="描述症状、回答澄清问题，或指定下一步取证…"
          onInput={(event) => {
            setText(event.currentTarget.value);
            resize(event.currentTarget);
          }}
          onKeyDown={onKeyDown}
        />
        <div class="composer-tools">
          <button type="button" class="tb">
            <Icon name="i-plus" size={14} />
            <span>上下文</span>
          </button>
          <button type="button" class="tb">
            <Icon name="i-plug" size={14} />
            <span>工具集：探针 + 串口 + KB</span>
          </button>
          <span class="spacer" />
          <span class="hint">Enter 发送 · Shift + Enter 换行</span>
          <button
            type="button"
            class="send"
            aria-label="发送"
            disabled={!canSend || text.trim() === ""}
            onClick={send}
          >
            <Icon name="i-send" size={16} />
          </button>
        </div>
      </div>
      {canSend ? null : (
        <p class="composer-note" role="status">
          {disabledReason ?? "未配置提交端点"}
        </p>
      )}
    </div>
  );
}