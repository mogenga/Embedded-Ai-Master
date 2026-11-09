/**
 * Link policy for the desktop shell — pure functions, no Electron import.
 *
 * `main.js` loads `electron` and cannot be imported by `vitest`, so the
 * decisions it applies to a URL or a path live here and are tested directly.
 * Same split as `desktop/close-behavior.js`, same reason.
 *
 * **Why a policy at all**: `shell.openExternal` is not "open a browser". It
 * hands the string to the OS and whichever program is registered for that
 * scheme opens it. Electron's own security guide lists
 * `openExternal(untrusted)` as a path to arbitrary command execution, and the
 * strings this window passes in are not trusted: transcript links come from
 * model output, tool output and knowledge-base entries. So the rule is an
 * allow-list of two schemes, decided by the URL parser rather than by string
 * prefixes — `HTTPS://…`, `java\nscript:` and `file:///E:/…` (three spellings
 * of the same path on Windows) all defeat `startsWith`.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

/** The only schemes `shell.openExternal` may receive. */
export const EXTERNAL_PROTOCOLS = ["http:", "https:"];

/** How much of a refused URL is echoed back. Long enough to recognise, short
 * enough that one hostile link cannot fill the transcript. */
const MAX_ECHO = 160;

/** One line, bounded: notices are single-line text and URLs may contain both. */
function oneLine(value) {
  const text = typeof value === "string" ? value : String(value ?? "");
  const collapsed = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_ECHO ? `${collapsed.slice(0, MAX_ECHO)}…` : collapsed;
}

/**
 * May this string be handed to `shell.openExternal`?
 *
 * Accepts only `http:` / `https:`, and only when the URL parser produces a
 * host — `http://` parses far enough to have a protocol but names nothing, and
 * opening it would only produce an OS error box.
 *
 * `url` in the answer is the **parsed** href, and that is what must be passed
 * to the shell. Handing the raw string on after checking a normalised copy is
 * how a check and its use drift apart.
 *
 * @param {unknown} raw
 * @returns {{ ok: true, url: string, protocol: string } | { ok: false, reason: string, protocol?: string }}
 */
export function checkExternalUrl(raw) {
  if (typeof raw !== "string") {
    return { ok: false, reason: "链接不是字符串" };
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: "不是绝对 URL" };
  }
  if (!EXTERNAL_PROTOCOLS.includes(parsed.protocol)) {
    return {
      ok: false,
      protocol: parsed.protocol,
      reason: `协议 ${parsed.protocol} 不在白名单（只允许 http: / https:）`,
    };
  }
  if (parsed.hostname === "") {
    return { ok: false, protocol: parsed.protocol, reason: "链接没有主机名" };
  }
  return { ok: true, url: parsed.href, protocol: parsed.protocol };
}

/**
 * May the window navigate to this target?
 *
 * The window draws one local file (`index.html`); everything else is a page
 * this app did not write. Same file, by path semantics — never by string
 * prefix, which would call `…/index.html.evil` and `…/index.html/../x` the
 * same page. `path.relative` is case-insensitive on Windows, so `E:\…` and
 * `e:\…` are one file there and two here, which is what each platform means.
 *
 * `protocol` is the parsed scheme on every answer, so the caller can tell
 * "a page load we refused" from "a `javascript:` target", which needs no
 * notice (the CSP already stops it) and can be produced at will.
 *
 * @param {unknown} raw the `will-navigate` URL
 * @param {string} indexPath absolute path of the file the window loads
 * @returns {{ ok: true, protocol: string } | { ok: false, reason: string, protocol?: string }}
 */
export function checkNavigationTarget(raw, indexPath) {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, reason: "导航目标为空" };
  }
  if (typeof indexPath !== "string" || indexPath === "") {
    // Without the page's own path there is nothing to compare against; refusing
    // everything is the only safe answer, and it is loud in the test suite.
    return { ok: false, reason: "窗口页面路径未配置" };
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: "不是绝对 URL" };
  }
  if (parsed.protocol !== "file:") {
    return {
      ok: false,
      protocol: parsed.protocol,
      reason: `协议 ${parsed.protocol} 不是本应用的本地页面`,
    };
  }
  let targetPath;
  try {
    targetPath = fileURLToPath(parsed);
  } catch {
    return { ok: false, protocol: parsed.protocol, reason: "file: 链接不是可解析的本地路径" };
  }
  if (path.relative(path.resolve(indexPath), path.resolve(targetPath)) !== "") {
    return { ok: false, protocol: parsed.protocol, reason: "目标不是本窗口的页面" };
  }
  return { ok: true, protocol: parsed.protocol };
}

/** The line shown when an external link is refused. */
export function blockedExternalText(raw, reason) {
  return `链接未打开（${reason}）：${oneLine(raw)}`;
}

/** The line shown when a navigation is refused. */
export function blockedNavigationText(raw, reason) {
  return `已阻止窗口跳转（${reason}）：${oneLine(raw)}`;
}

