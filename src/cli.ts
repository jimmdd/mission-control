#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as outputStream } from "node:process";

type Json = Record<string, unknown> | unknown[];

const MC_URL = process.env.MISSION_CONTROL_URL ?? "http://127.0.0.1:18790";
const API_PREFIX = "/ext/mission-control/api";

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
  | "result";

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
        scope: entry.scope ?? entry.domain ?? "",
        category: entry.category ?? "",
        stage: entry.stage ?? "",
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
  knowledge reject <id>
  knowledge delete <id>
  knowledge update <id> [--interactive] [--text TEXT] [--domain DOMAIN]

  services health
  board [--limit N] [--offset N] [--since ISO] [--live true]
  system-stats
  repos
  config
  linear teams

Global options:
  --json       Print raw JSON
  --help       Show help

Environment:
  MISSION_CONTROL_URL   Base URL for Mission Control (default: ${MC_URL})

Examples:
  mc tasks list --status inbox
  mc tasks create --interactive
  mc tasks create --title "[CAP-99] Fix auth bug" --description "Handle expired sessions" --priority high
  mc knowledge add --interactive
  mc services health --json
`);
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
      throw new Error("Unknown tasks command. Try: list, get, create, update, activities, deliverables, retry, done");
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
    case "promote":
      if (!id) throw new Error("Usage: mc knowledge promote <id>");
      outputValue(await mcFetch("POST", `${API_PREFIX}/knowledge/${id}/promote`, {}), jsonMode, "result");
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
      throw new Error("Unknown knowledge command. Try: list, add, promote, reject, delete, update");
  }
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
    case "linear":
      if (rest[0] !== "teams") throw new Error("Usage: mc linear teams");
      outputValue(await mcFetch("GET", `${API_PREFIX}/linear/teams`), jsonMode, "default");
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
