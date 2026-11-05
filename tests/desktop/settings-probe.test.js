import { describe, expect, it } from "vitest";
import { probeAnswer, providerProbePayload } from "../../desktop/renderer/settings.js";

describe("providerProbePayload", () => {
  const target = { baseUrl: "https://api.example.com/v1", apiKey: "sk-1", apiKeyEnv: "ENV", model: "m1" };

  it("列表请求不带模型名：兜底的 chat 请求回答的是「能不能用」，不是「列得出哪些」", () => {
    expect(providerProbePayload("list", target)).toEqual({
      cmd: "testProvider",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-1",
      apiKeyEnv: "ENV",
    });
  });

  it("测试请求带上模型名，让内核能走 chat 兜底", () => {
    expect(providerProbePayload("test", target).model).toBe("m1");
  });

  it("空字段不发送：空 apiKey 会被当成空凭据，空 apiKeyEnv 会去读一个没有名字的变量", () => {
    expect(
      providerProbePayload("test", { baseUrl: "http://127.0.0.1:1", apiKey: "", apiKeyEnv: "", model: "" }),
    ).toEqual({ cmd: "testProvider", baseUrl: "http://127.0.0.1:1" });
  });

  it("缺字段时按空值处理，不发出 undefined", () => {
    expect(providerProbePayload("list", {})).toEqual({ cmd: "testProvider", baseUrl: "" });
    expect(providerProbePayload("list", undefined)).toEqual({ cmd: "testProvider", baseUrl: "" });
    expect(providerProbePayload("list", { baseUrl: 42, apiKey: 7 })).toEqual({
      cmd: "testProvider",
      baseUrl: "",
    });
  });
});

describe("probeAnswer", () => {
  it("带了模型列表 → ok", () => {
    expect(probeAnswer({ ok: true, models: ["a", "b"], latencyMs: 42 })).toEqual({
      outcome: "ok",
      models: ["a", "b"],
      latencyMs: 42,
    });
  });

  it("ok 但没有 models 字段 → empty，不是「零个模型」", () => {
    expect(probeAnswer({ ok: true, latencyMs: 10 })).toEqual({ outcome: "empty", models: [], latencyMs: 10 });
  });

  it("ok 但 models 是空数组 → empty（端点确实没有模型）", () => {
    expect(probeAnswer({ ok: true, models: [] }).outcome).toBe("empty");
  });

  it("丢掉非字符串的模型名", () => {
    expect(probeAnswer({ ok: true, models: ["a", 42, null, " b "] }).models).toEqual(["a", " b "]);
  });

  it("没有 latencyMs 就不伪造一个", () => {
    expect(probeAnswer({ ok: true, models: ["a"] })).not.toHaveProperty("latencyMs");
    expect(probeAnswer({ ok: true, models: ["a"], latencyMs: "fast" })).not.toHaveProperty("latencyMs");
  });

  it("失败带分类码与内核原话", () => {
    expect(probeAnswer({ ok: false, code: "unauthorized", error: "鉴权失败（HTTP 401）" })).toEqual({
      outcome: "failed",
      code: "unauthorized",
      detail: "鉴权失败（HTTP 401）",
    });
  });

  it("未知分类码原样透传，不猜一个最像的", () => {
    expect(probeAnswer({ ok: false, code: "bad_response" }).code).toBe("bad_response");
    expect(probeAnswer({ ok: false }).code).toBe("");
    expect(probeAnswer({ ok: false }).detail).toBe("");
  });

  it("ok 不是严格的 true 时算失败：只有真的测过才配说成功", () => {
    expect(probeAnswer({ ok: "yes", models: ["a"] }).outcome).toBe("failed");
    expect(probeAnswer({ models: ["a"] }).outcome).toBe("failed");
  });

  it("入参不是对象时回退成一次没有说明的失败", () => {
    for (const message of [null, undefined, "ok", 42]) {
      expect(probeAnswer(message)).toEqual({ outcome: "failed", code: "", detail: "" });
    }
  });
});
