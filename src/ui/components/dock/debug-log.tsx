import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { LogLine } from "./dock.js";

export function DebugLog({ lines }: { lines: LogLine[] }): JSX.Element {
  const view = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const el = view.current;
    if (!el || paused) return;
    el.scrollTop = el.scrollHeight;
  }, [lines, paused]);

  function onScroll(): void {
    const el = view.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    setPaused(!nearBottom);
  }

  return (
    <div class="log-wrap">
      <div class="log" ref={view} onScroll={onScroll}>
        {lines.length === 0 ? (
          <p class="log-empty">探针与串口的每次调用都会在此留痕，供夜批排障与会话回放使用。</p>
        ) : (
          lines.map((line, index) => (
            <div class="log-item" key={`${line.time}-${line.mark}-${index}`}>
              <span class="log-time">{line.time}</span>
              <span class="log-mark" data-l={line.mark} aria-hidden="true" />
              <span class="log-text">{line.text}</span>
            </div>
          ))
        )}
      </div>
      {paused ? <p class="log-pause">已暂停自动滚动</p> : null}
    </div>
  );
}