import { randomUUID } from "node:crypto";
import path from "node:path";
import { resolveHarnessHome } from "./config/harness-home.js";
import { loadProviders, parseProviders, resolveModelRef } from "./config/providers.js";
import { checkBudget } from "./context/budget.js";
import type { LoopEvent } from "./loop/events.js";
import { query } from "./loop/query.js";
import type { LoopCtx } from "./loop/query.js";
import { createOpenAIProvider } from "./model/openai.js";
import { createSession } from "./session/session.js";
import { echoTool } from "./tools/echo.js";
import { ToolRegistry } from "./tools/registry.js";

export interface RunOptions {
  input: string;
  model: string;
  sessionId?: string;
  sessionDir?: string;
  providersText?: string;
  systemPrompt?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  maxTurns?: number;
  maxCostUsd?: number;
  cwd?: string;
  timeoutMs?: number;
}

export async function* runSession(opts: RunOptions): AsyncGenerator<LoopEvent> {
  const home = resolveHarnessHome();
  const providers =
    opts.providersText === undefined ? loadProviders(home) : parseProviders(opts.providersText);
  const { provider, modelName, model } = resolveModelRef(providers, opts.model);

  const apiKeyEnv = provider.apiKeyEnv;
  const rawApiKey = apiKeyEnv === undefined ? undefined : process.env[apiKeyEnv];
  const apiKey = rawApiKey === undefined ? undefined : rawApiKey.trim();
  const modelProtocol = createOpenAIProvider({
    baseUrl: provider.baseUrl,
    model: modelName,
    fetchImpl: opts.fetchImpl,
    ...(apiKey !== undefined && apiKey !== "" ? { apiKey } : {}),
  });

  const id = opts.sessionId ?? randomUUID();
  const sessionDir = opts.sessionDir ?? path.join(home, "sessions", id);
  const session = await createSession(sessionDir, { id, systemPrompt: opts.systemPrompt });

  const ctx: LoopCtx = {
    session,
    model: modelProtocol,
    modelCfg: model,
    tools: new ToolRegistry([echoTool]),
    budget: (messages) => checkBudget(messages, model.contextWindow),
    signal: opts.signal ?? new AbortController().signal,
    artifactDir: path.join(session.dir, "artifacts"),
    cwd: opts.cwd,
    timeoutMs: opts.timeoutMs,
    pricePerMillion: provider.pricePerMillion,
  };

  try {
    yield* query(ctx, opts.input, {
      maxTurns: opts.maxTurns ?? 10,
      maxCostUsd: opts.maxCostUsd,
    });
  } finally {
    await session.close();
  }
}
