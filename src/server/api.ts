import { statSync } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { Dirent } from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import path from "node:path";
import { resolveHarnessHome } from "../config/harness-home.js";
import { createLogTailEventSource } from "../events/log-tail.js";
import type { SessionEventSource } from "../events/types.js";
import { SessionCorruptionError } from "../session/errors.js";
import { isValidSessionId } from "../session/handle.js";
import { readSessionMeta } from "../session/metadata.js";
import {
  listSessionLogFiles,
  readSessionDir,
  readSessionHeader as persistenceReadSessionHeader,
  readSessionSnapshot,
} from "../session/persistence.js";
import type { SessionEvent, SessionHeader } from "../session/types.js";
import { readJsonBody } from "./body.js";
import { createConfigApi } from "./config-api.js";
import { createEventStreamHandler } from "./event-stream.js";
import {
  listDirectory,
  listSessionArtifacts,
  readFilePreview,
  registerWorkspaceRoot,
} from "./files-api.js";
import { HttpError, sendError, sendJson } from "./http.js";
import { createSessionAdmin } from "./session-admin.js";
import type { PermissionPreset } from "../permissions/types.js";
import { createSessionRunner, RunnerError } from "./runner.js";
import type { SessionRunner } from "./runner.js";

export interface ApiOptions {
  harnessHome?: string;
  staticRoot?: string;
  port?: number;
  eventSource?: SessionEventSource;
  runner?: SessionRunner;
  model?: string;
  fetchImpl?: typeof fetch;
}

export interface SessionSummary {
  id: string;
  createdAt: string;
  status: "open" | "closed";
  model?: string;
  workdir?: string;
  /**
   * Operator-assigned metadata from `meta.json`.
   *
   * The header is the kernel's own record and its validator drops unknown
   * fields, so a title cannot live there. `updatedAt` falls back to
   * `createdAt` for a session that was never renamed.
   */
  title?: string;
  pinned?: boolean;
  archived?: boolean;
  updatedAt?: string;
}

export interface KbNode {
  name: string;
  path: string;
  kind: "dir" | "file";
  children?: KbNode[];
}

const KB_MAX_DEPTH = 8;

const KB_MAX_ENTRIES = 2000;

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function isLoopbackHostname(hostname: string): boolean {
  return (
    hostname === "127.0.0.1"
    || hostname === "localhost"
    || hostname === "::1"
    || hostname === "[::1]"
  );
}

function requireLocalRequest(req: IncomingMessage, port: number | undefined): void {
  const hostHeader = req.headers.host;
  if (hostHeader !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(`http://${hostHeader}`);
    } catch {
      throw new HttpError(403, "forbidden_host", "Host 非法");
    }
    if (!isLoopbackHostname(parsed.hostname)) {
      throw new HttpError(403, "forbidden_host", "Host 必须是 loopback 地址");
    }
    if (port !== undefined) {
      const hostPort = parsed.port === "" ? 80 : Number(parsed.port);
      if (hostPort !== port) {
        throw new HttpError(403, "forbidden_host", "Host 端口与监听端口不一致");
      }
    }
  }
  const origin = req.headers.origin;
  if (origin !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new HttpError(403, "forbidden_origin", "Origin 非法");
    }
    if (!isLoopbackHostname(parsed.hostname)) {
      throw new HttpError(403, "forbidden_origin", "Origin 必须是 loopback 地址");
    }
    if (port !== undefined) {
      const originPort = parsed.port === ""
        ? (parsed.protocol === "https:" ? 443 : 80)
        : Number(parsed.port);
      if (originPort !== port) {
        throw new HttpError(403, "forbidden_origin", "Origin 端口与监听端口不一致");
      }
    }
  }
}

function normalizeForCompare(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(normalizeForCompare(parent), normalizeForCompare(child));
  if (relative === "") return true;
  if (path.isAbsolute(relative)) return false;
  return relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

async function realpathOrNull(value: string): Promise<string | null> {
  try {
    return await realpath(value);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, "invalid_session_id", "非法的会话 id");
  }
}

