#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as outputStream } from "node:process";

type Json = Record<string, unknown> | unknown[];

const MC_URL = process.env.MISSION_CONTROL_URL ?? "http://127.0.0.1:18900";
const API_PREFIX = "/api";
const MC_HOME = process.env.MC_HOME ?? join(homedir(), ".mission-control");

type ParsedArgs = {
  positionals: string[];
  flags: Map<string, string | boolean>;
};

type RenderKind =
  | "default"
  | "tasks"
  | "task"
  | "activities"
  | "deliverables"
  | "workspaces"
  | "workspace"
  | "agents"
  | "agent"
  | "agent-status"
  | "board"
  | "services-health"
  | "system-stats"
  | "knowledge"
  | "repos"
  | "config"
  | "swarm-sessions"
  | "checkpoints"
  | "connections"
  | "objectives"
  | "objective"
  | "pages"
  | "result";

type SwarmRegistryEntry = Record<string, unknown> & {
  id?: string;
  tmuxSession?: string;
  agent?: string;
  description?: string;
  repo?: string;
  worktree?: string;
  branch?: string;
  status?: string;
  mcTaskId?: string;
  reviewCycles?: number;
  retryCount?: number;
};

const SWARM_DIR = join(MC_HOME, "swarm");
const SWARM_REGISTRY = join(SWARM_DIR, "active-tasks.json");
const SWARM_STATUS_SCRIPT = join(SWARM_DIR, "status.sh");
const SWARM_MONITOR_SESSION = "mission-control-swarm";

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const keyValue = token.slice(2);
    const eqIndex = keyValue.indexOf("=");
    if (eqIndex >= 0) {
      flags.set(keyValue.slice(0, eqIndex), keyValue.slice(eqIndex + 1));
      continue;
    }

    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      flags.set(keyValue, next);
      i += 1;
    } else {
      flags.set(keyValue, true);
    }
  }

  return { positionals, flags };
}

function flag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

function hasFlag(args: ParsedArgs, name: string): boolean {
  return args.flags.get(name) !== undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord);
}

function readSwarmRegistry(): SwarmRegistryEntry[] {
  if (!existsSync(SWARM_REGISTRY)) return [];
  try {
    const parsed = JSON.parse(readFileSync(SWARM_REGISTRY, "utf-8"));
    return Array.isArray(parsed) ? parsed.filter(isRecord) as SwarmRegistryEntry[] : [];
  } catch {
    return [];
  }
}

function execFileText(command: string, args: string[], timeout = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, encoding: "utf-8" }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || error.message).trim()));
        return;
      }
      resolve(String(stdout ?? ""));
    });
  });
}

async function listTmuxSessions(): Promise<Set<string>> {
  try {
    const output = await execFileText("tmux", ["list-sessions", "-F", "#{session_name}"]);
    return new Set(
      output
        .split("\n")
        .map(line => line.trim())
        .filter(Boolean),
    );
  } catch {
    return new Set();
  }
}

async function captureTmuxPane(session: string, lines = 5): Promise<string> {
  try {
    const output = await execFileText("tmux", ["capture-pane", "-pt", session, "-S", `-${lines}`], 10000);
    return output.trim();
  } catch {
    return "";
  }
}

function findSwarmEntry(identifier: string, entries: SwarmRegistryEntry[]): SwarmRegistryEntry | undefined {
  return entries.find(entry => entry.id === identifier || entry.mcTaskId === identifier || entry.tmuxSession === identifier);
}

async function ensureTmuxSessionExists(session: string): Promise<boolean> {
  try {
    await execFileText("tmux", ["has-session", "-t", session], 5000);
    return true;
  } catch {
    return false;
  }
}

function runInteractive(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", code => {
      if (code && code !== 0) {
        reject(new Error(`${command} exited with code ${code}`));
        return;
      }
      resolve();
    });
  });
}

async function mcFetch(method: string, path: string, body?: unknown): Promise<Json> {
  const url = new URL(path, MC_URL);
  const response = await fetch(url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let parsed: unknown = text;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!response.ok) {
    const message =
      typeof parsed === "object" && parsed !== null && "error" in parsed && typeof (parsed as Record<string, unknown>).error === "string"
        ? String((parsed as Record<string, unknown>).error)
        : `Request failed with ${response.status}`;
    throw new Error(message);
  }

  return (parsed ?? {}) as Json;
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      search.set(key, String(value));
    }
  }
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

function truncate(value: unknown, length = 80): string {
  const text = String(value ?? "");
  if (text.length <= length) return text;
  return `${text.slice(0, Math.max(0, length - 1))}…`;
}

function printKV(record: Record<string, unknown>, preferredOrder?: string[]): void {
  const seen = new Set<string>();
  const keys = preferredOrder
    ? [...preferredOrder.filter(key => key in record), ...Object.keys(record).filter(key => !preferredOrder.includes(key))]
    : Object.keys(record);

  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    const value = record[key];
    if (value === undefined) continue;
    if (typeof value === "object" && value !== null) {
      console.log(`${key}:`);
      console.log(JSON.stringify(value, null, 2));
    } else {
      console.log(`${key}: ${String(value)}`);
    }
  }
}

function renderDefault(data: unknown): boolean {
  if (Array.isArray(data)) {
    console.table(data);
    return true;
  }

  if (isRecord(data)) {
    const tableKey = ["tasks", "workspaces", "repos", "teams", "agents", "entries"].find(key => Array.isArray(data[key]));
    if (tableKey) {
      console.table(data[tableKey] as unknown[]);
      const rest = Object.fromEntries(Object.entries(data).filter(([key]) => key !== tableKey));
      if (Object.keys(rest).length > 0) console.log(JSON.stringify(rest, null, 2));
      return true;
    }
  }

  return false;
}

function renderTasks(data: unknown): void {
  const rows = asArray(data).map(task => ({
    id: task.id,
    status: task.status,
    priority: task.priority,
    type: task.task_type,
    title: truncate(task.title, 56),
    agent: task.assigned_agent_id ?? "",
    workspace: task.workspace_id ?? "",
    updated: task.updated_at ?? "",
  }));
  console.table(rows);
  console.log(`Total tasks: ${rows.length}`);
}

function renderTask(data: unknown): void {
  if (!isRecord(data)) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  printKV(data, [
    "id",
    "title",
    "status",
    "priority",
    "task_type",
    "workspace_id",
    "assigned_agent_id",
    "parent_task_id",
    "external_id",
    "external_url",
    "source",
    "due_date",
    "created_at",
    "updated_at",
    "description",
  ]);
}

