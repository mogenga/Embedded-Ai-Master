import type { SessionEventEnvelope } from "../../session/types.js";

export interface SessionEventStreamHandlers {
  onEvent(event: SessionEventEnvelope): void;
  onOpen?: () => void;
  onError?: () => void;
  onGap?: () => void;
  onEnd?: () => void;
}

export interface SessionEventStreamDeps {
  EventSourceCtor?: typeof EventSource;
  retryMs?: number;
}

export interface SessionEventStream {
  close(): void;
}

export interface SessionEventStreamOptions {
  url: string;
  sessionId: string;
  initialSince: number;
  handlers: SessionEventStreamHandlers;
  deps?: SessionEventStreamDeps;
}

const DEFAULT_RETRY_MS = 1_000;
const MAX_RETRIES = 3;
const ABSOLUTE_URL = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildUrl(base: string, sessionId: string, since: number): string {
  const absolute = ABSOLUTE_URL.test(base);
  const href =
    typeof globalThis.location === "object" && globalThis.location !== null
      ? globalThis.location.href
      : undefined;
  const resolved = new URL(base, href ?? "http://127.0.0.1/");
  resolved.searchParams.set("sessionId", sessionId);
  resolved.searchParams.set("since", String(since));
  if (absolute || href !== undefined) return resolved.toString();
  return `${resolved.pathname}${resolved.search}`;
}

function parseEnvelope(raw: unknown): SessionEventEnvelope | undefined {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (!isRecord(value)) return undefined;
  if (typeof value.sessionId !== "string") return undefined;
  if (typeof value.seq !== "number" || !Number.isSafeInteger(value.seq) || value.seq < 0) return undefined;
  if (typeof value.type !== "string" || !isRecord(value.payload)) return undefined;
  return value as unknown as SessionEventEnvelope;
}

export function createSessionEventStream(opts: SessionEventStreamOptions): SessionEventStream {
  const ctor = opts.deps?.EventSourceCtor ?? globalThis.EventSource;
  const retryMs =
    opts.deps?.retryMs !== undefined && Number.isFinite(opts.deps.retryMs) && opts.deps.retryMs >= 0
      ? opts.deps.retryMs
      : DEFAULT_RETRY_MS;
  const handlers = opts.handlers;
  let lastSeq = opts.initialSince;
  let retries = 0;
  let stopped = false;
  let source: EventSource | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function clearTimer(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearTimer();
    const current = source;
    source = undefined;
    current?.close();
  }

  function fail(): void {
    if (stopped) return;
    stop();
    handlers.onError?.();
  }

  function gap(): void {
    if (stopped) return;
    stop();
    handlers.onGap?.();
  }

  function end(): void {
    if (stopped) return;
    stop();
    handlers.onEnd?.();
  }

  function scheduleReconnect(): void {
    if (stopped) return;
    if (retries >= MAX_RETRIES) {
      fail();
      return;
    }
    retries += 1;
    clearTimer();
    timer = setTimeout(() => {
      timer = undefined;
      connect();
    }, retryMs);
  }

  function onFailure(current: EventSource): void {
    if (stopped) return;
    if (source !== current) return;
    source = undefined;
    current.close();
    scheduleReconnect();
  }

  function handleMessage(current: EventSource, data: unknown): void {
    if (stopped || source !== current) return;
    const event = parseEnvelope(data);
    if (event === undefined) {
      fail();
      return;
    }
    if (event.sessionId !== opts.sessionId) return;
    if (event.seq <= lastSeq) return;
    if (event.seq > lastSeq + 1) {
      gap();
      return;
    }
    try {
      handlers.onEvent(event);
    } catch {
      fail();
      return;
    }
    lastSeq = event.seq;
  }

  function connect(): void {
    if (stopped) return;
    if (ctor === undefined) {
      fail();
      return;
    }
    let current: EventSource;
    try {
      current = new ctor(buildUrl(opts.url, opts.sessionId, lastSeq));
    } catch {
      fail();
      return;
    }
    source = current;
    current.addEventListener("open", () => {
      if (stopped || source !== current) return;
      retries = 0;
      handlers.onOpen?.();
    });
    current.addEventListener("message", (event) => {
      handleMessage(current, (event as MessageEvent).data);
    });
    current.addEventListener("error", () => {
      onFailure(current);
    });
    current.addEventListener("stream_error", () => {
      onFailure(current);
    });
    current.addEventListener("stream_end", () => {
      if (stopped || source !== current) return;
      end();
    });
  }

  connect();

  return {
    close(): void {
      stop();
    },
  };
}