import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, cpus, totalmem, freemem, loadavg } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { McEventBus } from "./events.js";
import type { McEvent } from "./events.js";
import type {
  AgentProgressState,
  CreateActivityInput,
  CreateAgentInput,
  CreateDeliverableInput,
  CreateEventInput,
  CreateTaskInput,
  CreateWorkspaceInput,
  MissionControlDB,
  TaskStatus,
  UpdateAgentInput,
  UpdateTaskInput,
  UpdateWorkspaceInput,
  UpsertProgressInput,
} from "./db.js";

export interface McLogger {
  info: (message: string, ...args: unknown[]) => void;
  error: (message: string, ...args: unknown[]) => void;
}

const consoleLogger: McLogger = { info: console.log, error: console.error };
const MAX_JSON_BODY_BYTES = Number.parseInt(process.env.MISSION_CONTROL_MAX_BODY_BYTES ?? "1048576", 10);

// Resolve a runtime helper script (swarm/*.py, health/*.py). Prefer the copy
// shipped in this repo so a fresh `git clone` works without first copying files
// into $MC_HOME; fall back to $MC_HOME for installs that keep runtime files
// separate from the source checkout.
function resolveRuntimePath(...segments: string[]): string {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const repoPath = join(repoRoot, ...segments);
  if (existsSync(repoPath)) return repoPath;
  const mcHome = process.env.MC_HOME ?? join(homedir(), ".mission-control");
  return join(mcHome, ...segments);
}

// Resolve the Python interpreter that runs the knowledge/health scripts. Prefer
// an explicit override, then the conventional Mission Control venv, then a
// plain `python3` on PATH so a documented `pip install context-fabrica` setup
// works without a venv.
function resolvePythonBin(): string {
  const override = (process.env.MC_PYTHON_BIN ?? "").trim();
  if (override) return override;
  const mcHome = process.env.MC_HOME ?? join(homedir(), ".mission-control");
  const venvPython = join(mcHome, "venv-3.12", "bin", "python3");
  if (existsSync(venvPython)) return venvPython;
  return "python3";
}

export async function parseBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;
    let rejected = false;
    req.on("data", (chunk: unknown) => {
      if (rejected) return;
      const text = String(chunk);
      bytes += Buffer.byteLength(text);
      if (bytes > MAX_JSON_BODY_BYTES) {
        rejected = true;
        req.pause();
        reject(new Error("Request body too large"));
        return;
      }
      body += text;
    });
    req.on("end", () => {
      if (rejected) return;
      try {
        if (!body.trim()) {
          resolve({});
          return;
        }
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("Malformed JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(data));
}

function isTruthyEnv(name: string): boolean {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function getReadAccessToken(): string {
  return (process.env.MISSION_CONTROL_ACCESS_TOKEN ?? process.env.MISSION_CONTROL_READ_ACCESS_TOKEN ?? "").trim();
}

function getAuthMode(): "simple" | "scoped" {
  return (process.env.MISSION_CONTROL_AUTH_MODE ?? "simple").trim().toLowerCase() === "scoped" ? "scoped" : "simple";
}

function firstToken(...names: string[]): string {
  for (const name of names) {
    const token = (process.env[name] ?? "").trim();
    if (token) return token;
  }
  return "";
}

function requiredAccessToken(url: URL, method: string): string {
  const defaultToken = getReadAccessToken();
  if (getAuthMode() !== "scoped") return defaultToken;

  const routePath = resolveApiRoutePath(url.pathname);
  const segments = routePath?.split("/").filter(Boolean) ?? [];
  if (segments[0] === "webhooks") {
    return firstToken("MISSION_CONTROL_WEBHOOK_SECRET", "MISSION_CONTROL_WRITE_TOKEN") || defaultToken;
  }
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return firstToken("MISSION_CONTROL_READ_TOKEN") || defaultToken;
  }
  if (method === "DELETE") {
    return firstToken("MISSION_CONTROL_ADMIN_TOKEN", "MISSION_CONTROL_WRITE_TOKEN") || defaultToken;
  }
  return firstToken("MISSION_CONTROL_WRITE_TOKEN") || defaultToken;
}

function hasAnyAccessToken(): boolean {
  return Boolean(
    firstToken(
      "MISSION_CONTROL_ACCESS_TOKEN",
      "MISSION_CONTROL_READ_ACCESS_TOKEN",
      "MISSION_CONTROL_READ_TOKEN",
      "MISSION_CONTROL_WRITE_TOKEN",
      "MISSION_CONTROL_ADMIN_TOKEN",
      "MISSION_CONTROL_WEBHOOK_SECRET",
    ),
  );
}

function extractProvidedToken(req: IncomingMessage, url: URL): string {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    return auth.slice(7).trim();
  }
  const queryToken = url.searchParams.get("token");
  return typeof queryToken === "string" ? queryToken.trim() : "";
}

function isAuthorized(req: IncomingMessage, url: URL): boolean {
  const required = requiredAccessToken(url, req.method ?? "GET");
  if (!required) return true;
  const provided = extractProvidedToken(req, url);
  const requiredBuffer = Buffer.from(required);
  const providedBuffer = Buffer.from(provided);
  return requiredBuffer.length === providedBuffer.length && timingSafeEqual(requiredBuffer, providedBuffer);
}

function getAllowedHosts(): Set<string> {
  const hosts = new Set<string>(["127.0.0.1", "localhost", "::1", "[::1]"]);
  const mcHost = (process.env.MC_HOST ?? "").trim().toLowerCase();
  if (mcHost) hosts.add(mcHost);
  const extra = process.env.MISSION_CONTROL_ALLOWED_HOSTS ?? "";
  for (const host of extra.split(",").map(value => value.trim().toLowerCase()).filter(Boolean)) {
    hosts.add(host);
  }
  return hosts;
}

function hostnameFromHostHeader(hostHeader: string): string | null {
  try {
    return new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// Anti DNS-rebinding. A malicious site that rebinds its DNS to 127.0.0.1 still
// sends its own name in the Host header, so requiring an allowlisted Host blocks
// the browser from reaching a local Mission Control instance. Clients that omit
// Host (some non-browser tooling) are allowed; remote deployments add their
// public hostname via MISSION_CONTROL_ALLOWED_HOSTS.
function isHostAllowed(req: IncomingMessage): boolean {
  const hostHeader = req.headers.host;
  if (!hostHeader) return true;
  const allowed = getAllowedHosts();
  if (allowed.has(hostHeader.toLowerCase())) return true;
  const hostname = hostnameFromHostHeader(hostHeader);
  if (!hostname) return false;
  const bare = hostname.replace(/^\[|\]$/g, "");
  return allowed.has(hostname) || allowed.has(bare) || allowed.has(`[${bare}]`);
}

// Anti-CSRF for state-changing requests. Browsers attach Sec-Fetch-Site (and
// Origin) to fetch/XHR: same-origin dashboard calls are allowed and cross-site
// calls are blocked. Non-browser clients (CLI, bridge, curl) send neither header
// and are allowed — when a token is configured they still must present it.
function isCsrfSafe(req: IncomingMessage, method: string): boolean {
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return true;

  const secFetchSite = req.headers["sec-fetch-site"];
  if (typeof secFetchSite === "string" && secFetchSite) {
    return secFetchSite === "same-origin" || secFetchSite === "same-site";
  }

  const origin = req.headers.origin;
  if (typeof origin === "string" && origin) {
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).hostname.toLowerCase();
    } catch {
      return false;
    }
    const allowed = getAllowedHosts();
    const bare = originHost.replace(/^\[|\]$/g, "");
    return allowed.has(originHost) || allowed.has(bare) || allowed.has(`[${bare}]`);
  }

  return true;
}

function requireStringField(body: Record<string, unknown>, field: string): string | null {
  const val = body[field];
  return typeof val === "string" && val.trim() ? val : null;
}

function parsePagination(url: URL): { limit: number; offset: number } {
  const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "100", 10);
  const rawOffset = Number.parseInt(url.searchParams.get("offset") ?? "0", 10);
  return {
    limit: Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 1000) : 100,
    offset: Number.isFinite(rawOffset) && rawOffset >= 0 ? rawOffset : 0,
  };
}

function parseIsoMs(value: unknown): number | null {
  if (typeof value !== "string" || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // Malformed → treat as unsafe.
  }
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast / reserved
  return false;
}

function isPrivateIpv6(address: string): boolean {
  const addr = address.toLowerCase().split("%")[0].replace(/^\[|\]$/g, "");
  if (addr === "::1" || addr === "::") return true;
  if (addr.startsWith("fe80")) return true; // link-local
  if (addr.startsWith("fc") || addr.startsWith("fd")) return true; // unique local
  const mapped = addr.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isPrivateIpv4(mapped[1]);
  return false;
}

function isPrivateAddress(family: number, address: string): boolean {
  return family === 6 ? isPrivateIpv6(address) : isPrivateIpv4(address);
}

// SSRF guard. Validates scheme, rejects embedded credentials, and — crucially —
// resolves the hostname and rejects if ANY resolved IP is loopback/private/
// link-local. DNS resolution catches both integer-encoded IP literals (e.g.
// http://2130706433/ == 127.0.0.1) and DNS-rebinding names that point inward.
async function assertPublicUrl(urlStr: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new Error("Invalid URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only http and https URLs are allowed");
  }
  if (parsed.username || parsed.password) {
    throw new Error("URLs with embedded credentials are not allowed");
  }
  const bareHost = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (bareHost === "localhost" || bareHost.endsWith(".local") || bareHost.endsWith(".internal")) {
    throw new Error("Local/internal hosts are not allowed");
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(bareHost, { all: true });
  } catch {
    throw new Error("Could not resolve host");
  }
  if (addresses.length === 0) {
    throw new Error("Could not resolve host");
  }
  for (const { family, address } of addresses) {
    if (isPrivateAddress(family, address)) {
      throw new Error("URL resolves to a private or loopback address");
    }
  }
  return parsed;
}

