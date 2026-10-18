import type { JSX } from "preact";
import type { DeviceStatus, KbNode, SessionSummary } from "./api/client.js";
import { Composer } from "./components/conversation/composer.js";
import { ConversationHeader } from "./components/conversation/header.js";
import { PathLine } from "./components/conversation/pathline.js";
import { ConversationStream } from "./components/conversation/stream.js";
import { Dock } from "./components/dock/dock.js";
import { KnowledgePane } from "./components/rail/knowledge-pane.js";
import { SessionPane } from "./components/rail/session-pane.js";
import { StatusBar } from "./components/statusbar.js";
import { TopBar } from "./components/topbar.js";
import type { ThemeChoice } from "./theme.js";
import type { GuardModel, TranscriptView } from "./view/transcript.js";

export interface AppProps {
  view: TranscriptView;
  sessions: SessionSummary[];
  activeSessionId?: string;
  onSelectSession?: (id: string) => void;
  kbTree: KbNode[];
  kbRoot?: string | null;
  device: DeviceStatus;
  onSend?: (text: string) => void;
  canSend?: boolean;
  themeChoice?: ThemeChoice;
  onThemeChange?: (c: ThemeChoice) => void;
  dockOpen?: boolean;
  onDockToggle?: () => void;
  connection?: "loading" | "ready" | "error";
  errorMessage?: string;
  onRetry?: () => void;
  switching?: boolean;
  detailError?: string;
  streamError?: string;
  onGuardConfirm?: (guard: GuardModel) => void;
  onGuardReject?: (guard: GuardModel) => void;
}

function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value < 1000) return String(value);
  const k = value / 1000;
  return `${k >= 100 ? Math.round(k) : k.toFixed(1)}k`;
}

function formatContext(context: TranscriptView["context"]): string | undefined {
  return context === undefined ? undefined : `${formatTokens(context.used)} / ${formatTokens(context.limit)}`;
}

function formatCost(value: number | undefined): string | undefined {
  return value === undefined || !Number.isFinite(value) ? undefined : `$${value.toFixed(3)}`;
}

function known(value: string): string | undefined {
  return value === "unknown" || value === "" ? undefined : value;
}

function logGuard(action: "确认" | "拒绝"): (guard: GuardModel) => void {
  return (guard) => {
    console.info(`[ui] guard ${action}：${guard.action} ${guard.address} = ${guard.value}`);
  };
}

export function App({
  view,
  sessions,
  activeSessionId,
  onSelectSession,
  kbTree,
  kbRoot = null,
  device,
  onSend,
  canSend = true,
  themeChoice = "system",
  onThemeChange,
  dockOpen = true,
  onDockToggle,
  connection = "ready",
  errorMessage,
  onRetry,
  switching = false,
  detailError,
  streamError,
  onGuardConfirm,
  onGuardReject,
}: AppProps): JSX.Element {
  const title = activeSessionId ?? "未选择会话";
  const busy = connection === "loading";
  const failed = connection === "error" || detailError !== undefined;
  const failureText = connection === "error" ? errorMessage ?? "加载失败" : detailError ?? "加载失败";

  return (
    <div class="app">
      <TopBar
        themeChoice={themeChoice}
        onThemeChange={onThemeChange ?? (() => {})}
        dockOpen={dockOpen}
        onDockToggle={onDockToggle ?? (() => {})}
        device={device}
      />
      <div class={dockOpen ? "workspace" : "workspace is-collapsed"}>
        <aside class="rail" aria-label="知识库">
          <KnowledgePane nodes={kbTree} root={kbRoot} state={connection} />
          <SessionPane
            sessions={sessions}
            activeId={activeSessionId}
            onSelect={onSelectSession}
            state={connection}
          />
        </aside>
        <main class="conversation" aria-label="对话" data-status={view.status}>
          <ConversationHeader title={title} status={view.status} />
          <PathLine steps={view.steps} />
          {busy ? <p class="cnv-state">加载中…</p> : null}
          {failed ? (
            <div class="cnv-state cnv-state--error" role="alert">
              <p>{failureText}</p>
              <button type="button" class="btn" onClick={onRetry} disabled={onRetry === undefined}>
                <span>重试</span>
              </button>
            </div>
          ) : null}
          {switching && !failed ? <p class="cnv-state">会话加载中…</p> : null}
          {streamError === undefined ? null : (
            <p class="cnv-state cnv-state--warn" role="status">
              {streamError}
            </p>
          )}
          {busy || failed ? null : (
            <ConversationStream
              view={view}
              onGuardConfirm={onGuardConfirm ?? logGuard("确认")}
              onGuardReject={onGuardReject ?? logGuard("拒绝")}
            />
          )}
          <Composer
            onSend={onSend}
            canSend={onSend !== undefined && canSend && connection === "ready" && !switching && !failed}
            disabledReason={
              connection !== "ready"
                ? "会话尚未就绪，暂不能发送"
                : switching
                  ? "会话切换中，暂不能发送"
                  : failed
                    ? "会话读取失败，暂不能发送"
                    : "未配置提交端点，输入不会发送"
            }
          />
        </main>
        <aside class="dock" id="dock" aria-label="调试坞">
          <Dock view={view} device={device} state={connection} />
        </aside>
      </div>
      <StatusBar
        probe={known(device.probe)}
        serial={known(device.serial)}
        sessionId={view.sessionId}
        context={formatContext(view.context)}
        cost={formatCost(view.cost ?? view.usage?.costUsd)}
      />
    </div>
  );
}
