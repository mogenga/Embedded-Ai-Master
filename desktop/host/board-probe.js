/**
 * Board-pane device probe.
 *
 * The pane's refresh must not depend on the agent happening to call a status
 * tool, and it must not ask the model to do it (an LLM in the loop for "what
 * chip is this" is slow, costs tokens, and can refuse). The host therefore
 * holds its own short-lived MCP connection: load the same mcp.json the
 * sessions use, connect, call the read-only status tool of each embedded
 * backend, close. No model, no approval path — this host process is the
 * user's own, and the tools it calls are read-only by whitelist.
 *
 * The manager is created per probe and disposed after: sessions own their
 * own connections, and two managers would double-connect every stdio server
 * for the whole session's life. A connect costs a few hundred ms per server,
 * which is what the refresh button is allowed to take.
 */

/**
 * Tools that may be called here, by exact name. Everything else is refused
 * before any process spawns: this module is a status read, and a config file
 * must not widen it into flash/erase.
 */
const STATUS_TOOLS = new Set([
  // probe MCP (embedded server): reports {backend, probe, cpu, serial}
  "device_status",
  "device_list",
  // keil: session/toolchain state without opening a debug session
  "keil_debug:status",
  // cubeide: backend presence + target probe list, no session needed
  "cubeide_build:probe",
  "cubeide_debug:status",
  "cubeide_build:version",
]);

/** Actions allowed on action-style tools (name:action whitelist). */
const STATUS_ACTIONS = new Set(["status", "probe", "version", "info"]);

/**
 * Read the embedded status from every configured MCP server.
 *
 * Returns `[{ server, tool, ok, state, error }]` — `state` is whatever the
 * tool's structuredContent carried (deviceStatus objects, probe lists), and
 * the renderer decides how to draw each shape.
 */
export async function probeBoardState(opts) {
  const { loadMcpConfig, McpManager, harnessHome, workdir, timeoutMs = 15_000 } = opts;
  let servers;
  try {
    servers = loadMcpConfig({ home: harnessHome, workdir });
  } catch (error) {
    return [{ server: "", tool: "", ok: false, state: null, error: `MCP 配置读取失败：${error?.message ?? error}` }];
  }
  const embedded = servers.filter((server) =>
    // The embedded backends by name; anything else has nothing to say to a
    // board pane. KB/pack servers would only slow the connect.
    /^(keil|cubeide|espidf|arduino|probe|embedded)$/.test(server.name),
  );
  if (embedded.length === 0) {
    return [];
  }
  const manager = new McpManager(embedded, {});
  const results = [];
  try {
    await manager.connectAll();
    const tools = manager.tools();
    await Promise.all(tools.map(async (info) => {
      const allowed = statusCallFor(info);
      if (allowed === null) return;
      try {
        const result = await manager.call(info.server, info.tool, allowed, undefined);
        if (result.isError) {
          results.push({ server: info.server, tool: info.tool, ok: false, state: null, error: result.content?.[0]?.text ?? result.code });
          return;
        }
        const structured = result.structuredContent ?? {};
        // `deviceStatus` is the shape the renderer's board pane already draws;
        // other read-only answers (probe lists, versions) travel as their own
        // state blobs under the tool name.
        const state = structured.deviceStatus ?? structured;
        results.push({ server: info.server, tool: info.tool, ok: true, state, error: undefined });
      } catch (error) {
        results.push({ server: info.server, tool: info.tool, ok: false, state: null, error: error?.message ?? String(error) });
      }
    }));
  } finally {
    await manager.close().catch(() => {});
  }
  return results;
}

/** The arguments a status tool may be called with, or null when it may not. */
function statusCallFor(info) {
  const fullName = `${info.server === "" ? "" : `${info.server}:`}${info.tool}`;
  void fullName;
  if (STATUS_TOOLS.has(info.tool) && !info.tool.includes(":")) {
    // Plain tools from the probe/embedded servers take no arguments.
    return {};
  }
  // server-prefixed entries in the set are name:action pairs.
  for (const entry of STATUS_TOOLS) {
    if (!entry.includes(":")) continue;
    const [toolName, action] = entry.split(":");
    if (info.tool !== toolName) continue;
    if (!STATUS_ACTIONS.has(action)) return null;
    return { action };
  }
  return null;
}
