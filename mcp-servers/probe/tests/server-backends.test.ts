import { describe, expect, it } from "vitest";
import { OpenOcdBackend } from "../openocd.js";
import { RenodeBackend } from "../renode-backend.js";
import { DEFAULT_RENODE_PATH } from "../renode.js";
import { createProbeBackends } from "../server.js";
import { probeTools } from "../tools.js";

describe("createProbeBackends 环境变量", () => {
  it("把 RENODE_PATH 传给 RenodeBackend", () => {
    const backends = createProbeBackends({ RENODE_PATH: "D:/Renode/bin/Renode.exe" });

    expect(backends.renode).toBeInstanceOf(RenodeBackend);
    expect((backends.renode as RenodeBackend).renodePath).toBe("D:/Renode/bin/Renode.exe");
  });

  it("RENODE_PATH 两侧空白会被裁剪", () => {
    const backends = createProbeBackends({ RENODE_PATH: "  D:/Renode/bin/Renode.exe  " });

    expect((backends.renode as RenodeBackend).renodePath).toBe("D:/Renode/bin/Renode.exe");
  });

  it("RENODE_PATH 为空时沿用 RenodeBackend 默认路径", () => {
    for (const value of [undefined, "", "   "]) {
      const backends = createProbeBackends({ RENODE_PATH: value });

      expect((backends.renode as RenodeBackend).renodePath).toBeUndefined();
    }
  });

  it("未读取 RENODE_PATH 时仍返回 OpenOCD backend", () => {
    const backends = createProbeBackends({});

    expect(backends.openocd).toBeInstanceOf(OpenOcdBackend);
  });
});
describe("RenodeBackend 可用性", () => {
  it("available 由 renodePath 与注入的 existsImpl 决定", () => {
    const checked: string[] = [];
    const backend = new RenodeBackend({
      renodePath: "D:/Renode/bin/Renode.exe",
      existsImpl: (target) => {
        checked.push(target);
        return false;
      },
    });

    expect(backend.available()).toBe(false);
    expect(checked).toEqual(["D:/Renode/bin/Renode.exe"]);
    expect(
      new RenodeBackend({
        renodePath: "D:/Renode/bin/Renode.exe",
        existsImpl: () => true,
      }).available(),
    ).toBe(true);
  });

  it("未提供 renodePath 时检查默认路径", () => {
    const checked: string[] = [];
    const backend = new RenodeBackend({
      existsImpl: (target) => {
        checked.push(target);
        return true;
      },
    });

    expect(backend.available()).toBe(true);
    expect(checked).toEqual([DEFAULT_RENODE_PATH]);
  });

  it("RENODE_PATH 不存在时 device_list 报告 available: false", async () => {
    const tools = probeTools({
      renode: new RenodeBackend({
        renodePath: "D:/missing/Renode.exe",
        existsImpl: () => false,
      }),
    });

    const result = await tools.find((tool) => tool.name === "device_list")?.handler({});
    const backends = (
      result?.structuredContent as { backends: Array<{ kind: string; available: boolean }> }
    ).backends;
    expect(backends.find((entry) => entry.kind === "renode")?.available).toBe(false);
  });
});