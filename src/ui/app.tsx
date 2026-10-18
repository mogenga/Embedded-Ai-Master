import type { ComponentChildren, JSX } from "preact";
import { KnowledgePane } from "./components/rail/knowledge-pane.js";
import { SessionPane } from "./components/rail/session-pane.js";
import { StatusBar } from "./components/statusbar.js";
import { TopBar } from "./components/topbar.js";
import type { ThemeChoice } from "./theme.js";
import type { TranscriptView } from "./view/transcript.js";

export function App({
  view,
  themeChoice = "system",
  onThemeChange,
  dockOpen = true,
  onDockToggle,
  children,
}: {
  view: TranscriptView;
  themeChoice?: ThemeChoice;
  onThemeChange?: (c: ThemeChoice) => void;
  dockOpen?: boolean;
  onDockToggle?: () => void;
  children?: ComponentChildren;
}): JSX.Element {
  return (
    <div class="app">
      <TopBar
        themeChoice={themeChoice}
        onThemeChange={onThemeChange ?? (() => {})}
        dockOpen={dockOpen}
        onDockToggle={onDockToggle ?? (() => {})}
      />
      <div class={dockOpen ? "workspace" : "workspace is-collapsed"}>
        <aside class="rail" aria-label="知识库">
          <KnowledgePane />
          <SessionPane />
        </aside>
        <main class="conversation" aria-label="对话" data-status={view.status}>
          {children ?? <div class="placeholder">对话</div>}
        </main>
        <aside class="dock" id="dock" aria-label="调试坞">
          <div class="placeholder">调试坞</div>
        </aside>
      </div>
      <StatusBar />
    </div>
  );
}