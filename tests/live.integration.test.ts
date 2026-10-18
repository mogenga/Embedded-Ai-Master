import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveHarnessHome } from "../src/config/harness-home.js";
import { loadProviders, resolveModelRef } from "../src/config/providers.js";
import type { ProviderConfig } from "../src/config/providers.js";
import { createOpenAIProvider } from "../src/model/openai.js";

const live = process.env.HARNESS_COMPAT_LIVE === "1";
const configuredModelRef = process.env.HARNESS_COMPAT_MODEL;

export function requireModelRef(): string {
  const value = process.env.HARNESS_COMPAT_MODEL;
  if (value === undefined || value.trim() === "") {
    throw new Error("HARNESS_COMPAT_MODEL is required");
  }
  return value.trim();
}

function resolveBaseUrl(provider: ProviderConfig): string {
  const override = process.env.HARNESS_COMPAT_BASE_URL;
  if (override !== undefined && override.trim() !== "") return override;
  return provider.baseUrl;
}

function resolveApiKey(provider: ProviderConfig): string | undefined {
  const direct = process.env.HARNESS_COMPAT_API_KEY;
  const fromEnv = provider.apiKeyEnv === undefined ? undefined : process.env[provider.apiKeyEnv];
  const value = direct !== undefined && direct.trim() !== "" ? direct : fromEnv;
  return value !== undefined && value.trim() !== "" ? value.trim() : undefined;
}

describe("live env helper", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("requireModelRef 返回 trim 后的引用", () => {
    vi.stubEnv("HARNESS_COMPAT_MODEL", "  gw/flash  ");
    expect(requireModelRef()).toBe("gw/flash");
  });

  it("空白引用视为缺失", () => {
    vi.stubEnv("HARNESS_COMPAT_MODEL", "   ");
    expect(() => requireModelRef()).toThrow(/HARNESS_COMPAT_MODEL/);
  });
});

describe.skipIf(!live || configuredModelRef === undefined || configuredModelRef.trim() === "")(
  "live OpenAI 兼容网关",
  () => {
    it("真实 complete 往返", async () => {
      const providers = loadProviders(resolveHarnessHome());
      const resolved = resolveModelRef(providers, requireModelRef());
      const provider = createOpenAIProvider({
        baseUrl: resolveBaseUrl(resolved.provider),
        model: resolved.modelName,
        apiKey: resolveApiKey(resolved.provider),
      });

      const result = await provider.complete(
        [{ role: "user", content: "回复 OK" }],
        [],
        { signal: new AbortController().signal, maxOutputTokens: 16 },
      );

      expect(result.content.length).toBeGreaterThan(0);
    });
  },
);