// Fetch a public URL, following redirects manually and re-validating every hop
// so a public URL cannot redirect into the private network.
async function fetchPublicUrl(initialUrl: string, maxRedirects = 4): Promise<Response> {
  let current = initialUrl;
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    await assertPublicUrl(current);
    const resp = await fetch(current, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; MissionControl/1.0)" },
      signal: AbortSignal.timeout(15000),
      redirect: "manual",
    });
    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get("location");
      if (!location) return resp;
      current = new URL(location, current).toString();
      continue;
    }
    return resp;
  }
  throw new Error("Too many redirects");
}

function sanitizeConfig(config: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...config };

  const claudeDefaults = { model: "claude-opus-4-6", fallbackModel: "", maxAgents: 10 };
  const codexDefaults = { model: "codex-mini", effort: "high", reviewEffort: "xhigh", maxAgents: 3 };
  const ciDefaults = { enabled: false, maxCycles: 3 };

  const rawClaude = isRecord(config.claude) ? config.claude : {};
  result.claude = {
    model: typeof rawClaude.model === "string" ? rawClaude.model : claudeDefaults.model,
    fallbackModel: typeof rawClaude.fallbackModel === "string" ? rawClaude.fallbackModel : claudeDefaults.fallbackModel,
    maxAgents:
      typeof rawClaude.maxAgents === "number" && Number.isFinite(rawClaude.maxAgents) && rawClaude.maxAgents >= 1 && rawClaude.maxAgents <= 20
        ? rawClaude.maxAgents
        : claudeDefaults.maxAgents,
  };

  const rawCodex = isRecord(config.codex) ? config.codex : {};
  result.codex = {
    model: typeof rawCodex.model === "string" ? rawCodex.model : codexDefaults.model,
    effort: typeof rawCodex.effort === "string" ? rawCodex.effort : codexDefaults.effort,
    reviewEffort: typeof rawCodex.reviewEffort === "string" ? rawCodex.reviewEffort : codexDefaults.reviewEffort,
    maxAgents:
      typeof rawCodex.maxAgents === "number" && Number.isFinite(rawCodex.maxAgents) && rawCodex.maxAgents >= 1 && rawCodex.maxAgents <= 20
        ? rawCodex.maxAgents
        : codexDefaults.maxAgents,
  };

  const rawCi = isRecord(config.ci) ? config.ci : {};
  let enabled = ciDefaults.enabled;
  if (typeof rawCi.enabled === "boolean") {
    enabled = rawCi.enabled;
  } else if (typeof rawCi.enabled === "string" && ["true", "false"].includes(rawCi.enabled.toLowerCase())) {
    enabled = rawCi.enabled.toLowerCase() === "true";
  }
  result.ci = {
    enabled,
    maxCycles:
      typeof rawCi.maxCycles === "number" && Number.isFinite(rawCi.maxCycles) && rawCi.maxCycles >= 1 && rawCi.maxCycles <= 5
        ? rawCi.maxCycles
        : ciDefaults.maxCycles,
  };

  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PROGRESS_STATES = ["running", "blocked", "waiting", "delegating", "done"] as const;

function sanitizeProgressInput(body: Record<string, unknown>): UpsertProgressInput {
  const out: UpsertProgressInput = {};
  if (typeof body.state === "string" && (PROGRESS_STATES as readonly string[]).includes(body.state)) {
    out.state = body.state as AgentProgressState;
  }
  if (typeof body.phase === "string") out.phase = body.phase;
  if (typeof body.step_label === "string") out.step_label = body.step_label;
  if (typeof body.step_index === "number" && Number.isFinite(body.step_index)) out.step_index = Math.floor(body.step_index);
  if (typeof body.step_total === "number" && Number.isFinite(body.step_total)) out.step_total = Math.floor(body.step_total);
  if (typeof body.blocked_reason === "string") out.blocked_reason = body.blocked_reason.slice(0, 2000);
  if (typeof body.detail === "string") out.detail = body.detail.slice(0, 2000);
  return out;
}

const TERMINAL_TASK_STATUSES = new Set(["review", "done"]);

// When a delegated child task reaches a terminal state, record the result on its
// parent and — if the parent was paused waiting on its children — resume the
// parent once every child is terminal. This lets a stuck agent spin up a
// specialist subtask and have the result flow back automatically.
function rollUpDelegation(db: MissionControlDB, childId: string, events?: McEventBus): void {
  const child = db.getTask(childId);
  if (!child || !child.parent_task_id) return;
  if (!TERMINAL_TASK_STATUSES.has(child.status)) return;
  const parent = db.getTask(child.parent_task_id);
  if (!parent) return;

  db.createActivity({
    task_id: parent.id,
    activity_type: "subtask_completed",
    message: `Delegated subtask "${child.title}" reached ${child.status}.`,
    metadata: JSON.stringify({ child_task_id: child.id, child_status: child.status }),
  });
  events?.emit("subtask_completed", { parentId: parent.id, childTaskId: child.id, childStatus: child.status });

  const siblings = db.listChildTasks(parent.id);
  const allTerminal = siblings.every((sibling) => TERMINAL_TASK_STATUSES.has(sibling.status));
  if (allTerminal && parent.status === "on_hold") {
    db.updateTask(parent.id, { status: "inbox" });
    db.upsertProgress(parent.id, { state: "running", blocked_reason: null });
    db.createActivity({
      task_id: parent.id,
      activity_type: "status_changed",
      message: "All delegated subtasks complete — resuming parent task.",
    });
    events?.emit("parent_resumed", { parentId: parent.id });
  }
}

type ResolveResult =
  | { ok: true; checkpoint: unknown }
  | { ok: false; code: number; error: string };

// Resolve a pending checkpoint and resume its task once nothing else blocks it
// on a human. Shared by the checkpoint-resolve route and objective approval.
function resolveCheckpointAndResume(
  db: MissionControlDB,
  events: McEventBus,
  checkpointId: string,
  decisionRaw: string,
  response?: string,
): ResolveResult {
  const existing = db.getCheckpoint(checkpointId);
  if (!existing) return { ok: false, code: 404, error: "Checkpoint not found" };

  const decisionMap: Record<string, "approved" | "rejected" | "answered"> = {
    approve: "approved",
    approved: "approved",
    reject: "rejected",
    rejected: "rejected",
    answer: "answered",
    answered: "answered",
    choose: "answered",
  };
  const newStatus = decisionMap[decisionRaw.toLowerCase()];
  if (!newStatus) return { ok: false, code: 400, error: "decision must be one of: approve, reject, answer" };

  const resolved = db.resolveCheckpoint(checkpointId, newStatus, response);
  if (!resolved) return { ok: false, code: 409, error: "Checkpoint is already resolved" };

  const taskId = resolved.task_id;
  db.createActivity({
    task_id: taskId,
    activity_type: "checkpoint_resolved",
    message: response ? `Checkpoint ${newStatus}: ${response}` : `Checkpoint ${newStatus}.`,
    metadata: JSON.stringify({ checkpoint_id: checkpointId, decision: newStatus }),
  });

  const task = db.getTask(taskId);
  if (task && task.status === "on_hold" && db.countPendingCheckpoints(taskId) === 0) {
    db.updateTask(taskId, { status: "inbox" });
    db.upsertProgress(taskId, { state: "running", blocked_reason: null });
    db.createActivity({
      task_id: taskId,
      activity_type: "status_changed",
      message: "Checkpoint resolved — resuming task.",
    });
  }
  events.emit("checkpoint_resolved", { taskId, checkpointId, decision: newStatus });
  return { ok: true, checkpoint: resolved };
}

const API_PREFIX = "/api";

function resolveApiRoutePath(pathname: string): string | null {
  if (pathname === API_PREFIX || pathname.startsWith(`${API_PREFIX}/`)) {
    return pathname.slice(API_PREFIX.length) || "/";
  }
  return null;
}

export async function getSwarmAgentStatusMap(
  logger: McLogger
): Promise<Record<string, Record<string, unknown>>> {
  const mcHome = process.env.MC_HOME ?? join(homedir(), ".mission-control");
  const registryPath = join(mcHome, "swarm", "active-tasks.json");
  // No swarm runtime yet (fresh install) — return an empty map instead of
  // throwing, so the dashboard board and agent-status endpoints work out of box.
  if (!existsSync(registryPath)) {
    return {};
  }
  const raw = readFileSync(registryPath, "utf-8");
  const entries = JSON.parse(raw) as Array<Record<string, unknown>>;

  let aliveSessions: Set<string> = new Set();
  try {
    const { execSync } = await import("node:child_process");
    const tmuxOut = execSync("tmux list-sessions -F '#{session_name}' 2>/dev/null || true", {
      encoding: "utf-8",
      timeout: 3000,
    });
    for (const line of tmuxOut.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) aliveSessions.add(trimmed);
    }
  } catch {
    logger.info("mission-control agent-status: no tmux sessions or tmux unavailable");
  }

  const byTask: Record<string, Record<string, unknown>> = {};
  for (const entry of entries) {
    const mcId = entry.mcTaskId as string;
    if (!mcId) continue;

    const tmuxName = entry.tmuxSession as string;
    const tmuxAlive = tmuxName ? aliveSessions.has(tmuxName) : false;
    const registryStatus = entry.status as string;

    let liveStatus = registryStatus;
    if (tmuxAlive && registryStatus !== "failed") {
      liveStatus = "running";
    } else if (!tmuxAlive && registryStatus === "running") {
      liveStatus = "completed_by_agent";
    }

    byTask[mcId] = {
      agent: entry.agent,
      status: registryStatus,
      liveStatus,
      tmuxAlive,
      tmuxSession: tmuxName,
      reviewCycles: entry.reviewCycles,
      retryCount: entry.retryCount,
      branch: entry.branch,
      startedAt: entry.startedAt,
      pr: entry.pr,
      changeRequestAt: entry.changeRequestAt,
      lastHeartbeatAt: entry.lastHeartbeatAt,
      heartbeatIntervalSec: entry.heartbeatIntervalSec,
    };
  }

  return byTask;
}

function getDashboardHtml(): string | null {
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const htmlPath = join(thisDir, "..", "public", "index.html");
    return readFileSync(htmlPath, "utf-8");
  } catch {
    return null;
  }
}

const STATIC_CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

