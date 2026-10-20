import { describe, expect, it, vi } from "vitest";
import { postAction } from "../../src/ui/view/sse.js";

describe("postAction", () => {
  it("成功返回响应体", async () => {
    const okFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: 1 }), { status: 200 }));
    expect(await postAction("http://x/a", { v: 1 }, { fetchImpl: okFetch as unknown as typeof fetch })).toEqual({ ok: 1 });
  });

  it("非 2xx 抛 http_error 并带状态码", async () => {
    const badFetch = vi.fn().mockResolvedValue(new Response("boom", { status: 500 }));
    await expect(postAction("http://x/a", {}, { fetchImpl: badFetch as unknown as typeof fetch })).rejects.toMatchObject({
      code: "http_error",
      status: 500,
    });
  });
});