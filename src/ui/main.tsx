import { render } from "preact";
import type { LoopEvent } from "../loop/events.js";
import { ApiError } from "./api/client.js";
import type { DeviceStatus } from "./api/client.js";
import { loadSessionView, loadWorkbench } from "./api/load.js";
import { App } from "./app.js";
import { SYMBOL_SPRITE } from "./icons.js";
import {
  applyLoadFailure,
  applyLoadSuccess,
  applySessionFailure,
  applySessionLoaded,
  applyStreamError,
  applyStreamEvent,
  RequestGate,
  retryTarget,
  startLoad,
  startSessionSwitch,
} from "./state.js";
import type { WorkbenchState } from "./state.js";
import { applyTheme, onChangeMedia, persistTheme, readStoredTheme } from "./theme.js";
import type { ThemeChoice } from "./theme.js";
import { createEventStream, postAction } from "./view/sse.js";
import { emptyTranscriptView, transcriptFromLoop } from "./view/transcript.js";
import type { TranscriptView } from "./view/transcript.js";
import "./styles.css";

const root = document.getElementById("root")!;
const media = window.matchMedia("(prefers-color-scheme: light)");
const abort = new AbortController();
const fetchImpl: typeof fetch = (input, init) => fetch(input, { ...init, signal: abort.signal });

function readUrl(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

const streamUrl = readUrl(import.meta.env.VITE_EVENT_STREAM_URL);
const actionUrl = readUrl(import.meta.env.VITE_ACTION_URL);

const UNKNOWN_DEVICE: DeviceStatus = {
  probe: "unknown",
  serial: "unknown",
  cpu: "unknown",
  backend: "unknown",
};

let state: WorkbenchState = {
  connection: "loading",
  view: emptyTranscriptView(),
  sessions: [],
  kbTree: [],
  kbRoot: null,
  device: UNKNOWN_DEVICE,
};

let themeChoice: ThemeChoice = readStoredTheme();
let dockOpen = true;
let liveView: TranscriptView | undefined;
const gate = new RequestGate();

function errorMessageOf(error: unknown): string {
  if (error instanceof ApiError && error.code === "invalid_response") return "接口返回内容无法解析";
  if (error instanceof ApiError) return `接口返回错误（${error.code}，HTTP ${error.status}）`;
  return "无法连接本地服务，请确认已运行 node dist/server/serve.js";
}

function renderApp(): void {
  render(
    <>
      {SYMBOL_SPRITE}
      <App
        view={state.view}
        sessions={state.sessions}
        activeSessionId={state.activeSessionId}
        onSelectSession={(id) => {
          void selectSession(id);
        }}
        kbTree={state.kbTree}
        kbRoot={state.kbRoot}
        device={state.device}
        onSend={actionUrl === undefined ? undefined : (text) => postAction(actionUrl, { text })}
        canSend={actionUrl !== undefined}
        themeChoice={themeChoice}
        onThemeChange={(choice) => {
          themeChoice = choice;
          persistTheme(choice);
          applyTheme(choice, onChangeMedia(media));
          renderApp();
        }}
        dockOpen={dockOpen}
        onDockToggle={() => {
          dockOpen = !dockOpen;
          renderApp();
        }}
        connection={state.connection}
        errorMessage={state.errorMessage}
        switching={state.switching === true}
        detailError={state.detailError}
        streamError={state.streamError}
        onRetry={() => {
          void retry();
        }}
      />
    </>,
    root,
  );
}

async function load(): Promise<void> {
  const isCurrent = gate.begin();
  state = startLoad(state);
  renderApp();
  try {
    const loaded = await loadWorkbench({ fetchImpl });
    if (!isCurrent() || abort.signal.aborted) return;
    state = applyLoadSuccess(state, loaded, liveView);
    renderApp();
  } catch (error) {
    if (!isCurrent() || abort.signal.aborted) return;
    state = applyLoadFailure(state, errorMessageOf(error));
    renderApp();
  }
}

async function selectSession(id: string): Promise<void> {
  const isCurrent = gate.begin();
  state = startSessionSwitch(state);
  renderApp();
  try {
    const view = await loadSessionView(id, { fetchImpl });
    if (!isCurrent() || abort.signal.aborted) return;
    state = applySessionLoaded(state, id, view);
    renderApp();
  } catch (error) {
    if (!isCurrent() || abort.signal.aborted) return;
    state = applySessionFailure(state, id, errorMessageOf(error));
    renderApp();
  }
}

async function retry(): Promise<void> {
  const target = retryTarget(state);
  if (target.kind === "session" && target.id !== undefined) {
    await selectSession(target.id);
    return;
  }
  await load();
}

if (streamUrl !== undefined) {
  const streamed: LoopEvent[] = [];
  createEventStream(streamUrl, {
    onOpen: () => {
      state = { ...state, streamError: undefined };
      renderApp();
    },
    onEvent: (event) => {
      streamed.push(event);
      liveView = transcriptFromLoop(streamed);
      state = applyStreamEvent(state, liveView);
      renderApp();
    },
    onError: () => {
      state = applyStreamError(state, "实时事件流中断或未建立");
      renderApp();
    },
  });
}

window.addEventListener("beforeunload", () => {
  abort.abort();
});

applyTheme(themeChoice, onChangeMedia(media));

media.addEventListener("change", (event) => {
  applyTheme(themeChoice, onChangeMedia(event));
});

renderApp();
void load();
