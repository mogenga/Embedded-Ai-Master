import type { SessionEvent, SessionHeader } from "../../session/types.js";

export interface SessionSummary {
  id: string;
  createdAt: string;
  status: "open" | "closed";
  model?: string;
  workdir?: string;
}

export interface KbNode {
  name: string;
  path: string;
  kind: "dir" | "file";
  children?: KbNode[];
}

export interface DeviceStatus {
  probe: string;
  serial: string;
  cpu: string;
  backend: string;
}

export interface FetchDeps {
  fetchImpl?: typeof fetch;
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, deps?: FetchDeps): Promise<T> {
  const fetchImpl: typeof fetch = deps?.fetchImpl ?? ((input, init) => fetch(input, init));
  const response = await fetchImpl(path, { headers: { Accept: "application/json" } });
  const text = await response.text();
  let body: unknown;
  try {
    body = text.length === 0 ? undefined : JSON.parse(text);
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    const error = isRecord(body) && isRecord(body.error) ? body.error : undefined;
    const code = error !== undefined && typeof error.code === "string" ? error.code : "unknown_error";
    const message =
      error !== undefined && typeof error.message === "string" ? error.message : `请求失败（${response.status}）`;
    throw new ApiError(code, response.status, message);
  }
  if (body === undefined || body === null) {
    throw new ApiError("invalid_response", response.status, "接口返回内容无法解析");
  }
  return body as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function fetchSessions(
  deps?: FetchDeps,
): Promise<{ sessions: SessionSummary[]; errors: Array<{ dir: string; code: string }> }> {
  return request("/api/sessions", deps);
}

export function fetchSession(
  id: string,
  deps?: FetchDeps,
): Promise<{ header: SessionHeader; events: SessionEvent[] }> {
  return request(`/api/sessions/${encodeURIComponent(id)}`, deps);
}

export function fetchKb(deps?: FetchDeps): Promise<{ root: string | null; tree: KbNode[] }> {
  return request("/api/kb", deps);
}

export function fetchDevice(deps?: FetchDeps): Promise<DeviceStatus> {
  return request("/api/device", deps);
}
