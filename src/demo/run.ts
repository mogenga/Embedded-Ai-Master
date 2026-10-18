import { randomUUID } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveHarnessHome } from "../config/harness-home.js";
import { loadProviders, resolveModelRef } from "../config/providers.js";
import type { ProvidersConfig } from "../config/providers.js";
import { runSession } from "../index.js";
import type { PricePerMillion } from "../loop/breakers.js";
import { computeCostUsd } from "../loop/breakers.js";
import type { LoopFinishReason } from "../loop/events.js";
import { readSessionFile } from "../session/session.js";

const USAGE = `用法: node dist/demo/run.js [--help] <prompt>

环境变量:
  HARNESS_COMPAT_MODEL        必填, 形如 <provider>/<model>
  HARNESS_HOME                harness 数据目录
  HARNESS_COMPAT_BASE_URL     覆盖 provider 的 baseUrl
  HARNESS_COMPAT_API_KEY_ENV  覆盖 provider 的 apiKeyEnv

退出码: 0 正常完成, 1 熔断, 130 取消, 2 用法/装配/运行期未恢复错误`;

export type ParsedArgs =
  | { kind: "help" }
  | { kind: "run"; prompt: string }
  | { kind: "error"; message: string };

export function parseArgs(argv: readonly string[]): ParsedArgs {
  if (argv.includes("--help")) return { kind: "help" };
  const positional: string[] = [];
  for (const arg of argv) {
    if (arg.startsWith("-")) return { kind: "error", message: `未知参数: ${arg}` };
    positional.push(arg);
  }
  if (positional.length === 0) return { kind: "error", message: "缺少 prompt" };
  if (positional.length > 1) return { kind: "error", message: "只能提供一个 prompt" };
  return { kind: "run", prompt: positional[0] };
}

export function resolveModelRefFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const value = env.HARNESS_COMPAT_MODEL;
  return value !== undefined && value.trim() !== "" ? value.trim() : undefined;
}

export function withOverrides(
  providers: ProvidersConfig,
  providerName: string,
  env: NodeJS.ProcessEnv,
): ProvidersConfig {
  const next = structuredClone(providers);
  const provider = next[providerName];
  const baseUrl = env.HARNESS_COMPAT_BASE_URL;
  const apiKeyEnv = env.HARNESS_COMPAT_API_KEY_ENV;
  if (baseUrl !== undefined && baseUrl.trim() !== "") provider.baseUrl = baseUrl.trim();
  if (apiKeyEnv !== undefined && apiKeyEnv.trim() !== "") provider.apiKeyEnv = apiKeyEnv.trim();
  return next;
}

export interface SessionCost {
  cost: number;
  priced: boolean;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
}

export function sessionCost(filePath: string, price?: PricePerMillion): SessionCost | undefined {
  try {
    let cost = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let cachedTokens = 0;
    for (const event of readSessionFile(filePath)) {
      if (event.type !== "usage") continue;
      const payload = event.payload;
      const prompt = typeof payload.promptTokens === "number" ? payload.promptTokens : 0;
      const completion =
        typeof payload.completionTokens === "number" ? payload.completionTokens : 0;
      const cached = typeof payload.cachedTokens === "number" ? payload.cachedTokens : undefined;
      promptTokens += prompt;
      completionTokens += completion;
      if (cached !== undefined) cachedTokens += cached;
      cost += computeCostUsd(
        {
          promptTokens: prompt,
          completionTokens: completion,
          ...(cached === undefined ? {} : { cachedTokens: cached }),
        },
        price,
      );
    }
    return {
      cost,
      priced: price !== undefined,
      promptTokens,
      completionTokens,
      cachedTokens,
    };
  } catch {
    return undefined;
  }
}

export function resolveExitCode(
  finishReason: LoopFinishReason | undefined,
  error?: unknown,
): number {
  if (error !== undefined) return 2;
  if (finishReason === "no_tool_calls") return 0;
  if (finishReason === "aborted") return 130;
  return 1;
}

function errorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return (error as { code: string }).code;
  }
  if (error instanceof Error && error.name) return error.name;
  return "error";
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.kind === "help") {
    console.log(USAGE);
    return 0;
  }
  if (parsed.kind === "error") {
    console.error(parsed.message);
    console.error(USAGE);
    return 2;
  }

  const modelRef = resolveModelRefFromEnv();
  if (modelRef === undefined) {
    console.error("缺少 HARNESS_COMPAT_MODEL");
    console.error(USAGE);
    return 2;
  }

  const home = resolveHarnessHome();
  const providers = loadProviders(home);
  const resolved = resolveModelRef(providers, modelRef);
  const overridden = withOverrides(providers, resolved.providerName, process.env);
  const id = randomUUID();
  const sessionDir = path.join(home, "sessions", id);

  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  let turns = 0;
  let finishReason: LoopFinishReason | undefined;
  try {
    for await (const event of runSession({
      input: parsed.prompt,
      model: modelRef,
      sessionId: id,
      sessionDir,
      providersText: JSON.stringify(overridden),
      signal: controller.signal,
    })) {
      switch (event.kind) {
        case "model_message":
          turns += 1;
          console.log(`[model] ${event.content}`);
          break;
        case "tool_use":
          console.log(`[tool] ${event.name}`);
          break;
        case "tool_result":
          console.log(`[tool_result] ${event.ok ? "ok" : "error"} ${event.text}`);
          break;
        case "compacted":
          console.log("[compacted]");
          break;
        case "interrupted":
          console.log(`[interrupted] ${event.reason}`);
          break;
        case "done":
          finishReason = event.finishReason;
          console.log(`[done] ${event.finishReason}`);
          break;
        case "turn_end":
          break;
      }
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }

  console.log(`turns: ${turns}`);
  const summary = sessionCost(
    path.join(sessionDir, "session.v1.jsonl"),
    resolved.provider.pricePerMillion,
  );
  if (summary === undefined) {
    console.error("警告: 无法读取会话日志，token 与费用统计未知");
    console.log("tokens: unknown");
    console.log("cost: unknown (log unreadable)");
  } else {
    console.log(
      `tokens: prompt=${summary.promptTokens} completion=${summary.completionTokens} cached=${summary.cachedTokens}`,
    );
    console.log(
      summary.priced ? `cost: $${summary.cost.toFixed(6)}` : "cost: unknown (no price)",
    );
  }

  return resolveExitCode(finishReason);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(
        `${errorCode(error)}: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = resolveExitCode(undefined, error);
    },
  );
}
