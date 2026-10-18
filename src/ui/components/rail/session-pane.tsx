import type { JSX } from "preact";
import type { SessionSummary } from "../../api/client.js";
import { Icon } from "../../icons.js";

function formatTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toISOString().slice(5, 16).replace("T", " ");
}

function SessionRow({
  session,
  active,
  onSelect,
}: {
  session: SessionSummary;
  active: boolean;
  onSelect?: (id: string) => void;
}): JSX.Element {
  const state = session.status === "open" ? "run" : "idle";
  return (
    <li>
      <button
        type="button"
        class={active ? "session is-active" : "session"}
        onClick={onSelect === undefined ? undefined : () => onSelect(session.id)}
      >
        <span class="dot" data-s={state} />
        <span class="session-title">{session.id}</span>
        <span class="session-meta">{formatTime(session.createdAt)}</span>
      </button>
    </li>
  );
}

export function SessionPane({
  sessions,
  activeId,
  onSelect,
}: {
  sessions: SessionSummary[];
  activeId?: string;
  onSelect?: (id: string) => void;
}): JSX.Element {
  const open = sessions.filter((session) => session.status === "open");
  const closed = sessions.filter((session) => session.status === "closed");
  return (
    <section class="rail-bottom" aria-label="诊断会话">
      <div class="pane-head">
        <Icon name="i-chat" size={14} />
        <span>诊断会话</span>
        <button type="button" class="head-btn" title="新建诊断" aria-label="新建诊断" disabled>
          <Icon name="i-plus" size={14} />
        </button>
      </div>
      {sessions.length === 0 ? (
        <p class="pane-empty">暂无会话</p>
      ) : (
        <ul class="sessions">
          {open.length > 0 ? <li class="session-group">进行中</li> : null}
          {open.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              active={session.id === activeId}
              onSelect={onSelect}
            />
          ))}
          {closed.length > 0 ? <li class="session-group">历史</li> : null}
          {closed.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              active={session.id === activeId}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </section>
  );
}