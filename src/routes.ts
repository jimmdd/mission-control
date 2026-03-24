import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, cpus, totalmem, freemem, loadavg } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type {
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
} from "./db.js";

export async function parseBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: unknown) => {
      body += String(chunk);
    });
    req.on("end", () => {
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
  return (process.env.MISSION_CONTROL_READ_ACCESS_TOKEN ?? "").trim();
}

function extractProvidedToken(req: IncomingMessage, url: URL): string {
  const auth = req.headers.authorization;
  if (typeof auth === "string" && auth.startsWith("Bearer ")) {
    return auth.slice(7).trim();
  }
  const queryToken = url.searchParams.get("token");
  return typeof queryToken === "string" ? queryToken.trim() : "";
}

function isReadAuthorized(req: IncomingMessage, url: URL): boolean {
  const required = getReadAccessToken();
  if (!required) return true;
  const provided = extractProvidedToken(req, url);
  return provided === required;
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

function isUrlSafe(urlStr: string): { safe: boolean; reason?: string } {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return { safe: false, reason: "Invalid URL" };
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { safe: false, reason: "Only http and https URLs are allowed" };
  }

  const host = parsed.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host === "[::1]" ||
    host === "::1" ||
    host.endsWith(".local")
  ) {
    return { safe: false, reason: "Local/private hosts are not allowed" };
  }

  const ipParts = host.split(".").map(Number);
  if (ipParts.length === 4 && ipParts.every(n => !isNaN(n))) {
    if (ipParts[0] === 10) return { safe: false, reason: "Private IP range blocked" };
    if (ipParts[0] === 172 && ipParts[1] >= 16 && ipParts[1] <= 31) return { safe: false, reason: "Private IP range blocked" };
    if (ipParts[0] === 192 && ipParts[1] === 168) return { safe: false, reason: "Private IP range blocked" };
    if (ipParts[0] === 169 && ipParts[1] === 254) return { safe: false, reason: "Link-local IP range blocked" };
  }

  return { safe: true };
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
const PLUGIN_PREFIX = "/ext/mission-control";
const API_PREFIX = `${PLUGIN_PREFIX}/api`;

function getSwarmConfig(): Record<string, unknown> {
  try {
    const p = join(homedir(), ".openclaw", "swarm", "swarm-config.json");
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf-8"));
  } catch {}
  return {};
}

async function getSwarmAgentStatusMap(
  logger: OpenClawPluginApi["logger"]
): Promise<Record<string, Record<string, unknown>>> {
  const registryPath = join(homedir(), ".openclaw", "swarm", "active-tasks.json");
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

function getLinearConfig(): { enabled: boolean; label: string; triageLabel: string; mentionTag: string; botName: string } {
  const cfg = getSwarmConfig();
  const linear = (cfg.linear ?? {}) as Record<string, unknown>;
  return {
    enabled: linear.enabled !== false,
    label: typeof linear.label === "string" ? linear.label : "",
    triageLabel: typeof linear.triageLabel === "string" ? linear.triageLabel : "",
    mentionTag: typeof linear.mentionTag === "string" ? linear.mentionTag : "",
    botName: typeof linear.botName === "string" ? linear.botName : "Mission Control",
  };
}

const LINEAR_API = "https://api.linear.app/graphql";

async function linearGraphQL(query: string, variables?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) throw new Error("LINEAR_API_KEY not set");

  const resp = await fetch(LINEAR_API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: apiKey },
    body: JSON.stringify({ query, variables }),
  });

  if (!resp.ok) throw new Error(`Linear API ${resp.status}: ${resp.statusText}`);
  const json = (await resp.json()) as Record<string, unknown>;
  if (json.errors) {
    const msgs = (json.errors as Array<{ message: string }>).map(e => e.message).join("; ");
    throw new Error(`Linear GraphQL: ${msgs}`);
  }
  return (json.data ?? {}) as Record<string, unknown>;
}

interface TriageQuestion {
  question?: string;
  q?: string;
  answer?: string;
  answered?: boolean;
  options?: string[];
  linear_comment_id?: string;
}

interface TriageState {
  questions?: TriageQuestion[];
  status?: string;
}

function parseTriageState(raw: unknown): TriageState | null {
  if (!raw) return null;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (parsed && Array.isArray(parsed.questions)) return parsed as TriageState;
  } catch {}
  return null;
}

