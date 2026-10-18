import type { ComponentChildren, JSX } from "preact";
import { Icon } from "../../icons.js";
import type { TranscriptEvent, TranscriptView } from "../../view/transcript.js";
import { GuardNotice } from "./guard-notice.js";
import { ToolCard } from "./tool-card.js";
import { VerdictCard } from "./verdict-card.js";

const AGENT_NAME = "Embedded-Ai-Master";
const ASK_TAG = "第 0 步分流 · 一次只问一个问题";
const ASK_PREFIX = "第 0 步分流";

type UserEvent = Extract<TranscriptEvent, { kind: "user" }>;
type AssistantEvent = Extract<TranscriptEvent, { kind: "assistant" }>;
type AskEvent = Extract<TranscriptEvent, { kind: "ask" }>;

type InterruptedEvent = Extract<TranscriptEvent, { kind: "interrupted" }>;

function renderInline(text: string): ComponentChildren {
  const parts = text.split(/(`[^`\n]+`)/g);
  if (parts.length === 1) return text;
  return parts.map((part, index) =>
    part.length > 1 && part.startsWith("`") && part.endsWith("`") ? (
      <code key={index}>{part.slice(1, -1)}</code>
    ) : (
      part
    ),
  );
}

function RoleLine({ role }: { role: "user" | "agent" }): JSX.Element {
  return (
    <div class="turn-role">
      <span class="avatar" aria-hidden="true">
        <Icon name={role === "agent" ? "i-logo" : "i-user"} size={13} />
      </span>
      <span class="role">{role === "agent" ? AGENT_NAME : "你"}</span>
    </div>
  );
}

function UserTurn({ entry }: { entry: UserEvent }): JSX.Element {
  return (
    <div class="turn turn--user">
      <RoleLine role="user" />
      <div class="bubble">{renderInline(entry.text)}</div>
    </div>
  );
}

function AgentTurn({ entry }: { entry: AssistantEvent }): JSX.Element {
  return (
    <div class="turn turn--agent">
      <RoleLine role="agent" />
      <div class="bubble">{renderInline(entry.text)}</div>
    </div>
  );
}

function AskBlock({ entry }: { entry: AskEvent }): JSX.Element {
  const lines = entry.text.split("\n");
  const heading = lines[0] ?? "";
  const hasHeading = heading.startsWith(ASK_PREFIX);
  const body = hasHeading ? lines.slice(1).join("\n").trim() : entry.text;
  return (
    <div class="turn turn--agent">
      <RoleLine role="agent" />
      <div class="ask">
        <div class="ask-tag">{hasHeading ? heading : ASK_TAG}</div>
        {body.length === 0 ? null : <p class="ask-body">{renderInline(body)}</p>}
        {entry.note === undefined ? null : <p class="ask-note">{entry.note}</p>}
      </div>
    </div>
  );
}

function InterruptedNotice({ entry }: { entry: InterruptedEvent }): JSX.Element {
  return (
    <div class="interrupted" role="status">
      <Icon name="i-alert" size={14} />
      <span>{entry.reason}</span>
    </div>
  );
}

function renderEvent(entry: TranscriptEvent): JSX.Element {
  switch (entry.kind) {
    case "user":
      return <UserTurn key={entry.id} entry={entry} />;
    case "assistant":
      return <AgentTurn key={entry.id} entry={entry} />;
    case "ask":
      return <AskBlock key={entry.id} entry={entry} />;
    case "tool":
      return <ToolCard key={entry.id} tool={entry.tool} />;
    case "verdict":
      return <VerdictCard key={entry.id} verdict={entry.verdict} />;
    case "guard":
      return <GuardNotice key={entry.id} guard={entry.guard} />;
    case "interrupted":
      return <InterruptedNotice key={entry.id} entry={entry} />;
  }
}

export function MessageStream({ view }: { view: TranscriptView }): JSX.Element {
  return <div class="messages">{view.events.map(renderEvent)}</div>;
}