function renderActivities(data: unknown): void {
  const rows = asArray(data).map(activity => ({
    id: activity.id,
    type: activity.activity_type,
    agent: activity.agent_id ?? "",
    created: activity.created_at ?? "",
    message: truncate(activity.message, 100),
  }));
  console.table(rows);
}

function renderDeliverables(data: unknown): void {
  const rows = asArray(data).map(deliverable => ({
    id: deliverable.id,
    type: deliverable.deliverable_type,
    title: truncate(deliverable.title, 48),
    path: truncate(deliverable.path ?? "", 60),
    created: deliverable.created_at ?? "",
  }));
  console.table(rows);
}

function renderWorkspaces(data: unknown): void {
  const rows = asArray(data).map(workspace => ({
    id: workspace.id,
    icon: workspace.icon ?? "",
    name: workspace.name,
    slug: workspace.slug,
    description: truncate(workspace.description ?? "", 60),
  }));
  console.table(rows);
}

function renderWorkspace(data: unknown): void {
  if (!isRecord(data)) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  printKV(data, ["id", "icon", "name", "slug", "description", "created_at", "updated_at"]);
}

function renderAgents(data: unknown): void {
  const rows = asArray(data).map(agent => ({
    id: agent.id,
    name: agent.name,
    role: agent.role,
    status: agent.status,
    model: agent.model ?? "",
    workspace: agent.workspace_id ?? "",
    source: agent.source ?? "",
  }));
  console.table(rows);
}

function renderAgent(data: unknown): void {
  if (!isRecord(data)) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  printKV(data, [
    "id",
    "name",
    "role",
    "status",
    "workspace_id",
    "model",
    "source",
    "description",
    "avatar_emoji",
    "created_at",
    "updated_at",
  ]);
}

function renderAgentStatus(data: unknown): void {
  if (!isRecord(data)) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  const rows = Object.entries(data).map(([taskId, status]) => {
    const item = isRecord(status) ? status : {};
    return {
      taskId,
      agent: item.agent ?? "",
      status: item.status ?? "",
      live: item.liveStatus ?? "",
      tmuxAlive: item.tmuxAlive ?? false,
      branch: item.branch ?? "",
      pr: item.pr ?? "",
    };
  });
  console.table(rows);
}

function renderBoard(data: unknown): void {
  if (!isRecord(data)) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  const summary = isRecord(data.summary) ? data.summary : null;
  if (summary) {
    console.log("Board summary:");
    printKV(summary, [
      "totalTasks",
      "runningSwarmAgents",
      "staleHeartbeat",
      "missingHeartbeat",
      "liveMode",
      "boardGeneratedAt",
    ]);
    if (isRecord(summary.statusCounts)) {
      console.log("statusCounts:");
      console.table([summary.statusCounts]);
    }
    console.log("");
  }

  const tasks = asArray(data.tasks).map(task => ({
    id: task.id,
    status: task.status,
    priority: task.priority,
    type: task.task_type,
    title: truncate(task.title, 48),
    swarm: isRecord(task.swarm) ? task.swarm.liveStatus ?? task.swarm.status ?? "" : "",
    updated: task.updated_at ?? "",
  }));
  console.table(tasks);
}

function renderServicesHealth(data: unknown): void {
  if (Array.isArray(data)) {
    console.table(data);
    return;
  }
  if (isRecord(data)) {
    const key = ["services", "results", "checks"].find(candidate => Array.isArray(data[candidate]));
    if (key) {
      console.table(data[key] as unknown[]);
      return;
    }
  }
  console.log(JSON.stringify(data, null, 2));
}

function renderSystemStats(data: unknown): void {
  if (!isRecord(data)) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  if (isRecord(data.cpu)) {
    console.log("CPU:");
    printKV(data.cpu);
  }
  if (isRecord(data.memory)) {
    console.log("\nMemory:");
    printKV(data.memory);
  }
  if (isRecord(data.concurrency)) {
    console.log("\nConcurrency:");
    printKV(data.concurrency);
  }
}

function renderKnowledge(data: unknown): void {
  if (isRecord(data)) {
    const listKey = ["entries", "results", "knowledge"].find(key => Array.isArray(data[key]));
    if (listKey) {
      const rows = asArray(data[listKey]).map(entry => ({
        id: entry.id,
        schema: entry.schema ?? "",
        score: typeof entry.score === "number" ? Number(entry.score).toFixed(3) : "",
        scope: entry.scope ?? entry.domain ?? "",
        category: entry.category ?? "",
        stage: entry.stage ?? "",
        shared: entry.shared ?? "",
        importance: entry.importance ?? "",
        text: truncate(entry.text ?? entry.summary ?? "", 100),
      }));
      console.table(rows);
      const meta = Object.fromEntries(Object.entries(data).filter(([key]) => key !== listKey));
      if (Object.keys(meta).length > 0) console.log(JSON.stringify(meta, null, 2));
      return;
    }
  }
  if (!renderDefault(data)) {
    console.log(JSON.stringify(data, null, 2));
  }
}

function renderRepos(data: unknown): void {
  if (!isRecord(data) || !Array.isArray(data.repos)) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  console.table(asArray(data.repos));
}

function renderConfig(data: unknown): void {
  if (!isRecord(data)) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  for (const [section, value] of Object.entries(data)) {
    console.log(`${section}:`);
    console.log(JSON.stringify(value, null, 2));
  }
}

function renderSwarmSessions(data: unknown): void {
  const rows = asArray(data).map(entry => ({
    taskId: entry.id ?? "",
    mcTaskId: entry.mcTaskId ?? "",
    session: entry.tmuxSession ?? "",
    agent: entry.agent ?? "",
    status: entry.status ?? "",
    branch: entry.branch ?? "",
    repo: truncate(entry.repo ?? "", 28),
    description: truncate(entry.description ?? "", 52),
    live: entry.tmuxAlive ?? false,
    preview: truncate(entry.preview ?? "", 80),
  }));
  console.table(rows);
  console.log(`Active registry entries: ${rows.length}`);
}

function renderObjectives(data: unknown): void {
  const rows = asArray(data).map(o => ({
    id: o.id,
    status: o.status,
    round: `${o.round ?? 0}/${o.max_rounds ?? "?"}`,
    subtasks: o.subtasks_spawned ?? 0,
    goal: truncate(o.goal ?? "", 64),
    created: o.created_at ?? "",
  }));
  console.table(rows);
  console.log(`Total objectives: ${rows.length}`);
}