function assertSessionId(id: string): void {
  if (!isValidSessionId(id)) {
    throw new HttpError(400, "invalid_session_id", "非法的会话 id");
  }
}

function requireMethod(method: string, expected: string): void {
  if (method !== expected) {
    throw new HttpError(405, "method_not_allowed", "不支持的请求方法");
  }
}

function requireWriteRequest(req: IncomingMessage, port: number | undefined): void {
  requireLocalRequest(req, port);
  // 浏览器跨源页面（含 localhost 上的 dev 代理页面）会自动带上该头；非浏览器客户端
  // 不发送它，仍由 Origin 校验兜底。
  if (req.headers["sec-fetch-site"] === "cross-site") {
    throw new HttpError(403, "forbidden_origin", "写请求不允许浏览器跨源发起");
  }
  if (req.headers.origin === undefined) {
    throw new HttpError(403, "forbidden_origin", "写请求必须携带 Origin");
  }
}

function requireRunner(runner: SessionRunner | undefined): SessionRunner {
  if (runner === undefined) {
    throw new HttpError(503, "runner_unavailable", "会话运行器不可用");
  }
  return runner;
}

function mapRunnerError(error: RunnerError): HttpError {
  switch (error.code) {
    case "invalid_text":
    case "invalid_session_id":
    case "invalid_mode":
    case "invalid_run_limits":
    case "invalid_cwd":
      return new HttpError(400, error.code, error.message);
    case "unknown_session":
      return new HttpError(404, error.code, error.message);
    case "session_busy":
      return new HttpError(409, error.code, error.message);
    case "session_corrupt":
    case "session_unreadable":
      return new HttpError(500, error.code, error.message);
    case "model_unavailable":
    case "session_start_timeout":
    case "runner_unavailable":
      return new HttpError(503, error.code, error.message);
  }
}

async function handleAction(
  req: IncomingMessage,
  res: ServerResponse,
  runner: SessionRunner,
): Promise<void> {
  const body = await readJsonBody(req);
  if (typeof body.text !== "string") {
    throw new HttpError(400, "invalid_body", "text 必须是字符串");
  }
  if (body.sessionId !== undefined && typeof body.sessionId !== "string") {
    throw new HttpError(400, "invalid_session_id", "sessionId 必须是字符串");
  }
  if (body.mode !== undefined && typeof body.mode !== "string") {
    throw new HttpError(400, "invalid_mode", "mode 必须是字符串");
  }
  // 只判类型；「目录存不存在、是不是目录」由 runner 判定并抛 invalid_cwd，
  // 因为它同时服务桌面宿主，规则只能有一份。
  if (body.cwd !== undefined && typeof body.cwd !== "string") {
    throw new HttpError(400, "invalid_cwd", "cwd 必须是字符串");
  }
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined;
  const mode = typeof body.mode === "string" ? body.mode : undefined;
  const cwd = typeof body.cwd === "string" ? body.cwd : undefined;
  const limits = readRunLimitsBody(body);
  let outcome: Awaited<ReturnType<SessionRunner["start"]>>;
  try {
    outcome = await runner.start({
      text: body.text,
      ...(sessionId === undefined ? {} : { sessionId }),
      ...(mode === undefined ? {} : { mode: mode as PermissionPreset }),
      ...(cwd === undefined ? {} : { cwd }),
      ...limits,
    });
  } catch (error) {
    if (error instanceof RunnerError) throw mapRunnerError(error);
    throw error;
  }
  sendJson(res, 202, outcome);
}

/**
 * Optional per-run limits from the request body.
 *
 * Type errors are caught here so a string where a number belongs is a 400
 * before a session is touched; the runner re-validates the same fields
 * because it is also called from the desktop host.
 */