// Serves a UI asset from public/. The path regex allows only a flat filename
// with a known extension — no slashes, no "..", so directory traversal is
// impossible. Returns true if it handled the request.
function serveStaticAsset(res: ServerResponse, pathname: string): boolean {
  const match = pathname.match(/^\/([A-Za-z0-9_-]+\.(css|js|map))$/);
  if (!match) return false;
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const filePath = join(thisDir, "..", "public", match[1]);
    if (!existsSync(filePath)) return false;
    res.statusCode = 200;
    res.setHeader("Content-Type", STATIC_CONTENT_TYPES[`.${match[2]}`] ?? "application/octet-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.end(readFileSync(filePath, "utf-8"));
    return true;
  } catch {
    return false;
  }
}

function serveDashboard(res: ServerResponse): void {
  const html = getDashboardHtml();
  if (!html) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain");
    res.end("Dashboard not found");
    return;
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.end(html);
}

function getSpaceHtml(): string | null {
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const htmlPath = join(thisDir, "..", "public", "space.html");
    return readFileSync(htmlPath, "utf-8");
  } catch {
    return null;
  }
}

function serveSpace(res: ServerResponse): void {
  const html = getSpaceHtml();
  if (!html) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain");
    res.end("Space not found");
    return;
  }
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.end(html);
}

function handleEventStream(req: IncomingMessage, res: ServerResponse, events: McEventBus): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("event: ready\ndata: {}\n\n");

  const unsubscribe = events.subscribe((event: McEvent) => {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    } catch {
      // client gone; cleanup runs on close
    }
  });
  const keepalive = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      // ignore
    }
  }, 25_000);
  if (typeof keepalive.unref === "function") keepalive.unref();

  const cleanup = () => {
    clearInterval(keepalive);
    unsubscribe();
  };
  req.on("close", cleanup);
  res.on("close", cleanup);
}

export function createHandler(
  db: MissionControlDB,
  logger?: McLogger,
  events: McEventBus = new McEventBus(),
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const log = logger ?? consoleLogger;
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;
    const method = req.method ?? "GET";

    // Anti DNS-rebinding: reject requests whose Host header is not allowlisted.
    if (!isHostAllowed(req)) {
      res.statusCode = 403;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Forbidden: host not allowed");
      return;
    }

    // Anti-CSRF: block cross-site state-changing browser requests.
    if (!isCsrfSafe(req, method)) {
      res.statusCode = 403;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Forbidden: cross-site request blocked");
      return;
    }

    // Static UI assets (CSS/JS) are inert and contain no secrets, so they are
    // served before the auth gate — a <script src> can't carry a token, and the
    // dashboard HTML behind auth is what gates access to data.
    if (method === "GET" && serveStaticAsset(res, pathname)) {
      return;
    }

    if (!isAuthorized(req, url)) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Unauthorized");
      return;
    }

    // Serve dashboard UI at / or /dashboard
    if (
      pathname === "/" ||
      pathname === "/dashboard" ||
      pathname === "/dashboard/"
    ) {
      serveDashboard(res);
      return;
    }

    if (pathname === "/space" || pathname === "/space/") {
      serveSpace(res);
      return;
    }

    // Server-sent events stream for reactive dashboard updates.
    if (pathname === "/api/stream" && method === "GET") {
      handleEventStream(req, res, events);
      return;
    }

    // API routes
    if (resolveApiRoutePath(pathname) !== null) {
      await handleApiRequest(req, res, url, db, log, events);
      return;
    }

    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Not found");
  };
}