function renderObjective(data: unknown): void {
  if (!isRecord(data)) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  printKV(data, ["id", "goal", "status", "round", "max_rounds", "subtasks_spawned", "max_subtasks", "anchor_task_id", "blocked_reason", "created_at", "updated_at"]);
  const parseJson = (v: unknown) => {
    if (typeof v !== "string" || !v.trim()) return null;
    try { return JSON.parse(v); } catch { return v; }
  };
  const scope = parseJson(data.approved_scope) ?? parseJson(data.proposed_scope);
  if (scope) {
    console.log("\nscope:");
    console.log(JSON.stringify(scope, null, 2));
  }
  const coverage = parseJson(data.coverage);
  if (coverage) {
    console.log("\ncoverage:");
    console.log(JSON.stringify(coverage, null, 2));
  }
  if (Array.isArray(data.children) && data.children.length) {
    console.log("\nsub-tasks:");
    console.table(asArray(data.children).map(c => ({ id: c.id, status: c.status, type: c.task_type, title: truncate(c.title, 48) })));
  }
  if (isRecord(data.document)) {
    console.log(`\ndocument: ${data.document.title} (${data.page_count ?? 0} pages)`);
  }
}

function renderPages(data: unknown): void {
  const rows = asArray(data).map(p => ({
    slug: p.slug,
    title: truncate(p.title ?? "", 48),
    parent: p.parent_page_id ?? "",
    bytes: typeof p.body_md === "string" ? p.body_md.length : 0,
    updated: p.updated_at ?? "",
  }));
  console.table(rows);
}

function renderConnections(data: unknown): void {
  if (!isRecord(data)) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }
  console.log("Runtimes:");
  console.table(
    asArray(data.runtimes).map(r => ({
      runtime: r.name,
      installed: r.installed ? "yes" : "no",
      auth: r.authenticated ? "✓" : "✗",
      detail: truncate(r.detail ?? "", 52),
      fix: truncate(r.fix ?? "", 40),
    })),
  );
  console.log("\nSources:");
  console.table(
    asArray(data.sources).map(s => ({
      source: s.name,
      kind: s.kind ?? "",
      status: s.status ?? "",
      detail: truncate(s.detail ?? "", 36),
      fix: truncate(s.fix ?? "", 40),
    })),
  );
  if (isRecord(data.summary)) {
    const sm = data.summary;
    console.log(
      `\nRuntimes ready: ${sm.runtimesReady}/${sm.runtimesTotal}   Sources connected: ${sm.sourcesConnected}/${sm.sourcesTotal}`,
    );
  }
}

function renderCheckpoints(data: unknown): void {
  const rows = asArray(data).map(cp => ({
    id: cp.id,
    task: typeof cp.task_id === "string" ? cp.task_id.slice(0, 8) : "",
    kind: cp.kind ?? "",
    status: cp.status ?? "",
    prompt: truncate(cp.prompt ?? "", 70),
    created: cp.created_at ?? "",
  }));
  console.table(rows);
  console.log(`Pending checkpoints: ${rows.length}`);
}

function renderResult(data: unknown): void {
  if (isRecord(data) && typeof data.success === "boolean") {
    console.log(data.success ? "Success" : "Failed");
  }
  console.log(JSON.stringify(data, null, 2));
}

function outputValue(data: unknown, jsonMode: boolean, kind: RenderKind = "default"): void {
  if (jsonMode) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  switch (kind) {
    case "tasks":
      renderTasks(data);
      return;
    case "task":
      renderTask(data);
      return;
    case "activities":
      renderActivities(data);
      return;
    case "deliverables":
      renderDeliverables(data);
      return;
    case "workspaces":
      renderWorkspaces(data);
      return;
    case "workspace":
      renderWorkspace(data);
      return;
    case "agents":
      renderAgents(data);
      return;
    case "agent":
      renderAgent(data);
      return;
    case "agent-status":
      renderAgentStatus(data);
      return;
    case "board":
      renderBoard(data);
      return;
    case "services-health":
      renderServicesHealth(data);
      return;
    case "system-stats":
      renderSystemStats(data);
      return;
    case "knowledge":
      renderKnowledge(data);
      return;
    case "repos":
      renderRepos(data);
      return;
    case "config":
      renderConfig(data);
      return;
    case "swarm-sessions":
      renderSwarmSessions(data);
      return;
    case "checkpoints":
      renderCheckpoints(data);
      return;
    case "connections":
      renderConnections(data);
      return;
    case "objectives":
      renderObjectives(data);
      return;
    case "objective":
      renderObjective(data);
      return;
    case "pages":
      renderPages(data);
      return;
    case "result":
      renderResult(data);
      return;
    default:
      if (!renderDefault(data)) {
        console.log(JSON.stringify(data, null, 2));
      }
  }
}

async function ask(question: string, defaultValue?: string): Promise<string> {
  if (!input.isTTY || !outputStream.isTTY) {
    throw new Error(`Missing required input and no interactive terminal is available for: ${question}`);
  }

  const rl = createInterface({ input, output: outputStream });
  try {
    const suffix = defaultValue !== undefined && defaultValue !== "" ? ` [${defaultValue}]` : "";
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    return answer || defaultValue || "";
  } finally {
    rl.close();
  }
}

async function askChoice(question: string, options: string[], defaultValue?: string): Promise<string> {
  if (options.length === 0) return ask(question, defaultValue);
  const label = `${question} (${options.join("/")})`;
  while (true) {
    const answer = await ask(label, defaultValue);
    if (options.includes(answer)) return answer;
    console.error(`Please choose one of: ${options.join(", ")}`);
  }
}

async function ensureTaskCreateBody(args: ParsedArgs): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {
    title: flag(args, "title"),
    description: flag(args, "description"),
    priority: flag(args, "priority"),
    status: flag(args, "status") ?? "inbox",
    workspace_id: flag(args, "workspace"),
    assigned_agent_id: flag(args, "agent"),
    source: flag(args, "source") ?? "cli",
    task_type: flag(args, "task-type"),
    parent_task_id: flag(args, "parent"),
    due_date: flag(args, "due-date"),
  };

  const interactive = hasFlag(args, "interactive") || !body.title;
  if (interactive) {
    body.title = body.title || await ask("Task title");
    if (!body.description) body.description = await ask("Description", "");
    if (!body.priority) body.priority = await askChoice("Priority", ["low", "normal", "high", "urgent"], "normal");
    if (!flag(args, "status")) body.status = await askChoice("Status", ["inbox", "planning", "in_progress", "review", "on_hold"], String(body.status));
    if (!body.task_type) body.task_type = await askChoice("Task type", ["implementation", "investigation", "research"], "implementation");
    if (!body.workspace_id) body.workspace_id = await ask("Workspace ID", "default");
    if (!body.assigned_agent_id) body.assigned_agent_id = await ask("Assigned agent ID", "");
  }

  if (!body.title) throw new Error("Task title is required");
  return body;
}

