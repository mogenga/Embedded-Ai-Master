export type PermissionConfigErrorCode =
  | "invalid_json"
  | "invalid_schema"
  | "unsupported_version"
  | "read_failed";

export class PermissionConfigError extends Error {
  readonly code: PermissionConfigErrorCode;
  readonly detail?: unknown;

  constructor(code: PermissionConfigErrorCode, message: string, detail?: unknown) {
    super(message);
    this.name = "PermissionConfigError";
    this.code = code;
    this.detail = detail;
  }
}