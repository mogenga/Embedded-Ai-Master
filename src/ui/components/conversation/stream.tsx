import type { JSX } from "preact";
import type { TranscriptView } from "../../view/transcript.js";
import { MessageStream } from "./messages.js";

export function ConversationStream({ view }: { view: TranscriptView }): JSX.Element {
  return (
    <div class="cnv-stream">
      <MessageStream view={view} />
    </div>
  );
}