async function ensureGsdTicketBody(args: ParsedArgs): Promise<Record<string, unknown>> {
  const body = await ensureTaskCreateBody({
    positionals: args.positionals,
    flags: new Map(args.flags),
  });
  body.status = flag(args, "status") ?? "inbox";
  body.task_type = flag(args, "task-type") ?? body.task_type ?? "implementation";

  if (hasFlag(args, "interactive")) {
    const verifyCommand = await ask("Verification command", "npm test");
    const acceptance = await ask("Acceptance criteria", "");
    const repo = await ask("Target repo", flag(args, "repo") ?? "");
    const project = await ask("Project", flag(args, "project") ?? "");
    const gsdNotes = [
      body.description ? String(body.description) : "",
      acceptance ? `\nAcceptance criteria:\n${acceptance}` : "",
      verifyCommand ? `\nVerification command:\n${verifyCommand}` : "",
      project || repo ? `\nTarget repo:\n${project}${project && repo ? "/" : ""}${repo}` : "",
    ].filter(Boolean).join("\n");
    body.description = gsdNotes;
  }

  return body;
}

async function ensureTaskUpdateBody(args: ParsedArgs, id: string): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {
    title: flag(args, "title"),
    description: flag(args, "description"),
    priority: flag(args, "priority"),
    status: flag(args, "status"),
    assigned_agent_id: flag(args, "agent"),
    workspace_id: flag(args, "workspace"),
    task_type: flag(args, "task-type"),
    due_date: flag(args, "due-date"),
  };

  const noFields = Object.values(body).every(value => value === undefined);
  if (hasFlag(args, "interactive") || noFields) {
    const current = await mcFetch("GET", `${API_PREFIX}/tasks/${id}`);
    const record = isRecord(current) ? current : {};
    body.title = body.title ?? await ask("Title", String(record.title ?? ""));
    body.description = body.description ?? await ask("Description", String(record.description ?? ""));
    body.priority = body.priority ?? await askChoice("Priority", ["low", "normal", "high", "urgent"], String(record.priority ?? "normal"));
    body.status = body.status ?? await askChoice("Status", ["pending_dispatch", "planning", "inbox", "assigned", "in_progress", "testing", "review", "on_hold", "done"], String(record.status ?? "inbox"));
    body.task_type = body.task_type ?? await askChoice("Task type", ["implementation", "investigation", "research"], String(record.task_type ?? "implementation"));
    body.workspace_id = body.workspace_id ?? await ask("Workspace ID", String(record.workspace_id ?? "default"));
    body.assigned_agent_id = body.assigned_agent_id ?? await ask("Assigned agent ID", String(record.assigned_agent_id ?? ""));
    body.due_date = body.due_date ?? await ask("Due date", String(record.due_date ?? ""));
  }

  return body;
}

async function ensureWorkspaceCreateBody(args: ParsedArgs): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {
    name: flag(args, "name"),
    description: flag(args, "description"),
    slug: flag(args, "slug"),
    icon: flag(args, "icon"),
  };

  if (hasFlag(args, "interactive") || !body.name) {
    body.name = body.name || await ask("Workspace name");
    if (!body.description) body.description = await ask("Description", "");
    if (!body.slug) body.slug = await ask("Slug", "");
    if (!body.icon) body.icon = await ask("Icon", "📁");
  }

  if (!body.name) throw new Error("Workspace name is required");
  return body;
}

async function ensureWorkspaceUpdateBody(args: ParsedArgs, id: string): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {
    name: flag(args, "name"),
    description: flag(args, "description"),
    slug: flag(args, "slug"),
    icon: flag(args, "icon"),
  };
  const noFields = Object.values(body).every(value => value === undefined);
  if (hasFlag(args, "interactive") || noFields) {
    const current = await mcFetch("GET", `${API_PREFIX}/workspaces/${id}`);
    const record = isRecord(current) ? current : {};
    body.name = body.name ?? await ask("Workspace name", String(record.name ?? ""));
    body.description = body.description ?? await ask("Description", String(record.description ?? ""));
    body.slug = body.slug ?? await ask("Slug", String(record.slug ?? ""));
    body.icon = body.icon ?? await ask("Icon", String(record.icon ?? "📁"));
  }
  return body;
}

async function ensureKnowledgeAddBody(args: ParsedArgs): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {
    text: flag(args, "text"),
    project: flag(args, "project"),
    repo: flag(args, "repo"),
    scope: flag(args, "scope"),
    importance: flag(args, "importance") ? Number(flag(args, "importance")) : undefined,
    category: flag(args, "category"),
  };

  if (hasFlag(args, "interactive") || !body.text) {
    body.text = body.text || await ask("Knowledge text");
    if (!body.project) body.project = await ask("Project", "");
    if (!body.repo) body.repo = await ask("Repo", "");
    if (!body.scope) body.scope = await ask("Scope", "");
    if (body.importance === undefined) body.importance = Number(await askChoice("Importance", ["1", "2", "3", "4", "5"], "5"));
    if (!body.category) body.category = await askChoice("Category", ["fact", "decision", "entity", "convention", "other"], "fact");
  }

  if (!body.text) throw new Error("Knowledge text is required");
  return body;
}

async function ensureKnowledgeUpdateBody(args: ParsedArgs, id: string): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {
    text: flag(args, "text"),
    domain: flag(args, "domain"),
  };
  if (hasFlag(args, "interactive") || (body.text === undefined && body.domain === undefined)) {
    body.text = body.text ?? await ask("Updated text", "");
    body.domain = body.domain ?? await ask("Updated domain", "");
  }
  if (body.text === undefined && body.domain === undefined) {
    throw new Error(`No updates provided for knowledge entry ${id}`);
  }
  return body;
}

