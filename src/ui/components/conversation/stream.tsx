import type { JSX } from "preact";
import type { GuardModel, TranscriptView } from "../../view/transcript.js";
import { MessageStream } from "./messages.js";

export function ConversationStream({
  view,
  onGuardConfirm,
  onGuardReject,
}: {
  view: TranscriptView;
  onGuardConfirm?: (guard: GuardModel) => void;
  onGuardReject?: (guard: GuardModel) => void;
}): JSX.Element {
  return (
    <div class="cnv-stream">
      <MessageStream view={view} onGuardConfirm={onGuardConfirm} onGuardReject={onGuardReject} />
    </div>
  );
}