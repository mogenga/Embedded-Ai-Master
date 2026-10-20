import type { SessionEvent } from "../../session/types.js";
import type { TranscriptView } from "../view/transcript.js";
import { emptyTranscriptView, transcriptFromSession } from "../view/transcript.js";
import { deviceFromSession, UNKNOWN_DEVICE } from "../view/device.js";
import { fetchDevice, fetchKb, fetchSession, fetchSessions } from "./client.js";
import type { DeviceStatus, FetchDeps, KbNode, SessionSummary } from "./client.js";

export interface LoadSessionDeps extends FetchDeps {
  deviceFallback?: DeviceStatus;
}

export interface LoadedSession {
  view: TranscriptView;
  events: SessionEvent[];
  lastSeq: number;
  device: DeviceStatus;
}

export interface LoadedWorkbench extends LoadedSession {
  sessions: SessionSummary[];
  errors: Array<{ dir: string; code: string }>;
  activeSessionId?: string;
  kbTree: KbNode[];
  kbRoot: string | null;
  deviceFallback: DeviceStatus;
}

export function lastSeqOf(events: readonly SessionEvent[]): number {
  let last = -1;
  for (const event of events) {
    if (event.seq > last) last = event.seq;
  }
  return last;
}

export function deviceForSession(
  events: readonly SessionEvent[],
  fallback: DeviceStatus | undefined,
): DeviceStatus {
  return events.some((event) => event.type === "device_status")
    ? deviceFromSession(events)
    : fallback ?? UNKNOWN_DEVICE;
}

export async function loadSessionView(id: string, deps?: LoadSessionDeps): Promise<LoadedSession> {
  const detail = await fetchSession(id, deps);
  const events = detail.events;
  return {
    view: { ...transcriptFromSession(events), sessionId: id },
    events,
    lastSeq: lastSeqOf(events),
    device: deviceForSession(events, deps?.deviceFallback),
  };
}

export async function loadWorkbench(deps?: FetchDeps): Promise<LoadedWorkbench> {
  const [sessions, kb, device] = await Promise.all([
    fetchSessions(deps),
    fetchKb(deps),
    fetchDevice(deps),
  ]);
  const first = sessions.sessions[0];
  const loaded: LoadedSession =
    first === undefined
      ? { view: emptyTranscriptView(), events: [], lastSeq: -1, device }
      : await loadSessionView(first.id, { ...deps, deviceFallback: device });
  return {
    sessions: sessions.sessions,
    errors: sessions.errors ?? [],
    ...(first === undefined ? {} : { activeSessionId: first.id }),
    ...loaded,
    kbTree: kb.tree,
    kbRoot: kb.root,
    deviceFallback: device,
  };
}