/** Post triage answers back to Linear as a formatted comment. Fire-and-forget. */
function syncTriageAnswersToLinear(
  externalId: string,
  oldState: TriageState | null,
  newState: TriageState,
): void {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) return;

  const cfg = getLinearConfig();
  if (!cfg.enabled) return;

  const newQs = newState.questions ?? [];
  const oldQs = oldState?.questions ?? [];
  const prefix = `${cfg.mentionTag} **${cfg.botName}**`;

  const threadMutation = `mutation($issueId: String!, $body: String!, $parentId: String!) {
    commentCreate(input: { issueId: $issueId, body: $body, parentId: $parentId }) { success }
  }`;
  const topLevelMutation = `mutation($issueId: String!, $body: String!) {
    commentCreate(input: { issueId: $issueId, body: $body }) { success }
  }`;

  const unthreaded: { question: string; answer: string }[] = [];

  for (let i = 0; i < newQs.length; i++) {
    const nq = newQs[i];
    const oq = oldQs[i];
    const hasNewAnswer = !!(nq.answer || nq.answered);
    const hadOldAnswer = !!(oq?.answer || oq?.answered);
    if (!hasNewAnswer || hadOldAnswer) continue;

    const answer = nq.answer ?? "(no text)";
    const linearCommentId = nq.linear_comment_id;

    if (linearCommentId) {
      const body = `${prefix}: **A:** ${answer}`;
      linearGraphQL(threadMutation, {
        issueId: externalId,
        body,
        parentId: linearCommentId,
      }).catch(err => {
        console.error(`[MC] Failed to reply to Q${i + 1} thread: ${err}`);
      });
    } else {
      unthreaded.push({
        question: nq.question ?? nq.q ?? `Question ${i + 1}`,
        answer,
      });
    }
  }

  if (unthreaded.length > 0) {
    const body = unthreaded.map(qa =>
      `**Q:** ${qa.question}\n**A:** ${qa.answer}`
    ).join("\n\n");

    linearGraphQL(topLevelMutation, {
      issueId: externalId,
      body: `${prefix}: Triage answers via Mission Control:\n\n${body}`,
    }).catch(err => {
      console.error(`[MC] Failed to sync triage answers to Linear: ${err}`);
    });
  }
}

async function fetchLinearTeams(): Promise<Array<{ id: string; name: string; key: string }>> {
  const data = await linearGraphQL(`{ teams { nodes { id name key } } }`);
  const teams = data.teams as { nodes: Array<{ id: string; name: string; key: string }> };
  return teams.nodes;
}

let labelIdCache: Record<string, string> = {};

async function resolveLinearLabelId(labelName: string): Promise<string | null> {
  if (labelIdCache[labelName]) return labelIdCache[labelName];

  const data = await linearGraphQL(
    `query($name: String!) { issueLabels(filter: { name: { eq: $name } }) { nodes { id name } } }`,
    { name: labelName },
  );
  const labels = data.issueLabels as { nodes: Array<{ id: string; name: string }> };
  if (labels.nodes.length > 0) {
    labelIdCache[labelName] = labels.nodes[0].id;
    return labels.nodes[0].id;
  }
  return null;
}

const MC_PRIORITY_TO_LINEAR: Record<string, number> = { urgent: 1, high: 2, normal: 3, low: 4 };