function readRunLimitsBody(body: Record<string, unknown>): {
  maxTurns?: number;
  maxCostUsd?: number;
  timeoutMs?: number;
  systemPrompt?: string;
} {
  const limits: {
    maxTurns?: number;
    maxCostUsd?: number;
    timeoutMs?: number;
    systemPrompt?: string;
  } = {};
  for (const key of ["maxTurns", "maxCostUsd", "timeoutMs"] as const) {
    const value = body[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new HttpError(400, "invalid_run_limits", `${key} 必须是数字`);
    }
    limits[key] = value;
  }
  if (body.systemPrompt !== undefined) {
    if (typeof body.systemPrompt !== "string") {
      throw new HttpError(400, "invalid_run_limits", "systemPrompt 必须是字符串");
    }
    limits.systemPrompt = body.systemPrompt;
  }
  return limits;
}

/** Titles, pins and archives live beside the session, not in its header. */
async function handleSessionMeta(
  req: IncomingMessage,
  res: ServerResponse,
  harnessHome: string,
  rawId: string,
): Promise<void> {
  const id = decodeSegment(rawId);
  assertSessionId(id);
  const admin = createSessionAdmin({ harnessHome });
  const body = await readJsonBody(req);
  const outcome = await admin.update(id, body);
  sendJson(res, 200, outcome);
}

async function handleSessionDelete(
  res: ServerResponse,
  harnessHome: string,
  rawId: string,
): Promise<void> {
  const id = decodeSegment(rawId);
  assertSessionId(id);
  const admin = createSessionAdmin({ harnessHome });
  await admin.remove(id);
  sendJson(res, 200, { id, deleted: true });
}

async function handleSessionFork(
  req: IncomingMessage,
  res: ServerResponse,
  harnessHome: string,
  rawId: string,
): Promise<void> {
  const id = decodeSegment(rawId);
  assertSessionId(id);
  const admin = createSessionAdmin({ harnessHome });
  let body: Record<string, unknown> = {};
  // A fork from the UI's menu sends nothing; a body is only read when the
  // client actually sent bytes (a Content-Type header alone is common on
  // `fetch` calls with no payload, and parsing an empty stream would 400).
  const contentLength = Number(req.headers["content-length"] ?? "0");
  const hasBody = Number.isFinite(contentLength) && contentLength > 0;
  if (hasBody) body = await readJsonBody(req);
  const atSeq = body.atSeq;
  // A mistyped position must not silently fork at the end of the log: the
  // caller asked for a specific transcript state.
  if (atSeq !== undefined && (typeof atSeq !== "number" || !Number.isInteger(atSeq))) {
    throw new HttpError(400, "invalid_body", "atSeq 必须是整数");
  }
  const outcome = await admin.fork(id, atSeq);
  sendJson(res, 201, outcome);
}

async function handleAbort(
  req: IncomingMessage,
  res: ServerResponse,
  runner: SessionRunner,
): Promise<void> {
  const body = await readJsonBody(req);
  if (typeof body.sessionId !== "string" || !isValidSessionId(body.sessionId)) {
    throw new HttpError(400, "invalid_session_id", "sessionId 必须是合法的会话 id");
  }
  // Aborting a run that already finished is not an error: the click and the
  // finish can race, and a 404 would show a failure for a run that is gone.
  const aborted = runner.abort(body.sessionId);
  sendJson(res, 202, { sessionId: body.sessionId, aborted });
}

