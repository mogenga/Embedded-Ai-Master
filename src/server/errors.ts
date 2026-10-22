/**
 * 带状态码的领域错误。
 *
 * 名字里的 `Http` 是历史遗留：它最初只服务 HTTP 处理器。浏览器形态下线后，
 * 桌面宿主仍然直接调用 `files-api` / `session-admin`，靠 `status` 与 `code`
 * 把「路径非法」「目录不存在」「会话忙」区分开并转成自己的 `notice` / 错误行
 * （R3：失败要说清是哪一类）。因此这个类保留在这里，只是不再有任何 HTTP
 * 序列化代码（`sendJson` / `sendError` 已随 `http.ts` 一起删除）。
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}
