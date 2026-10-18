import type { JSX } from "preact";

export function Icon({
  name,
  size = 16,
  className,
}: {
  name: string;
  size?: number;
  className?: string;
}): JSX.Element {
  return (
    <svg class={className ? `ico ${className}` : "ico"} width={size} height={size}>
      <use href={"#" + name} />
    </svg>
  );
}

export const SYMBOL_SPRITE = (
  <svg class="sprite" width="0" height="0" aria-hidden="true" focusable="false">
    <defs>
      <symbol
        id="i-logo"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.7"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M2 13h4l2.2-6 3.6 12 2.4-6H22" />
      </symbol>
      <symbol
        id="i-book"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H19v15.5H6.5A2.5 2.5 0 0 0 4 21z" />
        <path d="M4 18.5A2.5 2.5 0 0 1 6.5 16H19" />
      </symbol>
      <symbol
        id="i-search"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.7"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <circle cx="11" cy="11" r="6.5" />
        <path d="m16 16 4.5 4.5" />
      </symbol>
      <symbol
        id="i-chat"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.4A8 8 0 1 1 21 12z" />
      </symbol>
      <symbol
        id="i-plus"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
      >
        <path d="M12 5v14M5 12h14" />
      </symbol>
      <symbol
        id="i-chevron"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="m9 6 6 6-6 6" />
      </symbol>
      <symbol
        id="i-chevron-down"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="m6 9 6 6 6-6" />
      </symbol>
      <symbol
        id="i-chip"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <rect x="7" y="7" width="10" height="10" rx="1.5" />
        <path d="M10 3v2M14 3v2M10 19v2M14 19v2M3 10h2M3 14h2M19 10h2M19 14h2" />
      </symbol>
      <symbol
        id="i-branch"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <circle cx="6" cy="6" r="2" />
        <circle cx="6" cy="18" r="2" />
        <circle cx="18" cy="8" r="2" />
        <path d="M6 8v8M18 10c0 4-4 3-6 6" />
      </symbol>
      <symbol
        id="i-terminal"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="m7 9 3 3-3 3M13 15h4" />
      </symbol>
      <symbol
        id="i-sun"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </symbol>
      <symbol
        id="i-moon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
      </symbol>
      <symbol
        id="i-monitor"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <rect x="3" y="4" width="18" height="12" rx="2" />
        <path d="M9 20h6M12 16v4" />
      </symbol>
      <symbol
        id="i-sidebar"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M14 4v16" />
      </symbol>
      <symbol
        id="i-send"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M12 19V5M6 11l6-6 6 6" />
      </symbol>
      <symbol
        id="i-refresh"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M20 11a8 8 0 1 0-2.3 5.7" />
        <path d="M20 5v6h-6" />
      </symbol>
      <symbol
        id="i-copy"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <rect x="9" y="9" width="11" height="11" rx="2" />
        <path d="M5 15V6a1 1 0 0 1 1-1h9" />
      </symbol>
      <symbol
        id="i-play"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M8 5.5v13l10-6.5z" />
      </symbol>
      <symbol
        id="i-pause"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.7"
        stroke-linecap="round"
      >
        <path d="M9 5v14M15 5v14" />
      </symbol>
      <symbol
        id="i-power"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M12 3v9" />
        <path d="M6.5 7a8 8 0 1 0 11 0" />
      </symbol>
      <symbol
        id="i-cpu"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <rect x="8" y="8" width="8" height="8" rx="1" />
        <rect x="4" y="4" width="16" height="16" rx="2" />
        <path d="M10 2v2M14 2v2M10 20v2M14 20v2M2 10h2M2 14h2M20 10h2M20 14h2" />
      </symbol>
      <symbol
        id="i-plug"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M9 2v6M15 2v6" />
        <path d="M6 8h12v3a6 6 0 0 1-6 6 6 6 0 0 1-6-6z" />
        <path d="M12 17v5" />
      </symbol>
      <symbol
        id="i-log"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M5 4h14M5 9h14M5 14h9M5 19h6" />
      </symbol>
      <symbol
        id="i-shield"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M12 3l7 3v6c0 4.4-3 7.7-7 9-4-1.3-7-4.6-7-9V6z" />
      </symbol>
      <symbol
        id="i-check"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="m5 12.5 4.5 4.5L19 7" />
      </symbol>
      <symbol
        id="i-alert"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.7"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M12 8v5M12 16.5v.5" />
        <circle cx="12" cy="12" r="9" />
      </symbol>
      <symbol
        id="i-x"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
      >
        <path d="M6 6l12 12M18 6 6 18" />
      </symbol>
      <symbol
        id="i-hand"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M8 12V5.5a1.5 1.5 0 0 1 3 0V11m0-1.5a1.5 1.5 0 0 1 3 0V11m0-.5a1.5 1.5 0 0 1 3 0V15a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5v-3l-1-.8a1.5 1.5 0 0 1 1.8-2.3L8 11" />
      </symbol>
      <symbol
        id="i-user"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <circle cx="12" cy="8.5" r="3.5" />
        <path d="M5 20a7 7 0 0 1 14 0" />
      </symbol>
      <symbol
        id="i-spark"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6.5 6.5l2.5 2.5M15 15l2.5 2.5M17.5 6.5 15 9M9 15l-2.5 2.5" />
      </symbol>
    </defs>
  </svg>
);
