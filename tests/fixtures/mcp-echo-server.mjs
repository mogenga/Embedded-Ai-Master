import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

if (process.env.PID_FILE) {
  fs.writeFileSync(process.env.PID_FILE, String(process.pid), "utf8");
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
    },
    async ({ text }) => textResult(text),
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
    "grow-broken",
    { description: "Register a tool, then fail the next tools/list" },
    async () => {
      grownCount += 1;
      server.registerTool(
        `grown-${grownCount}`,
        { description: `Dynamically grown ${grownCount}` },
        async () => textResult(`grown-${grownCount}`),
      );
      server.server.setRequestHandler("tools/list", async () => {
        throw new Error("tools/list refresh failed");
      });
      return textResult(`grown-${grownCount}`);
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
      setTimeout(() => process.exit(1), 20);
      return textResult("bye");
    },
  );

  await server.connect(new StdioServerTransport());
}

if (process.env.SILENT === "1") {
  setInterval(() => {}, 1_000);
} else {
  await main();
}