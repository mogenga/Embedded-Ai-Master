import { render } from "preact";
import { ApiError, fetchSessions } from "./api/client.js";
import type { DeviceStatus } from "./api/client.js";
import { createSessionEventStream } from "./api/event-stream.js";
import { loadSessionView, loadWorkbench } from "./api/load.js";
import { createSessionStreamController } from "./api/session-stream.js";
import { App } from "./app.js";
import { SYMBOL_SPRITE } from "./icons.js";
import {
  applyLoadFailure,
  applyLoadSuccess,
  applySessionEvent,
  applySessionFailure,
  applySessionLoaded,
  applyStreamError,
  RequestGate,
  retryTarget,
  startLoad,
  startSessionSwitch,
} from "./state.js";
import type { WorkbenchState } from "./state.js";
import { applyTheme, onChangeMedia, persistTheme, readStoredTheme } from "./theme.js";
import type { ThemeChoice } from "./theme.js";
import { UNKNOWN_DEVICE } from "./view/device.js";
import { postAction } from "./view/sse.js";
import type { HttpError } from "./view/sse.js";
import { emptyTranscriptView } from "./view/transcript.js";
import "./styles.css";

const root = document.getElementById("root")!;
const media = window.matchMedia("(prefers-color-scheme: light)");
const abort = new AbortController();
const fetchImpl: typeof fetch = (input, init) => fetch(input, { ...init, signal: abort.signal });

function readUrl(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

const eventsUrl = readUrl(import.meta.env.VITE_EVENT_STREAM_URL) ?? "/api/events";
const actionUrl = readUrl(import.meta.env.VITE_ACTION_URL) ?? "/api/actions";
const approvalUrl = readUrl(import.meta.env.VITE_APPROVAL_URL) ?? "/api/approvals";

let state: WorkbenchState = {
  connection: "loading",
  view: emptyTranscriptView(),
  sessions: [],
  kbTree: [],
  kbRoot: null,
  device: UNKNOWN_DEVICE,
  events: [],
  lastSeq: -1,
  mcpStatuses: [],
};

let themeChoice: ThemeChoice = readStoredTheme();
let dockOpen = true;
let deviceFallback: DeviceStatus | undefined;
const gate = new RequestGate();

function errorMessageOf(error: unknown): string {
  if (error instanceof ApiError && error.code === "invalid_response") return "接口返回内容无法解析";
  if (error instanceof ApiError) return `接口返回错误（${error.code}，HTTP ${error.status}）`;
  return "无法连接本地服务，请确认已运行 node dist/server/serve.js";
}

function isHttpError(error: unknown): error is HttpError {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "http_error";
}

function serverMessage(text: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const detail = (parsed as { error?: unknown }).error;
    if (typeof detail !== "object" || detail === null) return undefined;
    const message = (detail as { message?: unknown }).message;
    return typeof message === "string" && message.length > 0 ? message : undefined;
  } catch {
    return undefined;
  }
}

function actionErrorText(error: unknown): string {
  if (isHttpError(error)) {
    const detail = serverMessage(error.text);
    return detail === undefined ? `发送失败（HTTP ${error.status}）` : `发送失败（HTTP ${error.status}）：${detail}`;
  }
  if (error instanceof Error && error.message.length > 0) return `发送失败：${error.message}`;
  return "发送失败，请确认本地服务可用";
}

const controller = createSessionStreamController({
  loadSession: (id) =>
    loadSessionView(id, {
      fetchImpl,
      ...(deviceFallback === undefined ? {} : { deviceFallback }),
    }),
  openStream: (id, since, handlers) =>
    createSessionEventStream({ url: eventsUrl, sessionId: id, initialSince: since, handlers }),
  onEvent: (_id, event) => {
    state = applySessionEvent(state, event);
    renderApp();
  },
  onOpen: () => {
    state = { ...state, streamError: undefined };
    renderApp();
  },
  onError: (_id, message) => {
    state = applyStreamError(state, message);
    renderApp();
  },
  onLoadError: (id, error) => {
    state = applySessionFailure(state, id, errorMessageOf(error));
    renderApp();
  },
  onLoaded: (id, loaded) => {
    state = applySessionLoaded(state, id, loaded);
    renderApp();
  },
  maxGapReloads: 3,
});

function renderApp(): void {
  render(
    <>
      {SYMBOL_SPRITE}
      <App
        view={state.view}
        sessions={state.sessions}
        sessionErrors={state.sessionErrors}
        activeSessionId={state.activeSessionId}
        onSelectSession={(id) => {
          void selectSession(id);
        }}
        kbTree={state.kbTree}
        kbRoot={state.kbRoot}
        device={state.device}
        mcpStatuses={state.mcpStatuses}
        onSend={(text) => send(text)}
        onApprovalDecision={decideApproval}
        onNewSession={newSession}
        sendError={state.sendError}
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
  controller.close();
  state = startLoad(state);
  renderApp();
  try {
    const loaded = await loadWorkbench({ fetchImpl });
    if (!isCurrent() || abort.signal.aborted) return;
    deviceFallback = loaded.deviceFallback;
    state = applyLoadSuccess(state, loaded);
    renderApp();
    if (state.activeSessionId !== undefined) controller.start(state.activeSessionId, state.lastSeq);
  } catch (error) {
    if (!isCurrent() || abort.signal.aborted) return;
    state = applyLoadFailure(state, errorMessageOf(error));
    renderApp();
  }
}

async function send(text: string): Promise<void> {
  let created: { sessionId: string };
  try {
    created = await postAction<{ sessionId: string }>(actionUrl, {
      text,
      ...(state.activeSessionId === undefined ? {} : { sessionId: state.activeSessionId }),
    });
  } catch (error) {
    state = { ...state, sendError: actionErrorText(error) };
    renderApp();
    throw error;
  }
  state = { ...state, sendError: undefined };
  try {
    const listed = await fetchSessions({ fetchImpl });
    state = { ...state, sessions: listed.sessions, sessionErrors: listed.errors };
    renderApp();
  } catch {
    // 提交已成功；列表刷新失败不阻断新会话的加载
  }
  await selectSession(created.sessionId);
}

async function decideApproval(
  sessionId: string,
  requestId: string,
  decision: "allow" | "deny",
): Promise<void> {
  try {
    await postAction(approvalUrl, { sessionId, requestId, decision });
  } catch (error) {
    throw new Error(actionErrorText(error));
  }
}

function newSession(): void {
  controller.close();
  state = {
    ...state,
    activeSessionId: undefined,
    events: [],
    view: emptyTranscriptView(),
    lastSeq: -1,
    sendError: undefined,
  };
  renderApp();
}

async function selectSession(id: string): Promise<void> {  const isCurrent = gate.begin();
  state = startSessionSwitch(state);
  renderApp();
  controller.close();
  try {
    const loaded = await loadSessionView(id, {
      fetchImpl,
      ...(deviceFallback === undefined ? {} : { deviceFallback }),
    });
    if (!isCurrent() || abort.signal.aborted) return;
    state = applySessionLoaded(state, id, loaded);
    renderApp();
    controller.start(id, loaded.lastSeq);
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

window.addEventListener("beforeunload", () => {
  controller.close();
  abort.abort();
});

applyTheme(themeChoice, onChangeMedia(media));

media.addEventListener("change", (event) => {
  applyTheme(themeChoice, onChangeMedia(event));
});

renderApp();
void load();
