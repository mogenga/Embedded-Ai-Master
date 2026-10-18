import { render } from "preact";
import { App } from "./app.js";
import { UART_TRANSCRIPT_EVENTS } from "./demo/fixtures.js";
import { SYMBOL_SPRITE } from "./icons.js";
import { applyTheme, onChangeMedia, persistTheme, readStoredTheme } from "./theme.js";
import type { ThemeChoice } from "./theme.js";
import { transcriptFromSession } from "./view/transcript.js";
import "./styles.css";

const root = document.getElementById("root")!;
const media = window.matchMedia("(prefers-color-scheme: light)");
const view = transcriptFromSession(UART_TRANSCRIPT_EVENTS);

let themeChoice: ThemeChoice = readStoredTheme();
let dockOpen = true;

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
      />
    </>,
    root,
  );
}

applyTheme(themeChoice, onChangeMedia(media));

media.addEventListener("change", (event) => {
  applyTheme(themeChoice, onChangeMedia(event));
});

renderApp();