async function handleApproval(
  req: IncomingMessage,
  res: ServerResponse,
  runner: SessionRunner,
): Promise<void> {
  const body = await readJsonBody(req);
  if (
    typeof body.sessionId !== "string"
    || typeof body.requestId !== "string"
    || typeof body.decision !== "string"
  ) {
    throw new HttpError(400, "invalid_body", "sessionId/requestId/decision 必须是字符串");
  }
  if (!isValidSessionId(body.sessionId)) {
    throw new HttpError(400, "invalid_session_id", "非法的会话 id");
  }
  const requestId = body.requestId;
  if (!/^[\x20-\x7E]{1,200}$/.test(requestId)) {
    throw new HttpError(400, "invalid_body", "requestId 必须是 1..200 个可打印 ASCII 字符");
  }
  const decision = body.decision;
  if (decision !== "allow" && decision !== "deny") {
    throw new HttpError(400, "invalid_decision", "decision 必须是 allow 或 deny");
  }
  const outcome = await runner.decide(body.sessionId, requestId, decision);
  switch (outcome.kind) {
    case "accepted":
      sendJson(res, 202, { requestId, decision });
      return;
    case "duplicate":
      sendJson(res, 200, { requestId, decision, duplicate: true });
      return;
    case "unknown_session":
    case "unknown_request":
      throw new HttpError(404, outcome.kind, "审批请求不存在");
    case "already_decided":
      throw new HttpError(409, "already_decided", "审批请求已完成相反的决策");
    case "expired":
      throw new HttpError(410, "approval_expired", "审批请求已过期");
    case "runner_unavailable":
      throw new HttpError(503, "runner_unavailable", "会话运行器不可用");
  }
}

function isPermissionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EACCES" || code === "EPERM";
}

function isLinkedDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function permissionCause(error: unknown): unknown {
  const cause = (error as { detail?: { cause?: unknown } }).detail?.cause;
  return cause !== undefined && isPermissionError(cause) ? cause : undefined;
}

// 列表用的 header-only 读取:复用 persistence 的同一套校验,额外要求至少一个日志文件。
// persistence 会把底层错误包进 detail.cause;权限错误在此还原上抛,列表归入 unreadable
// 而不是损坏(D-070 的既有语义)。
export function readSessionHeader(dir: string): SessionHeader {
  let header: SessionHeader;
  try {
    header = persistenceReadSessionHeader(dir);
  } catch (error) {
    const cause = permissionCause(error);
    if (cause !== undefined) throw cause;
    throw error;
  }
  if (listSessionLogFiles(dir).length === 0) {
    throw new SessionCorruptionError("invalid_header", `Session has no log files: ${dir}`, {
      dir,
    });
  }
  return header;
}

function summarize(header: SessionHeader, dir: string): SessionSummary {
  const meta = readSessionMeta(dir);
  return {
    id: header.id,
    createdAt: header.createdAt,
    status: header.status,
    ...(header.model === undefined ? {} : { model: header.model }),
    ...(header.workdir === undefined ? {} : { workdir: header.workdir }),
    ...(meta.title === undefined ? {} : { title: meta.title }),
    ...(meta.pinned === undefined ? {} : { pinned: meta.pinned }),
    ...(meta.archived === undefined ? {} : { archived: meta.archived }),
    updatedAt: meta.updatedAt,
  };
}

