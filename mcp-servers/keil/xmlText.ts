/**
 * Decoding the entities a Keil project file uses.
 *
 * uVision writes XML, so a path or group name containing `&`, `<` or `>` is
 * stored escaped (`Work &amp; Play`). Every parser in this module reads the
 * raw text with a regex, and without decoding, a directory that exists is
 * reported as missing and a group that exists lists no files. The failure is
 * silent in both directions, which is why it belongs in one place.
 *
 * `&amp;` is decoded last: decoding it first would turn `&amp;lt;` — a literal
 * `&lt;` in a name — into `<` instead of `&lt;`.
 */
export function decodeXmlText(text: string): string {
  if (!text.includes("&")) return text;
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/g, "&");
}

/** Encode text for a `<tag>value</tag>` the way uVision writes it. */
export function encodeXmlText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
