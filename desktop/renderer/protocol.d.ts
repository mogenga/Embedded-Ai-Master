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
  /**
   * `thinking` is the model's reasoning, replayed as an already-finished
   * block (adjacent `thinking_delta` fragments merged). It is display only:
   * the renderer draws it de-emphasised and it never reaches the model.
   */
  role: "user" | "assistant" | "tool" | "thinking";
  text?: string;
  name?: string;
  summary?: string;
  ok?: boolean;
  done?: boolean;
  images?: number;
  index?: number;
  /** The kernel's own verdict on a tool result; absent means "not declared". */
  evidence?: boolean;
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
  /**
   * callId → tool name for every call still executing, in start order. The
   * newest entry is what `turn_progress` names.
   */
  runningTools: Map<string, string>;
  /**
   * Epoch ms of the `user` event that opened this turn, or 0 before one was
   * seen. `turn_progress.elapsedMs` is measured from it.
   */
  turnStartedAt: number;
  startedTools: Set<string>;
  pendingApprovals: Set<string>;
  streamedText: string;
  /**
   * Whether a reasoning block is open. The kernel emits only `thinking_delta`
   * (no start/end of its own), so this layer synthesises the renderer's
   * `thinking_start` / `thinking_end` around each run of fragments.
   */
  thinkingOpen: boolean;
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
  options?: {
    cwd?: string;
    mode?: string;
    /**
     * Replay only up to this event (BR-6). Must be an integer in
     * `0..lastSeq`; anything else throws rather than clamping, because a
     * clamped position makes "replay to event 3" indistinguishable from
     * "replay to the end".
     */
    atSeq?: number;
  },
): HostEvent;
