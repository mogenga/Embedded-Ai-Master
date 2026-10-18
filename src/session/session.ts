import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, open, rm, stat } from "node:fs/promises";
import path from "node:path";
import { SessionResumeError } from "./errors.js";
import {
  createHandle,
  deepFreeze,
  openSessionHandle,
  resolveGenerationThresholdBytes,
  writeHeaderAtomic,
} from "./handle.js";
import type { SessionHandle } from "./handle.js";
import { readSessionDir } from "./persistence.js";
import type { SessionEvent, SessionHeader } from "./types.js";

export { openSessionHandle } from "./handle.js";
export type { SessionHandle, UsageTotals } from "./handle.js";

async function assertSessionExists(dir: string, headerPath: string): Promise<void> {
  try {
    await stat(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SessionResumeError("missing_session_dir", `Session directory not found: ${dir}`, {
        dir,
      });
    }
    throw error;
  }
  try {
    await stat(headerPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SessionResumeError("missing_session_dir", `Session header not found: ${headerPath}`, {
        dir,
        file: path.basename(headerPath),
      });
    }
    throw error;
  }
}

export async function createSession(
  sessionDir: string,
  opts: {
    systemPrompt?: string;
    id?: string;
    provider?: string;
    model?: string;
    workdir?: string;
    generationThresholdBytes?: number;
  } = {},
): Promise<SessionHandle> {
  const generationThresholdBytes = resolveGenerationThresholdBytes(
    opts.generationThresholdBytes,
  );
  const id = opts.id ?? randomUUID();
  const dir = path.resolve(sessionDir);
  const header: SessionHeader = {
    id,
    createdAt: new Date().toISOString(),
    status: "open",
    ...(opts.provider === undefined ? {} : { provider: opts.provider }),
    ...(opts.model === undefined ? {} : { model: opts.model }),
    ...(opts.workdir === undefined ? {} : { workdir: opts.workdir }),
  };
  await mkdir(dir, { recursive: true });
  const headerPath = path.join(dir, "header.json");
  const logPath = path.join(dir, "session.v1.jsonl");
  let headerCreated = false;
  let logCreated = false;
  try {
    const headerFile = await open(headerPath, "wx");
    headerCreated = true;
    try {
      await headerFile.writeFile(`${JSON.stringify(header)}\n`, "utf8");
    } finally {
      await headerFile.close();
    }
    const logFile = await open(logPath, "wx");
    logCreated = true;
    await logFile.close();
  } catch (error) {
    if (logCreated) await rm(logPath, { force: true });
    if (headerCreated) await rm(headerPath, { force: true });
    throw new Error(`Session already exists or initialization failed: ${String(error)}`, { cause: error });
  }

  const handle = openSessionHandle(dir, header, [], {
    generationThresholdBytes,
  });

  if (opts.systemPrompt !== undefined) {
    await handle.append({ type: "system", payload: { content: opts.systemPrompt } });
  }
  return handle;
}

export async function resumeSession(
  sessionDir: string,
  opts: { generationThresholdBytes?: number } = {},
): Promise<SessionHandle> {
  const generationThresholdBytes = resolveGenerationThresholdBytes(
    opts.generationThresholdBytes,
  );
  const dir = path.resolve(sessionDir);
  const headerPath = path.join(dir, "header.json");
  await assertSessionExists(dir, headerPath);
  const { header, events, logFiles } = readSessionDir(dir);
  const lastLog = logFiles[logFiles.length - 1];
  const logPath = path.join(dir, lastLog);
  const { size } = await stat(logPath);
  const openHeader = await writeHeaderAtomic(headerPath, { ...header, status: "open" });
  for (const event of events) deepFreeze(event);
  return createHandle(dir, openHeader, events, logPath, {
    generationThresholdBytes,
    currentBytes: size,
  });
}

export function readSessionFile(filePath: string): SessionEvent[] {
  const content = readFileSync(filePath, "utf8");
  return content
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as SessionEvent);
}
