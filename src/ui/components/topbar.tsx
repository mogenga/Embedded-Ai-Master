import type { JSX } from "preact";
import { Icon } from "../icons.js";
import type { ThemeChoice } from "../theme.js";

const THEME_OPTIONS: ReadonlyArray<{ value: ThemeChoice; icon: string; label: string }> = [
  { value: "light", icon: "i-sun", label: "日间主题" },
  { value: "system", icon: "i-monitor", label: "跟随系统主题" },
  { value: "dark", icon: "i-moon", label: "夜间主题" },
];

export function TopBar({
  themeChoice,
  onThemeChange,
  dockOpen,
  onDockToggle,
}: {
  themeChoice: ThemeChoice;
  onThemeChange: (c: ThemeChoice) => void;
  dockOpen: boolean;
  onDockToggle: () => void;
}): JSX.Element {
  return (
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark">
          <Icon name="i-logo" size={16} />
        </span>
        <span class="brand-text">
          <span class="brand-name">Embedded-Ai-Master</span>
          <span class="brand-sub">症状驱动固件调试</span>
        </span>
      </div>
      <div class="targets">
        <button type="button" class="chip">
          <Icon name="i-chip" size={14} />
          <strong>STM32F407ZGT6</strong>
          <Icon name="i-chevron-down" size={14} />
        </button>
        <button type="button" class="chip">
          <Icon name="i-branch" size={14} />
          <span>fix/uart-baud</span>
          <Icon name="i-chevron-down" size={14} />
        </button>
        <button type="button" class="chip chip--state">
          <Icon name="i-terminal" size={14} />
          <span>OpenOCD · 真机</span>
          <Icon name="i-chevron-down" size={14} />
        </button>
      </div>
      <div class="topbar-right">
        <div class="seg" role="group" aria-label="主题">
          {THEME_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              data-theme-opt={option.value}
              aria-pressed={themeChoice === option.value}
              title={option.label}
              aria-label={option.label}
              onClick={() => onThemeChange(option.value)}
            >
              <Icon name={option.icon} size={15} />
            </button>
          ))}
        </div>
        <button
          type="button"
          class="icon-btn"
          aria-pressed={dockOpen}
          aria-controls="dock"
          title="调试坞"
          aria-label="切换调试坞"
          onClick={onDockToggle}
        >
          <Icon name="i-sidebar" size={16} />
        </button>
      </div>
    </header>
  );
}