import { describe, expect, it } from "vitest";
import { OpenOcdBackend } from "../openocd.js";
import { RenodeBackend } from "../renode-backend.js";
import { createProbeBackends } from "../server.js";

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