function printHelp(): void {
  console.log(`Mission Control CLI

Usage:
  mc <command> [subcommand] [options]

Commands:
  tasks list [--status S] [--workspace ID] [--agent ID] [--limit N] [--offset N]
  tasks get <id>
  tasks create [--interactive] --title T [--description D] [--priority P] [--status S] [--workspace ID] [--agent ID] [--source SRC] [--task-type TYPE]
  tasks update <id> [--interactive] [--title T] [--description D] [--priority P] [--status S] [--agent ID] [--workspace ID] [--task-type TYPE]
  tasks gsd [--interactive] [--title T] [--description D] [--project P] [--repo R]
  tasks activities <id>
  tasks deliverables <id>
  tasks retry <id>
  tasks done <id> [--reason TEXT]

  workspaces list
  workspaces get <id>
  workspaces create [--interactive] --name NAME [--description TEXT] [--slug SLUG] [--icon ICON]
  workspaces update <id> [--interactive] [--name NAME] [--description TEXT] [--slug SLUG] [--icon ICON]
  workspaces delete <id>

  agents list [--workspace ID] [--status STATUS]
  agents get <id>
  agent-status

  knowledge list [--stage STAGE] [--project P] [--repo R] [--scope S] [--limit N]
  knowledge add [--interactive] --text TEXT [--project P] [--repo R] [--scope S] [--importance N] [--category C]
  knowledge promote <id>
  knowledge share <id>
  knowledge doctor
  knowledge recall --query TEXT [--project P] [--repo R] [--domain D] [--limit N]
  knowledge reembed [--schema S] [--dimensions N] [--limit N] [--force]
  knowledge reject <id>
  knowledge delete <id>
  knowledge update <id> [--interactive] [--text TEXT] [--domain DOMAIN]

  checkpoints [list]
  checkpoints resolve <id> --decision approve|reject|answer [--response TEXT]

  connections                  # agent runtime auth + connected sources
  setup                        # interactive: fill missing keys / log in runtimes

  objectives create "<goal>" [--max-rounds N] [--max-subtasks N]   # autopilot
  objectives list [--status STATUS]
  objectives get <id>
  objectives approve <id> [--decision approve|reject] [--scope-file f.json]
  objectives pages <id>
  objectives page <id> <slug>

  services health
  board [--limit N] [--offset N] [--since ISO] [--live true]
  system-stats
  repos
  config
  swarm sessions
  swarm attach <task-id|mc-task-id|tmux-session>
  swarm monitor

Global options:
  --json       Print raw JSON
  --help       Show help

Environment:
  MISSION_CONTROL_URL   Base URL for Mission Control (default: ${MC_URL})

Examples:
  mc tasks list --status inbox
  mc tasks create --interactive
  mc tasks gsd --interactive
  mc tasks create --title "[CAP-99] Fix auth bug" --description "Handle expired sessions" --priority high
  mc knowledge add --interactive
  mc knowledge recall --query "deploy agent worktree failure" --project myorg --repo backend-api
  mc swarm sessions
  mc swarm attach task-123
  mc swarm monitor
  mc services health --json
`);
}

async function getSwarmSessionRows(): Promise<Record<string, unknown>[]> {
  const entries = readSwarmRegistry();
  const tmuxSessions = await listTmuxSessions();
  const rows: Record<string, unknown>[] = [];

  for (const entry of entries) {
    const session = typeof entry.tmuxSession === "string" ? entry.tmuxSession : "";
    rows.push({
      ...entry,
      tmuxAlive: session ? tmuxSessions.has(session) : false,
      preview: session ? await captureTmuxPane(session, 5) : "",
    });
  }

  return rows;
}

async function handleSwarm(args: ParsedArgs, jsonMode: boolean): Promise<void> {
  const [action, identifier] = args.positionals;
  switch (action) {
    case "sessions": {
      outputValue(await getSwarmSessionRows(), jsonMode, "swarm-sessions");
      return;
    }
    case "attach": {
      if (!identifier) throw new Error("Usage: mc swarm attach <task-id|mc-task-id|tmux-session>");
      const entries = readSwarmRegistry();
      const entry = findSwarmEntry(identifier, entries);
      const session = entry?.tmuxSession ?? identifier;
      if (!(await ensureTmuxSessionExists(session))) {
        throw new Error(`tmux session not found: ${session}`);
      }
      await runInteractive("tmux", ["attach-session", "-t", session]);
      return;
    }
    case "monitor": {
      const entries = readSwarmRegistry().filter(entry => typeof entry.tmuxSession === "string" && entry.tmuxSession);
      if (entries.length === 0) {
        throw new Error("No active swarm sessions found in registry");
      }

      const existing = await ensureTmuxSessionExists(SWARM_MONITOR_SESSION);
      if (existing) {
        await execFileText("tmux", ["kill-session", "-t", SWARM_MONITOR_SESSION], 10000).catch(() => undefined);
      }

      // Loop bodies are STATIC strings; dynamic values (status script path,
      // session id, task id, description) are passed via tmux `-e KEY=VALUE`
      // and expanded as data by the session shell. Nothing untrusted is
      // interpolated into a shell command line, so a malicious task description
      // (e.g. synced from an external tracker) cannot inject commands.
      const boardLoop = `while true; do clear; echo 'Mission Control Swarm Monitor'; echo; "$MC_STATUS_SCRIPT" || true; sleep 3; done`;
      await execFileText(
        "tmux",
        ["new-session", "-d", "-s", SWARM_MONITOR_SESSION, "-n", "board", "-e", `MC_STATUS_SCRIPT=${SWARM_STATUS_SCRIPT}`, boardLoop],
        10000,
      );

      for (const entry of entries) {
        const session = String(entry.tmuxSession);
        const windowName = truncate(entry.id ?? session, 18).replace(/\s+/g, "-");
        const tmuxExists = await ensureTmuxSessionExists(session);
        const command = tmuxExists
          ? `while true; do clear; echo "Agent session: $MC_SESSION"; echo "Task: $MC_TASK_ID"; echo "Description: $MC_DESC"; echo; tmux capture-pane -pt "$MC_SESSION" -S -200 2>/dev/null || echo 'Unable to capture pane'; sleep 2; done`
          : `while true; do clear; echo "Agent session missing: $MC_SESSION"; echo "Task: $MC_TASK_ID"; sleep 5; done`;
        await execFileText(
          "tmux",
          [
            "new-window", "-t", SWARM_MONITOR_SESSION, "-n", windowName,
            "-e", `MC_SESSION=${session}`,
            "-e", `MC_TASK_ID=${String(entry.id ?? "")}`,
            "-e", `MC_DESC=${String(entry.description ?? "")}`,
            command,
          ],
          10000,
        ).catch(() => undefined);
      }

      await runInteractive("tmux", ["attach-session", "-t", SWARM_MONITOR_SESSION]);
      return;
    }
    default:
      throw new Error("Unknown swarm command. Try: sessions, attach, monitor");
  }
}

