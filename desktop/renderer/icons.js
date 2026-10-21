/**
 * The icon set.
 *
 * One sprite, one grid: every glyph is drawn on 24×24 with a 1.75 stroke, round
 * caps, and no fills except the two dots that have to be solid at small sizes.
 * Before this file the window carried three different icon languages — inline
 * SVG with hand-tuned stroke widths, text glyphs (◆ ▾ ▸ ↳ ✓ ×), and emoji-ish
 * symbols — which is why the toolbar never looked like one product.
 *
 * The sprite is injected once at module load. `<use href="#i-name">` then works
 * from both the static HTML and from templates built in JS, so there is exactly
 * one definition per glyph.
 */

const ICONS = {
  /* brand: one cycle of a digital signal on a tile.
   *
   * This was a monogram tile, and the letterform it carried was the previous
   * project's initial — the mark kept naming the tool this one replaced. A
   * square wave says what the product is (a probe reading a line that is
   * either high or low, never "sort of"), stays legible at 16 px, and cannot
   * be mistaken for a flame, which is what every other agent uses. */
  mark: '<rect x="1.5" y="1.5" width="21" height="21" rx="6.2" fill="currentColor" stroke="none"/><path d="M5.6 15.2H10V8.8h4v6.4h4.4" fill="none" stroke="var(--on-accent)" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>',

  /* actions */
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  x: '<path d="M7 7l10 10M17 7 7 17"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/>',
  refresh: '<path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1"/><path d="M20.5 4.5V10h-5.5"/>',
  more: '<circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  trash: '<path d="M4.5 7h15M9.5 7V5.2a1.2 1.2 0 0 1 1.2-1.2h2.6a1.2 1.2 0 0 1 1.2 1.2V7"/><path d="m7 7 1 12.1a1.4 1.4 0 0 0 1.4 1.3h5.2a1.4 1.4 0 0 0 1.4-1.3L17 7"/>',
  pin: '<path d="M9.2 3.8h5.6l-.9 5.4 3.4 3.3H6.7l3.4-3.3Z"/><path d="M12 12.5V20"/>',
  edit: '<path d="M4.5 19.5h4L19 9l-4-4L4.5 15.5Z"/><path d="m13.8 6.2 4 4"/>',
  copy: '<rect x="8.5" y="8.5" width="11" height="11" rx="2"/><path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-8a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4l-8.5 8.5"/><path d="M18 14.5V19a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 19V8a1.5 1.5 0 0 1 1.5-1.5H10"/>',
  download: '<path d="M12 4v11"/><path d="m8 11 4 4 4-4"/><path d="M5 19.5h14"/>',
  upload: '<path d="M12 20V9"/><path d="m8 13 4-4 4 4"/><path d="M5 4.5h14"/>',
  play: '<path d="M8 5.6v12.8L19 12Z"/>',
  pause: '<path d="M9.5 5.5v13"/><path d="M14.5 5.5v13"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="2"/>',
  filter: '<path d="M4 6h16l-6.2 7.2V20l-3.6-2v-4.8Z"/>',

  /* navigation */
  'chevron-up': '<path d="m6 14.5 6-6 6 6"/>',
  'chevron-down': '<path d="m6 9.5 6 6 6-6"/>',
  'chevron-left': '<path d="m14.5 6-6 6 6 6"/>',
  'chevron-right': '<path d="m9.5 6 6 6-6 6"/>',
  'arrow-up': '<path d="M12 19V5"/><path d="m6 11 6-6 6 6"/>',
  'arrow-down': '<path d="M12 5v14"/><path d="m6 13 6 6 6-6"/>',
  'arrow-right': '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
  'corner-down-right': '<path d="M6 5v6a3 3 0 0 0 3 3h9"/><path d="m14 10 4 4-4 4"/>',
  'panel-left': '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M9.5 4v16"/>',
  'panel-right': '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M14.5 4v16"/>',

  /* window controls */
  'win-minimize': '<path d="M6 12h12"/>',
  'win-maximize': '<rect x="6.5" y="6.5" width="11" height="11" rx="1.5"/>',
  'win-restore': '<path d="M8.5 8.5V6.5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-2"/><rect x="5.5" y="8.5" width="10" height="10" rx="1.5"/>',
  'win-close': '<path d="M7 7l10 10M17 7 7 17"/>',

  /* workspace */
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h3.6l2 2.5h7.4a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z"/>',
  file: '<path d="M6.5 3.5h7L18 8v12.5H6.5Z"/><path d="M13.5 3.5V8H18"/>',
  'file-code': '<path d="M6.5 3.5h7L18 8v12.5H6.5Z"/><path d="M13.5 3.5V8H18"/><path d="m10.5 12.5-2 2.5 2 2.5"/><path d="m13.5 12.5 2 2.5-2 2.5"/>',
  'file-diff': '<path d="M6.5 3.5h7L18 8v12.5H6.5Z"/><path d="M13.5 3.5V8H18"/><path d="M9.5 12.5h5M9.5 16.5h5M12 10.5v8"/>',
  branch: '<circle cx="6.5" cy="6" r="2.3"/><circle cx="6.5" cy="18" r="2.3"/><circle cx="17.5" cy="8" r="2.3"/><path d="M6.5 8.3v7.4"/><path d="M17.5 10.3c0 3.3-2.5 4.4-6 5.1"/>',
  terminal: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="m7 9.5 3 2.5-3 2.5"/><path d="M12.5 15H17"/>',
  code: '<path d="m9 7.5-5 4.5 5 4.5"/><path d="m15 7.5 5 4.5-5 4.5"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5a13.5 13.5 0 0 1 0 17 13.5 13.5 0 0 1 0-17"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  image: '<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.7"/><path d="m4 17.5 4.8-4.3 3.7 3.3 2.9-2.5L20 17.5"/>',
  paperclip: '<path d="M20 11.5 12.3 19.2a4.9 4.9 0 0 1-7-7l7.8-7.8a3.3 3.3 0 0 1 4.7 4.7l-7.8 7.8a1.7 1.7 0 0 1-2.4-2.4l7.1-7.1"/>',
  slash: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M13.5 8.5 10.5 15.5"/>',
  layers: '<path d="M12 3.5 3.5 8 12 12.5 20.5 8Z"/><path d="M3.5 12 12 16.5 20.5 12"/><path d="M3.5 16 12 20.5 20.5 16"/>',
  robot: '<rect x="4" y="7.5" width="16" height="11.5" rx="3"/><circle cx="9" cy="13" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="13" r="1.2" fill="currentColor" stroke="none"/><path d="M12 3.5v4"/><path d="M2.5 12.5v3M21.5 12.5v3"/>',
  'corner-up-right': '<path d="M6 19v-6a3 3 0 0 1 3-3h9"/><path d="m14 6 4 4-4 4"/>',
  'list-check': '<path d="M4 7h9M4 12h9M4 17h5"/><path d="m14.5 16.5 2 2 4-4.5"/>',
  sparkle: '<path d="M12 4.5c.6 3.4 2.1 4.9 5.5 5.5-3.4.6-4.9 2.1-5.5 5.5-.6-3.4-2.1-4.9-5.5-5.5 3.4-.6 4.9-2.1 5.5-5.5Z"/><path d="M18 15.5c.3 1.6 1 2.3 2.5 2.5-1.5.3-2.2 1-2.5 2.5-.3-1.5-1-2.2-2.5-2.5 1.5-.2 2.2-.9 2.5-2.5Z"/>',
  dot: '<circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none"/>',

  /* settings rail */
  user: '<circle cx="12" cy="8" r="3.4"/><path d="M5.5 20a6.5 6.5 0 0 1 13 0"/>',
  palette: '<path d="M12 3.5a8.5 8.5 0 0 0 0 17c1.2 0 1.9-.8 1.9-1.8 0-.5-.2-1-.6-1.4-.3-.4-.5-.8-.5-1.3 0-1 .8-1.8 1.8-1.8h1.5a4.4 4.4 0 0 0 4.4-4.4c0-3.4-3.9-6.3-8.5-6.3Z"/><circle cx="8" cy="10" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="7.5" r="1" fill="currentColor" stroke="none"/><circle cx="16" cy="10" r="1" fill="currentColor" stroke="none"/>',
  chart: '<path d="M4.5 20V10.5"/><path d="M10 20V4.5"/><path d="M15.5 20v-6"/><path d="M21 20V8"/>',
  plug: '<path d="M9 3.5v5M15 3.5v5"/><path d="M6.5 8.5h11V12a5.5 5.5 0 0 1-11 0Z"/><path d="M12 17.5V21"/>',
  star: '<path d="m12 3.5 2.7 5.6 6 .8-4.4 4.2 1.1 6L12 17.2l-5.4 2.9 1.1-6-4.4-4.2 6-.8Z"/>',
  book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5Z"/><path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H20"/>',
  shield: '<path d="M12 3.5 19 6v6c0 4-3 7-7 8.5C8 19 5 16 5 12V6Z"/>',
  monitor: '<rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M8 20.5h8"/><path d="M12 16.5v4"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5"/><path d="M12 7.8h.01"/>',
  sliders: '<path d="M4 7.5h9M18.5 7.5h1.5"/><path d="M4 16.5h3.5M13 16.5h7"/><circle cx="15.8" cy="7.5" r="2.3"/><circle cx="10.2" cy="16.5" r="2.3"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01"/><path d="M7 14h10"/>',
  'new-window': '<rect x="3.5" y="7" width="12" height="12" rx="2"/><path d="M8.5 7V5.5A1.5 1.5 0 0 1 10 4h8.5A1.5 1.5 0 0 1 20 5.5V14a1.5 1.5 0 0 1-1.5 1.5H17"/>',
  archive: '<rect x="3" y="4" width="18" height="4.5" rx="1.5"/><path d="M5 8.5v10A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5v-10"/><path d="M10 12.5h4"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0"/><path d="M12 17.5V21"/>',
  alert: '<path d="M12 3.5 21 20H3Z"/><path d="M12 10v4"/><path d="M12 17h.01"/>',
};

