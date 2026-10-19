import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { resolveHarnessHome } from "./config/harness-home.js";
import { loadProviders, parseProviders, resolveModelRef } from "./config/providers.js";
import { checkBudget, checkBudgetTokens } from "./context/budget.js";
import {
  assertCompactionRatios,
  assertKeepRecentTurns,
  compactSession,
} from "./context/compact.js";
import { createTokenMeter } from "./context/token-meter.js";
import type { TokenMeter } from "./context/token-meter.js";
import type { LoopEvent } from "./loop/events.js";
import { query } from "./loop/query.js";
import type { LoopCtx } from "./loop/query.js";
import { loadMcpConfig } from "./mcp/config.js";
import { McpConfigError } from "./mcp/errors.js";
import { McpManager } from "./mcp/manager.js";
import type { McpStatusEvent } from "./mcp/manager.js";
import { createMcpTools } from "./mcp/tools.js";
import type { McpToolAdapterStatus } from "./mcp/tools.js";
import { heuristicCountTokens } from "./model/count.js";
import { createOpenAIProvider } from "./model/openai.js";
import { SessionResumeError } from "./session/errors.js";
import { readSessionDir } from "./session/persistence.js";
import { createSession, resumeSession } from "./session/session.js";
import type { SessionHandle } from "./session/session.js";
import { createBuiltinTools } from "./tools/builtin.js";
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
  compaction?: {
    enabled?: boolean;
    keepRecentTurns?: number;
    keepTailRatio?: number;
    softRatio?: number;
  };
  mcp?: {
    enabled?: boolean;
    userConfigPath?: string;
    projectConfigPath?: string;
    trustProjectConfig?: boolean;
  };
}

interface McpSessionStatus {
  status:
    | "mcp_connected"
    | "mcp_connect_failed"
    | "mcp_tools_changed"
    | "mcp_tools_refresh_failed"
    | "mcp_tool_invalid_schema"
    | "mcp_tool_name_renamed"
    | "mcp_config_failed"
    | "mcp_project_config_skipped";
  server?: string;
  tool?: string;
  name?: string;
  originalName?: string;
  scope?: "global";
  toolCount?: number;
  message?: string;
}

