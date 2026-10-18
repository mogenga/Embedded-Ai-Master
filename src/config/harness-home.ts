import os from "node:os";
import path from "node:path";

export function resolveHarnessHome(env: NodeJS.ProcessEnv = process.env): string {
  const configuredHome = env.HARNESS_HOME?.trim();
  return configuredHome ? configuredHome : path.join(os.homedir(), ".harness");
}