async function handleApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  db: MissionControlDB,
  logger: McLogger,
  events: McEventBus,
): Promise<void> {
  try {
    const pathname = url.pathname;
    const method = req.method ?? "GET";
    const readOnly = isTruthyEnv("MISSION_CONTROL_READ_ONLY");

    const routePath = resolveApiRoutePath(pathname);
    if (routePath === null) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    const segments = routePath.split("/").filter(Boolean);

    if (segments[0] === "meta" && segments.length === 1 && method === "GET") {
      sendJson(res, 200, {
        readOnly,
        authMode: getAuthMode(),
        tokenRequired: hasAnyAccessToken(),
      });
      return;
    }

    if (readOnly && !["GET", "HEAD", "OPTIONS"].includes(method)) {
      sendJson(res, 403, { error: "Mission Control is running in read-only mode" });
      return;
    }

    if (segments[0] === "tasks") {
      if (segments.length === 2 && segments[1] === "claim" && method === "POST") {
        const body = await parseBody(req);
        const owner = isRecord(body) && typeof body.owner === "string" ? body.owner.trim() : "";
        const leaseSeconds =
          isRecord(body) && typeof body.lease_seconds === "number" && Number.isFinite(body.lease_seconds)
            ? Math.max(30, Math.min(Math.floor(body.lease_seconds), 3600))
            : 900;
        if (!owner) {
          sendJson(res, 400, { error: "owner is required" });
          return;
        }

        const task = db.claimNextInboxTask(owner, leaseSeconds);
        if (!task) {
          sendJson(res, 200, { task: null });
          return;
        }

        db.createActivity({
          task_id: task.id,
          activity_type: "lease_claimed",
          message: `Bridge lease claimed by ${owner} until ${task.processing_expires_at}`,
        });
        sendJson(res, 200, { task });
        return;
      }

      if (segments.length === 1 && method === "GET") {
        const limitParam = url.searchParams.get("limit");
        const offsetParam = url.searchParams.get("offset");
        const tasks = db.listTasks({
          status: url.searchParams.get("status") ?? undefined,
          workspace_id: url.searchParams.get("workspace_id") ?? undefined,
          assigned_agent_id: url.searchParams.get("assigned_agent_id") ?? undefined,
          limit: limitParam ? parseInt(limitParam, 10) : undefined,
          offset: offsetParam ? parseInt(offsetParam, 10) : undefined,
        });
        sendJson(res, 200, tasks);
        return;
      }

      if (segments.length === 1 && method === "POST") {
        const body = await parseBody(req);
        if (!isRecord(body) || typeof body.title !== "string") {
          sendJson(res, 400, { error: "Task title is required" });
          return;
        }

        // Backward compat: accept old linear_issue_id/url field names as generic external refs
        if (body.linear_issue_id && !body.external_id) {
          body.external_id = body.linear_issue_id;
          delete body.linear_issue_id;
        }
        if (body.linear_issue_url && !body.external_url) {
          body.external_url = body.linear_issue_url;
          delete body.linear_issue_url;
        }
        const task = db.createTask(body as unknown as CreateTaskInput);
        sendJson(res, 201, task);
        return;
      }
          if (segments.length >= 2) {
            const taskId = segments[1];

            if (segments.length === 2 && method === "GET") {
              const task = db.getTask(taskId);
              if (!task) {
                sendJson(res, 404, { error: "Task not found" });
                return;
              }
              sendJson(res, 200, task);
              return;
            }

            if (segments.length === 2 && method === "PATCH") {
              const body = await parseBody(req);
              if (!isRecord(body)) {
                sendJson(res, 400, { error: "Invalid request body" });
                return;
              }
              if (body.linear_issue_id !== undefined && body.external_id === undefined) {
                body.external_id = body.linear_issue_id;
                delete body.linear_issue_id;
              }
              if (body.linear_issue_url !== undefined && body.external_url === undefined) {
                body.external_url = body.linear_issue_url;
                delete body.linear_issue_url;
              }
              delete body.processing_owner;
              delete body.processing_expires_at;

              const needsTriageCheck = typeof body.triage_state === "string";
              const needsPriorityCheck = typeof body.priority === "string" && ["urgent", "high"].includes(body.priority);
              const oldTask = (needsTriageCheck || needsPriorityCheck) ? db.getTask(taskId) : null;

              if (needsPriorityCheck && oldTask) {
                const stalled = ["on_hold", "inbox", "planning"];
                if (stalled.includes(oldTask.status) && !["urgent", "high"].includes(oldTask.priority)) {
                  body.status = "inbox";
                }
              }

              const task = db.updateTask(taskId, body as unknown as UpdateTaskInput);
              if (!task) {
                sendJson(res, 404, { error: "Task not found" });
                return;
              }

              if (needsPriorityCheck && oldTask && body.status === "inbox" && oldTask.status !== "inbox") {
                db.createActivity({
                  task_id: taskId,
                  activity_type: "status_changed",
                  message: `Priority escalated to ${body.priority} — moved from ${oldTask.status} to inbox for immediate dispatch`,
                });
              }

              if (typeof body.status === "string" && TERMINAL_TASK_STATUSES.has(body.status)) {
                rollUpDelegation(db, taskId, events);
              }

              sendJson(res, 200, task);
              return;
            }

            if (segments.length === 2 && method === "DELETE") {
              const task = db.getTask(taskId);
              const deleted = db.deleteTask(taskId);
              if (!deleted) {
                sendJson(res, 404, { error: "Task not found" });
                return;
              }
              db.createEvent({
                type: "task_deleted",
                message: `Task deleted: ${taskId}${task ? ` (${task.title})` : ""}`,
                metadata: JSON.stringify({ task_id: taskId, title: task?.title ?? null }),
              });
              sendJson(res, 200, { success: true });
              return;
            }

            if (segments.length === 3 && segments[2] === "lease" && method === "DELETE") {
              const body = await parseBody(req);
              const owner = isRecord(body) && typeof body.owner === "string" ? body.owner.trim() : "";
              if (!owner) {
                sendJson(res, 400, { error: "owner is required" });
                return;
              }
              const released = db.releaseTaskLease(taskId, owner);
              if (!released) {
                sendJson(res, 409, { error: "Task lease was not held by this owner" });
                return;
              }
              db.createActivity({
                task_id: taskId,
                activity_type: "lease_released",
                message: `Bridge lease released by ${owner}`,
              });
              sendJson(res, 200, { success: true });
              return;
            }

            if (segments.length === 3 && segments[2] === "retry" && method === "POST") {
              const task = db.getTask(taskId);
              if (!task) {
                sendJson(res, 404, { error: "Task not found" });
                return;
              }
              db.updateTask(taskId, { status: "planning" } as unknown as UpdateTaskInput);
              db.clearBlockingActivities(taskId);
              db.createActivity({
                task_id: taskId,
                activity_type: "status_changed",
                message: "Agent retry requested — re-dispatching (triage preserved)",
              });
              sendJson(res, 200, { success: true, status: "planning" });
              return;
            }

            if (segments.length === 3 && segments[2] === "done" && method === "POST") {
              const task = db.getTask(taskId);
              if (!task) {
                sendJson(res, 404, { error: "Task not found" });
                return;
              }

              if (task.status === "done") {
                sendJson(res, 200, { success: true, alreadyDone: true, task });
                return;
              }

              const body = await parseBody(req);
              const reason = isRecord(body) && typeof body.reason === "string" ? body.reason.trim() : "";

              const updated = db.updateTask(taskId, { status: "done" } as unknown as UpdateTaskInput);
              if (!updated) {
                sendJson(res, 500, { error: "Failed to close task" });
                return;
              }

              db.createActivity({
                task_id: taskId,
                activity_type: "status_changed",
                message: reason
                  ? `Task marked done in Mission Control. Reason: ${reason}`
                  : "Task marked done in Mission Control.",
              });

              rollUpDelegation(db, taskId, events);

              sendJson(res, 200, { success: true, task: updated });
              return;
            }

            if (segments.length === 3 && segments[2] === "promote" && method === "POST") {
              const task = db.getTask(taskId);
              if (!task) {
                sendJson(res, 404, { error: "Task not found" });
                return;
              }
              let existingTriage: Record<string, unknown> = {};
              if (typeof task.triage_state === "string" && task.triage_state.trim()) {
                try {
                  const parsed = JSON.parse(task.triage_state);
                  if (isRecord(parsed)) existingTriage = parsed;
                } catch {}
              }

              const existingPromotion = isRecord(existingTriage.promotion) ? existingTriage.promotion : null;

              if (
                task.task_type === "implementation"
                && existingPromotion
                && existingPromotion.mode === "implementation"
              ) {
                sendJson(res, 200, { success: true, alreadyPromoted: true, task });
                return;
              }

              if (!["investigation", "research"].includes(task.task_type)) {
                sendJson(res, 400, { error: "Only investigation/research tasks can be promoted" });
                return;
              }

              const body = await parseBody(req);
              if (!isRecord(body) || typeof body.reason !== "string" || body.reason.trim().length < 5) {
                sendJson(res, 400, { error: "Promotion reason is required (min 5 chars)" });
                return;
              }

              const reason = body.reason.trim();
              const currentTriage = existingTriage;
              const nextTriage = {
                ...currentTriage,
                promotion: {
                  mode: "implementation",
                  reason,
                  promoted_at: new Date().toISOString(),
                  promoted_by: "mission-control",
                },
              };

              const updated = db.updateTask(taskId, {
                task_type: "implementation",
                status: "planning",
                triage_state: JSON.stringify(nextTriage),
              } as unknown as UpdateTaskInput);

              if (!updated) {
                sendJson(res, 500, { error: "Failed to promote task" });
                return;
              }

              const modeLabel = task.task_type === "research" ? "Research" : "Investigation";
              db.clearBlockingActivities(taskId);
              db.createActivity({
                task_id: taskId,
                activity_type: "status_changed",
                message: `${modeLabel} promoted to implementation — moved ${task.status} -> planning. Reason: ${reason}`,
              });

              sendJson(res, 200, { success: true, task: updated });
              return;
            }

            if (segments.length === 3 && segments[2] === "activities") {
              if (method === "GET") {
                sendJson(res, 200, db.listActivities(taskId));
                return;
              }
              if (method === "POST") {
                const body = await parseBody(req);
                if (!isRecord(body)) {
                  sendJson(res, 400, { error: "Invalid request body" });
                  return;
                }
                const input: CreateActivityInput = {
                  task_id: taskId,
                  activity_type:
                    typeof body.activity_type === "string"
                      ? body.activity_type
                      : "updated",
                  message:
                    typeof body.message === "string"
                      ? body.message
                      : "Activity logged",
                  agent_id:
                    typeof body.agent_id === "string" ? body.agent_id : undefined,
                  metadata:
                    typeof body.metadata === "string" ? body.metadata : undefined,
                };
                const activity = db.createActivity(input);

                // Surface agent escalations as a push notification, not just a
                // board entry the human has to go look at.
                if (input.activity_type === "needs_human") {
                  events.emit("needs_human", { taskId, message: input.message });
                }

                sendJson(res, 201, activity);
                return;
              }
            }

            if (segments.length === 3 && segments[2] === "triage-state") {
              if (method === "GET") {
                const state = db.getTriageState(taskId);
                sendJson(res, 200, state);
                return;
              }

              if (method === "PATCH") {
                const body = await parseBody(req);
                if (!isRecord(body)) {
                  sendJson(res, 400, { error: "Invalid request body" });
                  return;
                }
                const state = db.updateTriageState(taskId, body);
                sendJson(res, 200, state);
                return;
              }

              if (method === "PUT") {
                const body = await parseBody(req);
                if (!isRecord(body)) {
                  sendJson(res, 400, { error: "Invalid request body" });
                  return;
                }
                const state = db.replaceTriageState(taskId, body);
                sendJson(res, 200, state);
                return;
              }
            }

            if (segments.length === 3 && segments[2] === "deliverables") {
              if (method === "GET") {
                sendJson(res, 200, db.listDeliverables(taskId));
                return;
              }
              if (method === "POST") {
                const body = await parseBody(req);
                if (!isRecord(body)) {
                  sendJson(res, 400, { error: "Invalid request body" });
                  return;
                }
                const input: CreateDeliverableInput = {
                  task_id: taskId,
                  deliverable_type:
                    typeof body.deliverable_type === "string"
                      ? body.deliverable_type
                      : "artifact",
                  title:
                    typeof body.title === "string" ? body.title : "Untitled deliverable",
                  path: typeof body.path === "string" ? body.path : undefined,
                  description:
                    typeof body.description === "string" ? body.description : undefined,
                };
                sendJson(res, 201, db.createDeliverable(input));
                return;
              }
            }

            if (segments.length === 3 && segments[2] === "progress") {
              if (method === "GET") {
                sendJson(res, 200, db.getProgress(taskId));
                return;
              }
              if (method === "PUT" || method === "POST" || method === "PATCH") {
                const task = db.getTask(taskId);
                if (!task) {
                  sendJson(res, 404, { error: "Task not found" });
                  return;
                }
                const body = await parseBody(req);
                if (!isRecord(body)) {
                  sendJson(res, 400, { error: "Invalid request body" });
                  return;
                }
                const progress = db.upsertProgress(taskId, sanitizeProgressInput(body));
                events.emit("progress", {
                  taskId,
                  state: progress.state,
                  phase: progress.phase,
                  blockedReason: progress.blocked_reason,
                });
                sendJson(res, 200, progress);
                return;
              }
            }

            if (segments.length === 3 && segments[2] === "children" && method === "GET") {
              const children = db.listChildTasks(taskId);
              const progressMap = db.getProgressMap();
              sendJson(res, 200, children.map((child) => ({ ...child, progress: progressMap[child.id] ?? null })));
              return;
            }

            if (segments.length === 3 && segments[2] === "delegate" && method === "POST") {
              const parent = db.getTask(taskId);
              if (!parent) {
                sendJson(res, 404, { error: "Task not found" });
                return;
              }
              const body = await parseBody(req);
              if (!isRecord(body) || typeof body.title !== "string" || !body.title.trim()) {
                sendJson(res, 400, { error: "Subtask title is required" });
                return;
              }
              const childType =
                typeof body.task_type === "string" && ["implementation", "investigation", "research"].includes(body.task_type)
                  ? (body.task_type as "implementation" | "investigation" | "research")
                  : "investigation";
              const reason = typeof body.reason === "string" ? body.reason.trim() : "";

              const child = db.createTask({
                title: body.title.trim(),
                description: typeof body.description === "string" ? body.description : undefined,
                status: "inbox",
                priority: parent.priority,
                workspace_id: parent.workspace_id,
                parent_task_id: parent.id,
                task_type: childType,
                source: "delegation",
              });

              db.createActivity({
                task_id: parent.id,
                activity_type: "delegated",
                message: reason ? `Delegated subtask "${child.title}": ${reason}` : `Delegated subtask "${child.title}".`,
                metadata: JSON.stringify({ child_task_id: child.id }),
              });

              const wait = body.wait === true;
              if (wait) {
                db.updateTask(parent.id, { status: "on_hold" });
                db.upsertProgress(parent.id, {
                  state: "waiting",
                  blocked_reason: `Waiting on delegated subtask: ${child.title}`,
                });
                db.createActivity({
                  task_id: parent.id,
                  activity_type: "status_changed",
                  message: `Paused — waiting on delegated subtask "${child.title}".`,
                });
              }

              events.emit("delegated", { parentId: parent.id, childTaskId: child.id, wait });
              sendJson(res, 201, { child, parent_waiting: wait });
              return;
            }

            if (segments.length === 3 && segments[2] === "checkpoints") {
              if (method === "GET") {
                sendJson(res, 200, db.listCheckpoints(taskId));
                return;
              }
              if (method === "POST") {
                const task = db.getTask(taskId);
                if (!task) {
                  sendJson(res, 404, { error: "Task not found" });
                  return;
                }
                const body = await parseBody(req);
                if (!isRecord(body) || typeof body.prompt !== "string" || !body.prompt.trim()) {
                  sendJson(res, 400, { error: "Checkpoint prompt is required" });
                  return;
                }
                const kind =
                  typeof body.kind === "string" && ["approval", "question", "choice"].includes(body.kind)
                    ? (body.kind as "approval" | "question" | "choice")
                    : "approval";
                const options = Array.isArray(body.options) ? JSON.stringify(body.options) : undefined;

                const checkpoint = db.createCheckpoint({ task_id: taskId, kind, prompt: body.prompt.trim(), options });

                const pause = body.pause !== false; // default: pause the task
                if (pause) {
                  db.updateTask(taskId, { status: "on_hold" });
                  db.upsertProgress(taskId, { state: "waiting", blocked_reason: body.prompt.trim().slice(0, 500) });
                }
                db.createActivity({
                  task_id: taskId,
                  activity_type: "checkpoint_raised",
                  message: `Awaiting human ${kind}: ${body.prompt.trim()}`,
                  metadata: JSON.stringify({ checkpoint_id: checkpoint.id }),
                });
                events.emit("awaiting_approval", { taskId, checkpointId: checkpoint.id, prompt: body.prompt.trim(), kind });

                sendJson(res, 201, { checkpoint, paused: pause });
                return;
              }
            }
          }
        }

        if (segments[0] === "checkpoints") {
          if (segments.length === 1 && method === "GET") {
            // The "what needs me" inbox: pending checkpoints across all tasks.
            sendJson(res, 200, db.listPendingCheckpoints());
            return;
          }

          if (segments.length === 3 && segments[2] === "resolve" && method === "POST") {
            const body = await parseBody(req);
            const decisionRaw = isRecord(body) && typeof body.decision === "string" ? body.decision : "";
            const response = isRecord(body) && typeof body.response === "string" ? body.response : undefined;
            const result = resolveCheckpointAndResume(db, events, segments[1], decisionRaw, response);
            if (!result.ok) {
              sendJson(res, result.code, { error: result.error });
              return;
            }
            sendJson(res, 200, { checkpoint: result.checkpoint });
            return;
          }
        }

        if (segments[0] === "agents") {
          if (segments.length === 1 && method === "GET") {
            const agents = db.listAgents({
              workspace_id: url.searchParams.get("workspace_id") ?? undefined,
              status: (url.searchParams.get("status") ?? undefined) as
                | "standby"
                | "working"
                | "offline"
                | undefined,
            });
            sendJson(res, 200, agents);
            return;
          }

          if (segments.length === 1 && method === "POST") {
            const body = await parseBody(req);
            if (
              !isRecord(body) ||
              typeof body.name !== "string" ||
              typeof body.role !== "string"
            ) {
              sendJson(res, 400, { error: "name and role are required" });
              return;
            }

            const agent = db.createAgent(body as unknown as CreateAgentInput);
            sendJson(res, 201, agent);
            return;
          }

          if (segments.length === 2) {
            const agentId = segments[1];
            if (method === "GET") {
              const agent = db.getAgent(agentId);
              if (!agent) {
                sendJson(res, 404, { error: "Agent not found" });
                return;
              }
              sendJson(res, 200, agent);
              return;
            }

            if (method === "PATCH") {
              const body = await parseBody(req);
              if (!isRecord(body)) {
                sendJson(res, 400, { error: "Invalid request body" });
                return;
              }
              const agent = db.updateAgent(agentId, body as unknown as UpdateAgentInput);
              if (!agent) {
                sendJson(res, 404, { error: "Agent not found" });
                return;
              }
              sendJson(res, 200, agent);
              return;
            }

            if (method === "DELETE") {
              const agent = db.getAgent(agentId);
              const deleted = db.deleteAgent(agentId);
              if (!deleted) {
                sendJson(res, 404, { error: "Agent not found" });
                return;
              }
              db.createEvent({
                type: "agent_deleted",
                message: `Agent deleted: ${agentId}${agent ? ` (${agent.name})` : ""}`,
                metadata: JSON.stringify({ agent_id: agentId, name: agent?.name ?? null }),
              });
              sendJson(res, 200, { success: true });
              return;
            }
          }
        }

        if (segments[0] === "workspaces") {
          if (segments.length === 1 && method === "GET") {
            sendJson(res, 200, db.listWorkspaces());
            return;
          }

          if (segments.length === 1 && method === "POST") {
            const body = await parseBody(req);
            if (!isRecord(body) || typeof body.name !== "string") {
              sendJson(res, 400, { error: "Workspace name is required" });
              return;
            }
            const workspace = db.createWorkspace(body as unknown as CreateWorkspaceInput);
            sendJson(res, 201, workspace);
            return;
          }

          if (segments.length === 2) {
            const workspaceId = segments[1];

            if (method === "GET") {
              const workspace = db.getWorkspace(workspaceId);
              if (!workspace) {
                sendJson(res, 404, { error: "Workspace not found" });
                return;
              }
              sendJson(res, 200, workspace);
              return;
            }

            if (method === "PATCH") {
              const body = await parseBody(req);
              if (!isRecord(body)) {
                sendJson(res, 400, { error: "Invalid request body" });
                return;
              }
              const workspace = db.updateWorkspace(
                workspaceId,
                body as unknown as UpdateWorkspaceInput
              );
              if (!workspace) {
                sendJson(res, 404, { error: "Workspace not found" });
                return;
              }
              sendJson(res, 200, workspace);
              return;
            }

            if (method === "DELETE") {
              if (workspaceId === "default") {
                sendJson(res, 400, { error: "Cannot delete default workspace" });
                return;
              }
              const workspace = db.getWorkspace(workspaceId);
              const deleted = db.deleteWorkspace(workspaceId);
              if (!deleted) {
                sendJson(res, 404, { error: "Workspace not found" });
                return;
              }
              db.createEvent({
                type: "workspace_deleted",
                message: `Workspace deleted: ${workspaceId}${workspace ? ` (${workspace.name})` : ""}`,
                metadata: JSON.stringify({ workspace_id: workspaceId, name: workspace?.name ?? null }),
              });
              sendJson(res, 200, { success: true });
              return;
            }
          }
        }

        if (segments[0] === "events") {
          if (segments.length === 1 && method === "GET") {
            const limitRaw = url.searchParams.get("limit") ?? "50";
            const limit = Number.parseInt(limitRaw, 10);
            const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 1000) : 50;
            const since = url.searchParams.get("since") ?? undefined;
            sendJson(res, 200, db.listEvents(safeLimit, since));
            return;
          }
          if (segments.length === 1 && method === "POST") {
            const body = await parseBody(req);
            if (
              !isRecord(body) ||
              typeof body.type !== "string" ||
              typeof body.message !== "string"
            ) {
              sendJson(res, 400, { error: "type and message are required" });
              return;
            }

            const event = db.createEvent(body as unknown as CreateEventInput);
            sendJson(res, 201, event);
            return;
          }
        }

        if (
          segments[0] === "webhooks" &&
          segments[1] === "agent-completion" &&
          method === "POST"
        ) {
          const body = await parseBody(req);
          if (!isRecord(body)) {
            sendJson(res, 400, { error: "Invalid request body" });
            return;
          }

          if (typeof body.task_id === "string") {
            const task = db.getTask(body.task_id);
            if (!task) {
              sendJson(res, 404, { error: "Task not found" });
              return;
            }

            const newStatus = (typeof body.status === "string" && ["testing", "review", "done"].includes(body.status)
              ? body.status
              : "review") as TaskStatus;

            if (!["review", "done"].includes(task.status)) {
              db.updateTask(task.id, { status: newStatus });
            }

            if (TERMINAL_TASK_STATUSES.has(newStatus)) {
              rollUpDelegation(db, task.id, events);
            }
            events.emit("task_completed", { taskId: task.id, status: newStatus });

            db.createEvent({
              type: "task_completed",
              task_id: task.id,
              agent_id: task.assigned_agent_id ?? undefined,
              message:
                typeof body.summary === "string"
                  ? body.summary
                  : `Task ${task.id} completed`,
            });

            if (task.assigned_agent_id) {
              db.updateAgent(task.assigned_agent_id, { status: "standby" });
            }

            sendJson(res, 200, {
              success: true,
              task_id: task.id,
              new_status: newStatus,
            });
            return;
          }

          if (
            typeof body.session_id === "string" &&
            typeof body.message === "string"
          ) {
            const completionMatch = body.message.match(/TASK_COMPLETE:\s*(.+)/i);
            if (!completionMatch) {
              sendJson(res, 400, {
                error: "Invalid completion message format. Expected TASK_COMPLETE: summary",
              });
              return;
            }

            const sessions = db.listSessions();
            const session = sessions.find(
              (item) =>
                item.session_id === body.session_id && item.status === "active"
            );

            if (!session) {
              sendJson(res, 404, { error: "Session not found or inactive" });
              return;
            }

            const tasks = db.listTasks({ assigned_agent_id: session.agent_id ?? undefined });
            const activeTask = tasks.find((task) =>
              ["assigned", "in_progress"].includes(task.status)
            );

            if (!activeTask) {
              sendJson(res, 404, { error: "No active task found for this session" });
              return;
            }

            if (!["testing", "review", "done"].includes(activeTask.status)) {
              db.updateTask(activeTask.id, { status: "testing" });
            }

            db.createEvent({
              type: "task_completed",
              task_id: activeTask.id,
              agent_id: session.agent_id ?? undefined,
              message: completionMatch[1].trim(),
            });

            if (session.agent_id) {
              db.updateAgent(session.agent_id, { status: "standby" });
            }

            sendJson(res, 200, {
              success: true,
              task_id: activeTask.id,
              agent_id: session.agent_id,
              new_status: "testing",
            });
            return;
          }

          sendJson(res, 400, {
            error: "Invalid payload. Provide task_id or session_id + message",
          });
          return;
        }

        if (segments[0] === "agent-status" && segments.length === 1 && method === "GET") {
          try {
            const byTask = await getSwarmAgentStatusMap(logger);
            sendJson(res, 200, byTask);
          } catch (error) {
            const message = error instanceof Error ? error.message : "Failed to read agent status";
            logger.error(`mission-control agent-status error: ${message}`);
            sendJson(res, 500, { error: message });
          }
          return;
        }

        if (segments[0] === "board" && segments.length === 1 && method === "GET") {
          try {
            const { limit, offset } = parsePagination(url);
            const since = url.searchParams.get("since") ?? undefined;
            const liveMode = url.searchParams.get("live") === "true";

            // Counts come from unbounded SQL aggregates so the summary stays
            // correct regardless of table size. The working set used for the
            // task list/pagination is bounded (max 1000) for response size.
            const totalTasks = db.countTasks();
            const statusCounts = db.getStatusCounts();
            const allTasks = db.listTasks({ limit: 1000 });
            const sortedTasks = [...allTasks].sort((a, b) =>
              String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? ""))
            );
            const swarmStatus = await getSwarmAgentStatusMap(logger);

            const sinceMs = parseIsoMs(since);
            const pagedTasks = liveMode
              ? sortedTasks
                  .filter((task) => {
                    const updatedMs = parseIsoMs(task.updated_at);
                    if (sinceMs === null) return true;
                    const swarm = swarmStatus[task.id];
                    const heartbeatMs =
                      typeof swarm?.lastHeartbeatAt === "number"
                        ? (swarm.lastHeartbeatAt as number)
                        : null;
                    return (
                      (updatedMs !== null && updatedMs > sinceMs) ||
                      (heartbeatMs !== null && heartbeatMs > sinceMs)
                    );
                  })
                  .slice(0, limit)
              : sortedTasks.slice(offset, offset + limit);

            const heartbeatThresholdMs = Number.parseInt(
              url.searchParams.get("heartbeatThresholdMs") ?? "300000",
              10
            );
            const nowMs = Date.now();
            const heartbeatStats = Object.values(swarmStatus).reduce<{
              runningAgents: number;
              staleHeartbeat: number;
              missingHeartbeat: number;
            }>(
              (acc, swarmEntry) => {
                const live = swarmEntry.liveStatus === "running";
                if (!live) return acc;
                acc.runningAgents += 1;

                const lastHeartbeatAt =
                  typeof swarmEntry.lastHeartbeatAt === "number"
                    ? (swarmEntry.lastHeartbeatAt as number)
                    : null;
                const heartbeatIntervalSec =
                  typeof swarmEntry.heartbeatIntervalSec === "number"
                    ? (swarmEntry.heartbeatIntervalSec as number)
                    : null;

                if (lastHeartbeatAt === null) {
                  acc.missingHeartbeat += 1;
                  return acc;
                }

                const ageMs = nowMs - lastHeartbeatAt;
                const effectiveThreshold = heartbeatIntervalSec
                  ? Math.max(heartbeatThresholdMs, heartbeatIntervalSec * 3000)
                  : heartbeatThresholdMs;

                if (ageMs > effectiveThreshold) {
                  acc.staleHeartbeat += 1;
                }
                return acc;
              },
              { runningAgents: 0, staleHeartbeat: 0, missingHeartbeat: 0 }
            );

            const progressMap = db.getProgressMap();
            const childCounts = db.getChildCountsByParent();
            const checkpointCounts = db.getPendingCheckpointCounts();
            const tasks = pagedTasks.map((task) => ({
              ...task,
              swarm: swarmStatus[task.id] ?? null,
              progress: progressMap[task.id] ?? null,
              subtasks: childCounts[task.id] ?? null,
              pending_checkpoints: checkpointCounts[task.id] ?? 0,
              recent_activity: db.listActivities(task.id, 3, 0),
            }));
            const blockedAgents = Object.values(progressMap).filter(
              (p) => p.state === "blocked" || p.state === "waiting",
            ).length;
            const awaitingApproval = Object.values(checkpointCounts).reduce((a, b) => a + b, 0);

            const recentEvents = db.listEvents(Math.min(limit, 200), since, 0);
            const nextCursor =
              tasks.length > 0
                ? String(tasks[tasks.length - 1]?.updated_at ?? "") || new Date().toISOString()
                : new Date().toISOString();

            sendJson(res, 200, {
              summary: {
                totalTasks,
                statusCounts,
                runningSwarmAgents: heartbeatStats.runningAgents,
                staleHeartbeat: heartbeatStats.staleHeartbeat,
                missingHeartbeat: heartbeatStats.missingHeartbeat,
                blockedAgents,
                awaitingApproval,
                heartbeatThresholdMs,
                liveMode,
                cursorMode: liveMode ? "since" : "offset",
                boardGeneratedAt: new Date().toISOString(),
              },
              tasks,
              swarm: swarmStatus,
              recentEvents,
              nextCursor,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : "Failed to build board";
            logger.error(`mission-control board error: ${message}`);
            sendJson(res, 500, { error: message });
          }
          return;
        }

        if (segments[0] === "system-stats" && segments.length === 1 && method === "GET") {
          const totalMem = totalmem();
          // os.freemem() on macOS only reports truly free pages, not inactive/purgeable.
          // This makes memory look nearly full when macOS is just caching files.
          // Use vm_stat to get a more accurate picture on macOS.
          let freeMem = freemem();
          if (process.platform === "darwin") {
            try {
              const { execSync } = await import("node:child_process");
              const vmstat = execSync("vm_stat", { timeout: 3000 }).toString();
              const pageSize = 16384;
              const extract = (label: string): number => {
                const m = vmstat.match(new RegExp(`${label}:\\s+(\\d+)`));
                return m ? parseInt(m[1], 10) * pageSize : 0;
              };
              // Available = free + inactive + purgeable (what macOS will reclaim)
              freeMem = extract("Pages free") + extract("Pages inactive") + extract("Pages purgeable");
            } catch {
              // Fall back to os.freemem() if vm_stat fails
            }
          }
          const usedMem = totalMem - freeMem;
          const load = loadavg();
          const numCpus = cpus().length;
          sendJson(res, 200, {
            cpu: {
              cores: numCpus,
              loadAvg1m: Math.round(load[0] * 100) / 100,
              loadAvg5m: Math.round(load[1] * 100) / 100,
              usagePercent: Math.round((load[0] / numCpus) * 100),
            },
            memory: {
              totalGB: Math.round((totalMem / 1073741824) * 10) / 10,
              usedGB: Math.round((usedMem / 1073741824) * 10) / 10,
              freeGB: Math.round((freeMem / 1073741824) * 10) / 10,
              usagePercent: Math.round((usedMem / totalMem) * 100),
            },
            concurrency: {
              maxClaude: parseInt(process.env.MAX_CLAUDE_AGENTS || "10", 10),
              maxCodex: parseInt(process.env.MAX_CODEX_AGENTS || "3", 10),
            },
          });
          return;
        }

        if (segments[0] === "config" && segments.length === 1) {
          const mcHome = process.env.MC_HOME ?? join(homedir(), ".mission-control");
          const configPath = join(mcHome, "swarm", "swarm-config.json");

          const readConfig = (): Record<string, unknown> => {
            try {
              if (existsSync(configPath)) {
                return JSON.parse(readFileSync(configPath, "utf-8"));
              }
            } catch {}
            return {
              claude: { model: "claude-opus-4-6", fallbackModel: "", maxAgents: 10 },
              codex: { model: "codex-mini", effort: "high", reviewEffort: "xhigh", maxAgents: 3 },
              ci: { enabled: false, maxCycles: 3 },
            };
          };
          if (method === "GET") {
            sendJson(res, 200, readConfig());
            return;
          }

          if (method === "PATCH") {
            const body = await parseBody(req);
            if (!isRecord(body)) {
              sendJson(res, 400, { error: "Expected JSON object" });
              return;
            }

            const current = readConfig() as Record<string, unknown>;

            for (const key of ["claude", "codex", "ci"] as const) {
              if (isRecord(body[key])) {
                const base = isRecord(current[key]) ? (current[key] as Record<string, unknown>) : {};
                current[key] = { ...base, ...(body[key] as Record<string, unknown>) };
              }
            }

            const sanitized = sanitizeConfig(current);
            writeFileSync(configPath, JSON.stringify(sanitized, null, 2) + "\n", "utf-8");
            sendJson(res, 200, sanitized);
            return;
          }
        }
        if (segments[0] === "repos" && segments.length === 1 && method === "GET") {
          const gitProjectsDir = join(homedir(), "GitProjects");
          const repos: Array<{ project: string; repo: string }> = [];
          try {
            const projects = readdirSync(gitProjectsDir, { withFileTypes: true })
              .filter(d => d.isDirectory() && !d.name.startsWith("."));
            for (const proj of projects) {
              const projPath = join(gitProjectsDir, proj.name);
              const children = readdirSync(projPath, { withFileTypes: true })
                .filter(d => d.isDirectory() && !d.name.startsWith(".") && d.name !== "worktrees");
              for (const child of children) {
                if (existsSync(join(projPath, child.name, ".git"))) {
                  repos.push({ project: proj.name, repo: child.name });
                }
              }
            }
          } catch {}
          sendJson(res, 200, { repos });
          return;
        }

        if (segments[0] === "knowledge") {
          const knowledgeScript = resolveRuntimePath("swarm", "knowledge-manage.py");

          if (segments.length === 1 && method === "POST") {
            const body = await parseBody(req);
            if (!isRecord(body) || typeof body.text !== "string" || !body.text.trim()) {
              sendJson(res, 400, { error: "text is required" });
              return;
            }

            const args = [
              knowledgeScript, "inject",
              "--text", String(body.text),
              "--importance", String(body.importance ?? 5),
              "--category", String(body.category ?? "fact"),
              "--source", "human",
              "--via", "mc-api",
            ];
            if (body.project) args.push("--project", String(body.project));
            if (body.repo) args.push("--repo", String(body.repo));
            if (body.scope) args.push("--scope", String(body.scope));

            const result = await runKnowledgePython(args);
            sendJson(res, 201, result);
            return;
          }

          if (segments.length === 1 && method === "GET") {
            const stage = url.searchParams.get("stage") ?? "";
            const limit = url.searchParams.get("limit") ?? "50";

            // If stage filter requested, use review script for stage-aware listing
            if (stage) {
              const reviewScript = resolveRuntimePath("swarm", "knowledge-review.py");
              const result = await runKnowledgePython([reviewScript, "list", "--stage", stage, "--limit", limit]);
              sendJson(res, 200, result);
              return;
            }

            const project = url.searchParams.get("project") ?? "";
            const repo = url.searchParams.get("repo") ?? "";
            const scope = url.searchParams.get("scope") ?? "";

            const args = [knowledgeScript, "list", "--limit", limit];
            if (scope) args.push("--scope", scope);
            else if (project) {
              args.push("--project", project);
              if (repo) args.push("--repo", repo);
            }

            const result = await runKnowledgePython(args);
            sendJson(res, 200, result);
            return;
          }

          if (segments.length === 2 && segments[1] === "doctor" && method === "GET") {
            const result = await runKnowledgePython([knowledgeScript, "doctor"]);
            sendJson(res, 200, result);
            return;
          }

          if (segments.length === 2 && segments[1] === "recall" && method === "GET") {
            const queryText = url.searchParams.get("query") ?? "";
            if (!queryText.trim()) {
              sendJson(res, 400, { error: "query is required" });
              return;
            }
            const args = [knowledgeScript, "recall", "--query", queryText, "--limit", url.searchParams.get("limit") ?? "5"];
            const project = url.searchParams.get("project") ?? "";
            const repo = url.searchParams.get("repo") ?? "";
            const domain = url.searchParams.get("domain") ?? "";
            if (project) args.push("--project", project);
            if (repo) args.push("--repo", repo);
            if (domain) args.push("--domain", domain);
            const result = await runKnowledgePython(args);
            sendJson(res, 200, result);
            return;
          }

          if (segments.length === 2 && segments[1] === "reembed" && method === "POST") {
            const body = await parseBody(req);
            const payload = isRecord(body) ? body : {};
            const args = [knowledgeScript, "reembed"];
            if (typeof payload.schema === "string" && payload.schema.trim()) args.push("--schema", payload.schema);
            if (typeof payload.dimensions === "number" && Number.isFinite(payload.dimensions)) args.push("--dimensions", String(payload.dimensions));
            if (typeof payload.limit === "number" && Number.isFinite(payload.limit)) args.push("--limit", String(payload.limit));
            if (payload.force === true) args.push("--force");
            const result = await runKnowledgePython(args);
            sendJson(res, 200, result);
            return;
          }

          if (segments.length === 2 && segments[1] === "fetch-url" && method === "POST") {
            const body = await parseBody(req);
            if (!isRecord(body)) {
              sendJson(res, 400, { error: "url is required" });
              return;
            }

            const urlField = requireStringField(body, "url");
            if (!urlField) {
              sendJson(res, 400, { error: "url is required" });
              return;
            }

            const targetUrl = urlField.startsWith("http") ? urlField : `https://${urlField}`;
            try {
              await assertPublicUrl(targetUrl);
            } catch (err) {
              sendJson(res, 400, { error: err instanceof Error ? err.message : "Unsafe URL" });
              return;
            }

            const method_ = typeof body.method === "string" ? body.method : "direct";

            if (method_ === "claude") {
              try {
                const prompt = `Read this page: ${targetUrl} — Use available MCP tools (Notion, WebFetch) to access it. Return ONLY the page text content, no commentary or tool explanations.`;
                const result = await runClaude(prompt, 90000);
                sendJson(res, 200, { title: "", text: result.slice(0, 50000), url: targetUrl, length: result.length, method: "claude" });
              } catch (err) {
                sendJson(res, 502, { error: `Claude fetch failed: ${err instanceof Error ? err.message : "Unknown"}` });
              }
              return;
            }

            try {
              const resp = await fetchPublicUrl(targetUrl);

              if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
              const html = await resp.text();
              const text = stripHtmlToText(html);
              const title = extractTitle(html);

              if (targetUrl.includes("notion.so") && text.includes("JavaScript must be enabled")) {
                sendJson(res, 200, { title: "", text: "", url: targetUrl, length: 0, needsClaude: true });
                return;
              }

              sendJson(res, 200, { title, text: text.slice(0, 50000), url: targetUrl, length: text.length });
            } catch (err) {
              sendJson(res, 502, { error: `Failed to fetch: ${err instanceof Error ? err.message : "Unknown"}` });
            }
            return;
          }
          if (segments.length === 2 && method === "DELETE") {
            const entryId = segments[1];
            const args = [knowledgeScript, "delete", "--id", entryId];
            const result = await runKnowledgePython(args);
            db.createEvent({
              type: "knowledge_deleted",
              message: `Knowledge entry deleted: ${entryId}`,
              metadata: JSON.stringify({ entry_id: entryId }),
            });
            sendJson(res, 200, result);
            return;
          }

          // Knowledge review endpoints (shell out to knowledge-review.py)
          const reviewScript = resolveRuntimePath("swarm", "knowledge-review.py");

          if (segments.length === 3 && segments[0] === "knowledge" && segments[2] === "promote" && method === "POST") {
            const result = await runKnowledgePython([reviewScript, "promote", "--id", segments[1]]);
            sendJson(res, 200, result);
            return;
          }

          if (segments.length === 3 && segments[0] === "knowledge" && segments[2] === "share" && method === "POST") {
            const result = await runKnowledgePython([reviewScript, "share", "--id", segments[1]]);
            sendJson(res, 200, result);
            return;
          }

          if (segments.length === 3 && segments[0] === "knowledge" && segments[2] === "reject" && method === "POST") {
            const result = await runKnowledgePython([reviewScript, "reject", "--id", segments[1]]);
            sendJson(res, 200, result);
            return;
          }

          if (segments.length === 2 && segments[0] === "knowledge" && method === "PATCH") {
            const body = await parseBody(req);
            if (!isRecord(body)) {
              sendJson(res, 400, { error: "Body required" });
              return;
            }
            const args = [reviewScript, "update", "--id", segments[1]];
            if (typeof body.text === "string" && body.text.trim()) args.push("--text", body.text);
            if (typeof body.domain === "string" && body.domain.trim()) args.push("--domain", body.domain);
            const result = await runKnowledgePython(args);
            sendJson(res, 200, result);
            return;
          }
        }

        if (segments[0] === "services" && segments[1] === "health" && segments.length === 2 && method === "GET") {
          const healthScript = resolveRuntimePath("health", "service-health.py");
          const result = await runPython([healthScript]);
          sendJson(res, 200, result);
          return;
        }

        if (segments[0] === "connections" && segments.length === 1 && method === "GET") {
          // Readiness probe: agent runtime auth + connected sources.
          const result = await runPython([resolveRuntimePath("swarm", "connections.py")]);
          sendJson(res, 200, result);
          return;
        }

        if (segments[0] === "settings" && segments.length === 1) {
          if (method === "GET") {
            // Report which known settings are configured (booleans only — never
            // return secret values) plus the feature each unlocks.
            const env = readEnvConfig();
            const isSet = (key: string) => Boolean((env[key] ?? process.env[key] ?? "").trim());
            sendJson(res, 200, {
              configured: Object.fromEntries(SETTABLE_KEYS.map(k => [k, isSet(k)])),
              features: {
                generation: isSet("ANTHROPIC_API_KEY") || isSet("OPENAI_API_KEY") || isSet("GOOGLE_GENERATIVE_AI_API_KEY"),
                knowledgeStore: isSet("CONTEXT_FABRICA_DSN"),
                linear: isSet("LINEAR_API_KEY"),
                notifications: isSet("MISSION_CONTROL_NOTIFY_WEBHOOK"),
              },
              keys: SETTABLE_KEYS,
            });
            return;
          }
          if (method === "POST" || method === "PATCH") {
            const body = await parseBody(req);
            if (!isRecord(body)) {
              sendJson(res, 400, { error: "Expected a JSON object of settings" });
              return;
            }
            const updates: Record<string, string> = {};
            const rejected: string[] = [];
            for (const [key, value] of Object.entries(body)) {
              if (!SETTABLE_KEYS.includes(key)) {
                rejected.push(key);
                continue;
              }
              if (typeof value === "string" || typeof value === "number") {
                updates[key] = String(value);
              }
            }
            if (Object.keys(updates).length === 0) {
              sendJson(res, 400, { error: "No settable keys provided", rejected, allowed: SETTABLE_KEYS });
              return;
            }
            writeEnvConfig(updates);
            db.createEvent({
              type: "settings_updated",
              message: `Settings updated: ${Object.keys(updates).join(", ")}`,
            });
            sendJson(res, 200, { success: true, updated: Object.keys(updates), rejected });
            return;
          }
        }

        if (segments[0] === "objectives") {
          if (segments.length === 1 && method === "GET") {
            sendJson(res, 200, db.listObjectives(url.searchParams.get("status") ?? undefined));
            return;
          }

          if (segments.length === 1 && method === "POST") {
            const body = await parseBody(req);
            if (!isRecord(body) || typeof body.goal !== "string" || !body.goal.trim()) {
              sendJson(res, 400, { error: "goal is required" });
              return;
            }
            const goal = body.goal.trim();
            const workspaceId = typeof body.workspace_id === "string" ? body.workspace_id : "default";
            // Anchor task carries the objective on the board and gives it
            // delegation/checkpoint/progress for free.
            const anchor = db.createTask({
              title: goal,
              description: typeof body.description === "string" ? body.description : undefined,
              status: "on_hold",
              task_type: "investigation",
              source: "autopilot",
              workspace_id: workspaceId,
            });
            const objective = db.createObjective({
              goal,
              anchor_task_id: anchor.id,
              workspace_id: workspaceId,
              max_rounds: typeof body.max_rounds === "number" && Number.isFinite(body.max_rounds) ? Math.floor(body.max_rounds) : undefined,
              max_subtasks: typeof body.max_subtasks === "number" && Number.isFinite(body.max_subtasks) ? Math.floor(body.max_subtasks) : undefined,
              cost_cap_usd: typeof body.cost_cap_usd === "number" && Number.isFinite(body.cost_cap_usd) ? body.cost_cap_usd : undefined,
              output_config: JSON.stringify(
                isRecord(body.output_config) ? body.output_config : { knowledge: true, pages: true },
              ),
            });
            db.createActivity({
              task_id: anchor.id,
              activity_type: "objective_created",
              message: `Autopilot objective created: ${goal}`,
              metadata: JSON.stringify({ objective_id: objective.id }),
            });
            events.emit("objective_created", { objectiveId: objective.id, anchorTaskId: anchor.id });
            sendJson(res, 201, objective);
            return;
          }

          if (segments.length >= 2) {
            const objectiveId = segments[1];
            const objective = db.getObjective(objectiveId);
            if (!objective) {
              sendJson(res, 404, { error: "Objective not found" });
              return;
            }

            if (segments.length === 2 && method === "GET") {
              const anchorId = objective.anchor_task_id;
              const children = anchorId ? db.listChildTasks(anchorId) : [];
              const document = db.getDocumentByObjective(objectiveId) ?? null;
              const pages = document ? db.listPages(document.id) : [];
              sendJson(res, 200, {
                ...objective,
                anchor_task: anchorId ? db.getTask(anchorId) ?? null : null,
                children,
                document,
                page_count: pages.length,
              });
              return;
            }

            // PATCH /objectives/:id → autopilot persists loop state
            if (segments.length === 2 && method === "PATCH") {
              const body = await parseBody(req);
              if (!isRecord(body)) {
                sendJson(res, 400, { error: "Invalid request body" });
                return;
              }
              const jsonField = (v: unknown): string | undefined =>
                typeof v === "string" ? v : v !== undefined ? JSON.stringify(v) : undefined;
              const updated = db.updateObjective(objectiveId, {
                status: typeof body.status === "string" ? (body.status as never) : undefined,
                proposed_scope: jsonField(body.proposed_scope),
                approved_scope: jsonField(body.approved_scope),
                coverage: jsonField(body.coverage),
                round: typeof body.round === "number" ? body.round : undefined,
                subtasks_spawned: typeof body.subtasks_spawned === "number" ? body.subtasks_spawned : undefined,
                blocked_reason: typeof body.blocked_reason === "string" ? body.blocked_reason : undefined,
              });
              sendJson(res, 200, updated);
              return;
            }

            // GET /objectives/:id/document → document + page tree
            if (segments.length === 3 && segments[2] === "document" && method === "GET") {
              const document = db.getDocumentByObjective(objectiveId);
              if (!document) {
                sendJson(res, 200, { document: null, pages: [] });
                return;
              }
              sendJson(res, 200, { document, pages: db.listPages(document.id) });
              return;
            }

            // POST /objectives/:id/document → create (or return existing) the wiki doc
            if (segments.length === 3 && segments[2] === "document" && method === "POST") {
              const existing = db.getDocumentByObjective(objectiveId);
              if (existing) {
                sendJson(res, 200, existing);
                return;
              }
              const body = await parseBody(req);
              const title = isRecord(body) && typeof body.title === "string" && body.title.trim() ? body.title.trim() : objective.goal;
              const kind = isRecord(body) && typeof body.kind === "string" ? body.kind : "wiki";
              const document = db.createDocument({
                objective_id: objectiveId,
                workspace_id: objective.workspace_id,
                title,
                kind,
              });
              sendJson(res, 201, document);
              return;
            }

            // POST /objectives/:id/approve → resolve the pending scope checkpoint
            if (segments.length === 3 && segments[2] === "approve" && method === "POST") {
              if (!objective.anchor_task_id) {
                sendJson(res, 400, { error: "Objective has no anchor task" });
                return;
              }
              const pending = db
                .listCheckpoints(objective.anchor_task_id)
                .find((cp) => cp.status === "pending");
              if (!pending) {
                sendJson(res, 409, { error: "No pending scope checkpoint to approve" });
                return;
              }
              const body = await parseBody(req);
              const decision = isRecord(body) && typeof body.decision === "string" ? body.decision : "approve";
              const response =
                isRecord(body) && body.scope !== undefined
                  ? JSON.stringify(body.scope)
                  : isRecord(body) && typeof body.response === "string"
                    ? body.response
                    : undefined;
              const result = resolveCheckpointAndResume(db, events, pending.id, decision, response);
              if (!result.ok) {
                sendJson(res, result.code, { error: result.error });
                return;
              }
              events.emit("objective_scope_approved", { objectiveId, decision });
              sendJson(res, 200, { success: true, checkpoint: result.checkpoint });
              return;
            }
          }
        }

        if (segments[0] === "documents" && segments.length >= 2) {
          const documentId = segments[1];
          const document = db.getDocument(documentId);
          if (!document) {
            sendJson(res, 404, { error: "Document not found" });
            return;
          }

          if (segments.length === 3 && segments[2] === "pages" && method === "GET") {
            sendJson(res, 200, db.listPages(documentId));
            return;
          }

          if (segments.length === 4 && segments[2] === "pages") {
            const slug = segments[3];
            if (method === "GET") {
              const page = db.getPage(documentId, slug);
              if (!page) {
                sendJson(res, 404, { error: "Page not found" });
                return;
              }
              sendJson(res, 200, page);
              return;
            }
            if (method === "PUT") {
              const body = await parseBody(req);
              if (!isRecord(body) || typeof body.title !== "string" || !body.title.trim()) {
                sendJson(res, 400, { error: "Page title is required" });
                return;
              }
              const page = db.upsertPage(documentId, {
                slug,
                title: body.title.trim(),
                body_md: typeof body.body_md === "string" ? body.body_md : undefined,
                parent_page_id: typeof body.parent_page_id === "string" ? body.parent_page_id : undefined,
                position: typeof body.position === "number" && Number.isFinite(body.position) ? Math.floor(body.position) : undefined,
                source_record_ids: Array.isArray(body.source_record_ids)
                  ? JSON.stringify(body.source_record_ids)
                  : typeof body.source_record_ids === "string"
                    ? body.source_record_ids
                    : undefined,
              });
              sendJson(res, 200, page);
              return;
            }
          }
        }

        sendJson(res, 404, { error: "Not found" });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Internal server error";
        if (message === "Malformed JSON body") {
          sendJson(res, 400, { error: message });
          return;
        }
        if (message === "Request body too large") {
          sendJson(res, 413, { error: message });
          return;
        }
        // Knowledge not set up → guide the user instead of a scary 500.
        // Mission Control runs fine without it; knowledge memory is opt-in.
        const setupRequired = (error as { setupRequired?: string })?.setupRequired;
        if (setupRequired) {
          sendJson(res, 503, {
            error: "Knowledge store not available",
            setupRequired,
            hint: "Knowledge memory needs Python 3.10+ and PostgreSQL + pgvector. Add them in Settings, or run the core without it.",
            detail: (error as { detail?: string })?.detail ?? message.slice(0, 300),
          });
          return;
        }
        logger.error(`mission-control routes error: ${message}`);
        sendJson(res, 500, { error: message });
      }
}