async function handleTasks(args: ParsedArgs, jsonMode: boolean): Promise<void> {
  const [action, id] = args.positionals;
  switch (action) {
    case "list": {
      const result = await mcFetch(
        "GET",
        `${API_PREFIX}/tasks${query({
          status: flag(args, "status"),
          workspace_id: flag(args, "workspace"),
          assigned_agent_id: flag(args, "agent"),
          limit: flag(args, "limit"),
          offset: flag(args, "offset"),
        })}`,
      );
      outputValue(result, jsonMode, "tasks");
      return;
    }
    case "get": {
      if (!id) throw new Error("Usage: mc tasks get <id>");
      outputValue(await mcFetch("GET", `${API_PREFIX}/tasks/${id}`), jsonMode, "task");
      return;
    }
    case "create": {
      outputValue(await mcFetch("POST", `${API_PREFIX}/tasks`, await ensureTaskCreateBody(args)), jsonMode, "task");
      return;
    }
    case "gsd": {
      const created = await mcFetch("POST", `${API_PREFIX}/tasks`, await ensureGsdTicketBody({ ...args, flags: new Map(args.flags).set("interactive", true) }));
      outputValue(created, jsonMode, "task");
      if (!jsonMode) {
        const createdId = isRecord(created) && typeof created.id === "string" ? created.id : "";
        if (createdId) {
          const dispatchNow = await askChoice("Dispatch through GSD workflow now", ["yes", "no"], "yes");
          if (dispatchNow === "yes") {
            outputValue(await mcFetch("POST", `${API_PREFIX}/tasks/${createdId}/retry`, {}), jsonMode, "result");
          }
        }
        const openMonitor = await askChoice("Open swarm monitor", ["yes", "no"], "no");
        if (openMonitor === "yes") {
          await handleSwarm({ positionals: ["monitor"], flags: new Map() }, jsonMode);
        }
      }
      return;
    }
    case "update": {
      if (!id) throw new Error("Usage: mc tasks update <id> [options]");
      outputValue(await mcFetch("PATCH", `${API_PREFIX}/tasks/${id}`, await ensureTaskUpdateBody(args, id)), jsonMode, "task");
      return;
    }
    case "activities": {
      if (!id) throw new Error("Usage: mc tasks activities <id>");
      outputValue(await mcFetch("GET", `${API_PREFIX}/tasks/${id}/activities`), jsonMode, "activities");
      return;
    }
    case "deliverables": {
      if (!id) throw new Error("Usage: mc tasks deliverables <id>");
      outputValue(await mcFetch("GET", `${API_PREFIX}/tasks/${id}/deliverables`), jsonMode, "deliverables");
      return;
    }
    case "retry": {
      if (!id) throw new Error("Usage: mc tasks retry <id>");
      outputValue(await mcFetch("POST", `${API_PREFIX}/tasks/${id}/retry`, {}), jsonMode, "result");
      return;
    }
    case "done": {
      if (!id) throw new Error("Usage: mc tasks done <id> [--reason TEXT]");
      outputValue(await mcFetch("POST", `${API_PREFIX}/tasks/${id}/done`, { reason: flag(args, "reason") }), jsonMode, "result");
      return;
    }
    default:
      throw new Error("Unknown tasks command. Try: list, get, create, update, gsd, activities, deliverables, retry, done");
  }
}

async function handleWorkspaces(args: ParsedArgs, jsonMode: boolean): Promise<void> {
  const [action, id] = args.positionals;
  switch (action) {
    case "list":
      outputValue(await mcFetch("GET", `${API_PREFIX}/workspaces`), jsonMode, "workspaces");
      return;
    case "get":
      if (!id) throw new Error("Usage: mc workspaces get <id>");
      outputValue(await mcFetch("GET", `${API_PREFIX}/workspaces/${id}`), jsonMode, "workspace");
      return;
    case "create":
      outputValue(await mcFetch("POST", `${API_PREFIX}/workspaces`, await ensureWorkspaceCreateBody(args)), jsonMode, "workspace");
      return;
    case "update":
      if (!id) throw new Error("Usage: mc workspaces update <id> [options]");
      outputValue(await mcFetch("PATCH", `${API_PREFIX}/workspaces/${id}`, await ensureWorkspaceUpdateBody(args, id)), jsonMode, "workspace");
      return;
    case "delete":
      if (!id) throw new Error("Usage: mc workspaces delete <id>");
      outputValue(await mcFetch("DELETE", `${API_PREFIX}/workspaces/${id}`), jsonMode, "result");
      return;
    default:
      throw new Error("Unknown workspaces command. Try: list, get, create, update, delete");
  }
}

async function handleAgents(args: ParsedArgs, jsonMode: boolean): Promise<void> {
  const [action, id] = args.positionals;
  switch (action) {
    case "list":
      outputValue(
        await mcFetch(
          "GET",
          `${API_PREFIX}/agents${query({ workspace_id: flag(args, "workspace"), status: flag(args, "status") })}`,
        ),
        jsonMode,
        "agents",
      );
      return;
    case "get":
      if (!id) throw new Error("Usage: mc agents get <id>");
      outputValue(await mcFetch("GET", `${API_PREFIX}/agents/${id}`), jsonMode, "agent");
      return;
    default:
      throw new Error("Unknown agents command. Try: list or get");
  }
}

