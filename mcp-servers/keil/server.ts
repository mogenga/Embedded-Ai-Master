/**
 * Keil / UVSOCK MCP server — porting skeleton.
 *
 * Source of truth for the domain logic is Prometheus's src/embedded:
 *   uvsock.ts        — UVSOCK binary protocol (32-byte header, 0x3000/0x4000/0x50xx, GBK)
 *   keilSession.ts   — debug session registry, flash-download verify, project editing
 *   keilExtra.ts     — evaluate/disassemble/ITM/capability report
 *   keilProjectFile.ts — .uvprojx/.uvoptx surgical editing
 *   keilCli.ts       — UV4.exe command-line flags
 *   gbk.ts           — GBK/GB18030 codec
 *
 * Porting notes (see docs/embedded-porting-plan.md):
 *  - Domain code lives here, never in src/ (guarded by probe's bootstrap test).
 *  - Tools follow the probe pattern: zod inputSchema, ProbeToolResult-shaped results,
 *    declarations on every destructive operation, evidence on read-back verifications.
 *  - keilTools.ts from Prometheus is an adapter to a different ToolResult contract —
 *    do NOT copy it; re-register each action as its own tool or a tool+action enum here.
 */

export const KEIL_SERVER_NAME = "embedded-ai-keil";

/** Tools to expose once the UVSOCK layer lands. Keep in sync with permissions.example.json. */
export const PLANNED_TOOLS = [
  {
    name: "keil_debug",
    description:
      "Keil uVision debug actions (56): session enter/exit, run control, breakpoints, " +
      "stack, registers, variables, memory, disassembly, flash download + read-back verify.",
    annotations: { readOnlyHint: false }, // per-action; see tool implementation
  },
  {
    name: "keil_project",
    description:
      "Keil project file actions (14): read/patch .uvprojx/.uvoptx fields " +
      "(Device/Vendor/PackID/Cpu/FlashDriverDll/OutputName/OutputDirectory/pMon).",
    annotations: { readOnlyHint: false },
  },
] as const;
