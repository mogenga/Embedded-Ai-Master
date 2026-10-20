#!/usr/bin/env node
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const BACKEND_MODULE = path.join(ROOT, "dist-mcp", "probe", "renode-backend.js");
const DEFAULT_RENODE_PATH = "C:/Program Files/Renode/bin/Renode.exe";
const PLATFORM = "platforms/boards/stm32f4_discovery-kit.repl";
const ADDRESS = 0x20000000;
const WRITE_BYTES = [0x78, 0x56, 0x34, 0x12];
const WRITE_HEX = "78563412";

function getFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function main() {
  if (!existsSync(BACKEND_MODULE)) {
    console.error(
      "probe e2e: 未找到 dist-mcp/probe/renode-backend.js；请先运行 npm run build:mcp",
    );
    process.exitCode = 2;
    return;
  }

  const renodePath = process.env.RENODE_PATH?.trim() || DEFAULT_RENODE_PATH;
  if (!existsSync(renodePath)) {
    console.error(`probe e2e: 未找到 Renode 可执行文件: ${renodePath}（可用 RENODE_PATH 覆盖）`);
    process.exitCode = 1;
    return;
  }

  const { RenodeBackend } = await import(pathToFileURL(BACKEND_MODULE).href);
  const backend = new RenodeBackend({ renodePath });
  const monitorPort = await getFreePort();

  let detached = false;
  try {
    const status = await backend.attach({ platform: PLATFORM, monitorPort });
    if (status.backend !== "renode" || status.probe !== "attached") {
      throw new Error(`attach 返回状态不符合预期: ${JSON.stringify(status)}`);
    }

    await backend.halt();
    const original = await backend.readMemory(ADDRESS, WRITE_BYTES.length);

    const written = await backend.writeMemory(ADDRESS, WRITE_BYTES);
    if (written.verified.hex !== WRITE_HEX) {
      throw new Error(`写后回读不一致: 期望 ${WRITE_HEX}，实际 ${written.verified.hex}`);
    }

    await backend.reset();
    await backend.writeMemory(ADDRESS, original.bytes);
    await backend.detach();
    detached = true;

    console.log(
      JSON.stringify({
        backend: "renode",
        attach: true,
        halt: true,
        read: `0x${original.hex}`,
        writeVerified: true,
        reset: true,
        detach: true,
      }),
    );
  } finally {
    if (!detached) {
      try {
        await backend.detach();
      } catch (error) {
        console.error(`probe e2e: detach 清理失败: ${errorMessage(error)}`);
      }
    }
  }
}

main().catch((error) => {
  console.error(`probe e2e: ${errorMessage(error)}`);
  process.exitCode = 1;
});