async function handleKnowledge(args: ParsedArgs, jsonMode: boolean): Promise<void> {
  const [action, id] = args.positionals;
  switch (action) {
    case "list": {
      outputValue(
        await mcFetch(
          "GET",
          `${API_PREFIX}/knowledge${query({
            stage: flag(args, "stage"),
            project: flag(args, "project"),
            repo: flag(args, "repo"),
            scope: flag(args, "scope"),
            limit: flag(args, "limit"),
          })}`,
        ),
        jsonMode,
        "knowledge",
      );
      return;
    }
    case "add": {
      outputValue(await mcFetch("POST", `${API_PREFIX}/knowledge`, await ensureKnowledgeAddBody(args)), jsonMode, "result");
      return;
    }
    case "doctor":
      outputValue(await mcFetch("GET", `${API_PREFIX}/knowledge/doctor`), jsonMode, "result");
      return;
    case "recall": {
      const queryText = flag(args, "query");
      if (!queryText) throw new Error("Usage: mc knowledge recall --query TEXT [--project P] [--repo R] [--domain D]");
      outputValue(
        await mcFetch(
          "GET",
          `${API_PREFIX}/knowledge/recall${query({
            query: queryText,
            project: flag(args, "project"),
            repo: flag(args, "repo"),
            domain: flag(args, "domain"),
            limit: flag(args, "limit"),
          })}`,
        ),
        jsonMode,
        "knowledge",
      );
      return;
    }
    case "reembed": {
      const confirmed = hasFlag(args, "yes") || await askChoice("Re-embed knowledge chunks now", ["no", "yes"], "no");
      if (confirmed !== true && confirmed !== "yes") {
        console.log("Cancelled");
        return;
      }
      outputValue(
        await mcFetch("POST", `${API_PREFIX}/knowledge/reembed`, {
          schema: flag(args, "schema"),
          dimensions: flag(args, "dimensions") ? Number(flag(args, "dimensions")) : undefined,
          limit: flag(args, "limit") ? Number(flag(args, "limit")) : undefined,
          force: hasFlag(args, "force"),
        }),
        jsonMode,
        "result",
      );
      return;
    }
    case "promote":
      if (!id) throw new Error("Usage: mc knowledge promote <id>");
      outputValue(await mcFetch("POST", `${API_PREFIX}/knowledge/${id}/promote`, {}), jsonMode, "result");
      return;
    case "share":
      if (!id) throw new Error("Usage: mc knowledge share <id>");
      outputValue(await mcFetch("POST", `${API_PREFIX}/knowledge/${id}/share`, {}), jsonMode, "result");
      return;
    case "reject":
      if (!id) throw new Error("Usage: mc knowledge reject <id>");
      outputValue(await mcFetch("POST", `${API_PREFIX}/knowledge/${id}/reject`, {}), jsonMode, "result");
      return;
    case "delete":
      if (!id) throw new Error("Usage: mc knowledge delete <id>");
      outputValue(await mcFetch("DELETE", `${API_PREFIX}/knowledge/${id}`), jsonMode, "result");
      return;
    case "update":
      if (!id) throw new Error("Usage: mc knowledge update <id> [--text TEXT] [--domain DOMAIN]");
      outputValue(await mcFetch("PATCH", `${API_PREFIX}/knowledge/${id}`, await ensureKnowledgeUpdateBody(args, id)), jsonMode, "result");
      return;
    default:
      throw new Error("Unknown knowledge command. Try: list, add, promote, share, reject, delete, update");
  }
}

async function handleCheckpoints(args: ParsedArgs, jsonMode: boolean): Promise<void> {
  const [action, id] = args.positionals;
  switch (action ?? "list") {
    case "list":
      outputValue(await mcFetch("GET", `${API_PREFIX}/checkpoints?status=pending`), jsonMode, "checkpoints");
      return;
    case "resolve": {
      if (!id) throw new Error("Usage: mc checkpoints resolve <id> --decision approve|reject|answer [--response TEXT]");
      const decision = flag(args, "decision");
      if (!decision) throw new Error("--decision is required (approve|reject|answer)");
      outputValue(
        await mcFetch("POST", `${API_PREFIX}/checkpoints/${id}/resolve`, { decision, response: flag(args, "response") }),
        jsonMode,
        "result",
      );
      return;
    }
    default:
      throw new Error("Unknown checkpoints command. Try: list, resolve");
  }
}

async function handleObjectives(args: ParsedArgs, jsonMode: boolean): Promise<void> {
  const [action, id] = args.positionals;
  switch (action ?? "list") {
    case "list":
      outputValue(await mcFetch("GET", `${API_PREFIX}/objectives${query({ status: flag(args, "status") })}`), jsonMode, "objectives");
      return;
    case "create": {
      const goal = id ?? flag(args, "goal");
      if (!goal) throw new Error('Usage: mc objectives create "<goal>" [--max-rounds N] [--max-subtasks N]');
      const body: Record<string, unknown> = { goal };
      if (flag(args, "max-rounds")) body.max_rounds = Number(flag(args, "max-rounds"));
      if (flag(args, "max-subtasks")) body.max_subtasks = Number(flag(args, "max-subtasks"));
      if (flag(args, "cost-cap")) body.cost_cap_usd = Number(flag(args, "cost-cap"));
      outputValue(await mcFetch("POST", `${API_PREFIX}/objectives`, body), jsonMode, "objective");
      return;
    }
    case "get":
      if (!id) throw new Error("Usage: mc objectives get <id>");
      outputValue(await mcFetch("GET", `${API_PREFIX}/objectives/${id}`), jsonMode, "objective");
      return;
    case "approve": {
      if (!id) throw new Error("Usage: mc objectives approve <id> [--decision approve|reject] [--scope-file f.json]");
      const body: Record<string, unknown> = { decision: flag(args, "decision") ?? "approve" };
      const scopeFile = flag(args, "scope-file");
      if (scopeFile) {
        const raw = readFileSync(scopeFile, "utf-8");
        try { body.scope = JSON.parse(raw); } catch { body.response = raw; }
      }
      outputValue(await mcFetch("POST", `${API_PREFIX}/objectives/${id}/approve`, body), jsonMode, "result");
      return;
    }
    case "pages": {
      if (!id) throw new Error("Usage: mc objectives pages <id>");
      const doc = await mcFetch("GET", `${API_PREFIX}/objectives/${id}/document`);
      outputValue(isRecord(doc) && Array.isArray(doc.pages) ? doc.pages : [], jsonMode, "pages");
      return;
    }
    case "page": {
      const slug = args.positionals[2];
      if (!id || !slug) throw new Error("Usage: mc objectives page <id> <slug>");
      const doc = await mcFetch("GET", `${API_PREFIX}/objectives/${id}/document`);
      const document = isRecord(doc) && isRecord(doc.document) ? doc.document : null;
      if (!document) throw new Error("No document for this objective yet");
      const page = await mcFetch("GET", `${API_PREFIX}/documents/${document.id}/pages/${slug}`);
      if (jsonMode) {
        console.log(JSON.stringify(page, null, 2));
      } else if (isRecord(page)) {
        console.log(`# ${page.title}\n`);
        console.log(typeof page.body_md === "string" ? page.body_md : "(empty)");
      }
      return;
    }
    default:
      throw new Error("Unknown objectives command. Try: create, list, get, approve, pages, page");
  }
}

