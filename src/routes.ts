import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, renameSync } from "node:fs";
import { basename, join, dirname } from "node:path";
import { homedir, cpus, totalmem, freemem, loadavg } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { McEventBus } from "./events.js";
import type { McEvent } from "./events.js";
import { getPreviews, startPreview, stopPreview, stopAllPreviews } from "./preview.js";
import { readBusConfig } from "./messagebus/config.js";
import { sendTelegramMessage, telegramGetMe } from "./messagebus/telegram.js";
import { sendSlackMessage, slackAuthTest } from "./messagebus/slack.js";
import { closeLinearIssue } from "./linear.js";
import type { LinearClosureResult } from "./linear.js";
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

export interface ResetPullRequestResult {
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  closed: boolean;
}

export interface CreateLinearIssueInput {
  title: string;
  description: string;
  requestId: string;
  teamKey?: string;
  assignee?: string;
}

export interface CreatedLinearIssue {
  id: string;
  identifier: string;
  title: string;
  description?: string;
  url: string;
  priority?: number;
  team?: { id?: string; key?: string; name?: string };
  assignee?: { id?: string; name?: string; email?: string } | null;
}

export interface RouteDependencies {
  resetPullRequest?: (url: string) => Promise<ResetPullRequestResult>;
  createLinearIssue?: (input: CreateLinearIssueInput) => Promise<{ created: boolean; issue: CreatedLinearIssue }>;
  closeLinearIssue?: (issueId: string) => Promise<LinearClosureResult>;
  transitionTaskRuntime?: (
    taskId: string,
    transition: "hold" | "close" | "delete",
  ) => Promise<TaskRuntimeTransitionResult>;
}

export interface TaskRuntimeTransitionResult {
  matched: number;
  stopped: number;
}

const consoleLogger: McLogger = { info: console.log, error: console.error };
const MAX_JSON_BODY_BYTES = Number.parseInt(process.env.MISSION_CONTROL_MAX_BODY_BYTES ?? "1048576", 10);

function githubPullRequestTarget(url: string): { repo: string; number: string } | null {
  const match = /^https?:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)(?:[/?#].*)?$/i.exec(url.trim());
  return match ? { repo: match[1], number: match[2] } : null;
}

function runGh(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("gh", args, { timeout: 30_000 }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || error.message).trim();
        reject(new Error(detail || "GitHub CLI command failed"));
        return;
      }
      resolve(String(stdout));
    });
  });
}

/** Close the active PR before a review ticket is reset.
 *
 * Resetting is intentionally fail-closed here: returning the ticket to the inbox
 * while GitHub still has an open PR recreates the orphan lifecycle this operation
 * is meant to prevent. Closed PRs retain their branch and can be reopened by the
 * bridge when re-triage selects the same repository.
 */
export async function closePullRequestForReset(url: string): Promise<ResetPullRequestResult> {
  const target = githubPullRequestTarget(url);
  if (!target) throw new Error("The task's pull-request URL is not a supported GitHub PR URL");

  const raw = await runGh(["pr", "view", target.number, "--repo", target.repo, "--json", "state"]);
  const state = String((JSON.parse(raw || "{}") as { state?: unknown }).state ?? "").toUpperCase();
  if (state !== "OPEN" && state !== "CLOSED" && state !== "MERGED") {
    throw new Error(`GitHub returned an unknown pull-request state: ${state || "empty"}`);
  }
  if (state !== "OPEN") return { url, state, closed: false };

  await runGh([
    "pr", "close", target.number, "--repo", target.repo,
    "--comment", "Mission Control reset this ticket for re-triage. The PR will be reopened if the next run targets this repository.",
  ]);
  return { url, state: "CLOSED", closed: true };
}

// Canned follow-up instructions for a review-state PR. Used by the ticket quick-action
// buttons (manual) AND the check-agents auto-monitors (automatic) — keep the wording in
// sync with swarm/check-agents.sh so a human click and an auto-trigger behave the same.
const FOLLOWUP_ACTIONS: Record<string, string> = {
  review_comments:
    "Follow-up: address this PR's review comments. Fetch them via `gh pr view <n> --comments` AND the inline review threads " +
    "(`gh api repos/{owner}/{repo}/pulls/{n}/comments`), including bot reviewers like Greptile. Address every actionable " +
    "comment, then commit and push to update the PR. Skip a comment only if it conflicts with the ticket's acceptance " +
    "criteria, and note why.",
  merge_conflicts:
    "Follow-up: resolve this PR's merge conflicts. Fetch latest, merge/rebase the base branch into your branch, resolve ALL " +
    "conflicts (preserve both your change and the incoming base changes), run build + tests, then commit and push.",
  ci_lint:
    "Follow-up: fix this PR's failing CI. Run `gh pr checks <n>`, reproduce locally, fix build/type/lint/test errors (run the " +
    "repo's lint/format scripts), then commit and push. Repeat until checks are green.",
  rebuild_design:
    "Follow-up: re-sync the UI to the design. Re-read the linked Paper/Figma design via the design MCP, export EVERY image " +
    "asset (Paper get_fill_image / Figma assets), and match each section's real background, colors, typography, and alignment " +
    "(get_computed_styles) — do not default to the app's theme. Commit and push.",
};

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

/** An unrecognised progress state, or null when the input is acceptable. */
export function invalidProgressState(body: Record<string, unknown>): string | null {
  if (typeof body.state !== "string" || (PROGRESS_STATES as readonly string[]).includes(body.state)) {
    return null;
  }
  return body.state;
}

function sanitizeProgressInput(body: Record<string, unknown>): UpsertProgressInput {
  const out: UpsertProgressInput = {};
  // A state outside the set used to be dropped in silence, so the write "succeeded"
  // and left the old state in place. Writing `planning` (a task status, not a
  // progress state) therefore looked like it had worked while the task stayed
  // blocked. The route rejects it now; this stays defensive for other callers.
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

const TERMINAL_TASK_STATUSES = new Set(["review", "done", "closed"]);

function emitTerminalCompletion(
  events: McEventBus,
  taskId: string,
  previousStatus: string,
  nextStatus: string,
): void {
  if (previousStatus !== "done" && nextStatus === "done") {
    events.emit("task_completed", { taskId, status: "done" });
  }
}

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

  const draftPrUrl = existing.prompt.match(/https?:\/\/github\.com\/[^\s]+\/pull\/\d+/i)?.[0] ?? "";
  const draftPrDecision = String(response ?? "").trim();
  if (draftPrUrl && draftPrDecision === "Move to review (I'll finish the PR myself)") {
    db.updateTask(taskId, { status: "review" });
    db.upsertProgress(taskId, { state: "waiting", blocked_reason: null });
    db.createActivity({
      task_id: taskId,
      activity_type: "status_changed",
      message: `Draft PR kept for human review (${draftPrUrl}).`,
      metadata: JSON.stringify({ pr_url: draftPrUrl }),
    });
    events.emit("checkpoint_resolved", { taskId, checkpointId, decision: newStatus });
    return { ok: true, checkpoint: resolved };
  }

  if (draftPrUrl && draftPrDecision === "Let an agent continue on top of this PR") {
    db.createActivity({
      task_id: taskId,
      activity_type: "pr_reuse_requested",
      message: `Continue the task on the existing draft PR (${draftPrUrl}).`,
      metadata: JSON.stringify({ pr_url: draftPrUrl, pr_disposition: "reuse_if_same_repo" }),
    });
  }

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

function execRuntimeFile(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 10_000 }, (error, _stdout, stderr) => {
      if (!error) {
        resolve();
        return;
      }
      const detail = String(stderr || error.message).trim();
      reject(new Error(detail || `${command} failed`));
    });
  });
}