let mounted = false;

/** Inject the sprite once. Safe to call from any module. */
export function mountIcons() {
  if (mounted || typeof document === "undefined") return;
  mounted = true;
  const sprite = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  sprite.setAttribute("aria-hidden", "true");
  sprite.setAttribute("id", "icon-sprite");
  sprite.style.display = "none";
  sprite.innerHTML = Object.entries(ICONS)
    .map(([name, body]) => `<symbol id="i-${name}" viewBox="0 0 24 24">${body}</symbol>`)
    .join("");
  document.body.prepend(sprite);
}

/** Markup for one icon. `cls` is appended to the shared `icon` class. */
export function icon(name, cls = "") {
  return `<svg class="icon${cls ? ` ${cls}` : ""}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}

/** The same icon as a live element, for DOM code that sets properties. */
export function iconEl(name, cls = "") {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  el.setAttribute("class", `icon${cls ? ` ${cls}` : ""}`);
  el.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  el.append(use);
  return el;
}

/** Swap an existing icon element's glyph in place. */
export function setIcon(el, name) {
  if (!el) return;
  const use = el.querySelector("use");
  if (use) use.setAttribute("href", `#i-${name}`);
}

export function hasIcon(name) {
  return Object.hasOwn(ICONS, name);
}

mountIcons();
