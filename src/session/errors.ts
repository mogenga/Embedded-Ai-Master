export type SessionCorruptionCode =
  | "invalid_header"
  | "invalid_event_line"
  | "invalid_seq"
  | "unknown_event_type";

export class SessionCorruptionError extends Error {
  readonly code: SessionCorruptionCode;
  readonly detail?: unknown;

  constructor(code: SessionCorruptionCode, message?: string, detail?: unknown) {
    super(message ?? code);
    this.name = "SessionCorruptionError";
    this.code = code;
    this.detail = detail;
  }
}

export type SessionForkCode = "not_turn_boundary" | "target_not_empty" | "invalid_target";

export class SessionForkError extends Error {
  readonly code: SessionForkCode;
  readonly detail?: unknown;

  constructor(code: SessionForkCode, message?: string, detail?: unknown) {
    super(message ?? code);
    this.name = "SessionForkError";
    this.code = code;
    this.detail = detail;
  }
}

export type SessionResumeCode =
  | "model_mismatch"
  | "system_prompt_mismatch"
  | "session_id_mismatch"
  | "missing_session_dir";

export class SessionResumeError extends Error {
  readonly code: SessionResumeCode;
  readonly detail?: unknown;

  constructor(code: SessionResumeCode, message?: string, detail?: unknown) {
    super(message ?? code);
    this.name = "SessionResumeError";
    this.code = code;
    this.detail = detail;
  }
}
