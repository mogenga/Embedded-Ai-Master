import type { SessionEventEnvelope } from "../../session/types.js";
import type { SessionEventStream, SessionEventStreamHandlers } from "./event-stream.js";
import type { LoadedSession } from "./load.js";

export interface SessionStreamControllerOptions {
  loadSession(id: string): Promise<LoadedSession>;
  openStream(
    id: string,
    since: number,
    handlers: SessionEventStreamHandlers,
  ): SessionEventStream;
  onEvent(id: string, event: SessionEventEnvelope): void;
  onOpen?(id: string): void;
  onError(id: string, message: string): void;
  onLoadError?(id: string, error: unknown): void;
  onLoaded(id: string, loaded: LoadedSession): void;
  maxGapReloads?: number;
  streamErrorText?: string;
  gapErrorText?: string;
}

export interface SessionStreamController {
  start(id: string, since: number): void;
  close(): void;
}

const DEFAULT_MAX_GAP_RELOADS = 3;
const DEFAULT_STREAM_ERROR = "实时事件流已断开，请重试";
const DEFAULT_GAP_ERROR = "实时事件流缺口过多，请重试";

function normalizeMax(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return DEFAULT_MAX_GAP_RELOADS;
  return Math.floor(value);
}

export function createSessionStreamController(
  opts: SessionStreamControllerOptions,
): SessionStreamController {
  const maxGapReloads = normalizeMax(opts.maxGapReloads);
  const streamErrorText = opts.streamErrorText ?? DEFAULT_STREAM_ERROR;
  const gapErrorText = opts.gapErrorText ?? DEFAULT_GAP_ERROR;

  let activeId: string | undefined;
  let stream: SessionEventStream | undefined;
  let generation = 0;
  const reloads = new Map<string, Promise<void>>();
  const pendingReloads = new Set<string>();
  const gapReloads = new Map<string, number>();

  function closeCurrent(): void {
    const current = stream;
    stream = undefined;
    current?.close();
  }

  function isCurrent(id: string, expectedGeneration: number): boolean {
    return generation === expectedGeneration && activeId === id;
  }

  function open(id: string, since: number, expectedGeneration: number): void {
    if (!isCurrent(id, expectedGeneration)) return;
    closeCurrent();
    const handle = opts.openStream(id, since, {
      onEvent(event) {
        if (!isCurrent(id, expectedGeneration)) return;
        opts.onEvent(id, event);
      },
      onOpen() {
        if (!isCurrent(id, expectedGeneration)) return;
        opts.onOpen?.(id);
      },
      onError() {
        if (!isCurrent(id, expectedGeneration)) return;
        opts.onError(id, streamErrorText);
      },
      onGap() {
        if (!isCurrent(id, expectedGeneration)) return;
        void reload(id, expectedGeneration);
      },
      onEnd() {
        void 0;
      },
    });
    if (!isCurrent(id, expectedGeneration)) {
      handle.close();
      return;
    }
    stream = handle;
  }

  function reload(id: string, expectedGeneration: number): Promise<void> {
    if (!isCurrent(id, expectedGeneration)) return Promise.resolve();
    if (reloads.has(id)) {
      pendingReloads.add(id);
      return reloads.get(id)!;
    }
    const used = gapReloads.get(id) ?? 0;
    if (used >= maxGapReloads) {
      closeCurrent();
      opts.onError(id, gapErrorText);
      return Promise.resolve();
    }
    gapReloads.set(id, used + 1);
    closeCurrent();
    const task = (async () => {
      try {
        const loaded = await opts.loadSession(id);
        if (!isCurrent(id, expectedGeneration)) return;
        opts.onLoaded(id, loaded);
        if (!isCurrent(id, expectedGeneration)) return;
        open(id, loaded.lastSeq, expectedGeneration);
      } catch (error) {
        if (!isCurrent(id, expectedGeneration)) return;
        if (opts.onLoadError !== undefined) opts.onLoadError(id, error);
        else opts.onError(id, streamErrorText);
      }
    })().finally(() => {
      reloads.delete(id);
      if (pendingReloads.delete(id) && activeId === id) {
        void reload(id, generation);
      }
    });
    reloads.set(id, task);
    return task;
  }

  return {
    start(id: string, since: number): void {
      generation += 1;
      activeId = id;
      gapReloads.clear();
      pendingReloads.clear();
      open(id, since, generation);
    },
    close(): void {
      activeId = undefined;
      generation += 1;
      gapReloads.clear();
      pendingReloads.clear();
      closeCurrent();
    },
  };
}