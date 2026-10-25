import { z } from "zod";

// ---- embed_serial -----------------------------------------------------------
// 串口的动作面与 schema，从 cubeide/actions.ts 拆出（2026-10-25）：串口是
// 平台级能力，不属于任何厂商后端。


export const SERIAL_ACTIONS = ["read", "write", "ports", "status", "open", "close"] as const;
export type SerialAction = (typeof SERIAL_ACTIONS)[number];

export const SERIAL_EVIDENCE_ACTIONS: ReadonlySet<string> = new Set(["read", "ports", "status"]);
export const SERIAL_DESTRUCTIVE_ACTIONS: ReadonlySet<string> = new Set(["write", "open", "close"]);

export const serialInputSchema = z
  .object({
    action: z.enum(SERIAL_ACTIONS),
    // `read` without port → the panel's ring mirror; with port+baud → open
    // the port directly for durationMs and read the line tail.
    port: z.string().optional(),
    baud: z.number().int().min(300).max(4_000_000).optional(),
    max_lines: z.number().int().min(1).max(500).optional(),
    since: z.number().int().min(0).optional(),
    duration_ms: z.number().int().min(50).max(30_000).optional(),
    data: z.string().max(4096).optional(),
    /**
     * `write`: send `data` as hex bytes ("0D0A" → CRLF) instead of text.
     *
     * Without this a caller cannot express a non-printable byte at all: the
     * string goes out verbatim, so `"\r\n"` arrives as the four characters
     * backslash-r-backslash-n. The desktop bridge has always accepted a hex
     * flag — it was simply never exposed here, and an agent debugging a
     * CRLF-terminated protocol burned seventeen tool calls discovering that.
     */
    hex: z.boolean().optional(),
    // RX text codec for `open`: Keil and most Chinese MCU tutorials print GBK.
    encoding: z.enum(["utf-8", "gbk", "auto"]).optional(),
  })
  .strict()
  // With `hex:true` the payload must be even-length hex — both the host
  // channel and the fallback pump reject odd/non-hex payloads at runtime,
  // and a schema rejection beats a write that silently loses half a byte.
  .superRefine((value, ctx) => {
    if (value.hex !== true) return;
    const clean = (value.data ?? "").replace(/\s+/g, "");
    if (clean.length === 0) return;
    if (!/^[0-9a-fA-F]+$/.test(clean) || clean.length % 2 !== 0) {
      ctx.addIssue({
        code: "custom",
        message: 'hex payload must be even-length hex characters (each byte is two hex chars, e.g. "0D0A")',
      });
    }
  });

export const SERIAL_DESCRIPTION =
  "Serial monitor access for the agent — the same data the desktop panel shows. action `read` without `port` returns the panel's live ring buffer (the desktop host keeps writing it to <home>/.harness/serial/ring.json); action `read` with `port`+`baud`+`duration_ms` opens the COM port directly for that window and returns the lines captured (fails honestly if the panel already owns the port — COM ports are exclusive). action `write` sends data out through the panel's open port or a transient one; pass `hex:true` to send raw bytes (`data:\"0D0A\"` is CRLF), because text is written verbatim with no escape processing. action `ports` lists COM ports with friendly names. action `status` reports which port is open and who owns it.";
