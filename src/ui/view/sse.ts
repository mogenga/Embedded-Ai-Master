import type { LoopEvent } from "../../loop/events.js";

export interface StreamHandlers {
  onEvent(ev: LoopEvent): void;
  onOpen?(): void;
  onError?(err: unknown): void;
}

export interface EventStreamDeps {
  EventSourceCtor?: typeof EventSource;
  retryMs?: number;
  log?: (msg: string) => void;
}

export interface EventStream {
  close(): void;
}

export interface HttpError {
  code: "http_error";
  status: number;
  text: string;
}

const DEFAULT_RETRY_MS = 1000;

export function createEventStream(
  url: string,
  handlers: StreamHandlers,
  deps: EventStreamDeps = {},
): EventStream {
  const ctor = deps.EventSourceCtor ?? globalThis.EventSource;
  const retryMs = deps.retryMs ?? DEFAULT_RETRY_MS;
  const log = deps.log ?? ((msg: string): void => console.warn(msg));
  let closed = false;
  let source: EventSource | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function connect(): void {
    if (closed) return;
    if (ctor === undefined) {
      const err = new Error("EventSource unavailable");
      log("[sse] EventSource 不可用，事件流未建立");
      handlers.onError?.(err);
      return;
    }
    const es = new ctor(url);
    source = es;
    es.addEventListener("open", () => {
      handlers.onOpen?.();
    });
    es.addEventListener("message", (event) => {
      try {
        handlers.onEvent(JSON.parse(String((event as MessageEvent).data)) as LoopEvent);
      } catch (err) {
        handlers.onError?.(err);
      }
    });
    es.addEventListener("error", (err) => {
      handlers.onError?.(err);
      if (closed) return;
      source = undefined;
      es.close();
      timer = setTimeout(connect, retryMs);
    });
  }

  connect();

  return {
    close(): void {
      if (closed) return;
      closed = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      source?.close();
      source = undefined;
    },
  };
}

export async function postAction<T>(
  url: string,
  body: unknown,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<T> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    const err: HttpError = { code: "http_error", status: response.status, text };
    throw err;
  }
  return (await response.json()) as T;
}