import type { ComponentChildren, JSX } from "preact";
import { Composer } from "./components/conversation/composer.js";
import { ConversationHeader } from "./components/conversation/header.js";
import { PathLine } from "./components/conversation/pathline.js";
import { ConversationStream } from "./components/conversation/stream.js";
import { DEMO_LOG_LINES, DEMO_REGISTERS, Dock } from "./components/dock/dock.js";
import { KnowledgePane } from "./components/rail/knowledge-pane.js";
import { SessionPane } from "./components/rail/session-pane.js";
import { StatusBar } from "./components/statusbar.js";
import { TopBar } from "./components/topbar.js";
import type { ThemeChoice } from "./theme.js";
import type { TranscriptView } from "./view/transcript.js";

const SESSION_TITLE = "STM32F407 UART 输出乱码";

export function App({
  view,
  themeChoice = "system",
  onThemeChange,
  dockOpen = true,
  onDockToggle,
  onSend,
  children,
}: {
  view: TranscriptView;
  themeChoice?: ThemeChoice;
  onThemeChange?: (c: ThemeChoice) => void;
  dockOpen?: boolean;
  onDockToggle?: () => void;
  onSend?: (text: string) => void;
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
          <ConversationHeader title={SESSION_TITLE} status={view.status} />
          <PathLine steps={view.steps} />
          <ConversationStream view={view} />
          {children}
          <Composer onSend={onSend ?? (() => {})} />
        </main>
        <aside class="dock" id="dock" aria-label="调试坞">
          <Dock logLines={DEMO_LOG_LINES} registers={DEMO_REGISTERS} />
        </aside>
      </div>
      <StatusBar />
    </div>
  );
}