import { lstatSync, readFileSync, statSync } from "node:fs";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import type { Dirent } from "node:fs";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import path from "node:path";
import { resolveHarnessHome } from "../config/harness-home.js";
import { SessionCorruptionError } from "../session/errors.js";
import { validateHeader } from "../session/handle.js";
import { listSessionLogFiles, readSessionDir } from "../session/persistence.js";
import type { SessionEvent, SessionHeader } from "../session/types.js";

export interface ApiOptions {
  harnessHome?: string;
  staticRoot?: string;
  port?: number;
}

export interface SessionSummary {
  id: string;
  createdAt: string;
  status: "open" | "closed";
  model?: string;
  workdir?: string;
}

export interface KbNode {
  name: string;
  path: string;
  kind: "dir" | "file";
  children?: KbNode[];
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
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

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(payload));
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}

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
  if (!SESSION_ID_PATTERN.test(id) || id === "." || id === "..") {
    throw new HttpError(400, "invalid_session_id", "非法的会话 id");
  }
}

function requireMethod(method: string, expected: string): void {
  if (method !== expected) {
    throw new HttpError(405, "method_not_allowed", "不支持的请求方法");
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

export function readSessionHeader(dir: string): SessionHeader {
  const file = path.join(dir, "header.json");
  try {
    const info = lstatSync(file);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new SessionCorruptionError("invalid_header", `Invalid session header: ${file}`, {
        file: "header.json",
      });
    }
    const header = validateHeader(JSON.parse(readFileSync(file, "utf8")));
    if (listSessionLogFiles(dir).length === 0) {
      throw new SessionCorruptionError("invalid_header", `Session has no log files: ${dir}`, {
        dir,
      });
    }
    return header;
  } catch (error) {
    if (error instanceof SessionCorruptionError) throw error;
    if (isPermissionError(error)) throw error;
    throw new SessionCorruptionError("invalid_header", `Invalid session header: ${file}`, {
      file: "header.json",
      cause: error,
    });
  }
}

function summarize(header: SessionHeader): SessionSummary {
  return {
    id: header.id,
    createdAt: header.createdAt,
    status: header.status,
    ...(header.model === undefined ? {} : { model: header.model }),
    ...(header.workdir === undefined ? {} : { workdir: header.workdir }),
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
    if (!SESSION_ID_PATTERN.test(dir) || dir === "." || dir === "..") {
      errors.push({ dir, code: "invalid_id" });
      continue;
    }
    try {
      const header = readSessionHeader(path.join(sessionsDir, dir));
      sessions.push({ ...summarize(header), id: dir });
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
    result = readSessionDir(realTarget);
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
  const isIndex = decoded === "/" || decoded === "/web/index.html";
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
  const target = isIndex
    ? path.join(staticRoot, "web", "index.html")
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
        requireMethod(method, "GET");
        await handleSession(res, harnessHome, sessionMatch[1]);
        return;
      }
      if (pathname === "/api/kb") {
        requireMethod(method, "GET");
        await handleKb(res, harnessHome);
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
        throw new HttpError(501, "action_not_implemented", "写操作尚未实现");
      }
      if (pathname === "/api/events") {
        requireMethod(method, "GET");
        throw new HttpError(501, "event_stream_not_implemented", "事件流尚未实现");
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
  const handler = createApiHandler({ ...opts, port });
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  server.listen(port, host);
  return {
    server,
    port,
    close(): Promise<void> {
      return new Promise((resolve) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close(() => resolve());
        server.closeIdleConnections();
      });
    },
  };
}