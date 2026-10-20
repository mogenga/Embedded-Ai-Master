// 会话实时事件流的客户端已迁移到 src/ui/api/event-stream.ts(SessionEventEnvelope + 游标)。
// 这里只保留 action 通道的 HTTP POST,不再保留第二套 SSE 客户端。

export interface HttpError {
  code: "http_error";
  status: number;
  text: string;
}

export async function postAction<T>(
  url: string,
  body: unknown,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<T> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text();
    const err: HttpError = { code: "http_error", status: response.status, text };
    throw err;
  }
  return (await response.json()) as T;
}
