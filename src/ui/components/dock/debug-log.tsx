import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { McpStatusPayload } from "../../../session/types.js";
import type { LogLine } from "./dock.js";

const MAX_STATUS_ITEMS = 5;

function statusText(status: McpStatusPayload): string {
  const parts: string[] = [status.kind];
  if (status.server !== undefined) parts.push(status.server);
  if (status.tool !== undefined) parts.push(status.tool);
  if (status.toolCount !== undefined) parts.push(`${status.toolCount} 工具`);
  if (status.message !== undefined) parts.push(status.message);
  return parts.join(" · ");
}

export function DebugLog({
  lines,
  mcpStatuses = [],
}: {
  lines: LogLine[];
  mcpStatuses?: McpStatusPayload[];
}): JSX.Element {
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
      {mcpStatuses.length === 0 ? null : (
        <ul class="mcp-status" aria-label="MCP 状态">
          {mcpStatuses.slice(-MAX_STATUS_ITEMS).map((status, index) => (
            <li class="mcp-status-item" data-kind={status.kind} key={`${status.kind}-${index}`}>
              {statusText(status)}
            </li>
          ))}
        </ul>
      )}
      <div class="log" ref={view} onScroll={onScroll}>
        {lines.length === 0 ? (
          <p class="log-empty">暂无工具调用。探针与串口的每次调用都会在此留痕。</p>
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
