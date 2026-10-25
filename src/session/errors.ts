export type SessionCorruptionCode =
  | "invalid_header"
  | "invalid_event_line"
  | "invalid_seq"
  | "unknown_event_type"
  /**
   * 会话文件根本不存在（ENOENT / ENOTDIR），不是「内容损坏」。
   *
   * 与 `invalid_header` 分开是一个语义修正：文件没了说明「这个会话不在了」，
   * 用户该去确认目录是否被删；文件在但内容读不懂才说明「header 坏了」。
   * 两者用同一个码会把前者说成后者，把人引向错误的排查方向（D-215）。
   */
  | "session_not_found";

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
  | "workdir_mismatch"
  | "missing_session_dir"
  | "session_locked"
  | "invalid_target";

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
