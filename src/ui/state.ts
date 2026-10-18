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
}

export function startLoad(state: WorkbenchState): WorkbenchState {
  return { ...state, connection: "loading", errorMessage: undefined, detailError: undefined };
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
    sessions: loaded.sessions,
    ...(loaded.activeSessionId === undefined ? { activeSessionId: undefined } : { activeSessionId: loaded.activeSessionId }),
    kbTree: loaded.kbTree,
    kbRoot: loaded.kbRoot,
    device: loaded.device,
    errorMessage: undefined,
    detailError: undefined,
    switching: false,
    streamError: undefined,
  };
}

export function applyLoadFailure(state: WorkbenchState, message: string): WorkbenchState {
  return { ...state, connection: "error", errorMessage: message, switching: false };
}

export function startSessionSwitch(state: WorkbenchState): WorkbenchState {
  return { ...state, switching: true, detailError: undefined };
}

export function applySessionLoaded(
  state: WorkbenchState,
  id: string,
  view: TranscriptView,
): WorkbenchState {
  return { ...state, activeSessionId: id, view, switching: false, detailError: undefined };
}

export function applySessionFailure(state: WorkbenchState, message: string): WorkbenchState {
  return { ...state, switching: false, detailError: message };
}

export function applyStreamEvent(state: WorkbenchState, view: TranscriptView): WorkbenchState {
  return {
    ...state,
    view,
    connection: "ready",
    errorMessage: undefined,
    detailError: undefined,
    streamError: undefined,
  };
}

export function applyStreamError(state: WorkbenchState, message: string): WorkbenchState {
  return { ...state, streamError: message };
}
