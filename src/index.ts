import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { resolveHarnessHome } from "./config/harness-home.js";
import { loadProviders, parseProviders, resolveModelRef } from "./config/providers.js";
import { checkBudget } from "./context/budget.js";
import type { LoopEvent } from "./loop/events.js";
import { query } from "./loop/query.js";
import type { LoopCtx } from "./loop/query.js";
import { createOpenAIProvider } from "./model/openai.js";
import { SessionResumeError } from "./session/errors.js";
import { readSessionDir } from "./session/persistence.js";
import { createSession, resumeSession } from "./session/session.js";
import type { SessionHandle } from "./session/session.js";
import { echoTool } from "./tools/echo.js";
import { isWindowsReservedName } from "./tools/pipeline.js";
import { ToolRegistry } from "./tools/registry.js";

export interface RunOptions {
  input: string;
  model: string;
  sessionId?: string;
  sessionDir?: string;
  resume?: boolean;
  providersText?: string;
  systemPrompt?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  maxTurns?: number;
  maxCostUsd?: number;
  cwd?: string;
  timeoutMs?: number;
}

const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

function assertSessionId(sessionId: string): void {
  if (!SESSION_ID_PATTERN.test(sessionId) || isWindowsReservedName(sessionId)) {
    throw new TypeError(
      `invalid sessionId: ${JSON.stringify(sessionId)}; must match ${SESSION_ID_PATTERN.source} and not be a Windows reserved name`,
    );
  }
}

interface ResumePlan {
  session: SessionHandle;
  systemPromptToAppend?: string;
}

async function planResume(sessionDir: string, opts: RunOptions): Promise<ResumePlan> {
  const headerPath = path.join(sessionDir, "header.json");
  try {
    await stat(headerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SessionResumeError(
        "missing_session_dir",
        `Session header not found: ${headerPath}`,
        { dir: sessionDir, file: "header.json" },
      );
    }
    throw error;
  }

  const { header, events } = readSessionDir(sessionDir);

  if (header.model !== undefined && header.model !== opts.model) {
    throw new SessionResumeError(
      "model_mismatch",
      `Session model ${header.model} does not match requested model ${opts.model}`,
      { expected: opts.model, actual: header.model },
    );
  }

  if (opts.sessionId !== undefined && opts.sessionId !== header.id) {
    throw new SessionResumeError(
      "session_id_mismatch",
      `Session id ${header.id} does not match requested sessionId ${opts.sessionId}`,
      { expected: opts.sessionId, actual: header.id },
    );
  }

  let systemPromptToAppend: string | undefined;
  if (opts.systemPrompt !== undefined) {
    const systemEvent = events.find((event) => event.type === "system");
    if (systemEvent !== undefined) {
      const content = systemEvent.payload.content;
      if (content !== opts.systemPrompt) {
        throw new SessionResumeError(
          "system_prompt_mismatch",
          "Session system prompt does not match the provided systemPrompt",
          { expected: opts.systemPrompt, actual: content },
        );
      }
    } else if (events.length > 0) {
      throw new SessionResumeError(
        "system_prompt_mismatch",
        "Cannot add a system prompt to a non-empty session without a system event",
      );
    } else {
      systemPromptToAppend = opts.systemPrompt;
    }
  }

  const session = await resumeSession(sessionDir);
  return systemPromptToAppend === undefined ? { session } : { session, systemPromptToAppend };
}

export async function* runSession(opts: RunOptions): AsyncGenerator<LoopEvent> {
  if (opts.sessionId !== undefined) assertSessionId(opts.sessionId);
  const resume = opts.resume === true;
  const resumeDir = opts.sessionDir;
  if (resume && resumeDir === undefined) {
    throw new SessionResumeError(
      "missing_session_dir",
      "resume requires an explicit sessionDir",
    );
  }
  const home = resolveHarnessHome();
  const providers =
    opts.providersText === undefined ? loadProviders(home) : parseProviders(opts.providersText);
  const { providerName, provider, modelName, model } = resolveModelRef(providers, opts.model);

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
  let session: SessionHandle;
  let systemPromptToAppend: string | undefined;

  if (resume && resumeDir !== undefined) {
    const plan = await planResume(resumeDir, opts);
    session = plan.session;
    systemPromptToAppend = plan.systemPromptToAppend;
  } else {
    const sessionDir = resumeDir ?? path.join(home, "sessions", id);
    session = await createSession(sessionDir, {
      id,
      systemPrompt: opts.systemPrompt,
      provider: providerName,
      model: opts.model,
      workdir: opts.cwd ?? process.cwd(),
    });
  }

  let hasPrimaryError = false;
  try {
    if (systemPromptToAppend !== undefined) {
      await session.append({ type: "system", payload: { content: systemPromptToAppend } });
    }

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

    yield* query(ctx, opts.input, {
      maxTurns: opts.maxTurns ?? 10,
      maxCostUsd: opts.maxCostUsd,
    });
  } catch (error) {
    hasPrimaryError = true;
    throw error;
  } finally {
    try {
      await session.close();
    } catch (error) {
      if (!hasPrimaryError) throw error;
    }
  }
}
