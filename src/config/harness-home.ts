import os from "node:os";
import path from "node:path";

export function resolveHarnessHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.HARNESS_HOME ?? path.join(os.homedir(), ".harness");
}