async function createLinearIssue(
  teamId: string,
  title: string,
  description: string | undefined,
  priority: string,
  labelName: string,
): Promise<{ id: string; identifier: string; url: string }> {
  const labelId = await resolveLinearLabelId(labelName);
  const linearPriority = MC_PRIORITY_TO_LINEAR[priority] ?? 3;
  const labelIds = labelId ? [labelId] : [];

  const data = await linearGraphQL(
    `mutation($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue { id identifier url }
      }
    }`,
    { input: { title, description: description ?? "", teamId, priority: linearPriority, labelIds } },
  );

  const result = data.issueCreate as { success: boolean; issue: { id: string; identifier: string; url: string } };
  if (!result.success) throw new Error("Linear issue creation failed");
  return result.issue;
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

export function registerRoutes(api: OpenClawPluginApi, db: MissionControlDB): void {
  api.logger.info(`mission-control: registering HTTP handler at ${API_PREFIX}`);

  // Use registerHttpHandler (not registerHttpRoute) because this gateway
  // version only supports exact-path matching for registerHttpRoute.
  // registerHttpHandler passes the raw request and expects a boolean return.
  api.registerHttpHandler(async (req: IncomingMessage, res: ServerResponse): Promise<boolean | void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;

    if (pathname.startsWith(PLUGIN_PREFIX) && !isReadAuthorized(req, url)) {
      if (pathname.startsWith(API_PREFIX)) {
        sendJson(res, 401, { error: "Unauthorized" });
      } else {
        res.statusCode = 401;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Unauthorized");
      }
      return true;
    }

    // Serve dashboard UI at /ext/mission-control/ or /ext/mission-control
    if (
      pathname === PLUGIN_PREFIX ||
      pathname === `${PLUGIN_PREFIX}/` ||
      pathname === `${PLUGIN_PREFIX}/dashboard` ||
      pathname === `${PLUGIN_PREFIX}/dashboard/`
    ) {
      serveDashboard(res);
      return true;
    }

    if (pathname === `${PLUGIN_PREFIX}/space` || pathname === `${PLUGIN_PREFIX}/space/`) {
      serveSpace(res);
      return true;
    }

    // API routes
    if (!pathname.startsWith(`${API_PREFIX}/`)) {
      return false;
    }

    await handleApiRequest(req, res, url, db, api);
    return true;
  });
}