async function handleSessions(res: ServerResponse, harnessHome: string): Promise<void> {
  const sessionsDir = path.join(harnessHome, "sessions");
  const sessions: SessionSummary[] = [];
  const errors: Array<{ dir: string; code: string }> = [];
  let entries: Dirent[] = [];
  try {
    entries = await readdir(sessionsDir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") errors.push({ dir: "sessions", code: "unreadable" });
  }
  for (const entry of entries) {
    const dir = entry.name;
    if (entry.isSymbolicLink()) {
      if (isLinkedDirectory(path.join(sessionsDir, dir))) {
        errors.push({ dir, code: "skipped_link" });
      }
      continue;
    }
    if (!entry.isDirectory()) continue;
    // 列表与详情必须用同一套 id 规则,否则列表会给出一个随后 400 的会话 id(D-069 邻接)。
    if (!isValidSessionId(dir)) {
      errors.push({ dir, code: "invalid_id" });
      continue;
    }
    try {
      const header = readSessionHeader(path.join(sessionsDir, dir));
      sessions.push({ ...summarize(header, path.join(sessionsDir, dir)), id: dir });
      if (header.id !== dir) errors.push({ dir, code: "id_mismatch" });
    } catch (error) {
      errors.push({
        dir,
        code: error instanceof SessionCorruptionError ? error.code : "unreadable",
      });
    }
  }
  sessions.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  sendJson(res, 200, { sessions, errors });
}

async function handleSession(
  res: ServerResponse,
  harnessHome: string,
  rawId: string,
): Promise<void> {
  const id = decodeSegment(rawId);
  assertSessionId(id);
  const sessionsDir = path.join(harnessHome, "sessions");
  const realRoot = await realpathOrNull(sessionsDir);
  if (realRoot === null) {
    throw new HttpError(404, "session_not_found", "会话不存在");
  }
  const realTarget = await realpathOrNull(path.join(sessionsDir, id));
  if (realTarget === null) {
    throw new HttpError(404, "session_not_found", "会话不存在");
  }
  if (!isInside(realRoot, realTarget)) {
    throw new HttpError(400, "invalid_session_id", "非法的会话 id");
  }
  let result: { header: SessionHeader; events: SessionEvent[] };
  try {
    const header = readSessionHeader(realTarget);
    result =
      header.status === "open"
        ? await readSessionSnapshot(realTarget, { allowTrailingPartial: true }).then(
            (snapshot) => ({ header: snapshot.header, events: snapshot.events }),
          )
        : readSessionDir(realTarget);
  } catch (error) {
    if (error instanceof SessionCorruptionError) {
      throw new HttpError(500, "session_corrupt", `会话数据损坏（${error.code}）`);
    }
    throw error;
  }
  sendJson(res, 200, { header: result.header, events: result.events });
}

function compareNames(left: Dirent, right: Dirent): number {
  return left.name.localeCompare(right.name);
}

async function scanKb(
  dir: string,
  depth: number,
  counter: { count: number },
): Promise<KbNode[]> {
  let entries: Dirent[] = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = entries.filter((entry) => entry.isDirectory()).sort(compareNames);
  const files = entries.filter((entry) => entry.isFile()).sort(compareNames);
  const nodes: KbNode[] = [];
  for (const entry of [...dirs, ...files]) {
    if (counter.count >= KB_MAX_ENTRIES) break;
    counter.count += 1;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const children = depth < KB_MAX_DEPTH ? await scanKb(full, depth + 1, counter) : [];
      nodes.push({ name: entry.name, path: full, kind: "dir", children });
    } else {
      nodes.push({ name: entry.name, path: full, kind: "file" });
    }
  }
  return nodes;
}

async function handleKb(res: ServerResponse, harnessHome: string): Promise<void> {
  const kbDir = path.join(harnessHome, "kb");
  const info = await stat(kbDir).catch(() => undefined);
  if (info === undefined || !info.isDirectory()) {
    sendJson(res, 200, { root: null, tree: [] });
    return;
  }
  const tree = await scanKb(kbDir, 1, { count: 0 });
  sendJson(res, 200, { root: kbDir, tree });
}

async function serveStatic(
  method: string,
  res: ServerResponse,
  pathname: string,
  staticRoot: string | undefined,
): Promise<void> {
  if (method !== "GET" && method !== "HEAD") {
    throw new HttpError(405, "method_not_allowed", "不支持的请求方法");
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, "invalid_path", "非法的路径");
  }
  // The ported desktop renderer is a directory of plain files whose entry is
  // `index.html`; the old Vite build nested it under `web/`. Accept both so a
  // stale dist-web keeps working during the transition.
  const isLegacyIndex = decoded === "/web/index.html";
  const isIndex = decoded === "/" || decoded === "/index.html" || isLegacyIndex;
  if (decoded.includes("\0") || (!isIndex && decoded.split(/[\\/]/).includes(".."))) {
    throw new HttpError(400, "invalid_path", "非法的路径");
  }
  if (staticRoot === undefined) {
    throw new HttpError(404, "not_found", "未找到");
  }
  const realRoot = await realpathOrNull(staticRoot);
  if (realRoot === null) {
    throw new HttpError(404, "not_found", "未找到");
  }
  const target = isLegacyIndex
    ? path.join(staticRoot, "web", "index.html")
    : isIndex
      ? path.join(staticRoot, "index.html")
      : path.join(staticRoot, decoded);
  const realTarget = await realpathOrNull(target);
  if (realTarget === null) {
    throw new HttpError(404, "not_found", "未找到");
  }
  if (!isInside(realRoot, realTarget)) {
    throw new HttpError(400, "invalid_path", "非法的路径");
  }
  const info = await stat(realTarget);
  if (!info.isFile()) {
    throw new HttpError(404, "not_found", "未找到");
  }
  const payload = await readFile(realTarget);
  const contentType =
    MIME_TYPES[path.extname(realTarget).toLowerCase()] ?? "application/octet-stream";
  res.statusCode = 200;
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Length", payload.byteLength);
  if (method === "HEAD") {
    res.end();
    return;
  }
  res.end(payload);
}

