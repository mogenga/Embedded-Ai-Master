import { parseProviderBaseUrl } from "./openai.js";

/**
 * 「测试连接」：探测一个 OpenAI 兼容网关是否可用。
 *
 * 与主适配器（`openai.ts`）走同一套 baseUrl 校验（`parseProviderBaseUrl`），
 * 所以「测试通过但发消息失败」不会源自两边规则不一致。
 *
 * 诚实原则（R3）：
 * - 只有真的拿到 2xx 才回 `ok: true`；`ok: true` 绝不带 `error`。
 * - 2xx 但列不出模型时，`models` 字段省略而不是空数组：前者是「列出失败」，
 *   后者是「一个模型都没有」，两者不能混为一谈。
 * - 失败一定带分类码与中文原因，不把 401 说成「网络错误」。
 */

export interface ProviderProbeOptions {
  baseUrl: string;
  apiKeyEnv?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ProviderProbeResult {
  ok: boolean;
  baseUrl: string;
  /** 探测到的模型 id 列表；拿不到时该字段不存在（不是空数组）。 */
  models?: string[];
  /** 失败原因，人话，中文。ok 为 true 时不存在。 */
  error?: string;
  /**
   * 失败原因的分类码，便于前端区分「地址不通」和「鉴权失败」。
   *
   * `bad_response` 是契约保留值：按契约，2xx 但响应体解析失败算
   * 「端点可达」，走 `ok: true` + 无 `models`，因此当前探测流程不会产出该码。
   */
  code?: "invalid_base_url" | "unreachable" | "unauthorized" | "http_error" | "bad_response";
  latencyMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
/** 探测响应体的上限：这是诊断请求，不是数据通道，1 MiB 足够且必须有上限。 */
const MAX_BODY_BYTES = 1024 * 1024;

type AttemptFailure =
  | { kind: "http"; status: number; method: string; url: string }
  | { kind: "network"; detail: string; method: string; url: string }
  | { kind: "timeout"; method: string; url: string };

type AttemptResult =
  | { kind: "response"; response: Response; payload?: unknown }
  | AttemptFailure;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function endpointUrl(base: URL, suffix: string): string {
  const copy = new URL(base.toString());
  copy.pathname = `${copy.pathname.replace(/\/+$/, "")}/${suffix}`;
  return copy.toString();
}

function parseJsonOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** 读取响应体并解析 JSON；超限或不是 JSON 时返回 undefined（不抛）。 */
async function readJsonCapped(response: Response): Promise<unknown> {
  const body = response.body;
  if (body === null || body === undefined) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) return undefined;
    return parseJsonOrUndefined(text);
  }
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return parseJsonOrUndefined(Buffer.concat(chunks).toString("utf8"));
}

/** 丢掉不打算读的响应体，避免连接挂在半开状态。 */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // 对端已关闭连接：没有可丢弃的东西。
  }
}

/**
 * 从 `{ data: [{ id }] }` 里取模型 id。
 *
 * 返回 undefined 表示「形状不认识」——网关可能用了别的字段名，这时不能
 * 把「解析失败」伪装成「模型列表为空」。空数组才是「确实一个模型都没有」。
 */
function extractModels(payload: unknown): string[] | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return undefined;
  if (data.length === 0) return [];
  const models: string[] = [];
  const seen = new Set<string>();
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== "string" || id === "" || seen.has(id)) continue;
    seen.add(id);
    models.push(id);
  }
  // 列表非空但一个合法 id 都没有：形状不认识，而不是「零个模型」。
  return models.length === 0 ? undefined : models;
}

function invalidBaseUrlMessage(baseUrl: string): string {
  if (baseUrl.trim() === "") {
    return "请先填写模型服务地址（baseUrl）";
  }
  return `模型服务地址无效：${baseUrl}。必须是以 http:// 或 https:// 开头的绝对地址，且不能带查询串或片段。`;
}

interface KeyContext {
  apiKeyEnv: string;
  envConfigured: boolean;
  envMissing: boolean;
}