function setEnvVar(key: string, value: string): void {
  const envPath = join(MC_HOME, ".env");
  mkdirSync(MC_HOME, { recursive: true });
  const lines = existsSync(envPath) ? readFileSync(envPath, "utf-8").split("\n") : [];
  const idx = lines.findIndex(l => l.startsWith(`${key}=`));
  if (idx >= 0) lines[idx] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
  writeFileSync(envPath, lines.filter(l => l.trim() !== "").join("\n") + "\n");
}

async function runProbe(): Promise<Record<string, unknown>> {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const script = join(repoRoot, "swarm", "connections.py");
  const py = process.env.MC_PYTHON_BIN ?? "python3";
  const out = await execFileText(py, [script], 60000);
  return JSON.parse(out);
}

function loginCommand(runtime: string): string[] | null {
  if (runtime === "claude") return ["claude", "auth", "login"];
  if (runtime === "codex") return ["codex", "login"];
  if (runtime === "pi") return ["pi", "config"];
  return null;
}

async function handleSetup(): Promise<void> {
  if (!input.isTTY || !outputStream.isTTY) {
    throw new Error("mc setup is interactive — run it in a terminal.");
  }
  console.log("Mission Control setup — checking what's ready…\n");
  let report: Record<string, unknown>;
  try {
    report = await runProbe();
  } catch (e) {
    throw new Error(`Could not run the readiness probe: ${e instanceof Error ? e.message : String(e)}`);
  }

  const runtimes = asArray(report.runtimes);
  console.log("Agent runtimes:");
  for (const r of runtimes) {
    const ok = r.installed && r.authenticated;
    console.log(`  ${ok ? "✓" : "✗"} ${r.name}: ${r.detail || (r.installed ? "" : "not installed")}`);
    if (r.installed && !r.authenticated) {
      const cmd = loginCommand(String(r.name));
      if (cmd) {
        const yes = await askChoice(`    log in with \`${cmd.join(" ")}\` now?`, ["yes", "no"], "yes");
        if (yes === "yes") await runInteractive(cmd[0], cmd.slice(1)).catch(err => console.error(`    failed: ${err.message}`));
      }
    }
  }

  console.log("\nSources:");
  for (const s of asArray(report.sources)) {
    if (s.status === "connected") {
      console.log(`  ✓ ${s.name}: ${s.detail ?? ""}`);
      continue;
    }
    const fix = s.fix ? ` — ${s.fix}` : "";
    console.log(`  ✗ ${s.name}: ${s.detail || s.status}${fix}`);
    if (s.name === "Linear") {
      if (await askChoice("    set LINEAR_API_KEY now?", ["yes", "no"], "no") === "yes") {
        const k = await ask("    LINEAR_API_KEY");
        if (k) { setEnvVar("LINEAR_API_KEY", k); console.log("    saved to ~/.mission-control/.env"); }
      }
    } else if (s.name === "GitHub") {
      if (await askChoice("    run `gh auth login` now?", ["yes", "no"], "no") === "yes") {
        await runInteractive("gh", ["auth", "login"]).catch(err => console.error(`    failed: ${err.message}`));
      }
    } else if (s.kind === "mcp") {
      console.log(`    → connect in Claude (e.g. \`claude mcp add …\`) or authenticate the ${s.name} MCP server.`);
    }
  }

  console.log("\nText generation (triage / planner / autopilot) needs an LLM key, or a local Ollama model.");
  const gen = await askChoice("Set a generation key now?", ["anthropic", "openai", "gemini", "skip"], "skip");
  const genKey: Record<string, string> = { anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", gemini: "GOOGLE_GENERATIVE_AI_API_KEY" };
  if (gen in genKey) {
    const k = await ask(`  ${genKey[gen]}`);
    if (k) { setEnvVar(genKey[gen], k); console.log("  saved to ~/.mission-control/.env"); }
  }

  console.log("\nSetup complete. Verify any time with `mc connections`.");
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const jsonMode = hasFlag(args, "json");

  if (hasFlag(args, "help") || args.positionals.length === 0) {
    printHelp();
    return;
  }

  const [command, ...rest] = args.positionals;
  const subArgs: ParsedArgs = { positionals: rest, flags: args.flags };

  switch (command) {
    case "tasks":
      await handleTasks(subArgs, jsonMode);
      return;
    case "workspaces":
      await handleWorkspaces(subArgs, jsonMode);
      return;
    case "agents":
      await handleAgents(subArgs, jsonMode);
      return;
    case "knowledge":
      await handleKnowledge(subArgs, jsonMode);
      return;
    case "agent-status":
      outputValue(await mcFetch("GET", `${API_PREFIX}/agent-status`), jsonMode, "agent-status");
      return;
    case "services":
      if (rest[0] !== "health") throw new Error("Usage: mc services health");
      outputValue(await mcFetch("GET", `${API_PREFIX}/services/health`), jsonMode, "services-health");
      return;
    case "board":
      outputValue(
        await mcFetch(
          "GET",
          `${API_PREFIX}/board${query({
            limit: flag(subArgs, "limit"),
            offset: flag(subArgs, "offset"),
            since: flag(subArgs, "since"),
            live: flag(subArgs, "live"),
          })}`,
        ),
        jsonMode,
        "board",
      );
      return;
    case "system-stats":
      outputValue(await mcFetch("GET", `${API_PREFIX}/system-stats`), jsonMode, "system-stats");
      return;
    case "repos":
      outputValue(await mcFetch("GET", `${API_PREFIX}/repos`), jsonMode, "repos");
      return;
    case "config":
      outputValue(await mcFetch("GET", `${API_PREFIX}/config`), jsonMode, "config");
      return;
    case "swarm":
      await handleSwarm(subArgs, jsonMode);
      return;
    case "checkpoints":
      await handleCheckpoints(subArgs, jsonMode);
      return;
    case "connections":
      outputValue(await mcFetch("GET", `${API_PREFIX}/connections`), jsonMode, "connections");
      return;
    case "setup":
      await handleSetup();
      return;
    case "objectives":
      await handleObjectives(subArgs, jsonMode);
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`mc: ${message}`);
  process.exitCode = 1;
});
