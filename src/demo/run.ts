import { randomUUID } from "node:crypto";
import path from "node:path";
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

退出码: 0 正常完成, 1 熔断, 130 取消, 2 用法或装配错误`;

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

function withOverrides(providers: ProvidersConfig, providerName: string): ProvidersConfig {
  const next = structuredClone(providers);
  const provider = next[providerName];
  const baseUrl = process.env.HARNESS_COMPAT_BASE_URL;
  const apiKeyEnv = process.env.HARNESS_COMPAT_API_KEY_ENV;
  if (baseUrl !== undefined && baseUrl !== "") provider.baseUrl = baseUrl;
  if (apiKeyEnv !== undefined && apiKeyEnv !== "") provider.apiKeyEnv = apiKeyEnv;
  return next;
}

function sessionCost(filePath: string, price?: PricePerMillion): number {
  let cost = 0;
  for (const event of readSessionFile(filePath)) {
    if (event.type !== "usage") continue;
    const payload = event.payload;
    const promptTokens = typeof payload.promptTokens === "number" ? payload.promptTokens : 0;
    const completionTokens =
      typeof payload.completionTokens === "number" ? payload.completionTokens : 0;
    const cachedTokens = typeof payload.cachedTokens === "number" ? payload.cachedTokens : undefined;
    cost += computeCostUsd(
      {
        promptTokens,
        completionTokens,
        ...(cachedTokens === undefined ? {} : { cachedTokens }),
      },
      price,
    );
  }
  return cost;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(USAGE);
    return 0;
  }

  const prompt = args.find((arg) => !arg.startsWith("-"));
  const modelRef = process.env.HARNESS_COMPAT_MODEL;
  if (prompt === undefined || modelRef === undefined || modelRef === "") {
    console.error(USAGE);
    return 2;
  }

  const home = resolveHarnessHome();
  const providers = loadProviders(home);
  const resolved = resolveModelRef(providers, modelRef);
  const overridden = withOverrides(providers, resolved.providerName);
  const sessionDir = path.join(home, "sessions", randomUUID());

  let turns = 0;
  let finishReason: LoopFinishReason | undefined;
  for await (const event of runSession({
    input: prompt,
    model: modelRef,
    providersText: JSON.stringify(overridden),
    sessionDir,
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

  let cost = 0;
  try {
    cost = sessionCost(
      path.join(sessionDir, "session.v1.jsonl"),
      resolved.provider.pricePerMillion,
    );
  } catch {}
  console.log(`turns: ${turns}`);
  console.log(`cost: $${cost.toFixed(6)}`);

  if (finishReason === "no_tool_calls") return 0;
  if (finishReason === "aborted") return 130;
  return 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(`${errorCode(error)}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  },
);