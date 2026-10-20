/**
 * Type declarations for the shared protocol module.
 *
 * The module is plain ESM so both the desktop host and the browser bundle can
 * import it without a build step; these types mirror the kernel's
 * `SessionEvent` shape for editors and for the tests.
 */

export interface KernelSessionEvent {
  seq: number;
  ts: string;
  type: string;
  payload: Record<string, unknown>;
  parent?: number;
}

export interface PublicMessage {
  role: "user" | "assistant" | "tool";
  text?: string;
  name?: string;
  summary?: string;
  ok?: boolean;
  done?: boolean;
  images?: number;
  index?: number;
}

export interface HostEvent {
  type: string;
  [key: string]: unknown;
}

export interface ProtocolContext {
  sessionId: string;
  cwd: string;
  running: boolean;
  pendingCalls: Map<string, { name: string; arguments: Record<string, unknown> }>;
  lastAssistantText: string;
  lastSeq: number;
  openTool: string;
  startedTools: Set<string>;
  pendingApprovals: Set<string>;
}

export interface ModelOption {
  id: string;
  name: string;
  contextLength: number;
  supportsTools: boolean;
  supportsReasoning: boolean;
  supportsVision: boolean;
}

export const MAX_TOOL_OUTPUT_BYTES: number;

export function summarizeToolCall(name: string, args: unknown): string;
export function sessionEventsToMessages(events: readonly KernelSessionEvent[]): PublicMessage[];
export function createContext(options?: { sessionId?: string; cwd?: string }): ProtocolContext;
export function sessionEventToHostEvents(
  event: KernelSessionEvent,
  ctx: ProtocolContext,
): HostEvent[];
export function initialState(options?: {
  sessionId?: string;
  cwd?: string;
  locale?: string;
  mode?: string;
  model?: string;
  models?: ModelOption[];
  modelsSource?: string;
  baseUrl?: string;
}): HostEvent;
export function sessionsEvent(summaries: readonly unknown[]): HostEvent;
export function sessionLoadedEvent(
  events: readonly KernelSessionEvent[],
  options?: { cwd?: string; mode?: string },
): HostEvent;
export const LAST_SESSION_STORAGE_KEY: string;
