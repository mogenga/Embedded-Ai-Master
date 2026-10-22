/**
 * GBK transcoding without an external dependency.
 *
 * Measured: uVision answers a group named `中文组` with the bytes `d6d0 ce c4
 * d7 e9` — GBK, the system code page — regardless of whether the project file
 * stored it as UTF-8. The socket layer therefore has to encode and decode GBK,
 * not latin1 (which mapped each UTF-16 unit to its low byte) and not UTF-8
 * (which produced replacement characters for those bytes).
 *
 * Node ships a GBK *decoder* in `TextDecoder` but no encoder, so encoding is
 * done by searching the decoder: every two-byte GBK sequence is a code point,
 * and the reverse map is one scan at module load. One-byte ASCII passes
 * through unchanged, which is the common case and stays on the fast path.
 */

const decoder = new TextDecoder("gbk", { fatal: false });

/** Decode GBK bytes to text. */
export function decodeGbk(bytes: Uint8Array): string {
  // Pure ASCII is the overwhelming majority and needs no decoder.
  let ascii = true;
  for (const byte of bytes) {
    if (byte >= 0x80) {
      ascii = false;
      break;
    }
  }
  if (ascii) return Buffer.from(bytes).toString("latin1");
  return decoder.decode(bytes);
}

let encodeTable: Map<string, number> | undefined;

/**
 * Build `character -> two-byte GBK value`.
 *
 * The lead byte runs 0x81–0xFE and the trail byte 0x40–0xFE (0x7F excluded),
 * which is the GBK range. Scanning it once and keeping the mappings is faster
 * than any per-call search, and it costs about 24k entries.
 */
function buildEncodeTable(): Map<string, number> {
  const table = new Map<string, number>();
  const one = new Uint8Array(2);
  for (let lead = 0x81; lead <= 0xfe; lead++) {
    for (let trail = 0x40; trail <= 0xfe; trail++) {
      if (trail === 0x7f) continue;
      one[0] = lead;
      one[1] = trail;
      const text = decoder.decode(one);
      // A byte pair that is not a character decodes to U+FFFD; skip those.
      if (text.length === 1 && text !== "�") table.set(text, (lead << 8) | trail);
    }
  }
  return table;
}

/** Encode text as GBK. Characters with no GBK form become `?`. */
export function encodeGbk(text: string): Buffer {
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 0x80) {
      ascii = false;
      break;
    }
  }
  if (ascii) return Buffer.from(text, "latin1");
  encodeTable ??= buildEncodeTable();
  const out: number[] = [];
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (code < 0x80) {
      out.push(code);
      continue;
    }
    const pair = encodeTable.get(character);
    if (pair === undefined) {
      out.push(0x3f); // `?`
      continue;
    }
    out.push((pair >> 8) & 0xff, pair & 0xff);
  }
  return Buffer.from(out);
}

/** UTF-8 byte length of a string, for the length fields on the wire. */
export function gbkLength(text: string): number {
  return encodeGbk(text).length;
}
