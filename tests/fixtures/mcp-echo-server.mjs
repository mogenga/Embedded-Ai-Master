import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

if (process.env.PID_FILE) {
  fs.writeFileSync(process.env.PID_FILE, String(process.pid), "utf8");
}

if (process.env.PID_LOG) {
  fs.appendFileSync(process.env.PID_LOG, `${process.pid}\n`, "utf8");
}

function textResult(text) {
  return { content: [{ type: "text", text }] };
}

async function main() {
  const server = new McpServer(
    { name: "mcp-echo", version: "1.0.0" },
    { capabilities: { tools: { listChanged: true } } },
  );
  let grownCount = 0;

  server.registerTool(
    "echo",
    {
      description: "Echo the provided text",
      inputSchema: z.object({ text: z.string() }),
      annotations: { readOnlyHint: true },
      _meta: { evidence: true },
    },
    async ({ text }) => textResult(text),
  );

  server.registerTool(
    "dup.a",
    { description: "Sanitizes to dup_a" },
    async () => textResult("dup-dot"),
  );

  server.registerTool(
    "dup_a",
    { description: "Collides with dup.a after sanitize" },
    async () => textResult("dup-underscore"),
  );

  server.registerTool(
    "multi",
    {
      description: "Return two text blocks",
      inputSchema: z.object({ a: z.string(), b: z.string() }),
    },
    async ({ a, b }) => ({
      content: [
        { type: "text", text: a },
        { type: "text", text: b },
      ],
    }),
  );

  server.registerTool(
    "fail",
    { description: "Always reports a tool error" },
    async () => ({
      content: [{ type: "text", text: "boom" }],
      isError: true,
    }),
  );

  server.registerTool(
    "slow",
    {
      description: "Sleep then report timing",
      inputSchema: z.object({ ms: z.number(), tag: z.string() }),
    },
    async ({ ms, tag }) => {
      const start = Date.now();
      await delay(ms);
      const end = Date.now();
      return textResult(JSON.stringify({ tag, ms, start, end }));
    },
  );

  server.registerTool(
    "grow",
    { description: "Register a new tool and notify list_changed" },
    async () => {
      grownCount += 1;
      server.registerTool(
        `grown-${grownCount}`,
        { description: `Dynamically grown ${grownCount}` },
        async () => textResult(`grown-${grownCount}`),
      );

      return textResult(`grown-${grownCount}`);
    },
  );

  server.registerTool(
    "binary",
    { description: "Return a non-text content block" },
    async () => ({
      content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
    }),
  );

  server.registerTool(
    "structured",
    { description: "Return structured content only" },
    async () => ({
      content: [],
      structuredContent: { answer: 42 },
    }),
  );

  server.registerTool(
    "env",
    { description: "Return selected environment variables" },
    async () =>
      textResult(
        JSON.stringify({
          parentOnly: process.env.MCP_MANAGER_TEST_PARENT_ONLY ?? null,
          marker: process.env.MCP_MANAGER_TEST_MARKER ?? null,
          configOnly: process.env.MCP_MANAGER_TEST_CONFIG_ONLY ?? null,
        }),
      ),
  );

  server.registerTool(
    "pwd",
    { description: "Return the server working directory" },
    async () => textResult(process.cwd()),
  );

  server.registerTool(
    "grow-broken",
    {
      description: "Register a tool, then fail the next tools/list",
      inputSchema: z.object({ ms: z.number().optional() }),
    },
    async ({ ms = 0 }) => {
      grownCount += 1;
      server.registerTool(
        `grown-${grownCount}`,
        { description: `Dynamically grown ${grownCount}` },
        async () => textResult(`grown-${grownCount}`),
      );
      server.server.setRequestHandler("tools/list", async () => {
        if (ms > 0) {
          await delay(ms);
        }
        throw new Error("tools/list refresh failed");
      });
      return textResult(`grown-${grownCount}`);
    },
  );

  server.registerTool(
    "bad-schema",
    { description: "Expose a tool whose inputSchema root is not object" },
    async () => {
      server.server.setRequestHandler("tools/list", async () => ({
        tools: [
          {
            name: "echo",
            description: "Echo the provided text",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
          {
            name: "invalid",
            description: "Invalid inputSchema root",
            inputSchema: { type: "string" },
          },
        ],
      }));
      server.sendToolListChanged();
      return textResult("bad-schema-set");
    },
  );

  server.registerTool(
    "vanish",
    { description: "Exit without replying" },
    async () => {
      setTimeout(() => process.exit(1), 10);
      return new Promise(() => {});
    },
  );

  server.registerTool(
    "crash",
    {
      description: "Exit the server process shortly after replying",
      annotations: { destructiveHint: true },
    },
    async () => {
      setTimeout(() => process.exit(1), 100);
      return textResult("bye");
    },
  );

  await server.connect(new StdioServerTransport());
}

if (process.env.SILENT === "1") {
  setInterval(() => {}, 1_000);
} else {
  const startDelayMs = Number(process.env.START_DELAY_MS ?? 0);
  if (startDelayMs > 0) {
    await delay(startDelayMs);
  }
  await main();
}