function toSessionMcpStatus(event: McpStatusEvent): McpSessionStatus | undefined {
  switch (event.kind) {
    case "connected":
      return { status: "mcp_connected", server: event.server, toolCount: event.toolCount };
    case "connect_failed":
      return { status: "mcp_connect_failed", server: event.server, message: event.message };
    case "tools_changed":
      return { status: "mcp_tools_changed", server: event.server, toolCount: event.toolCount };
    case "tools_refresh_failed":
      return {
        status: "mcp_tools_refresh_failed",
        server: event.server,
        message: event.message,
      };
    case "tool_invalid_schema":
      return {
        status: "mcp_tool_invalid_schema",
        server: event.server,
        tool: event.tool,
        message: event.message,
      };
    default:
      return undefined;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  cwd: string;
}

function sameWorkdir(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
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

  if (
    header.workdir !== undefined
    && opts.cwd !== undefined
    && !sameWorkdir(header.workdir, opts.cwd)
  ) {
    throw new SessionResumeError(
      "workdir_mismatch",
      `Session workdir ${header.workdir} does not match requested cwd ${opts.cwd}`,
      { expected: opts.cwd, actual: header.workdir },
    );
  }

  const cwd = path.resolve(opts.cwd ?? header.workdir ?? process.cwd());

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
  return systemPromptToAppend === undefined
    ? { session, cwd }
    : { session, systemPromptToAppend, cwd };
}

export async function* runSession(opts: RunOptions): AsyncGenerator<LoopEvent> {
  if (opts.sessionId !== undefined) assertSessionId(opts.sessionId);
  const compaction = opts.compaction;
  if (compaction?.enabled !== undefined && typeof compaction.enabled !== "boolean") {
    throw new TypeError(`compaction.enabled must be a boolean; got ${typeof compaction.enabled}`);
  }

  const rawMcp: unknown = opts.mcp;
  if (rawMcp !== undefined) {
    const proto =
      typeof rawMcp === "object" && rawMcp !== null ? Object.getPrototypeOf(rawMcp) : undefined;
    if (
      typeof rawMcp !== "object" ||
      rawMcp === null ||
      Array.isArray(rawMcp) ||
      (proto !== Object.prototype && proto !== null)
    ) {
      throw new TypeError(`mcp must be an object; got ${rawMcp === null ? "null" : typeof rawMcp}`);
    }
  }
  if (opts.mcp?.enabled !== undefined && typeof opts.mcp.enabled !== "boolean") {
    throw new TypeError(`mcp.enabled must be a boolean; got ${typeof opts.mcp.enabled}`);
  }
  if (
    opts.mcp?.trustProjectConfig !== undefined
    && typeof opts.mcp.trustProjectConfig !== "boolean"
  ) {
    throw new TypeError(
      `mcp.trustProjectConfig must be a boolean; got ${typeof opts.mcp.trustProjectConfig}`,
    );
  }
  const compactionEnabled = compaction?.enabled !== false;
  if (compactionEnabled) {
    assertCompactionRatios(compaction?.keepTailRatio ?? 0.16, compaction?.softRatio ?? 0.8);
    assertKeepRecentTurns(compaction?.keepRecentTurns ?? 2);
  }
  if (opts.sessionDir !== undefined) {
    if (opts.sessionDir === "") {
      throw new SessionResumeError("invalid_target", "sessionDir must not be empty", {
        dir: opts.sessionDir,
      });
    }
    try {
      const info = await stat(opts.sessionDir);
      if (!info.isDirectory()) {
        throw new SessionResumeError(
          "invalid_target",
          `Session path is not a directory: ${opts.sessionDir}`,
          { dir: opts.sessionDir },
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
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
    ...(provider.requestTimeoutMs !== undefined
      ? { requestTimeoutMs: provider.requestTimeoutMs }
      : {}),
    ...(provider.maxResponseBytes !== undefined
      ? { maxResponseBytes: provider.maxResponseBytes }
      : {}),
  });

  const id = opts.sessionId ?? randomUUID();
  let session: SessionHandle;
  let systemPromptToAppend: string | undefined;
  let runCwd: string;

  if (resume && resumeDir !== undefined) {
    const plan = await planResume(resumeDir, opts);
    session = plan.session;
    systemPromptToAppend = plan.systemPromptToAppend;
    runCwd = plan.cwd;
  } else {
    const sessionDir = resumeDir ?? path.join(home, "sessions", id);
    runCwd = path.resolve(opts.cwd ?? process.cwd());
    session = await createSession(sessionDir, {
      id,
      systemPrompt: opts.systemPrompt,
      provider: providerName,
      model: opts.model,
      workdir: runCwd,
    });
  }

  let hasPrimaryError = false;
  let mcpManager: McpManager | undefined;
  let statusQueue: Promise<void> = Promise.resolve();
  let statusWriteFailure: unknown;
  const seenMcpStatuses = new Set<string>();
  const appendMcpStatus = (status: McpSessionStatus): void => {
    statusQueue = statusQueue
      .then(() => session.append({ type: "status", payload: { ...status } }))
      .then(
        () => undefined,
        (error: unknown) => {
          if (statusWriteFailure === undefined) {
            statusWriteFailure = error;
            console.error(`[mcp] status event append failed: ${messageOf(error)}`);
          }
        },
      );
  };
  const appendMcpStatusOnce = (key: string, status: McpSessionStatus): void => {
    if (seenMcpStatuses.has(key)) {
      return;
    }
    seenMcpStatuses.add(key);
    appendMcpStatus(status);
  };

  try {
    if (systemPromptToAppend !== undefined) {
      await session.append({ type: "system", payload: { content: systemPromptToAppend } });
    }

    const signal = opts.signal ?? new AbortController().signal;

    let meter: TokenMeter | undefined;
    let budget: LoopCtx["budget"];
    let compactor: LoopCtx["compactor"];

    if (compactionEnabled) {
      const softRatio = compaction?.softRatio ?? 0.8;
      const tokenMeter = createTokenMeter(heuristicCountTokens);
      meter = tokenMeter;
      budget = (messages) =>
        checkBudgetTokens(tokenMeter.measure(messages), model.contextWindow, softRatio);
      compactor = (target) =>
        compactSession({
          session: target,
          model: modelProtocol,
          modelCfg: model,

          signal,
          meter: tokenMeter,
          softRatio,
          ...(compaction?.keepRecentTurns !== undefined
            ? { keepRecentTurns: compaction.keepRecentTurns }
            : {}),
          ...(compaction?.keepTailRatio !== undefined
            ? { keepTailRatio: compaction.keepTailRatio }
            : {}),
        });
    } else {
      budget = (messages) => checkBudget(messages, model.contextWindow);
    }

    const builtinTools = createBuiltinTools();
    const registry = new ToolRegistry(builtinTools);

    if (opts.mcp?.enabled !== false) {
      try {
        const explicitProjectPath = opts.mcp?.projectConfigPath;
        const trustProject =
          opts.mcp?.trustProjectConfig === true || explicitProjectPath !== undefined;
        const defaultProjectPath = path.join(runCwd, ".harness", "mcp.json");
        if (!trustProject && existsSync(defaultProjectPath)) {
          appendMcpStatus({
            status: "mcp_project_config_skipped",
            message: defaultProjectPath,
          });
        }
        const servers = loadMcpConfig({
          home,
          workdir: runCwd,
          includeProject: trustProject,
          ...(opts.mcp?.userConfigPath !== undefined
            ? { userConfigPath: opts.mcp.userConfigPath }
            : {}),
          ...(explicitProjectPath !== undefined
            ? { projectConfigPath: explicitProjectPath }
            : {}),
        });
        if (servers.length > 0) {
          const manager = new McpManager(servers, {
            logger: (event) => {
              const status = toSessionMcpStatus(event);
              if (status !== undefined) appendMcpStatus(status);
            },
          });
          mcpManager = manager;
          const emitAdapterStatus = (status: McpToolAdapterStatus): void => {
            if (status.kind === "mcp_tool_invalid_schema") {
              appendMcpStatusOnce(`invalid:${status.server}\u0000${status.tool}`, {
                status: "mcp_tool_invalid_schema",
                server: status.server,
                tool: status.tool,
                message: status.message,
              });
              return;
            }
            appendMcpStatusOnce(
              `renamed:${status.server}\u0000${status.tool}\u0000${status.name}`,
              {
                status: "mcp_tool_name_renamed",
                server: status.server,
                tool: status.tool,
                name: status.name,
                originalName: status.originalName,
              },
            );
          };
          const rebuildMcpTools = (): void => {
            const pendingStatuses: McpToolAdapterStatus[] = [];
            try {
              const mcpTools = createMcpTools(manager, {
                reservedNames: builtinTools.map((tool) => tool.name),
                onStatus: (status) => pendingStatuses.push(status),
              });

              registry.replace([...builtinTools, ...mcpTools]);
            } catch (error) {
              appendMcpStatus({
                status: "mcp_tools_refresh_failed",
                scope: "global",
                message: messageOf(error),
              });
              return;
            }
            for (const status of pendingStatuses) emitAdapterStatus(status);
          };
          manager.onToolsChanged(() => rebuildMcpTools());
          await manager.connectAll();
          rebuildMcpTools();
        }
      } catch (error) {
        if (error instanceof McpConfigError) {
          appendMcpStatus({ status: "mcp_config_failed", message: error.message });
        } else {
          throw error;
        }
      }
    }

    const ctx: LoopCtx = {
      session,
      model: modelProtocol,
      modelCfg: model,
      tools: registry,
      budget,
      signal,
      artifactDir: path.join(session.dir, "artifacts"),
      cwd: runCwd,
      timeoutMs: opts.timeoutMs,
      pricePerMillion: provider.pricePerMillion,
      ...(meter !== undefined ? { meter } : {}),
      ...(compactor !== undefined ? { compactor } : {}),
    };

    yield* query(ctx, opts.input, {
      maxTurns: opts.maxTurns ?? 10,
      maxCostUsd: opts.maxCostUsd,
    });
  } catch (error) {
    hasPrimaryError = true;
    throw error;
  } finally {
    await statusQueue;

    let closeError: unknown;
    try {
      await mcpManager?.close();
    } catch (error) {
      if (!hasPrimaryError) closeError = error;
    }
    try {
      await session.close();
    } catch (error) {
      if (!hasPrimaryError && closeError === undefined) closeError = error;
    }
    if (closeError !== undefined && !hasPrimaryError) throw closeError;
  }
}
