/**
 * 真实 harness 层端到端测试：loadMcpConfig(~/.harness/mcp.json) → McpManager
 * → call("cubeide", "cubeide_build", {...})。与 desktop 宿主走的完全同一条路。
 */
import { loadMcpConfig } from "../dist/mcp/config.js";
import { McpManager } from "../dist/mcp/manager.js";

const home = "C:/Users/Admin/.harness";

const servers = loadMcpConfig({ home, workdir: process.cwd(), includeProject: false });
console.log("servers:", servers.map((s) => s.name).join(", "));

const manager = new McpManager(servers, {
  logger: (event) => {
    if (event.kind !== "mcp_connected") console.log("[mcp]", event.kind, event.server ?? "");
  },
});
await manager.connectAll();

async function call(tool, args, label) {
  const result = await manager.call("cubeide", tool, args);
  const text = result.content?.map((c) => c.text ?? "").join("\n") ?? JSON.stringify(result);
  console.log(`\n=== ${label} → isError=${result.isError === true}`);
  console.log(text.split("\n").slice(0, 10).join("\n"));
  return result;
}

// 1) version：确认三件套发现全部走 env 传入
await call("cubeide_build", { action: "version" }, "version");

// 2) probe：探针在线
await call("cubeide_build", { action: "probe" }, "probe");

// 3) CubeMX generate：真实生成一个新工程
const gen = await call("cubeide_build", {
  action: "generate",
  mcu: "STM32F429IGTx",
  name: "harness_e2e",
  path: "C:/Users/Admin/AppData/Local/Temp/harness_e2e",
}, "generate (CubeMX)");

// 4) build 生成的工程
const projDir = gen.structuredContent?.projectDir;
if (projDir) {
  await call("cubeide_build", { action: "build", project: projDir }, "build (CubeIDE)");
} else {
  console.log("!! no projectDir from generate, skipping build");
}

// 5) flash
await call("cubeide_build", { action: "flash", image: "C:/Users/Admin/AppData/Local/Temp/harness_e2e/STM32CubeIDE/Debug/harness_e2e.elf", verify: true }, "flash (CubeProgrammer)");

// 6) 调试 open（S7 固件可能挡——记录真实结果）
const dbg = await call("cubeide_debug", { action: "open", project: "C:/Users/Admin/STM32CubeIDE/workspace_2.2.0/test", load: false }, "debug open (gdbserver)");

// 7) close
await call("cubeide_debug", { action: "close" }, "debug close");

await manager.close();
console.log("\nE2E done");
