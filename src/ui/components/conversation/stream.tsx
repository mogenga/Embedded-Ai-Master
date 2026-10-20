import type { JSX } from "preact";
import type { GuardModel, TranscriptView } from "../../view/transcript.js";
import { MessageStream } from "./messages.js";

export function ConversationStream({
  view,
  sessionId,
  onGuardConfirm,
  onGuardReject,
  onApprovalDecision,
}: {
  view: TranscriptView;
  sessionId?: string;
  onGuardConfirm?: (guard: GuardModel) => void;
  onGuardReject?: (guard: GuardModel) => void;
  onApprovalDecision?: (
    sessionId: string,
    requestId: string,
    decision: "allow" | "deny",
  ) => Promise<void>;
}): JSX.Element {
  return (
    <div class="cnv-stream">
      {view.events.length === 0 ? (
        <p class="cnv-empty">{view.sessionId === undefined ? "暂无会话" : "暂无消息"}</p>
      ) : (
        <MessageStream
          view={view}
          sessionId={sessionId}
          onGuardConfirm={onGuardConfirm}
          onGuardReject={onGuardReject}
          onApprovalDecision={onApprovalDecision}
        />
      )}
    </div>
  );
}
