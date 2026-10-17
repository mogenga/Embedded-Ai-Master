import os from "node:os";
import path from "node:path";

export function resolveHarnessHome(env: NodeJS.ProcessEnv = process.env): string {
  const configuredHome = env.HARNESS_HOME;
  return configuredHome?.trim() ? configuredHome : path.join(os.homedir(), ".harness");
}