function extractTitle(html: string): string {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? match[1].replace(/\s+/g, " ").trim() : "";
}

function stripHtmlToText(html: string): string {
  let text = html;
  text = text.replace(/<script[\s\S]*?<\/script>/gi, "");
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, "");
  text = text.replace(/<footer[\s\S]*?<\/footer>/gi, "");
  text = text.replace(/<header[\s\S]*?<\/header>/gi, "");
  text = text.replace(/<(h[1-6])[^>]*>/gi, "\n\n");
  text = text.replace(/<\/(h[1-6])>/gi, "\n");
  text = text.replace(/<(p|div|br|li|tr)[^>]*\/?>/gi, "\n");
  text = text.replace(/<[^>]+>/g, "");
  text = text.replace(/&nbsp;/g, " ");
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/\n{3,}/g, "\n\n");
  text = text.replace(/[ \t]+/g, " ");
  return text.trim();
}

function runClaude(prompt: string, timeout = 120000): Promise<string> {
  const home = process.env.HOME || homedir();
  const claudePath = "/opt/homebrew/bin/claude";
  const args = ["-p", prompt, "--allowedTools", "mcp__notion__*,WebFetch", "--no-session-persistence", "--model", "sonnet"];

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(claudePath, args, {
      cwd: home,
      stdio: ["pipe", "pipe", "pipe"],
      env: { HOME: home, USER: process.env.USER || "mm", PATH: process.env.PATH || "/opt/homebrew/bin:/usr/bin:/bin" },
    });
    child.stdin.end();
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Claude timed out"));
    }, timeout);

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `Claude exited with code ${code}`));
        return;
      }
      if (!stdout.trim()) {
        reject(new Error("Claude returned empty response"));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

export async function getConnectionsReport(): Promise<Record<string, unknown>> {
  return runPython([resolveRuntimePath("swarm", "connections.py")]);
}

// Keys the Settings UI may write to ~/.mission-control/.env. Allowlisted so the
// endpoint can never set arbitrary environment (e.g. PATH).
const SETTABLE_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "EMBEDDING_PROVIDER",
  "EMBEDDING_MODEL",
  "CONTEXT_FABRICA_EMBEDDING_DIMENSIONS",
  "CONTEXT_FABRICA_DSN",
  "CONTEXT_FABRICA_SCHEMA",
  "LINEAR_API_KEY",
  "MISSION_CONTROL_NOTIFY_WEBHOOK",
];

