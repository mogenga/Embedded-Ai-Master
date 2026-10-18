import { render } from "preact";
import type { LoopEvent } from "../loop/events.js";
import { App } from "./app.js";
import { UART_TRANSCRIPT_EVENTS } from "./demo/fixtures.js";
import { SYMBOL_SPRITE } from "./icons.js";
import { applyTheme, onChangeMedia, persistTheme, readStoredTheme } from "./theme.js";
import type { ThemeChoice } from "./theme.js";
import { createEventStream, postAction } from "./view/sse.js";
import { transcriptFromLoop, transcriptFromSession } from "./view/transcript.js";
import type { TranscriptView } from "./view/transcript.js";
import "./styles.css";

const root = document.getElementById("root")!;
const media = window.matchMedia("(prefers-color-scheme: light)");

function readUrl(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

const streamUrl = readUrl(import.meta.env.VITE_EVENT_STREAM_URL);
const actionUrl = readUrl(import.meta.env.VITE_ACTION_URL);

let themeChoice: ThemeChoice = readStoredTheme();
let dockOpen = true;
let view: TranscriptView =
  streamUrl === undefined ? transcriptFromSession(UART_TRANSCRIPT_EVENTS) : transcriptFromLoop([]);

function renderApp(): void {
  render(
    <>
      {SYMBOL_SPRITE}
      <App
        view={view}
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
        onSend={(text) => {
          if (actionUrl === undefined) {
            console.warn("[ui] 未配置 VITE_ACTION_URL，输入未发送：", text);
            return;
          }
          void postAction(actionUrl, { text }).catch((err: unknown) => {
            console.warn("[ui] 发送失败：", err);
          });
        }}
      />
    </>,
    root,
  );
}

if (streamUrl !== undefined) {
  const streamed: LoopEvent[] = [];
  createEventStream(streamUrl, {
    onEvent: (event) => {
      streamed.push(event);
      view = transcriptFromLoop(streamed);
      renderApp();
    },
    onError: (err) => {
      console.warn("[ui] 事件流错误：", err);
    },
  });
}

applyTheme(themeChoice, onChangeMedia(media));

media.addEventListener("change", (event) => {
  applyTheme(themeChoice, onChangeMedia(event));
});

renderApp();