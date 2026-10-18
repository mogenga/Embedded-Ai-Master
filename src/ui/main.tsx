import { render } from "preact";
import { SYMBOL_SPRITE } from "./icons.js";
import { applyTheme, onChangeMedia, readStoredTheme } from "./theme.js";
import "./styles.css";

const media = window.matchMedia("(prefers-color-scheme: light)");

applyTheme(readStoredTheme(), onChangeMedia(media));

media.addEventListener("change", (event) => {
  applyTheme(readStoredTheme(), onChangeMedia(event));
});

render(
  <>
    {SYMBOL_SPRITE}
    <div class="app" />
  </>,
  document.getElementById("root")!,
);