/**
 * Move every swarm entry for a board ticket out of the runnable state before the
 * board transition is committed. Worktrees and branches are preserved; hold is
 * resumable, while delete leaves a terminal marker for the bounded cleaner.
 */
export async function transitionTaskRuntime(
  taskId: string,
  transition: "hold" | "close" | "delete",
): Promise<TaskRuntimeTransitionResult> {
  const mcHome = process.env.MC_HOME ?? join(homedir(), ".mission-control");
  const registryPath = join(mcHome, "swarm", "active-tasks.json");
  if (!existsSync(registryPath)) return { matched: 0, stopped: 0 };

  const parsed = JSON.parse(readFileSync(registryPath, "utf8")) as unknown;
  if (!Array.isArray(parsed)) throw new Error("Swarm registry is not an array");
  const entries = parsed.filter(
    (entry): entry is Record<string, unknown> =>
      Boolean(entry) && typeof entry === "object" && (entry as Record<string, unknown>).mcTaskId === taskId,
  );
  if (entries.length === 0) return { matched: 0, stopped: 0 };

  const stateTool = resolveRuntimePath("swarm", "swarm-state.py");
  const now = new Date().toISOString();
  const status = transition === "hold" ? "paused" : transition === "close" ? "closed" : "deleted";
  for (const entry of entries) {
    const runtimeId = typeof entry.id === "string" ? entry.id : "";
    if (!runtimeId) throw new Error(`Swarm entry for ${taskId} has no runtime id`);
    const patch = transition === "hold"
      ? { status, heldAt: now, lastError: null }
      : transition === "close"
        ? { status, closedAt: now, lastError: null }
        : { status, deletedAt: now, lastError: null };
    await execRuntimeFile(resolvePythonBin(), [
      stateTool,
      "--registry", registryPath,
      "update",
      "--task-id", runtimeId,
      "--patch-json", JSON.stringify(patch),
      "--reason", `task-${transition}`,
    ]);
  }

  let stopped = 0;
  for (const entry of entries) {
    const session = typeof entry.tmuxSession === "string" ? entry.tmuxSession.trim() : "";
    if (!session) continue;
    try {
      await execRuntimeFile("tmux", ["kill-session", "-t", `=${session}`]);
      stopped += 1;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (!/no server running|can't find session|session not found/i.test(detail)) throw error;
    }
  }
  return { matched: entries.length, stopped };
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

// Serves a page from public/ by fixed name. Callers pass a literal, never user input.
function servePage(res: ServerResponse, filename: string): void {
  try {
    const thisDir = dirname(fileURLToPath(import.meta.url));
    const html = readFileSync(join(thisDir, "..", "public", filename), "utf-8");
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.end(html);
  } catch {
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain");
    res.end(`${filename} not found`);
  }
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

/**
 * Move a task's plan and progress out of the live directories.
 *
 * A reset used to clear only the triage state, so the plan from the discarded run
 * stayed on disk: the ticket page still rendered it, and the progress file still
 * claimed `in_progress` with pending steps, which is enough for the daemon to
 * dispatch agents against a plan for a ticket that is back in the inbox.
 *
 * Archived rather than deleted — the reset already keeps activity history as an
 * audit trail, and a discarded plan is worth the same.
 */
function archivePlanFiles(taskId: string): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(taskId)) return false;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let moved = false;
  for (const kind of ["plans", "progress"]) {
    try {
      const live = resolveRuntimePath("bridge", kind, `${taskId}.json`);
      if (!existsSync(live)) continue;
      const archiveDir = resolveRuntimePath("bridge", "archive", kind);
      mkdirSync(archiveDir, { recursive: true });
      renameSync(live, join(archiveDir, `${taskId}.${stamp}.json`));
      moved = true;
    } catch {
      // Best effort: a reset that cannot archive is still a reset, and leaving the
      // task un-reset would be worse than leaving a stale file behind.
    }
  }
  return moved;
}

/** Stop and archive a detached planning run before re-triage starts.
 *
 * The planner is launched in its own process group so the bridge can stay
 * responsive. A reset that leaves that group alive does not actually restart the
 * ticket: the next run finds the old job file, waits on its PID, and can later
 * consume a plan written from the discarded triage answers.
 */
function archivePlanningJob(taskId: string): { archived: boolean; stopped: boolean } {
  if (!/^[A-Za-z0-9_-]+$/.test(taskId)) return { archived: false, stopped: false };
  const live = resolveRuntimePath("bridge", "plan-stage", `${taskId}.job.json`);
  if (!existsSync(live)) return { archived: false, stopped: false };

  let stopped = false;
  try {
    const state = JSON.parse(readFileSync(live, "utf8")) as { state?: unknown; pid?: unknown };
    const pid = typeof state.pid === "number" ? state.pid : Number.parseInt(String(state.pid ?? ""), 10);
    if (state.state === "running" && Number.isSafeInteger(pid) && pid > 1) {
      try {
        // plan_stage_runner.py is started with start_new_session=True. Killing the
        // group also stops any research subprocesses it launched.
        process.kill(-pid, "SIGTERM");
        stopped = true;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ESRCH") throw err;
      }
    }
  } catch {
    // A malformed/stale receipt should still be archived so it cannot wedge the
    // next run. We only signal a PID read from valid JSON above.
  }

  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const archiveDir = resolveRuntimePath("bridge", "archive", "plan-stage");
    mkdirSync(archiveDir, { recursive: true });
    renameSync(live, join(archiveDir, `${taskId}.${stamp}.job.json`));
    return { archived: true, stopped };
  } catch {
    return { archived: false, stopped };
  }
}

