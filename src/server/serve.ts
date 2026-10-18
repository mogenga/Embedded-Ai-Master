import { resolveHarnessHome } from "../config/harness-home.js";
import { createUiServer } from "./api.js";

function resolvePort(): number {
  const raw = process.env.HARNESS_UI_PORT?.trim();
  if (raw === undefined || raw === "") return 5174;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return 5174;
  return parsed;
}

const host = "127.0.0.1";
const port = resolvePort();
const staticRoot = process.env.HARNESS_UI_STATIC?.trim() || "dist-web";

const ui = createUiServer({
  harnessHome: resolveHarnessHome(),
  staticRoot,
  port,
  host,
});

ui.server.on("error", (error: Error) => {
  console.error(`UI server failed: ${error.message}`);
  process.exitCode = 1;
});

ui.server.once("listening", () => {
  console.log(`UI server listening on http://${host}:${port}/`);
});

let closing = false;
function shutdown(): void {
  if (closing) return;
  closing = true;
  void ui.close().then(() => {
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);