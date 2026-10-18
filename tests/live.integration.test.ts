import { describe, expect, it } from "vitest";
import { createOpenAIProvider } from "../src/model/openai.js";

const live = process.env.HARNESS_COMPAT_LIVE === "1";
const baseUrl = process.env.HARNESS_COMPAT_BASE_URL;
const model = process.env.HARNESS_COMPAT_MODEL;
const apiKey = process.env.HARNESS_COMPAT_API_KEY;

describe.skipIf(!live || !baseUrl || !model)("live OpenAI 兼容网关", () => {
  it("真实 complete 往返", async () => {
    const provider = createOpenAIProvider({
      baseUrl: baseUrl as string,
      model: model as string,
      apiKey,
    });

    const result = await provider.complete(
      [{ role: "user", content: "回复 OK" }],
      [],
      { signal: new AbortController().signal, maxOutputTokens: 16 },
    );

    expect(result.content.length).toBeGreaterThan(0);
  });
});