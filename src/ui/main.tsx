import { render } from "preact";
import type { LoopEvent } from "../loop/events.js";
import { ApiError, fetchDevice, fetchKb, fetchSession, fetchSessions } from "./api/client.js";
import type { DeviceStatus, KbNode, SessionSummary } from "./api/client.js";
import { App } from "./app.js";
import { SYMBOL_SPRITE } from "./icons.js";
import { applyTheme, onChangeMedia, persistTheme, readStoredTheme } from "./theme.js";
import type { ThemeChoice } from "./theme.js";
import { createEventStream, postAction } from "./view/sse.js";
import { emptyTranscriptView, transcriptFromLoop, transcriptFromSession } from "./view/transcript.js";
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

interface UiState {
  connection: "loading" | "ready" | "error";
  view: TranscriptView;
  sessions: SessionSummary[];
  activeSessionId?: string;
  kbTree: KbNode[];
  kbRoot: string | null;
  device: DeviceStatus;
  errorMessage?: string;
}

let state: UiState = {
  connection: "loading",
  view: emptyTranscriptView(),
  sessions: [],
  kbTree: [],
  kbRoot: null,
  device: UNKNOWN_DEVICE,
};

let themeChoice: ThemeChoice = readStoredTheme();
let dockOpen = true;
let requestSeq = 0;

function errorMessageOf(error: unknown): string {
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
        onSend={
          actionUrl === undefined
            ? undefined
            : (text) => {
                void postAction(actionUrl, { text }).catch(() => {
                  state = { ...state, connection: "error", errorMessage: "消息发送失败" };
                  renderApp();
                });
              }
        }
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
        onRetry={() => {
          void load();
        }}
      />
    </>,
    root,
  );
}

async function load(): Promise<void> {
  const seq = ++requestSeq;
  state = { ...state, connection: "loading", errorMessage: undefined };
  renderApp();
  try {
    const [sessions, kb, device] = await Promise.all([
      fetchSessions({ fetchImpl }),
      fetchKb({ fetchImpl }),
      fetchDevice({ fetchImpl }),
    ]);
    if (seq !== requestSeq || abort.signal.aborted) return;
    const first = sessions.sessions[0];
    let view = emptyTranscriptView();
    let activeSessionId: string | undefined;
    if (first !== undefined) {
      const detail = await fetchSession(first.id, { fetchImpl });
      if (seq !== requestSeq || abort.signal.aborted) return;
      view = { ...transcriptFromSession(detail.events), sessionId: first.id };
      activeSessionId = first.id;
    }
    state = {
      connection: "ready",
      view,
      sessions: sessions.sessions,
      activeSessionId,
      kbTree: kb.tree,
      kbRoot: kb.root,
      device,
    };
    renderApp();
  } catch (error) {
    if (seq !== requestSeq || abort.signal.aborted) return;
    state = { ...state, connection: "error", errorMessage: errorMessageOf(error) };
    renderApp();
  }
}

async function selectSession(id: string): Promise<void> {
  const seq = ++requestSeq;
  state = { ...state, activeSessionId: id, connection: "ready", errorMessage: undefined };
  renderApp();
  try {
    const detail = await fetchSession(id, { fetchImpl });
    if (seq !== requestSeq || abort.signal.aborted) return;
    state = { ...state, view: { ...transcriptFromSession(detail.events), sessionId: id } };
    renderApp();
  } catch (error) {
    if (seq !== requestSeq || abort.signal.aborted) return;
    state = { ...state, connection: "error", errorMessage: errorMessageOf(error) };
    renderApp();
  }
}

if (streamUrl !== undefined) {
  const streamed: LoopEvent[] = [];
  createEventStream(streamUrl, {
    onEvent: (event) => {
      streamed.push(event);
      const view = transcriptFromLoop(streamed);
      if (state.activeSessionId !== undefined) view.sessionId = state.activeSessionId;
      state = { ...state, view, connection: "ready", errorMessage: undefined };
      renderApp();
    },
    onError: () => {
      state = { ...state, connection: "error", errorMessage: "事件流已中断" };
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