function describeHttpFailures(failures: AttemptFailure[]): string {
  return failures
    .filter((failure): failure is Extract<AttemptFailure, { kind: "http" }> => failure.kind === "http")
    .map((failure) => `${failure.method} ${failure.url} 返回 HTTP ${failure.status}`)
    .join("；");
}

/**
 * 把一串尝试失败收敛成一条人话原因 + 分类码。
 *
 * 优先级：鉴权失败 > 超时 > 网络不可达 > 其它 HTTP 状态。鉴权失败排最前，
 * 因为 404 的 /models 后面跟着 401 的 /chat/completions 时，真正要改的是 key。
 */
function failureMessage(
  failures: AttemptFailure[],
  ctx: KeyContext,
  hints: { fallbackSkipped: boolean },
): { code: "unreachable" | "unauthorized" | "http_error"; error: string } {
  const authFailure = failures.find(
    (failure): failure is Extract<AttemptFailure, { kind: "http" }> =>
      failure.kind === "http" && (failure.status === 401 || failure.status === 403),
  );
  if (authFailure !== undefined) {
    const status = authFailure.status;
    if (ctx.envMissing) {
      return {
        code: "unauthorized",
        error: `鉴权失败（HTTP ${status}）：环境变量 ${ctx.apiKeyEnv} 未设置，请求未携带 API Key。请先在启动本服务的环境里设置该变量后重试。`,
      };
    }
    if (ctx.envConfigured) {
      return {
        code: "unauthorized",
        error: `鉴权失败（HTTP ${status}）：服务端拒绝了 API Key，请检查环境变量 ${ctx.apiKeyEnv} 的值。`,
      };
    }
    return {
      code: "unauthorized",
      error: `鉴权失败（HTTP ${status}）：服务端要求 API Key，但该模型服务没有配置 apiKeyEnv。`,
    };
  }

  const httpDetails = describeHttpFailures(failures);
  const httpSuffix = httpDetails === "" ? "" : `（${httpDetails}）`;

  const timeout = failures.find((failure) => failure.kind === "timeout");
  if (timeout !== undefined) {
    return {
      code: "unreachable",
      error: `连接模型服务超时：请求在超时时间内没有响应${httpSuffix}`,
    };
  }

  const network = failures.find(
    (failure): failure is Extract<AttemptFailure, { kind: "network" }> => failure.kind === "network",
  );
  if (network !== undefined) {
    return {
      code: "unreachable",
      error: `无法连接模型服务：${network.detail}${httpSuffix}`,
    };
  }

  const hint = hints.fallbackSkipped
    ? "。可以填写模型名后重试：会用一次最小 chat/completions 请求做兜底验证。"
    : "。请检查服务地址与模型配置。";
  return {
    code: "http_error",
    error: `模型服务返回异常状态：${httpDetails}${hint}`,
  };
}

