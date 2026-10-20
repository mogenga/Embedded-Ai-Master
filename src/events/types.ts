import type { SessionEvent, SessionEventEnvelope, SessionHeader } from "../session/types.js";

export type { SessionEventEnvelope };

export interface SessionGenerationState {
  file: string;
  offset: number;
}

export interface SessionSnapshot {
  header: SessionHeader;
  events: SessionEvent[];
  generations: SessionGenerationState[];
  pendingTail?: { bytes: Buffer; file: string; offset: number };
}

export interface SessionReadResult {
  header: SessionHeader;
  events: SessionEventEnvelope[];
  headSeq: number;
}

export interface SessionEventSource {
  read(sessionId: string, since: number): Promise<SessionReadResult>;
  follow(
    sessionId: string,
    since: number,
    signal: AbortSignal,
  ): AsyncIterable<SessionEventEnvelope>;
}

export class SessionNotFoundError extends Error {
  constructor(message = "Session not found") {
    super(message);
    this.name = "SessionNotFoundError";
  }
}