export function createHandler(
  db: MissionControlDB,
  logger?: McLogger,
  events: McEventBus = new McEventBus(),
  dependencies: RouteDependencies = {},
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

    // One ticket, end to end: brief, what triage found, the questions, the plan.
    // /ticket?id=<task-id> — the page fetches the task itself.
    if (pathname === "/ticket" || pathname === "/ticket/") {
      servePage(res, "ticket.html");
      return;
    }

    // Server-sent events stream for reactive dashboard updates.
    if (pathname === "/api/stream" && method === "GET") {
      handleEventStream(req, res, events);
      return;
    }

    // API routes
    if (resolveApiRoutePath(pathname) !== null) {
      await handleApiRequest(req, res, url, db, log, events, dependencies);
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
  dependencies: RouteDependencies = {},
): Promise<void> {
  try {
    const pathname = url.pathname;
    const method = req.method ?? "GET";
    const readOnly = isTruthyEnv("MISSION_CONTROL_READ_ONLY");
    const runtimeTransition = dependencies.transitionTaskRuntime ?? transitionTaskRuntime;
    const linearCloser = dependencies.closeLinearIssue ?? closeLinearIssue;

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

    if (segments[0] === "surface-threads" && segments.length === 1) {
      if (method === "GET") {
        const surface = url.searchParams.get("surface")?.trim() ?? "";
        const channelId = url.searchParams.get("channel_id")?.trim() ?? "";
        const threadTs = url.searchParams.get("thread_ts")?.trim() ?? "";
        if (!surface || !channelId || !threadTs) {
          sendJson(res, 400, { error: "surface, channel_id and thread_ts are required" });
          return;
        }
        const thread = db.getSurfaceThread(surface, channelId, threadTs);
        const task = thread ? db.getTask(thread.task_id) : undefined;
        if (!thread || !task) {
          sendJson(res, 404, { error: "Surface thread not found" });
          return;
        }
        sendJson(res, 200, { thread, task });
        return;
      }

      if (method === "POST") {
        const body = await parseBody(req);
        const surface = isRecord(body) && typeof body.surface === "string" ? body.surface.trim() : "";
        const channelId = isRecord(body) && typeof body.channel_id === "string" ? body.channel_id.trim() : "";
        const threadTs = isRecord(body) && typeof body.thread_ts === "string" ? body.thread_ts.trim() : "";
        const title = isRecord(body) && typeof body.title === "string" ? body.title.trim() : "";
        if (surface !== "slack" || !/^C[A-Z0-9]+$/i.test(channelId) || !/^\d+\.\d+$/.test(threadTs) || !title) {
          sendJson(res, 400, { error: "Valid Slack surface, channel_id, thread_ts and title are required" });
          return;
        }
        const result = db.createTaskForSurfaceThread({
          surface,
          channel_id: channelId,
          thread_ts: threadTs,
          created_by_external_id:
            isRecord(body) && typeof body.created_by_external_id === "string"
              ? body.created_by_external_id.trim()
              : undefined,
          title,
          description: isRecord(body) && typeof body.description === "string" ? body.description : undefined,
          source: "slack",
        });
        sendJson(res, result.created ? 201 : 200, result);
        return;
      }
    }

    if (segments[0] === "tasks") {
      if (segments.length === 2 && segments[1] === "pending-chat" && method === "GET") {
        const requested = Number.parseInt(url.searchParams.get("limit") ?? "20", 10);
        const limit = Number.isFinite(requested) ? requested : 20;
        sendJson(res, 200, db.listPendingChatMessages(limit));
        return;
      }

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
        // Enrich with the small per-task signals the board cards render (live progress
        // and pending human checkpoints) — both come from single grouped queries.
        const progressMap = db.getProgressMap();
        const checkpointCounts = db.getPendingCheckpointCounts();
        const prLinks = db.getPrLinks();
        const previews = getPreviews();
        const enriched = tasks.map((t) => ({
          ...t,
          progress: progressMap[t.id] ?? null,
          pending_checkpoints: checkpointCounts[t.id] ?? 0,
          pr_url: prLinks[t.id] ?? null,
          preview: previews[t.id] ?? null,
        }));
        sendJson(res, 200, enriched);
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
              const needsCompletionCheck = body.status === "done";
              const needsRuntimeCheck = body.status === "on_hold";
              const oldTask = (needsTriageCheck || needsPriorityCheck || needsCompletionCheck || needsRuntimeCheck)
                ? db.getTask(taskId)
                : null;

              if (needsRuntimeCheck && !oldTask) {
                sendJson(res, 404, { error: "Task not found" });
                return;
              }

              if (needsPriorityCheck && oldTask) {
                // Escalating priority fast-tracks a parked task back to the inbox for
                // immediate dispatch. "planning" is deliberately excluded: such a task is
                // mid-triage (often with answered questions), and moving it to inbox makes
                // the bridge re-triage from scratch and discard that work.
                const stalled = ["on_hold", "inbox"];
                if (stalled.includes(oldTask.status) && !["urgent", "high"].includes(oldTask.priority)) {
                  body.status = "inbox";
                }
              }

              if (needsRuntimeCheck && oldTask?.status !== "on_hold") {
                await runtimeTransition(taskId, "hold");
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
              if (oldTask && typeof body.status === "string") {
                emitTerminalCompletion(events, taskId, oldTask.status, body.status);
              }

              sendJson(res, 200, task);
              return;
            }

            if (segments.length === 2 && method === "DELETE") {
              const task = db.getTask(taskId);
              if (!task) {
                sendJson(res, 404, { error: "Task not found" });
                return;
              }
              await runtimeTransition(taskId, "delete");
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

              if (task.status === "closed") {
                sendJson(res, 409, { error: "Closed tickets cannot be marked done" });
                return;
              }

              if (task.status === "done") {
                // Re-run the terminal invariant even for idempotent completion.
                // This repairs checkpoints created by an older process or another
                // path before terminal checkpoint cleanup was introduced.
                const reconciled = db.updateTask(taskId, { status: "done" } as unknown as UpdateTaskInput) ?? task;
                sendJson(res, 200, { success: true, alreadyDone: true, task: reconciled });
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
              emitTerminalCompletion(events, taskId, task.status, updated.status);

              sendJson(res, 200, { success: true, task: updated });
              return;
            }

            if (segments.length === 3 && segments[2] === "close" && method === "POST") {
              const task = db.getTask(taskId);
              if (!task) {
                sendJson(res, 404, { error: "Task not found" });
                return;
              }

              if (task.status === "closed") {
                // Re-run terminal cleanup to repair old pending checkpoints/progress.
                const reconciled = db.updateTask(taskId, { status: "closed" } as unknown as UpdateTaskInput) ?? task;
                sendJson(res, 200, { success: true, alreadyClosed: true, task: reconciled });
                return;
              }

              const body = await parseBody(req);
              const reason = isRecord(body) && typeof body.reason === "string" ? body.reason.trim() : "";
              let linear: LinearClosureResult | null = null;

              // The external transition is intentionally first. A failed Linear write
              // must not leave MC claiming a linked ticket was closed everywhere.
              if (task.source === "linear") {
                if (!task.external_id) {
                  sendJson(res, 409, { error: "Linear-linked task has no external issue id" });
                  return;
                }
                try {
                  linear = await linearCloser(task.external_id);
                } catch (error) {
                  const detail = error instanceof Error ? error.message : String(error);
                  logger.error(`mission-control close: Linear sync failed for ${taskId}: ${detail}`);
                  sendJson(res, 502, { error: `Could not close linked Linear issue: ${detail}` });
                  return;
                }
              }

              let runtimeWarning: string | undefined;
              try {
                await runtimeTransition(taskId, "close");
              } catch (error) {
                // Linear has already accepted the close, so converge MC on that truth
                // and surface the local cleanup warning instead of leaving split state.
                runtimeWarning = error instanceof Error ? error.message : String(error);
                logger.error(`mission-control close: runtime cleanup failed for ${taskId}: ${runtimeWarning}`);
              }

              const updated = db.updateTask(taskId, { status: "closed" } as unknown as UpdateTaskInput);
              if (!updated) {
                sendJson(res, 500, { error: "Failed to close task" });
                return;
              }

              const linearNote = linear
                ? ` Linear ${linear.identifier} is ${linear.stateName}.`
                : "";
              db.createActivity({
                task_id: taskId,
                activity_type: "status_changed",
                message: `${reason ? `Ticket closed in Mission Control. Reason: ${reason}` : "Ticket closed in Mission Control."}${linearNote}`,
              });
              if (runtimeWarning) {
                db.createActivity({
                  task_id: taskId,
                  activity_type: "error",
                  message: `Ticket closed, but local runtime cleanup needs attention: ${runtimeWarning}`,
                });
              }

              rollUpDelegation(db, taskId, events);
              events.emit("task_closed", { taskId, status: "closed", linear: linear?.identifier ?? null });
              sendJson(res, 200, {
                success: true,
                task: updated,
                linear,
                ...(runtimeWarning ? { runtimeWarning } : {}),
              });
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
                  expects_reply: body.expects_reply === true,
                  reply_to_activity_id:
                    typeof body.reply_to_activity_id === "string"
                      ? body.reply_to_activity_id
                      : undefined,
                };
                // `needs_human` is a product contract, not just notification styling:
                // if MC interrupts a person, the ticket must contain something they can
                // resolve. Older callers only posted an activity, which produced the
                // MET-642 alert after its draft PR was already in review but left no
                // question or button anywhere in MC. Convert that legacy signal into a
                // pending checkpoint at ingestion, deduped for retrying callers.
                let escalationCheckpoint;
                if (input.activity_type === "needs_human") {
                  const task = db.getTask(taskId);
                  if (!task || !["done", "closed"].includes(task.status)) {
                    escalationCheckpoint = db.findPendingCheckpoint(taskId, input.message) ?? db.createCheckpoint({
                      task_id: taskId,
                      kind: Array.isArray(body.options) ? "choice" : "question",
                      prompt: input.message,
                      options: Array.isArray(body.options) ? JSON.stringify(body.options) : undefined,
                    });

                    // A review-stage decision should remain attached to the draft PR.
                    // Active implementation work, however, really is stopped by a human
                    // escalation unless the caller explicitly marks it non-pausing.
                    const pause = body.pause !== false && task && !["review", "done", "closed"].includes(task.status);
                    if (pause) {
                      await runtimeTransition(taskId, "hold");
                      db.updateTask(taskId, { status: "on_hold" });
                      db.upsertProgress(taskId, {
                        state: "waiting",
                        blocked_reason: input.message.slice(0, 500),
                      });
                    }

                    let metadata: Record<string, unknown> = {};
                    if (input.metadata) {
                      try {
                        const parsed = JSON.parse(input.metadata);
                        if (isRecord(parsed)) metadata = parsed;
                        else metadata.source_metadata = input.metadata;
                      } catch {
                        metadata.source_metadata = input.metadata;
                      }
                    }
                    input.metadata = JSON.stringify({ ...metadata, checkpoint_id: escalationCheckpoint.id });
                  }
                }

                const activity = db.createActivity(input);

                // Surface agent escalations as a push notification, now with the id of
                // the decision the notification leads to.
                if (input.activity_type === "needs_human" && escalationCheckpoint) {
                  events.emit("needs_human", {
                    taskId,
                    message: input.message,
                    checkpointId: escalationCheckpoint?.id,
                  });
                }

                // A new triage question appeared after earlier ones were answered (e.g. the
                // bridge's repo-selection follow-up) — surface it as a notification.
                if (input.activity_type === "new_triage_question") {
                  events.emit("new_triage_question", { taskId, message: input.message });
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

            // Everything a person can do to a single question without answering it.
            // "Answer or the ticket stalls" is a false choice: the exits below are
            // what stop one unanswerable question holding up the other eight.
            //   POST /api/tasks/:id/questions/:qid/ask       {text}  — ask back
            //        .../delegate — let the agent choose and say why
            //        .../defer    — not needed yet; stops blocking
            //        .../reopen   — take back an answer, keeping its reasoning
            if (segments.length === 5 && segments[2] === "questions" && method === "POST") {
              const questionId = decodeURIComponent(segments[3]);
              const action = segments[4];
              if (!["ask", "delegate", "defer", "reopen"].includes(action)) {
                sendJson(res, 400, { error: `Unknown question action: ${action}` });
                return;
              }

              const state = db.getTriageState(taskId);
              const questions = isRecord(state) && Array.isArray(state.questions) ? state.questions : null;
              if (!questions) {
                sendJson(res, 404, { error: "No questions on this task" });
                return;
              }
              const question = questions.find(
                (q) => isRecord(q) && q.id === questionId,
              ) as Record<string, unknown> | undefined;
              if (!question) {
                sendJson(res, 404, { error: `No question ${questionId}` });
                return;
              }

              const now = new Date().toISOString();
              let activityType = "updated";
              let activityMessage = "";

              if (action === "ask") {
                const body = await parseBody(req);
                const text = isRecord(body) && typeof body.text === "string" ? body.text.trim() : "";
                if (!text) {
                  sendJson(res, 400, { error: "Ask requires a non-empty text" });
                  return;
                }
                const thread = Array.isArray(question.thread) ? question.thread : [];
                question.thread = [...thread, { role: "you", text, at: now }];
                // A dedicated type so the bridge can see there is a reply owed —
                // the whole point is that the asker gets an answer, not a form.
                activityType = "question_asked";
                activityMessage = `Question "${String(question.question ?? questionId).slice(0, 120)}" — asked back: ${text}`;
              } else if (action === "delegate") {
                // A double click or a stale render must not create a new activity
                // every time. The pending handoff remains visible until the bridge
                // records an answer, so repeating it has no additional meaning.
                if (question.delegate_requested === true) {
                  sendJson(res, 200, { success: true, triage_state: state });
                  return;
                }
                question.delegate_requested = true;
                question.deferred = false;
                activityType = "question_delegated";
                activityMessage = `Question "${String(question.question ?? questionId).slice(0, 120)}" handed to the agent to decide.`;
              } else if (action === "defer") {
                question.deferred = true;
                question.delegate_requested = false;
                activityMessage = `Question "${String(question.question ?? questionId).slice(0, 120)}" deferred — it no longer blocks.`;
              } else {
                // reopen: the answer goes, the reasoning stays. Someone overriding an
                // agent's pick should be able to read why it picked that while deciding.
                // It also un-defers, so "bring it back" is the same edit as "change it".
                const wasDeferred = question.deferred === true;
                question.answer = null;
                question.answered_at = null;
                question.answered_by = null;
                question.delegate_requested = false;
                question.delegated_answer = false;
                question.deferred = false;
                activityMessage = wasDeferred
                  ? `Question "${String(question.question ?? questionId).slice(0, 120)}" is back in play.`
                  : `Answer to "${String(question.question ?? questionId).slice(0, 120)}" taken back.`;
              }

              const next = db.replaceTriageState(taskId, { ...state, questions, updated_at: now });
              db.createActivity({
                task_id: taskId,
                activity_type: activityType,
                message: activityMessage,
              });
              sendJson(res, 200, { success: true, triage_state: next });
              return;
            }

            if (segments.length === 3 && segments[2] === "reset-triage" && method === "POST") {
              const beforeReset = db.getTask(taskId);
              if (!beforeReset) {
                sendJson(res, 404, { error: "Task not found" });
                return;
              }
              const prUrl = db.listDeliverables(taskId).find((deliverable) =>
                ["pr", "pull_request"].includes(deliverable.deliverable_type.toLowerCase()) &&
                typeof deliverable.path === "string" &&
                deliverable.path.length > 0
              )?.path ?? null;
              let prReset: ResetPullRequestResult | null = null;
              if (prUrl) {
                try {
                  prReset = await (dependencies.resetPullRequest ?? closePullRequestForReset)(prUrl);
                } catch (error) {
                  const detail = error instanceof Error ? error.message : String(error);
                  logger.error(`triage reset refused for ${taskId}: could not close ${prUrl}: ${detail}`);
                  sendJson(res, 502, {
                    error: `Reset stopped because the existing pull request could not be closed: ${detail}`,
                    pr_url: prUrl,
                  });
                  return;
                }
              }

              const task = db.resetTriage(taskId);
              if (!task) {
                sendJson(res, 404, { error: "Task not found" });
                return;
              }
              // The plan and its progress live on disk, and resetting only cleared
              // the triage state — so a kicked-back ticket still showed the plan
              // from the run that had just been discarded, and looked planned when
              // it was not. Worse, the progress file still said `in_progress` with
              // pending steps, so the daemon could dispatch agents against a plan
              // for a ticket that was back in the inbox being re-triaged.
              //
              // Archived rather than deleted, to match the activity history this
              // reset already keeps as an audit trail.
              const archived = archivePlanFiles(taskId);
              const planningJob = archivePlanningJob(taskId);

              db.createActivity({
                task_id: taskId,
                activity_type: "triage_reset",
                message: [
                  planningJob.stopped
                    ? "Triage reset — task returned to inbox for re-triage. The active planning run was stopped and archived."
                    : archived || planningJob.archived
                      ? "Triage reset — task returned to inbox for re-triage. The previous planning state was archived."
                      : "Triage reset — task returned to inbox for re-triage.",
                  prReset?.closed
                    ? `Draft PR closed for reset (${prReset.url}); the same PR will be reopened if this run keeps the repository.`
                    : prReset?.state === "CLOSED"
                      ? `The recorded PR was already closed (${prReset.url}).`
                      : prReset?.state === "MERGED"
                        ? `The recorded PR was already merged (${prReset.url}).`
                        : "",
                ].filter(Boolean).join(" "),
                metadata: prReset ? JSON.stringify({
                  pr_url: prReset.url,
                  pr_state: prReset.state,
                  pr_disposition: prReset.state === "CLOSED" ? "reuse_if_same_repo" : "inactive",
                }) : undefined,
              });
              events.emit("triage_reset", { taskId });
              sendJson(res, 200, task);
              return;
            }

            // Local dev-server preview of the task's branch, so a reviewer can open
            // the change in a browser and verify it.
            if (segments.length === 3 && segments[2] === "preview" && method === "POST") {
              const task = db.getTask(taskId);
              if (!task) {
                sendJson(res, 404, { error: "Task not found" });
                return;
              }
              try {
                const state = await startPreview(taskId, task.title ?? "");
                db.createActivity({
                  task_id: taskId,
                  activity_type: "updated",
                  message: `Started local preview: ${state.app} at ${state.url}${state.apiReadOnly ? " · local API · production data · read-only" : ""}`,
                });
                sendJson(res, 200, state);
              } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                logger.error(`preview start failed for ${taskId}: ${message}`);
                sendJson(res, 400, { error: message });
              }
              return;
            }

            if (
              segments.length === 4 &&
              segments[2] === "preview" &&
              segments[3] === "stop" &&
              method === "POST"
            ) {
              const stopped = stopPreview(taskId);
              sendJson(res, 200, { stopped });
              return;
            }

            // One-click follow-up actions on a review-state ticket. Each posts a canned
            // instruction as manual_feedback; the bridge's review-feedback path relaunches
            // the agent (reusing its worktree/PR). Same instruction text the auto-monitors use.
            if (segments.length === 3 && segments[2] === "followup" && method === "POST") {
              const body = await parseBody(req);
              const action = isRecord(body) ? String(body.action ?? "") : "";
              const instruction = FOLLOWUP_ACTIONS[action];
              if (!instruction) {
                sendJson(res, 400, { error: `Unknown follow-up action: ${action}` });
                return;
              }
              const task = db.getTask(taskId);
              if (!task) {
                sendJson(res, 404, { error: "Task not found" });
                return;
              }
              db.createActivity({ task_id: taskId, activity_type: "manual_feedback", message: instruction });
              db.createActivity({
                task_id: taskId,
                activity_type: "updated",
                message: `Follow-up queued: ${action.replace(/_/g, " ")} — relaunching agent.`,
              });
              sendJson(res, 200, { queued: true, action });
              return;
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
                const badState = invalidProgressState(body);
                if (badState !== null) {
                  sendJson(res, 400, {
                    error: `Unknown progress state: ${badState}`,
                    allowed: PROGRESS_STATES,
                  });
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

            // The plan and its per-step progress live on disk, written by the Python
            // planner (bridge/plans, bridge/progress). Until they move into SQLite,
            // the ticket page reads them through here rather than reinventing paths.
            if (segments.length === 3 && segments[2] === "plan" && method === "GET") {
              const readJson = (kind: string): unknown => {
                // taskId comes off the URL, so keep it to the id shape db ids use —
                // anything else could walk out of the directory.
                if (!/^[A-Za-z0-9_-]+$/.test(taskId)) return null;
                try {
                  const path = resolveRuntimePath("bridge", kind, `${taskId}.json`);
                  return existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : null;
                } catch {
                  return null;
                }
              };
              sendJson(res, 200, { plan: readJson("plans"), progress: readJson("progress") });
              return;
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
                await runtimeTransition(parent.id, "hold");
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
                const body = await parseBody(req);
                if (!isRecord(body) || typeof body.prompt !== "string" || !body.prompt.trim()) {
                  sendJson(res, 400, { error: "Checkpoint prompt is required" });
                  return;
                }
                // Read task state after the asynchronous body parse so completion
                // cannot race with checkpoint creation on the same event loop.
                const task = db.getTask(taskId);
                if (!task) {
                  sendJson(res, 404, { error: "Task not found" });
                  return;
                }
                if (["done", "closed"].includes(task.status)) {
                  sendJson(res, 409, { error: "Completed tasks cannot accept new checkpoints" });
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
                  await runtimeTransition(taskId, "hold");
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
            if (task.status === "on_hold") {
              sendJson(res, 409, { error: "Task is on hold; completion callback ignored" });
              return;
            }
            if (task.status === "closed") {
              sendJson(res, 409, { error: "Task is closed; completion callback ignored" });
              return;
            }

            const newStatus = (typeof body.status === "string" && ["testing", "review", "done"].includes(body.status)
              ? body.status
              : "review") as TaskStatus;

            // Review/testing means an agent run has handed work back; only `done`
            // closes the ticket. Preserve a task already in review/done on repeated
            // review webhooks, while still allowing an explicit review -> done move.
            const alreadyAtOrBeyondRequestedStatus =
              task.status === "done" || (newStatus !== "done" && task.status === "review");
            const suppliedPrUrl = typeof body.pr_url === "string" &&
              /^https?:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/\d+(?:[/?#].*)?$/.test(body.pr_url)
              ? body.pr_url
              : undefined;
            const existingPr = db.listDeliverables(task.id, 100).find(
              (deliverable) =>
                ["pr", "pull_request"].includes(deliverable.deliverable_type) &&
                typeof deliverable.path === "string" &&
                deliverable.path.length > 0
            );
            const explicitlyNoPr = body.no_pr === true;

            // A process exit is not implementation evidence. Requiring either a
            // recorded PR or an explicit no-PR dispatch keeps an empty/partial run
            // from moving into review merely because its CLI returned success.
            if (
              !alreadyAtOrBeyondRequestedStatus &&
              task.task_type === "implementation" &&
              !suppliedPrUrl &&
              !existingPr &&
              !explicitlyNoPr
            ) {
              sendJson(res, 409, {
                error: "Implementation completion requires pr_url or explicit no_pr mode",
              });
              return;
            }

            if (suppliedPrUrl && !existingPr) {
              db.createDeliverable({
                task_id: task.id,
                deliverable_type: "pr",
                title: "Pull request",
                path: suppliedPrUrl,
              });
            }

            if (!alreadyAtOrBeyondRequestedStatus) {
              db.updateTask(task.id, { status: newStatus });
            }

            if (TERMINAL_TASK_STATUSES.has(newStatus)) {
              rollUpDelegation(db, task.id, events);
            }
            // Agent runs may complete many times while automated review sends them
            // back for another pass. Telegram should announce the ticket exactly when
            // it becomes done, not each time a run returns it to review.
            if (!alreadyAtOrBeyondRequestedStatus) {
              emitTerminalCompletion(events, task.id, task.status, newStatus);
            }

            db.createEvent({
              type: newStatus === "done" ? "task_completed" : "agent_run_completed",
              task_id: task.id,
              agent_id: task.assigned_agent_id ?? undefined,
              message:
                typeof body.summary === "string"
                  ? body.summary
                  : newStatus === "done"
                    ? `Task ${task.id} completed`
                    : `Agent run completed; task moved to ${newStatus}`,
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
              type: "agent_run_completed",
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

        if (segments[0] === "previews" && segments.length === 1 && method === "GET") {
          sendJson(res, 200, getPreviews());
          return;
        }

        if (
          segments[0] === "previews" &&
          segments[1] === "stop-all" &&
          segments.length === 2 &&
          method === "POST"
        ) {
          const stopped = stopAllPreviews();
          sendJson(res, 200, { stopped });
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
          const envConfig = readEnvConfig();
          let configuredClaude = 10;
          let configuredCodex = 3;
          try {
            const mcHome = process.env.MC_HOME ?? join(homedir(), ".mission-control");
            const raw = JSON.parse(readFileSync(join(mcHome, "swarm", "swarm-config.json"), "utf-8"));
            const profiles = isRecord(raw?.agents) && isRecord(raw.agents.profiles) ? raw.agents.profiles : {};
            const claudeProfile = isRecord(profiles.claude) ? profiles.claude : {};
            const codexProfile = isRecord(profiles.codex) ? profiles.codex : {};
            const legacyClaude = isRecord(raw?.claude) ? raw.claude : {};
            const legacyCodex = isRecord(raw?.codex) ? raw.codex : {};
            configuredClaude = Number(claudeProfile.maxAgents ?? legacyClaude.maxAgents ?? configuredClaude);
            configuredCodex = Number(codexProfile.maxAgents ?? legacyCodex.maxAgents ?? configuredCodex);
          } catch {
            // Defaults remain available when the optional swarm config is absent.
          }
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
              maxClaude: parseInt(process.env.MAX_CLAUDE_AGENTS || envConfig.MAX_CLAUDE_AGENTS || String(configuredClaude), 10),
              maxCodex: parseInt(process.env.MAX_CODEX_AGENTS || envConfig.MAX_CODEX_AGENTS || String(configuredCodex), 10),
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
          sendJson(res, 200, discoverExecutionRepos());
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
            const valueOf = (key: string) => (env[key] ?? process.env[key] ?? "").trim();
            sendJson(res, 200, {
              configured: Object.fromEntries(SETTABLE_KEYS.map(k => [k, isSet(k)])),
              values: Object.fromEntries(VALUE_KEYS.map(k => [k, valueOf(k)])),
              features: {
                generation: isSet("ANTHROPIC_API_KEY") || isSet("OPENAI_API_KEY") || isSet("GOOGLE_GENERATIVE_AI_API_KEY") || isSet("OPENROUTER_API_KEY"),
                knowledgeStore: isSet("CONTEXT_FABRICA_DSN"),
                linear: isSet("LINEAR_API_KEY"),
                notifications: isSet("MISSION_CONTROL_NOTIFY_WEBHOOK"),
                messageBus: isSet("TELEGRAM_BOT_TOKEN") || isSet("SLACK_BOT_TOKEN"),
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

        // Prove the chat interface end to end from Settings: identify the bot, then send
        // a real message to every allowlisted target. Verifying the token alone is not
        // enough — a wrong chat id or a missing im:write scope only shows on a send.
        if (segments[0] === "settings" && segments[1] === "messagebus-test" && segments.length === 2 && method === "POST") {
          const body = await parseBody(req);
          const surface = isRecord(body) && typeof body.surface === "string" ? body.surface.toLowerCase() : "";
          if (surface !== "telegram" && surface !== "slack") {
            sendJson(res, 400, { error: 'surface must be "telegram" or "slack"' });
            return;
          }
          const mcHome = process.env.MC_HOME ?? join(homedir(), ".mission-control");
          const cfg = readBusConfig(mcHome);
          const text = "✅ Mission Control test message — the chat interface is connected. Send /help for commands.";

          if (surface === "telegram") {
            if (!cfg.telegram.token) {
              sendJson(res, 400, { error: "TELEGRAM_BOT_TOKEN is not set" });
              return;
            }
            if (cfg.telegram.chatIds.length === 0) {
              sendJson(res, 400, { error: "TELEGRAM_ALLOWED_CHAT_IDS is empty — add your chat id" });
              return;
            }
            let bot = "";
            try {
              const me = await telegramGetMe(cfg.telegram.token);
              bot = me.username ? `@${me.username}` : "";
            } catch (e) {
              sendJson(res, 400, { error: `Bot token rejected: ${e instanceof Error ? e.message : String(e)}` });
              return;
            }
            const results = await Promise.all(
              cfg.telegram.chatIds.map(async (chatId) => {
                try {
                  await sendTelegramMessage(cfg.telegram.token, chatId, text);
                  return { target: chatId, ok: true };
                } catch (e) {
                  return { target: chatId, ok: false, error: e instanceof Error ? e.message : String(e) };
                }
              }),
            );
            sendJson(res, 200, { surface, bot, interaction: cfg.telegram.interaction, events: cfg.telegram.events, results });
            return;
          }

          if (!cfg.slack.botToken) {
            sendJson(res, 400, { error: "SLACK_BOT_TOKEN is not set" });
            return;
          }
          if (cfg.slack.userIds.length === 0) {
            sendJson(res, 400, { error: "SLACK_ALLOWED_USER_IDS is empty — add your Slack user id (U…)" });
            return;
          }
          let bot = "";
          let team = "";
          try {
            const auth = await slackAuthTest(cfg.slack.botToken);
            bot = auth.user ?? "";
            team = auth.team ?? "";
          } catch (e) {
            sendJson(res, 400, { error: `Bot token rejected: ${e instanceof Error ? e.message : String(e)}` });
            return;
          }
          const results = await Promise.all(
            cfg.slack.userIds.map(async (userId) => {
              try {
                await sendSlackMessage(cfg.slack.botToken, userId, text);
                return { target: userId, ok: true };
              } catch (e) {
                return { target: userId, ok: false, error: e instanceof Error ? e.message : String(e) };
              }
            }),
          );
          // Commands need Socket Mode; saying so here beats silently never listening.
          const inbound = cfg.slack.interaction === "command" && !cfg.slack.appToken
            ? "interaction is 'command' but SLACK_APP_TOKEN (xapp-) is missing — inbound commands are off"
            : undefined;
          sendJson(res, 200, { surface, bot, team, interaction: cfg.slack.interaction, events: cfg.slack.events, results, inbound });
          return;
        }

        if (segments[0] === "linear" && segments[1] === "meta" && segments.length === 2 && method === "GET") {
          // Pull teams/labels/members from Linear so the UI can offer pickers.
          try {
            const result = await runPython([resolveRuntimePath("integrations", "linear", "linear-sync.py"), "--discover"]);
            sendJson(res, 200, result);
          } catch (e) {
            sendJson(res, 502, { error: e instanceof Error ? e.message : String(e) });
          }
          return;
        }

        if (segments[0] === "linear" && segments[1] === "issues" && segments.length === 2 && method === "POST") {
          const body = await parseBody(req);
          if (!isRecord(body) || typeof body.title !== "string" || !body.title.trim()) {
            sendJson(res, 400, { error: "title is required" });
            return;
          }
          const title = body.title.trim();
          if (title.length > 255) {
            sendJson(res, 400, { error: "title must be 255 characters or fewer" });
            return;
          }
          const description = typeof body.description === "string" ? body.description.trim() : "";
          const requestId = typeof body.request_id === "string" ? body.request_id.trim() : "";
          if (!requestId) {
            sendJson(res, 400, { error: "request_id is required" });
            return;
          }

          try {
            const createIssue = dependencies.createLinearIssue ?? createLinearIssueWithScript;
            const linear = await createIssue({
              title,
              description,
              requestId,
              teamKey: typeof body.team_key === "string" ? body.team_key.trim() : undefined,
              assignee: typeof body.assignee === "string" ? body.assignee.trim() : undefined,
            });
            const issue = linear.issue;
            let task = db.getTaskByExternalId(issue.id);
            let taskCreated = false;
            if (!task) {
              const descriptionParts = description ? [description] : [];
              descriptionParts.push(`\n---\n*Synced from Linear: [${issue.identifier}](${issue.url})*`);
              if (issue.assignee?.name) descriptionParts.push(`*Linear assignee: ${issue.assignee.name}*`);
              try {
                task = db.createTask({
                  title: `[${issue.identifier}] ${issue.title}`,
                  description: descriptionParts.join("\n"),
                  status: "inbox",
                  priority: ({ 1: "urgent", 2: "high", 4: "low" } as Record<number, "urgent" | "high" | "low">)[issue.priority ?? 0] ?? "normal",
                  external_id: issue.id,
                  external_url: issue.url,
                  source: "linear",
                  task_type: "implementation",
                });
                taskCreated = true;
              } catch (error) {
                // The scheduled Linear poll may have imported the deterministic issue
                // between our lookup and insert. Its unique external-id index decides;
                // recover that task instead of reporting a false failure.
                task = db.getTaskByExternalId(issue.id);
                if (!task) throw error;
              }
            }
            if (taskCreated) {
              db.createActivity({
                task_id: task.id,
                activity_type: "created",
                message: `Created from Telegram and synced to Linear as ${issue.identifier}`,
                metadata: JSON.stringify({
                  source: "telegram",
                  actor: typeof body.actor === "string" ? body.actor : null,
                  request_id: requestId,
                }),
              });
            }
            sendJson(res, taskCreated ? 201 : 200, {
              created: taskCreated,
              linear_created: linear.created,
              issue,
              task,
            });
          } catch (error) {
            sendJson(res, 502, { error: error instanceof Error ? error.message : String(error) });
          }
          return;
        }

        if (segments[0] === "linear" && segments[1] === "sync" && segments.length === 2 && method === "POST") {
          // Run a full Linear sync once now, instead of waiting for the scheduled cycle.
          const result = await runPythonRaw([resolveRuntimePath("integrations", "linear", "linear-sync.py")]);
          db.createEvent({ type: "linear_sync", message: `Manual Linear sync: ${result.ok ? "ok" : "failed"}` });
          sendJson(res, result.ok ? 200 : 502, result);
          return;
        }

        if (segments[0] === "repos" && segments[1] === "meta" && segments.length === 2 && method === "GET") {
          // Discover git repos under the watch root for the Settings picker.
          sendJson(res, 200, discoverRepos());
          return;
        }

        if (segments[0] === "repos" && segments[1] === "scan" && segments.length === 2 && method === "POST") {
          // Run repo-watcher once now to seed the knowledge store from watched repos.
          const result = await runPythonRaw([resolveRuntimePath("swarm", "repo-watcher.py")]);
          db.createEvent({ type: "repo_scan", message: `Repo knowledge scan: ${result.ok ? "ok" : "failed"}` });
          sendJson(res, result.ok ? 200 : 502, result);
          return;
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
  "MISSION_CONTROL_ACCESS_TOKEN",
  "MISSION_CONTROL_READ_ACCESS_TOKEN",
  "MISSION_CONTROL_AUTH_MODE",
  "MISSION_CONTROL_READ_TOKEN",
  "MISSION_CONTROL_WRITE_TOKEN",
  "MISSION_CONTROL_ADMIN_TOKEN",
  "MISSION_CONTROL_WEBHOOK_SECRET",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "OPENROUTER_API_KEY",
  "EMBEDDING_PROVIDER",
  "EMBEDDING_MODEL",
  "CONTEXT_FABRICA_EMBEDDING_DIMENSIONS",
  "CONTEXT_FABRICA_DSN",
  "CONTEXT_FABRICA_SCHEMA",
  "LINEAR_API_KEY",
  "LINEAR_INTERACTION",
  "LINEAR_LABEL",
  "LINEAR_TRIAGE_LABEL",
  "LINEAR_TEAM_KEYS",
  "LINEAR_ASSIGNEES",
  "LINEAR_CREATE_TEAM_KEY",
  "LINEAR_CREATE_ASSIGNEE",
  "REPO_WATCH_ROOT",
  "REPO_WATCH_REPOS",
  "MISSION_CONTROL_NOTIFY_WEBHOOK",
  // Message bus — chat interface. Bot/app tokens are secrets; the rest is config.
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_ALLOWED_CHAT_IDS",
  "TELEGRAM_INTERACTION",
  "TELEGRAM_EVENTS",
  "TELEGRAM_ASSISTANT",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "SLACK_ALLOWED_USER_IDS",
  "SLACK_ALLOWED_CHANNEL_IDS",
  "SLACK_INTERACTION",
  "SLACK_EVENTS",
  // Dedicated trusted API checkout and production reader for local previews.
  "MC_PREVIEW_API_RUNNER_ROOT",
  "MC_PREVIEW_PROD_READ_DATABASE_URL",
];

// Non-secret settings whose current value is safe to return to the UI (so a
// dropdown or text field can show the active value). Secret keys never expose values.
const VALUE_KEYS = [
  "LINEAR_INTERACTION",
  "LINEAR_LABEL",
  "LINEAR_TRIAGE_LABEL",
  "LINEAR_TEAM_KEYS",
  "LINEAR_ASSIGNEES",
  "LINEAR_CREATE_TEAM_KEY",
  "LINEAR_CREATE_ASSIGNEE",
  "REPO_WATCH_ROOT",
  "REPO_WATCH_REPOS",
  "TELEGRAM_ALLOWED_CHAT_IDS",
  "TELEGRAM_INTERACTION",
  "TELEGRAM_EVENTS",
  "TELEGRAM_ASSISTANT",
  "SLACK_ALLOWED_USER_IDS",
  "SLACK_ALLOWED_CHANNEL_IDS",
  "SLACK_INTERACTION",
  "SLACK_EVENTS",
  "MC_PREVIEW_API_RUNNER_ROOT",
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

async function createLinearIssueWithScript(
  input: CreateLinearIssueInput,
): Promise<{ created: boolean; issue: CreatedLinearIssue }> {
  const args = [
    resolveRuntimePath("integrations", "linear", "linear-sync.py"),
    "--create-issue",
    "--title", input.title,
    "--description", input.description,
    "--request-id", input.requestId,
  ];
  if (input.teamKey) args.push("--team-key", input.teamKey);
  if (input.assignee) args.push("--assignee", input.assignee);
  const result = await runPython(args);
  if (!isRecord(result.issue)) throw new Error("Linear issue creation returned no issue");
  return {
    created: result.created === true,
    issue: result.issue as unknown as CreatedLinearIssue,
  };
}

// Run a Python helper that logs (not JSON) and return its tail + exit status.
function runPythonRaw(args: string[], timeoutMs = 600000): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const pythonBin = resolvePythonBin();
    execFile(pythonBin, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      const combined = `${stdout || ""}${stderr || ""}`.trim();
      const tail = combined.split("\n").slice(-6).join("\n");
      resolve({ ok: !err, output: tail });
    });
  });
}

// Discover git repos under the repo-watcher root for Settings and ticket routing.
// Both layouts are real here: ~/GitProjects/backend is flat, while
// ~/GitProjects/external/mission-control is nested.
function discoverRepos(): { repos: { domain: string }[]; root: string } {
  const env = readEnvConfig();
  const root = (env.REPO_WATCH_ROOT || process.env.REPO_WATCH_ROOT || join(homedir(), "GitProjects")).trim();
  const repos: { domain: string }[] = [];
  try {
    for (const group of readdirSync(root, { withFileTypes: true })) {
      if (!group.isDirectory()) continue;
      if (group.name === "worktrees" || group.name === "external") continue;
      const gpath = join(root, group.name);
      if (existsSync(join(gpath, ".git"))) {
        repos.push({ domain: `${basename(root)}/${group.name}` });
        continue;
      }
      try {
        for (const repo of readdirSync(gpath, { withFileTypes: true })) {
          if (repo.isDirectory() && existsSync(join(gpath, repo.name, ".git"))) {
            repos.push({ domain: `${group.name}/${repo.name}` });
          }
        }
      } catch { /* unreadable group dir */ }
    }
  } catch { /* root missing/unreadable */ }
  return { repos, root };
}

// Ticket routing uses the operator's repo-watcher allowlist as its execution
// boundary. Settings still receives every canonical checkout from discoverRepos()
// so the allowlist can be changed without editing a file by hand.
function discoverExecutionRepos(): { repos: { project: string; repo: string; domain: string }[]; root: string } {
  const discovered = discoverRepos();
  const env = readEnvConfig();
  const allowlist = new Set(
    (env.REPO_WATCH_REPOS || process.env.REPO_WATCH_REPOS || "")
      .split(",")
      .map(label => label.trim())
      .filter(Boolean),
  );
  const repos = discovered.repos
    .filter(({ domain }) => !allowlist.size || allowlist.has(domain))
    .map(({ domain }) => {
      const slash = domain.indexOf("/");
      return {
        project: slash >= 0 ? domain.slice(0, slash) : "",
        repo: slash >= 0 ? domain.slice(slash + 1) : domain,
        domain,
      };
    });
  return { repos, root: discovered.root };
}