export async function probeProvider(options: ProviderProbeOptions): Promise<ProviderProbeResult> {
  const { baseUrl } = options;
  let base: URL;
  try {
    base = parseProviderBaseUrl(baseUrl);
  } catch {
    return {
      ok: false,
      baseUrl,
      code: "invalid_base_url",
      error: invalidBaseUrlMessage(baseUrl),
    };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const configuredTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : DEFAULT_TIMEOUT_MS;

  const rawApiKeyEnv = options.apiKeyEnv ?? "";
  const apiKeyEnv = rawApiKeyEnv.trim();
  const envConfigured = apiKeyEnv !== "";
  const rawKey = envConfigured ? process.env[apiKeyEnv] : undefined;
  const apiKey = rawKey === undefined ? undefined : rawKey.trim();
  const envMissing = envConfigured && (apiKey === undefined || apiKey === "");
  const model = (options.model ?? "").trim();

  const headers: Record<string, string> = {};
  // 环境变量没设置时不发 Authorization：发一个空 Bearer 只会让服务端
  // 回一个看似「key 错误」的 401，掩盖真正的配置问题。
  if (apiKey !== undefined && apiKey !== "") headers.Authorization = `Bearer ${apiKey}`;

  // 超时是整个探测的总预算：/models 与 chat 兜底共用一个计时器，
  // 避免「先等 10 秒、再等 10 秒」。
  const timeoutController = new AbortController();
  const state = { timedOut: false };
  const timer = setTimeout(() => {
    state.timedOut = true;
    timeoutController.abort();
  }, timeoutMs);
  timer.unref?.();
  const signal = options.signal === undefined
    ? timeoutController.signal
    : AbortSignal.any([options.signal, timeoutController.signal]);

  const startedAt = Date.now();

  /**
   * 发一次请求。成功时返回响应（GET 顺便读好 JSON），失败时返回分类失败。
   *
   * 调用方取消（`options.signal`）不是探测结论：把 AbortError 原样抛出去，
   * 由上层按取消处理，而不是伪装成「服务不可达」。
   */
  const attempt = async (
    method: "GET" | "POST",
    url: string,
    body?: unknown,
  ): Promise<AttemptResult> => {
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: body === undefined ? headers : { ...headers, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal,
      });
    } catch (error) {
      if (options.signal?.aborted === true) throw error;
      if (state.timedOut) return { kind: "timeout", method, url };
      return { kind: "network", detail: messageOf(error), method, url };
    }
    if (method !== "GET" || !response.ok) {
      return { kind: "response", response };
    }
    // 2xx：响应头已证明端点应答了。读 body 失败（连接中途断了、超过上限）
    // 不改变这个事实，按「端点可达但没能列出模型」处理，而不是回头报
    // 「不可达」——那会把一个已经成功的握手说成失败（R3）。
    let payload: unknown;
    try {
      payload = await readJsonCapped(response);
    } catch (error) {
      if (options.signal?.aborted === true) throw error;
      payload = undefined;
    }
    return { kind: "response", response, payload };
  };

  try {
    const modelsUrl = endpointUrl(base, "models");
    const modelsAttempt = await attempt("GET", modelsUrl);

    if (modelsAttempt.kind === "response") {
      const { response } = modelsAttempt;
      if (response.ok) {
        // 契约：2xx 即端点可达。形状不认识时宁可不说，也不编造模型列表。
        const models = extractModels(modelsAttempt.payload);
        return {
          ok: true,
          baseUrl,
          ...(models === undefined ? {} : { models }),
          latencyMs: Date.now() - startedAt,
        };
      }
      await discardBody(response);
      const failures: AttemptFailure[] = [
        { kind: "http", status: response.status, method: "GET", url: modelsUrl },
      ];

      // /models 不可用不代表聊天端点不可用（很多网关不实现模型列表）。
      // 给了模型名就用一条最小请求再验一次。
      if (model !== "") {
        const chatUrl = endpointUrl(base, "chat/completions");
        const chatAttempt = await attempt("POST", chatUrl, {
          model,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
          stream: false,
        });
        if (chatAttempt.kind === "response") {
          await discardBody(chatAttempt.response);
          if (chatAttempt.response.ok) {
            return { ok: true, baseUrl, latencyMs: Date.now() - startedAt };
          }
          failures.push({
            kind: "http",
            status: chatAttempt.response.status,
            method: "POST",
            url: chatUrl,
          });
        } else {
          failures.push(chatAttempt);
        }
      }

      return {
        ok: false,
        baseUrl,
        ...failureMessage(failures, { apiKeyEnv, envConfigured, envMissing }, {
          fallbackSkipped: model === "",
        }),
      };
    }

    // 网络错误/超时：服务都没有应答，不做 chat 兜底。
    return {
      ok: false,
      baseUrl,
      ...failureMessage([modelsAttempt], { apiKeyEnv, envConfigured, envMissing }, {
        fallbackSkipped: false,
      }),
    };
  } finally {
    clearTimeout(timer);
  }
}