function envFilePath(): string {
  const mcHome = process.env.MC_HOME ?? join(homedir(), ".mission-control");
  return join(mcHome, ".env");
}

function readEnvConfig(): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const path = envFilePath();
    if (!existsSync(path)) return out;
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const eq = trimmed.indexOf("=");
      out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
  } catch {
    // ignore — treated as empty config
  }
  return out;
}

function writeEnvConfig(updates: Record<string, string>): void {
  const path = envFilePath();
  mkdirSync(dirname(path), { recursive: true });
  const lines = existsSync(path) ? readFileSync(path, "utf-8").split("\n") : [];
  for (const [key, value] of Object.entries(updates)) {
    const idx = lines.findIndex(l => l.trim().startsWith(`${key}=`));
    const line = `${key}=${value}`;
    if (idx >= 0) lines[idx] = line;
    else lines.push(line);
  }
  writeFileSync(path, lines.filter(l => l.trim() !== "").join("\n") + "\n", { mode: 0o600 });
}

// Knowledge memory is optional (needs Python 3.10+ + PostgreSQL + context-fabrica).
// Any failure here means "not set up yet" — tag it so the API returns a helpful
// 503 instead of a scary 500/traceback. The core runs fine without it.
async function runKnowledgePython(args: string[]): Promise<Record<string, unknown>> {
  try {
    return await runPython(args);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const tagged = new Error("Knowledge store not available");
    (tagged as Error & { setupRequired?: string; detail?: string }).setupRequired = "knowledge_store";
    (tagged as Error & { setupRequired?: string; detail?: string }).detail = detail.slice(0, 400);
    throw tagged;
  }
}

function runPython(args: string[]): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const pythonBin = resolvePythonBin();
    execFile(pythonBin, args, { timeout: 300000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`Invalid JSON from knowledge script: ${stdout}`));
      }
    });
  });
}
