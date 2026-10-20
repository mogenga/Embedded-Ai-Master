import type { JSX } from "preact";
import { useRef, useState } from "preact/hooks";
import { Icon } from "../../icons.js";

const MIN_HEIGHT = 22;
const MAX_HEIGHT = 120;

export function Composer({
  onSend,
  canSend = onSend !== undefined,
  disabledReason,
  errorMessage,
}: {
  onSend?: (text: string) => void | Promise<void>;
  canSend?: boolean;
  disabledReason?: string;
  errorMessage?: string;
}): JSX.Element {
  const [text, setText] = useState("");
  const [failed, setFailed] = useState(false);
  const [sending, setSending] = useState(false);
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

  function clear(): void {
    setText("");
    setFailed(false);
    const el = field.current;
    if (el) {
      el.value = "";
      el.style.height = MIN_HEIGHT + "px";
      el.scrollTop = 0;
    }
    scrollStreamToBottom();
  }

  async function send(): Promise<void> {
    if (!canSend || sending) return;
    const value = (field.current?.value ?? text).trim();
    if (!value) return;
    setSending(true);
    let result: void | Promise<void>;
    try {
      result = onSend?.(value);
    } catch {
      setSending(false);
      setFailed(true);
      return;
    }
    if (result === undefined) {
      setSending(false);
      clear();
      return;
    }
    setFailed(false);
    try {
      await result;
    } catch {
      setFailed(true);
      return;
    } finally {
      setSending(false);
    }
    clear();
  }

  function onKeyDown(event: JSX.TargetedKeyboardEvent<HTMLTextAreaElement>): void {
    if (event.isComposing) return;
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    void send();
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
            disabled={!canSend || sending || text.trim() === ""}
            onClick={() => {
              void send();
            }}
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
      {failed || errorMessage !== undefined ? (
        <p class="composer-note composer-error" role="status">
          {errorMessage ?? "发送失败，输入已保留"}
        </p>
      ) : null}
    </div>
  );
}
