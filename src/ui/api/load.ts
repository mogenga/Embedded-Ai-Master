import type { TranscriptView } from "../view/transcript.js";
import { emptyTranscriptView, transcriptFromSession } from "../view/transcript.js";
import { fetchDevice, fetchKb, fetchSession, fetchSessions } from "./client.js";
import type { DeviceStatus, FetchDeps, KbNode, SessionSummary } from "./client.js";

export interface LoadedWorkbench {
  sessions: SessionSummary[];
  activeSessionId?: string;
  view: TranscriptView;
  kbTree: KbNode[];
  kbRoot: string | null;
  device: DeviceStatus;
}

export async function loadSessionView(id: string, deps?: FetchDeps): Promise<TranscriptView> {
  const detail = await fetchSession(id, deps);
  return { ...transcriptFromSession(detail.events), sessionId: id };
}

export async function loadWorkbench(deps?: FetchDeps): Promise<LoadedWorkbench> {
  const [sessions, kb, device] = await Promise.all([
    fetchSessions(deps),
    fetchKb(deps),
    fetchDevice(deps),
  ]);
  const first = sessions.sessions[0];
  const view = first === undefined ? emptyTranscriptView() : await loadSessionView(first.id, deps);
  return {
    sessions: sessions.sessions,
    ...(first === undefined ? {} : { activeSessionId: first.id }),
    view,
    kbTree: kb.tree,
    kbRoot: kb.root,
    device,
  };
}
