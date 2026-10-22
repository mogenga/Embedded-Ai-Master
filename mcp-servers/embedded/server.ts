/**
 * Embedded toolchain MCP server — porting skeleton (Phase 1 scope).
 *
 * Source of truth for the domain logic is Prometheus's src/embedded + src/packs:
 *   identity.ts / identifyGate.ts / probe.ts  — chip identification (DBGMCU_IDCODE, 3-way probe)
 *   targets (in embeddedTools.ts logic)       — pyOCD 206-target table + pio/west/arduino/probe-rs sources
 *   svd.ts / cmsisPack.ts                     — SVD parsing, CMSIS-Pack discovery
 *   project.ts / build.ts / diagnostics.ts    — 11 project kinds, structured build diagnostics
 *   flash.ts / flashHistory.ts                — 9 flashers + verdict tables
 *   debug.ts / debugSession.ts                — GDB/MI + 4 GDB-server port tables
 *   serial.ts / serialStream.ts               — real serial ports (Windows PowerShell / POSIX stty)
 *   packs/ (catalog, install pipeline)        — transactional toolchain pack manager
 *
 * Phase 1 (this skeleton's target): identity + targets + registers(SVD) + ports.
 * Read-only tools only, evidence-annotated, feeding structuredContent.deviceStatus
 * so the desktop Board pane's device section lights up with zero host changes.
 *
 * Porting rules (docs/embedded-porting-plan.md):
 *  - domain code stays in mcp-servers/, never in src/ (bootstrap test guards this)
 *  - zod inputSchema; declarations on destructive ops; evidence on read-backs
 *  - Prometheus's embeddedTools.ts adapter layer is NOT copied (different ToolResult contract)
 */

import { z } from "zod";
import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import type { ToolAnnotations } from "./toolTypes.js";

export const EMBEDDED_SERVER_NAME = "embedded-ai-embedded";

/** Result shape mirrors probe: ok()/fail() with structuredContent, declarations on writes. */
export interface EmbeddedToolSpec {
  name: string;
  description: string;
  inputSchema?: z.ZodTypeAny;
  annotations?: ToolAnnotations;
  meta?: Record<string, unknown>;
  handler: (args: unknown, signal?: AbortSignal) => Promise<EmbeddedToolResult>;
}

export interface EmbeddedToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: unknown;
  isError?: boolean;
  /** Required for destructive operations — see probe's declaration pattern. */
  declaration?: { operation: string; effect: string; address?: number; length?: number };
}

/* ------------------------------------------------------------------ */
/* Phase 1 tool schemas (read-only)                                    */
/* ------------------------------------------------------------------ */

export const identifySchema = z.object({
  probe: z.enum(["pyocd", "openocd", "jlink"]).optional(),
  force: z.boolean().optional().default(false),
});

export const targetsSchema = z.object({
  filter: z.string().min(1).optional(),
  source: z.enum(["pyocd", "pio", "west", "arduino", "probe-rs"]).optional(),
});

export const registersSchema = z.object({
  mode: z.enum(["index", "peripheral", "register"]),
  query: z.string().min(1).optional(),
  svdPath: z.string().min(1).optional(),
});

export const portsSchema = z.object({});

/* ------------------------------------------------------------------ */
/* Later phases (schemas sketched now, handlers later)                 */
/* ------------------------------------------------------------------ */

/** Phase 3: build. Runs the project's own build system — ask-gated by default. */
export const buildSchema = z.object({
  projectDir: z.string().min(1),
  target: z.string().optional(),
  clean: z.boolean().optional().default(false),
});

/** Phase 3: flash — destructive, must return declaration {operation, effect}. */
export const flashSchema = z.object({
  projectDir: z.string().min(1),
  target: z.string().min(1),
  flasher: z.enum(["pyocd", "openocd", "probe-rs", "jlink", "esptool", "st-flash", "dfu-util", "avrdude", "keil"]),
  verify: z.boolean().optional().default(true),
});

/** Phase 4: serial — write is destructive; port whitelist goes in permissions rules. */
export const serialOpenSchema = z.object({
  port: z.string().min(1),
  baudRate: z.number().int().min(1200).max(12_000_000),
});
export const serialWriteSchema = z.object({
  data: z.string().min(1),
});

/** Tool surface phases — implement incrementally, keep permissions.example.json in sync. */
export const PHASED_TOOLS: Array<{ phase: 1 | 2 | 3 | 4; name: string; destructive: boolean }> = [
  { phase: 1, name: "embed_identify", destructive: false },
  { phase: 1, name: "embed_targets", destructive: false },
  { phase: 1, name: "embed_registers", destructive: false },
  { phase: 1, name: "embed_ports", destructive: false },
  { phase: 3, name: "embed_build", destructive: false }, // executes project scripts → ask-gated
  { phase: 3, name: "embed_flash", destructive: true },
  { phase: 3, name: "embed_packs", destructive: true },
  { phase: 4, name: "embed_serial", destructive: true }, // write subaction
];

export type { StandardSchemaWithJSON };
