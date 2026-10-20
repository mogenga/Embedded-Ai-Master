import type { McpStatusPayload, McpStatusPayloadKind, SessionEvent, SessionEventEnvelope } from "../session/types.js";
import type { DeviceStatus, KbNode, SessionSummary } from "./api/client.js";
import type { LoadedSession, LoadedWorkbench } from "./api/load.js";
import { deviceFromSession } from "./view/device.js";
import type { TranscriptView } from "./view/transcript.js";
import { transcriptFromSession } from "./view/transcript.js";

export const MAX_MCP_STATUSES = 20;

export interface WorkbenchState {
  connection: "loading" | "ready" | "error";
  view: TranscriptView;
  sessions: SessionSummary[];
  sessionErrors?: Array<{ dir: string; code: string }>;
  activeSessionId?: string;
  kbTree: KbNode[];
  kbRoot: string | null;
  device: DeviceStatus;
  events: SessionEvent[];
  lastSeq: number;
  mcpStatuses: McpStatusPayload[];
  errorMessage?: string;
  detailError?: string;
  switching?: boolean;
  streamError?: string;
  failedSessionId?: string;
}

export interface RetryTarget {
  kind: "load" | "session";
  id?: string;
}

const MCP_STATUS_KINDS: ReadonlySet<string> = new Set<McpStatusPayloadKind>([
  "connected",
  "connect_failed",
  "tools_changed",
  "tools_refresh_failed",
  "tool_invalid_schema",
  "listener_failed",
  "call_failed",
  "config_failed",
  "config_warning",
  "project_config_skipped",
  "tool_name_renamed",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function toPayload(kind: string, source: Record<string, unknown>): McpStatusPayload {
  const payload: McpStatusPayload = { kind: kind as McpStatusPayloadKind };
  const server = optionalString(source.server);
  if (server !== undefined) payload.server = server;
  const tool = optionalString(source.tool);
  if (tool !== undefined) payload.tool = tool;
  const toolCount = optionalNumber(source.toolCount);
  if (toolCount !== undefined) payload.toolCount = toolCount;
  const message = optionalString(source.message);
  if (message !== undefined) payload.message = message;
  const attempts = optionalNumber(source.attempts);
  if (attempts !== undefined) payload.attempts = attempts;
  const name = optionalString(source.name);
  if (name !== undefined) payload.name = name;
  const originalName = optionalString(source.originalName);
  if (originalName !== undefined) payload.originalName = originalName;
  if (source.scope === "global") payload.scope = "global";
  return payload;
}

export function mcpStatusOf(event: SessionEvent): McpStatusPayload | undefined {
  const payload = event.payload;
  if (!isRecord(payload)) return undefined;
  if (event.type === "mcp_status") {
    const kind = optionalString(payload.kind);
    return kind !== undefined && MCP_STATUS_KINDS.has(kind) ? toPayload(kind, payload) : undefined;
  }
  if (event.type === "status") {
    const status = optionalString(payload.status);
    if (status === undefined || !status.startsWith("mcp_")) return undefined;
    const kind = status.slice("mcp_".length);
    return MCP_STATUS_KINDS.has(kind) ? toPayload(kind, payload) : undefined;
  }
  return undefined;
}

export function mcpStatusesFromSession(events: readonly SessionEvent[]): McpStatusPayload[] {
  const statuses: McpStatusPayload[] = [];
  for (const event of events) {
    const status = mcpStatusOf(event);
    if (status !== undefined) statuses.push(status);
  }
  return statuses.slice(-MAX_MCP_STATUSES);
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
  };
}

export function applyLoadSuccess(state: WorkbenchState, loaded: LoadedWorkbench): WorkbenchState {
  return {
    ...state,
    connection: "ready",
    view: loaded.view,
    events: loaded.events,
    lastSeq: loaded.lastSeq,
    mcpStatuses: mcpStatusesFromSession(loaded.events),
    sessions: loaded.sessions,
    sessionErrors: loaded.errors,
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
  return {
    ...state,
    switching: true,
    detailError: undefined,
    failedSessionId: undefined,
    streamError: undefined,
  };
}

export function applySessionLoaded(
  state: WorkbenchState,
  id: string,
  loaded: LoadedSession,
): WorkbenchState {
  return {
    ...state,
    activeSessionId: id,
    view: loaded.view,
    events: loaded.events,
    lastSeq: loaded.lastSeq,
    device: loaded.device,
    mcpStatuses: mcpStatusesFromSession(loaded.events),
    connection: "ready",
    switching: false,
    detailError: undefined,
    failedSessionId: undefined,
    streamError: undefined,
  };
}

export function applySessionFailure(
  state: WorkbenchState,
  id: string,
  message: string,
): WorkbenchState {
  return { ...state, switching: false, detailError: message, failedSessionId: id };
}

export function applySessionEvent(
  state: WorkbenchState,
  event: SessionEventEnvelope,
): WorkbenchState {
  if (event.sessionId !== state.activeSessionId) return state;
  if (event.seq <= state.lastSeq) return state;
  const events = [...state.events, event];
  const status = mcpStatusOf(event);
  const mcpStatuses =
    status === undefined
      ? state.mcpStatuses
      : [...state.mcpStatuses, status].slice(-MAX_MCP_STATUSES);
  return {
    ...state,
    events,
    lastSeq: event.seq,
    view: {
      ...transcriptFromSession(events),
      ...(state.activeSessionId === undefined ? {} : { sessionId: state.activeSessionId }),
    },
    device: event.type === "device_status" ? deviceFromSession(events) : state.device,
    mcpStatuses,
    connection: "ready",
    errorMessage: undefined,
    streamError: undefined,
  };
}

export function applyStreamError(state: WorkbenchState, message: string): WorkbenchState {
  return { ...state, streamError: message };
}