export function createApiHandler(
  opts: ApiOptions = {},
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const harnessHome = path.resolve(opts.harnessHome ?? resolveHarnessHome());
  const staticRoot = opts.staticRoot === undefined ? undefined : path.resolve(opts.staticRoot);
  const eventSource =
    opts.eventSource
    ?? createLogTailEventSource({ sessionsRoot: path.join(harnessHome, "sessions") });
  const eventStream = createEventStreamHandler({ eventSource });

  return async function handler(req, res): Promise<void> {
    try {
      const method = req.method ?? "GET";
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const pathname = url.pathname;
      if (pathname === "/api" || pathname.startsWith("/api/")) {
        requireLocalRequest(req, opts.port);
      }

      if (pathname === "/api/sessions") {
        requireMethod(method, "GET");
        await handleSessions(res, harnessHome);
        return;
      }
      const sessionMatch = /^\/api\/sessions\/([^/]+)$/.exec(pathname);
      if (sessionMatch !== null) {
        const id = sessionMatch[1];
        if (method === "GET") {
          await handleSession(res, harnessHome, id);
          return;
        }
        if (method === "PATCH") {
          requireWriteRequest(req, opts.port);
          await handleSessionMeta(req, res, harnessHome, id);
          return;
        }
        if (method === "DELETE") {
          requireWriteRequest(req, opts.port);
          await handleSessionDelete(res, harnessHome, id);
          return;
        }
        throw new HttpError(405, "method_not_allowed", "不支持的请求方法");
      }
      const forkMatch = /^\/api\/sessions\/([^/]+)\/fork$/.exec(pathname);
      if (forkMatch !== null) {
        requireMethod(method, "POST");
        requireWriteRequest(req, opts.port);
        await handleSessionFork(req, res, harnessHome, forkMatch[1]);
        return;
      }
      if (pathname === "/api/config") {
        const config = createConfigApi({ harnessHome });
        if (method === "GET") {
          sendJson(res, 200, config.get());
          return;
        }
        if (method === "PUT") {
          requireWriteRequest(req, opts.port);
          const body = await readJsonBody(req);
          if (typeof body.mcpServers !== "undefined") {
            const outcome = await config.putMcp({ servers: body.mcpServers });
            sendJson(res, 200, { ...config.get(), ...outcome });
            return;
          }
          if (typeof body.permissions !== "undefined") {
            const outcome = await config.putPermissions({ permissions: body.permissions });
            sendJson(res, 200, { ...config.get(), ...outcome });
            return;
          }
          if (typeof body.run !== "undefined") {
            const outcome = await config.putRun({ run: body.run });
            sendJson(res, 200, { ...config.get(), ...outcome });
            return;
          }
          if (typeof body.providers !== "undefined") {
            const outcome = await config.putProviders({ providers: body.providers });
            sendJson(res, 200, { ...config.get(), ...outcome });
            return;
          }
          throw new HttpError(
            400,
            "invalid_body",
            "PUT /api/config 需要 mcpServers、permissions、run 或 providers",
          );
        }
        throw new HttpError(405, "method_not_allowed", "不支持的请求方法");
      }
      if (pathname === "/api/kb") {
        requireMethod(method, "GET");
        await handleKb(res, harnessHome);
        return;
      }
      if (pathname === "/api/file") {
        requireMethod(method, "GET");
        const preview = await readFilePreview(harnessHome, url.searchParams.get("path"));
        sendJson(res, 200, preview);
        return;
      }
      if (pathname === "/api/tree") {
        requireMethod(method, "GET");
        const rawPath = url.searchParams.get("path");
        if (rawPath === null || rawPath.trim() === "") {
          throw new HttpError(400, "invalid_path", "path 必须是非空字符串");
        }
        const listing = await listDirectory(harnessHome, rawPath);
        sendJson(res, 200, listing);
        return;
      }
      if (pathname === "/api/workspace") {
        requireMethod(method, "POST");
        requireWriteRequest(req, opts.port);
        const body = await readJsonBody(req);
        // 登记的是「操作者刚打开的目录」；它随后成为 /api/tree 与 /api/file
        // 的可见边界，所以这里必须是目录，不能是任意一个存在的路径。
        if (typeof body.path !== "string") {
          throw new HttpError(400, "invalid_path", "path 必须是字符串");
        }
        const registered = await registerWorkspaceRoot(body.path);
        sendJson(res, 200, { path: registered });
        return;
      }
      const artifactMatch = /^\/api\/sessions\/([^/]+)\/artifacts$/.exec(pathname);
      if (artifactMatch !== null) {
        requireMethod(method, "GET");
        const artifacts = await listSessionArtifacts(
          harnessHome,
          decodeSegment(artifactMatch[1]),
        );
        sendJson(res, 200, { artifacts });
        return;
      }
      if (pathname === "/api/device") {
        requireMethod(method, "GET");
        sendJson(res, 200, {
          probe: "unknown",
          serial: "unknown",
          cpu: "unknown",
          backend: "unknown",
        });
        return;
      }
      if (pathname === "/api/actions") {
        requireMethod(method, "POST");
        requireWriteRequest(req, opts.port);
        await handleAction(req, res, requireRunner(opts.runner));
        return;
      }
      if (pathname === "/api/abort") {
        requireMethod(method, "POST");
        requireWriteRequest(req, opts.port);
        await handleAbort(req, res, requireRunner(opts.runner));
        return;
      }
      if (pathname === "/api/approvals") {
        requireMethod(method, "POST");
        requireWriteRequest(req, opts.port);
        await handleApproval(req, res, requireRunner(opts.runner));
        return;
      }
      if (pathname === "/api/events") {
        requireMethod(method, "GET");
        await eventStream(req, res);
        return;
      }
      if (pathname === "/api" || pathname.startsWith("/api/")) {
        throw new HttpError(404, "not_found", "接口不存在");
      }

      await serveStatic(method, res, pathname, staticRoot);
    } catch (error) {
      req.resume();
      if (res.headersSent) {
        res.end();
        return;
      }
      if (error instanceof HttpError) {
        sendError(res, error.status, error.code, error.message);
        return;
      }
      sendError(res, 500, "internal_error", "内部错误");
    }
  };
}

export function createUiServer(
  opts: ApiOptions & { port?: number; host?: string } = {},
): { server: Server; port: number; close(): Promise<void> } {
  const port = opts.port ?? 5174;
  const host = opts.host ?? "127.0.0.1";
  const harnessHome = path.resolve(opts.harnessHome ?? resolveHarnessHome());
  const internalRunner = opts.runner === undefined
    ? createSessionRunner({
        harnessHome,
        ...(opts.model === undefined ? {} : { model: opts.model }),
        ...(opts.fetchImpl === undefined ? {} : { fetchImpl: opts.fetchImpl }),
      })
    : undefined;
  const handler = createApiHandler({
    ...opts,
    harnessHome,
    port,
    ...(internalRunner === undefined ? {} : { runner: internalRunner }),
  });
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  server.listen(port, host);
  return {
    server,
    port,
    async close(): Promise<void> {
      await new Promise<void>((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
        server.closeIdleConnections();
        server.closeAllConnections();
      });
      if (internalRunner !== undefined) await internalRunner.close();
    },
  };
}