async function handleApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  db: MissionControlDB,
  api: OpenClawPluginApi,
): Promise<void> {
  try {
    const pathname = url.pathname;
    const method = req.method ?? "GET";
    const readOnly = isTruthyEnv("MISSION_CONTROL_READ_ONLY");

    const routePath = pathname.replace(API_PREFIX, "");
    const segments = routePath.split("/").filter(Boolean);

    if (segments[0] === "meta" && segments.length === 1 && method === "GET") {
      sendJson(res, 200, {
        readOnly,
        tokenRequired: Boolean(getReadAccessToken()),
      });
      return;
    }

    if (readOnly && !["GET", "HEAD", "OPTIONS"].includes(method)) {
      sendJson(res, 403, { error: "Mission Control is running in read-only mode" });
      return;
    }

    if (segments[0] === "tasks") {
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

        // Backward compat: accept old linear_issue_id/url field names
        if (body.linear_issue_id && !body.external_id) {
          body.external_id = body.linear_issue_id;
          delete body.linear_issue_id;
        }
        if (body.linear_issue_url && !body.external_url) {
          body.external_url = body.linear_issue_url;
          delete body.linear_issue_url;
        }

        const syncToLinear = body.sync_to_linear === true;
        const linearTeamId = typeof body.linear_team_id === "string" ? body.linear_team_id : "";
        delete body.sync_to_linear;
        delete body.linear_team_id;

        let task = db.createTask(body as unknown as CreateTaskInput);
        if (syncToLinear && linearTeamId) {
          try {                const linearCfg = getLinearConfig();
                const taskType = typeof body.task_type === "string" ? body.task_type : "implementation";
                const linearLabel = taskType === "investigation" && linearCfg.triageLabel
                  ? linearCfg.triageLabel
                  : linearCfg.label;
                const issue = await createLinearIssue(
                  linearTeamId,
                  body.title as string,
                  typeof body.description === "string" ? body.description : undefined,
                  typeof body.priority === "string" ? body.priority : "normal",
                  linearLabel,
                );
                task = db.updateTask(task.id, {
                  external_id: issue.id,
                  external_url: issue.url,
                }) ?? task;
                db.createActivity({
                  task_id: task.id,
                  activity_type: "synced",
                  message: `Synced to Linear as ${issue.identifier}`,
                });
              } catch (err) {
                db.createActivity({
                  task_id: task.id,
                  activity_type: "sync_failed",
                  message: `Linear sync failed: ${err instanceof Error ? err.message : "Unknown error"}`,
                });
              }
            }

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

              const needsTriageCheck = typeof body.triage_state === "string";
              const needsPriorityCheck = typeof body.priority === "string" && ["urgent", "high"].includes(body.priority);
              const oldTask = (needsTriageCheck || needsPriorityCheck) ? db.getTask(taskId) : null;
              const oldTriageState = needsTriageCheck && oldTask ? parseTriageState(oldTask.triage_state) : null;

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

              if (needsTriageCheck && task.external_id) {
                const newTriageState = parseTriageState(body.triage_state);
                if (newTriageState) {
                  syncTriageAnswersToLinear(task.external_id, oldTriageState, newTriageState);
                }
              }

              sendJson(res, 200, task);
              return;
            }

            if (segments.length === 2 && method === "DELETE") {
              const deleted = db.deleteTask(taskId);
              if (!deleted) {
                sendJson(res, 404, { error: "Task not found" });
                return;
              }
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

              if (task.external_id) {
                const cfg = getLinearConfig();
                const note = reason
                  ? `${cfg.mentionTag} **${cfg.botName}**: Task marked done in Mission Control.\n\nReason: ${reason}`
                  : `${cfg.mentionTag} **${cfg.botName}**: Task marked done in Mission Control.`;
                linearGraphQL(
                  `mutation($id: String!, $body: String!) { commentCreate(input: { issueId: $id, body: $body }) { success } }`,
                  { id: task.external_id, body: note },
                ).catch(err => console.error(`[MC] Failed to post done note to Linear: ${err}`));
              }

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

              if (task.task_type !== "investigation") {
                sendJson(res, 400, { error: "Only investigation tasks can be promoted" });
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

              db.clearBlockingActivities(taskId);
              db.createActivity({
                task_id: taskId,
                activity_type: "status_changed",
                message: `Investigation promoted to implementation — moved ${task.status} -> planning. Reason: ${reason}`,
              });

              if (task.external_id) {
                const cfg = getLinearConfig();
                const line = `${cfg.mentionTag} **${cfg.botName}**: Investigation promoted to implementation in Mission Control.\n\nReason: ${reason}`;
                linearGraphQL(
                  `mutation($id: String!, $body: String!) { commentCreate(input: { issueId: $id, body: $body }) { success } }`,
                  { id: task.external_id, body: line },
                ).catch(err => console.error(`[MC] Failed to post promotion note to Linear: ${err}`));
              }

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

                if (input.activity_type === "investigation_findings") {
                  const task = db.getTask(taskId);
                  const externalId = task?.external_id;
                  if (externalId) {
                    const cfg = getLinearConfig();
                    const prefix = `${cfg.mentionTag} **${cfg.botName}**`;
                    const header = `${prefix}: 🔍 Investigation findings:\n\n`;
                    const maxChunk = 10000;
                    const fullText = input.message;

                    if (fullText.length <= maxChunk) {
                      linearGraphQL(
                        `mutation($id: String!, $body: String!) { commentCreate(input: { issueId: $id, body: $body }) { success } }`,
                        { id: externalId, body: header + fullText },
                      ).catch(err => console.error(`[MC] Failed to post findings to Linear: ${err}`));
                    } else {
                      const chunks: string[] = [];
                      let remaining = fullText;
                      while (remaining.length > 0) {
                        if (remaining.length <= maxChunk) {
                          chunks.push(remaining);
                          break;
                        }
                        let splitAt = remaining.lastIndexOf("\n", maxChunk);
                        if (splitAt < maxChunk * 0.5) splitAt = maxChunk;
                        chunks.push(remaining.slice(0, splitAt));
                        remaining = remaining.slice(splitAt).trimStart();
                      }

                      const postChunks = async () => {
                        for (let i = 0; i < chunks.length; i++) {
                          const label = chunks.length > 1 ? ` (${i + 1}/${chunks.length})` : "";
                          const body = (i === 0 ? header : `${prefix}: 🔍 Findings continued${label}:\n\n`) + chunks[i];
                          await linearGraphQL(
                            `mutation($id: String!, $body: String!) { commentCreate(input: { issueId: $id, body: $body }) { success } }`,
                            { id: externalId, body },
                          );
                        }
                      };
                      postChunks().catch(err => console.error(`[MC] Failed to post findings to Linear: ${err}`));
                    }
                  }
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
              const deleted = db.deleteAgent(agentId);
              if (!deleted) {
                sendJson(res, 404, { error: "Agent not found" });
                return;
              }
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
              const deleted = db.deleteWorkspace(workspaceId);
              if (!deleted) {
                sendJson(res, 404, { error: "Workspace not found" });
                return;
              }
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
                item.openclaw_session_id === body.session_id && item.status === "active"
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
            const byTask = await getSwarmAgentStatusMap(api.logger);
            sendJson(res, 200, byTask);
          } catch (error) {
            const message = error instanceof Error ? error.message : "Failed to read agent status";
            api.logger.error(`mission-control agent-status error: ${message}`);
            sendJson(res, 500, { error: message });
          }
          return;
        }

        if (segments[0] === "board" && segments.length === 1 && method === "GET") {
          try {
            const { limit, offset } = parsePagination(url);
            const since = url.searchParams.get("since") ?? undefined;
            const liveMode = url.searchParams.get("live") === "true";

            const allTasks = db.listTasks({});
            const sortedTasks = [...allTasks].sort((a, b) =>
              String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? ""))
            );
            const swarmStatus = await getSwarmAgentStatusMap(api.logger);

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

            const statusCounts = allTasks.reduce<Record<string, number>>((acc, task) => {
              const key = task.status;
              acc[key] = (acc[key] ?? 0) + 1;
              return acc;
            }, {});

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

            const tasks = pagedTasks.map((task) => ({
              ...task,
              swarm: swarmStatus[task.id] ?? null,
              recent_activity: db.listActivities(task.id, 3, 0),
            }));

            const recentEvents = db.listEvents(Math.min(limit, 200), since, 0);
            const nextCursor =
              tasks.length > 0
                ? String(tasks[tasks.length - 1]?.updated_at ?? "") || new Date().toISOString()
                : new Date().toISOString();

            sendJson(res, 200, {
              summary: {
                totalTasks: allTasks.length,
                statusCounts,
                runningSwarmAgents: heartbeatStats.runningAgents,
                staleHeartbeat: heartbeatStats.staleHeartbeat,
                missingHeartbeat: heartbeatStats.missingHeartbeat,
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
            api.logger.error(`mission-control board error: ${message}`);
            sendJson(res, 500, { error: message });
          }
          return;
        }

        if (segments[0] === "system-stats" && segments.length === 1 && method === "GET") {
          const totalMem = totalmem();
          const freeMem = freemem();
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
          const configPath = join(homedir(), ".openclaw", "swarm", "swarm-config.json");

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
        if (segments[0] === "linear" && segments.length >= 2) {
          if (segments[1] === "config" && method === "GET") {
            const cfg = getLinearConfig();
            const hasApiKey = !!process.env.LINEAR_API_KEY;
            sendJson(res, 200, { ...cfg, hasApiKey });
            return;
          }

          if (segments[1] === "teams" && method === "GET") {
            if (!process.env.LINEAR_API_KEY) {
              sendJson(res, 200, { teams: [], error: "LINEAR_API_KEY not set" });
              return;
            }
            try {
              const teams = await fetchLinearTeams();
              sendJson(res, 200, { teams });
            } catch (err) {
              sendJson(res, 500, { teams: [], error: err instanceof Error ? err.message : "Failed to fetch teams" });
            }
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
          const knowledgeScript = join(homedir(), ".openclaw", "swarm", "knowledge-manage.py");

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

            const result = await runPython(args);
            sendJson(res, 201, result);
            return;
          }

          if (segments.length === 1 && method === "GET") {
            const project = url.searchParams.get("project") ?? "";
            const repo = url.searchParams.get("repo") ?? "";
            const scope = url.searchParams.get("scope") ?? "";
            const limit = url.searchParams.get("limit") ?? "50";

            const args = [knowledgeScript, "list", "--limit", limit];
            if (scope) args.push("--scope", scope);
            else if (project) {
              args.push("--project", project);
              if (repo) args.push("--repo", repo);
            }

            const result = await runPython(args);
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
            const safety = isUrlSafe(targetUrl);
            if (!safety.safe) {
              sendJson(res, 400, { error: safety.reason ?? "Unsafe URL" });
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
              const resp = await fetch(targetUrl, {
                headers: { "User-Agent": "Mozilla/5.0 (compatible; MissionControl/1.0)" },
                signal: AbortSignal.timeout(15000),
                redirect: "follow",
              });

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
            const result = await runPython(args);
            sendJson(res, 200, result);
            return;
          }
        }

        sendJson(res, 404, { error: "Not found" });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Internal server error";
        if (message === "Malformed JSON body") {
          sendJson(res, 400, { error: message });
          return;
        }
        api.logger.error(`mission-control routes error: ${message}`);
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

function runPython(args: string[]): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    execFile("python3", args, { timeout: 30000 }, (err, stdout, stderr) => {
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
