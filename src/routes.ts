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
        resolve({});
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

export function registerRoutes(api: OpenClawPluginApi, db: MissionControlDB): void {
  api.logger.info(`mission-control: registering HTTP handler at ${API_PREFIX}`);

  // Use registerHttpHandler (not registerHttpRoute) because this gateway
  // version only supports exact-path matching for registerHttpRoute.
  // registerHttpHandler passes the raw request and expects a boolean return.
  api.registerHttpHandler(async (req: IncomingMessage, res: ServerResponse): Promise<boolean | void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;

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

    const routePath = pathname.replace(API_PREFIX, "");
        const segments = routePath.split("/").filter(Boolean);

        if (segments[0] === "tasks") {
          if (segments.length === 1 && method === "GET") {
            const tasks = db.listTasks({
              status: url.searchParams.get("status") ?? undefined,
              workspace_id: url.searchParams.get("workspace_id") ?? undefined,
              assigned_agent_id:
                url.searchParams.get("assigned_agent_id") ?? undefined,
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
              try {
                const linearCfg = getLinearConfig();
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
              const task = db.updateTask(taskId, body as unknown as UpdateTaskInput);
              if (!task) {
                sendJson(res, 404, { error: "Task not found" });
                return;
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
                sendJson(res, 201, db.createActivity(input));
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
            const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 50;
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
            const registryPath = join(homedir(), ".openclaw", "swarm", "active-tasks.json");
            const raw = readFileSync(registryPath, "utf-8");
            const entries = JSON.parse(raw) as Array<Record<string, unknown>>;

            // Check which tmux sessions are alive
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
              // tmux not running or no sessions — aliveSessions stays empty
            }

            const byTask: Record<string, Record<string, unknown>> = {};
            for (const entry of entries) {
              const mcId = entry.mcTaskId as string;
              if (mcId) {
                const tmuxName = entry.tmuxSession as string;
                const tmuxAlive = tmuxName ? aliveSessions.has(tmuxName) : false;
                const registryStatus = entry.status as string;

                // Compute live status: if tmux is alive, agent is running
                // If registry says running/ready but tmux is dead, it's completed
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
                };
              }
            }
            sendJson(res, 200, byTask);
          } catch {
            sendJson(res, 200, {});
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

            const current = readConfig() as Record<string, Record<string, unknown>>;

            for (const key of ["claude", "codex"] as const) {
              if (isRecord(body[key])) {
                current[key] = { ...current[key], ...(body[key] as Record<string, unknown>) };
              }
            }

            writeFileSync(configPath, JSON.stringify(current, null, 2) + "\n", "utf-8");
            sendJson(res, 200, current);
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
            if (!isRecord(body) || typeof body.url !== "string") {
              sendJson(res, 400, { error: "url is required" });
              return;
            }

            const targetUrl = body.url.startsWith("http") ? body.url : `https://${body.url}`;
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
  text = text.replace(/<style[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<nav[\s\S]*?<\/nav>/gi, "");
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
  const escaped = prompt.replace(/'/g, "'\\''");
  const cmd = `/opt/homebrew/bin/claude -p '${escaped}' --allowedTools 'mcp__notion__*,WebFetch' --no-session-persistence --model sonnet`;

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn("/bin/bash", ["-lc", cmd], {
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
