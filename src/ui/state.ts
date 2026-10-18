import type { DeviceStatus, KbNode, SessionSummary } from "./api/client.js";
import type { LoadedWorkbench } from "./api/load.js";
import type { TranscriptView } from "./view/transcript.js";

export interface WorkbenchState {
  connection: "loading" | "ready" | "error";
  view: TranscriptView;
  sessions: SessionSummary[];
  activeSessionId?: string;
  kbTree: KbNode[];
  kbRoot: string | null;
  device: DeviceStatus;
  errorMessage?: string;
  detailError?: string;
  switching?: boolean;
  streamError?: string;
  viewSource?: "live" | "replay";
  failedSessionId?: string;
}

export interface RetryTarget {
  kind: "load" | "session";
  id?: string;
}

export class RequestGate {
  private seq = 0;

  begin(): () => boolean {
    const seq = ++this.seq;
    return () => seq === this.seq;
  }
}

export function retryTarget(state: WorkbenchState): RetryTarget {
  return state.failedSessionId === undefined
    ? { kind: "load" }
    : { kind: "session", id: state.failedSessionId };
}

export function startLoad(state: WorkbenchState): WorkbenchState {
  return {
    ...state,
    connection: "loading",
    errorMessage: undefined,
    detailError: undefined,
    failedSessionId: undefined,
    viewSource: undefined,
  };
}

export function applyLoadSuccess(
  state: WorkbenchState,
  loaded: LoadedWorkbench,
  liveView?: TranscriptView,
): WorkbenchState {
  return {
    ...state,
    connection: "ready",
    view: liveView ?? loaded.view,
    viewSource: liveView === undefined ? "replay" : "live",
    sessions: loaded.sessions,
    ...(loaded.activeSessionId === undefined ? { activeSessionId: undefined } : { activeSessionId: loaded.activeSessionId }),
    kbTree: loaded.kbTree,
    kbRoot: loaded.kbRoot,
    device: loaded.device,
    errorMessage: undefined,
    detailError: undefined,
    failedSessionId: undefined,
    switching: false,
    streamError: undefined,
  };
}

export function applyLoadFailure(state: WorkbenchState, message: string): WorkbenchState {
  return {
    ...state,
    connection: "error",
    errorMessage: message,
    failedSessionId: undefined,
    switching: false,
  };
}

export function startSessionSwitch(state: WorkbenchState): WorkbenchState {
  return { ...state, switching: true, detailError: undefined, failedSessionId: undefined };
}

export function applySessionLoaded(
  state: WorkbenchState,
  id: string,
  view: TranscriptView,
): WorkbenchState {
  return {
    ...state,
    activeSessionId: id,
    view,
    viewSource: "replay",
    switching: false,
    detailError: undefined,
    failedSessionId: undefined,
  };
}

export function applySessionFailure(
  state: WorkbenchState,
  id: string,
  message: string,
): WorkbenchState {
  return { ...state, switching: false, detailError: message, failedSessionId: id };
}

export function applyStreamEvent(state: WorkbenchState, view: TranscriptView): WorkbenchState {
  if (state.viewSource === "replay") return state;
  return {
    ...state,
    view,
    viewSource: "live",
    connection: "ready",
    errorMessage: undefined,
    streamError: undefined,
  };
}

export function applyStreamError(state: WorkbenchState, message: string): WorkbenchState {
  return { ...state, streamError: message };
}
