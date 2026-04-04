import { Type } from "@sinclair/typebox";
import { execFile } from "node:child_process";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { homedir } from "node:os";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

const MC_URL = process.env.MISSION_CONTROL_URL ?? "http://127.0.0.1:18790";

function mcFetch(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, MC_URL);
    const req = httpRequest(url, { method, headers: { "Content-Type": "application/json" } }, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => { data += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(data)); } catch { resolve({ raw: data }); }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const KNOWLEDGE_SCRIPT = join(homedir(), ".openclaw", "swarm", "knowledge-manage.py");
const PYTHON_BIN = join(homedir(), ".openclaw", "venv-3.12", "bin", "python3");

function runKnowledgeScript(args: string[]): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    execFile(PYTHON_BIN, [KNOWLEDGE_SCRIPT, ...args], { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`Invalid JSON: ${stdout}`));
      }
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function registerTools(api: OpenClawPluginApi): void {
  api.registerTool(
    () => ({
      name: "mc_create_task",
      label: "Mission Control: Create Task",
      description:
        "Create a new task in Mission Control. Works without Linear — " +
        "tasks can be created directly via chat. Supports parent-child hierarchy " +
        "for multi-repo work.",
      parameters: Type.Object({
        title: Type.String({ minLength: 1, description: "Task title (e.g. '[CAP-99] Fix auth bug')" }),
        description: Type.Optional(Type.String({ description: "Detailed task description with requirements" })),
        priority: Type.Optional(
          Type.Union([
            Type.Literal("low"),
            Type.Literal("normal"),
            Type.Literal("high"),
            Type.Literal("urgent"),
          ])
        ),
        status: Type.Optional(
          Type.Union([
            Type.Literal("inbox"),
            Type.Literal("planning"),
            Type.Literal("in_progress"),
            Type.Literal("review"),
            Type.Literal("on_hold"),
          ], { description: "Initial status, defaults to inbox" })
        ),
        parent_task_id: Type.Optional(Type.String({ description: "Parent task ID for multi-repo child tasks" })),
        workspace_id: Type.Optional(Type.String()),
        assigned_agent_id: Type.Optional(Type.String()),
        source: Type.Optional(Type.String({ description: "Task source: manual, api, chat. Defaults to chat" })),
      }),
      async execute(_toolCallId: string, params: unknown) {
        if (!isRecord(params) || typeof params.title !== "string") {
          return {
            content: [{ type: "text", text: "Invalid input: title is required" }],
            details: { error: "validation_failed" },
          };
        }

        const input: Record<string, unknown> = {
          title: params.title as string,
          description: typeof params.description === "string" ? params.description : undefined,
          priority: typeof params.priority === "string" ? params.priority : undefined,
          status: typeof params.status === "string" ? params.status : "inbox",
          parent_task_id: typeof params.parent_task_id === "string" ? params.parent_task_id : undefined,
          workspace_id: typeof params.workspace_id === "string" ? params.workspace_id : undefined,
          assigned_agent_id: typeof params.assigned_agent_id === "string" ? params.assigned_agent_id : undefined,
          source: typeof params.source === "string" ? params.source : "chat",
        };
        const task = await mcFetch("POST", "/ext/mission-control/api/tasks", input);

        await mcFetch("POST", `/ext/mission-control/api/tasks/${task.id}/activities`, {
          task_id: task.id,
          activity_type: "created",
          message: `Task created via ${input.source ?? "chat"}`,
        });

        return {
          content: [{ type: "text", text: `Created task ${task.id}: ${task.title} (status: ${task.status})` }],
          details: task,
        };
      },
    }),
    { name: "mc_create_task" }
  );

  api.registerTool(
    () => ({
      name: "mc_list_tasks",
      label: "Mission Control: List Tasks",
      description: "List tasks with optional filters",
      parameters: Type.Object({
        status: Type.Optional(Type.String()),
        workspace_id: Type.Optional(Type.String()),
        assigned_agent_id: Type.Optional(Type.String()),
      }),
      async execute(_toolCallId: string, params: unknown) {
        const filters = isRecord(params)
          ? {
              status: typeof params.status === "string" ? params.status : undefined,
              workspace_id:
                typeof params.workspace_id === "string"
                  ? params.workspace_id
                  : undefined,
              assigned_agent_id:
                typeof params.assigned_agent_id === "string"
                  ? params.assigned_agent_id
                  : undefined,
            }
          : {};

        const queryParts: string[] = [];
        if (filters.status) queryParts.push(`status=${encodeURIComponent(filters.status)}`);
        if (filters.workspace_id) queryParts.push(`workspace_id=${encodeURIComponent(filters.workspace_id)}`);
        if (filters.assigned_agent_id) queryParts.push(`assigned_agent_id=${encodeURIComponent(filters.assigned_agent_id)}`);
        const qs = queryParts.length ? `?${queryParts.join("&")}` : "";
        const result = await mcFetch("GET", `/ext/mission-control/api/tasks${qs}`);
        const tasks = Array.isArray(result) ? result : (Array.isArray((result as Record<string, unknown>).tasks) ? (result as Record<string, unknown>).tasks as unknown[] : [result]);
        return {
          content: [{ type: "text", text: `Found ${tasks.length} tasks` }],
          details: { count: tasks.length, tasks },
        };
      },
    }),
    { name: "mc_list_tasks" }
  );

  api.registerTool(
    () => ({
      name: "mc_update_task",
      label: "Mission Control: Update Task",
      description: "Update an existing task",
      parameters: Type.Object({
        id: Type.String({ minLength: 1 }),
        status: Type.Optional(Type.String()),
        priority: Type.Optional(
          Type.Union([
            Type.Literal("low"),
            Type.Literal("normal"),
            Type.Literal("high"),
            Type.Literal("urgent"),
          ])
        ),
        title: Type.Optional(Type.String()),
        description: Type.Optional(Type.String()),
        assigned_agent_id: Type.Optional(Type.String()),
      }),
      async execute(_toolCallId: string, params: unknown) {
        if (!isRecord(params) || typeof params.id !== "string") {
          return {
            content: [{ type: "text", text: "Invalid input: id is required" }],
            details: { error: "validation_failed" },
          };
        }

        const update: Record<string, unknown> = {
          status: typeof params.status === "string" ? params.status : undefined,
          priority: typeof params.priority === "string" ? params.priority : undefined,
          title: typeof params.title === "string" ? params.title : undefined,
          description: typeof params.description === "string" ? params.description : undefined,
          assigned_agent_id: typeof params.assigned_agent_id === "string" ? params.assigned_agent_id : undefined,
        };

        const task = await mcFetch("PATCH", `/ext/mission-control/api/tasks/${params.id}`, update);
        if (task.error) {
          return {
            content: [{ type: "text", text: "Task not found" }],
            details: { error: "not_found", id: params.id },
          };
        }

        return {
          content: [{ type: "text", text: `Updated task ${task.id}` }],
          details: task,
        };
      },
    }),
    { name: "mc_update_task" }
  );

  api.registerTool(
    () => ({
      name: "mc_get_task",
      label: "Mission Control: Get Task",
      description: "Get task details by ID",
      parameters: Type.Object({
        id: Type.String({ minLength: 1 }),
      }),
      async execute(_toolCallId: string, params: unknown) {
        if (!isRecord(params) || typeof params.id !== "string") {
          return {
            content: [{ type: "text", text: "Invalid input: id is required" }],
            details: { error: "validation_failed" },
          };
        }

        const task = await mcFetch("GET", `/ext/mission-control/api/tasks/${params.id}`);
        if (task.error) {
          return {
            content: [{ type: "text", text: "Task not found" }],
            details: { error: "not_found", id: params.id },
          };
        }

        return {
          content: [{ type: "text", text: `Task ${task.id}: ${task.title}` }],
          details: task,
        };
      },
    }),
    { name: "mc_get_task" }
  );

  api.registerTool(
    () => ({
      name: "mc_log_activity",
      label: "Mission Control: Log Activity",
      description: "Log an activity against a task",
      parameters: Type.Object({
        task_id: Type.String({ minLength: 1 }),
        activity_type: Type.String({ minLength: 1 }),
        message: Type.String({ minLength: 1 }),
      }),
      async execute(_toolCallId: string, params: unknown) {
        if (
          !isRecord(params) ||
          typeof params.task_id !== "string" ||
          typeof params.activity_type !== "string" ||
          typeof params.message !== "string"
        ) {
          return {
            content: [{ type: "text", text: "Invalid input for activity logging" }],
            details: { error: "validation_failed" },
          };
        }

        const input = {
          task_id: params.task_id,
          activity_type: params.activity_type,
          message: params.message,
        };
        const activity = await mcFetch("POST", `/ext/mission-control/api/tasks/${params.task_id}/activities`, input);
        return {
          content: [{ type: "text", text: `Logged activity ${activity.id}` }],
          details: activity,
        };
      },
    }),
    { name: "mc_log_activity" }
  );

  api.registerTool(
    () => ({
      name: "mc_list_workspaces",
      label: "Mission Control: List Workspaces",
      description: "List all workspaces",
      parameters: Type.Object({}),
      async execute() {
        const result = await mcFetch("GET", "/ext/mission-control/api/workspaces");
        const workspaces = Array.isArray(result) ? result : (Array.isArray((result as Record<string, unknown>).workspaces) ? (result as Record<string, unknown>).workspaces as unknown[] : [result]);
        return {
          content: [{ type: "text", text: `Found ${workspaces.length} workspaces` }],
          details: { count: workspaces.length, workspaces },
        };
      },
    }),
    { name: "mc_list_workspaces" }
  );

  api.registerTool(
    () => ({
      name: "mc_create_workspace",
      label: "Mission Control: Create Workspace",
      description: "Create a workspace",
      parameters: Type.Object({
        name: Type.String({ minLength: 1 }),
        description: Type.Optional(Type.String()),
      }),
      async execute(_toolCallId: string, params: unknown) {
        if (!isRecord(params) || typeof params.name !== "string") {
          return {
            content: [{ type: "text", text: "Invalid input: workspace name required" }],
            details: { error: "validation_failed" },
          };
        }
        const input = {
          name: params.name,
          description:
            typeof params.description === "string" ? params.description : undefined,
        };
        const workspace = await mcFetch("POST", "/ext/mission-control/api/workspaces", input);
        return {
          content: [{ type: "text", text: `Created workspace ${workspace.id}` }],
          details: workspace,
        };
      },
    }),
    { name: "mc_create_workspace" }
  );

  api.registerTool(
    () => ({
      name: "mc_add_knowledge",
      label: "Mission Control: Add Knowledge",
      description:
        "Store developer knowledge about a repo or project. " +
        "Examples: branch conventions, directory constraints, coding standards, gotchas. " +
        "This knowledge is recalled during task triage and injected into agent prompts.",
      parameters: Type.Object({
        text: Type.String({ minLength: 1, description: "The knowledge to store (natural language)" }),
        project: Type.Optional(Type.String({ description: "Project name (e.g. 'acme')" })),
        repo: Type.Optional(Type.String({ description: "Repo name (e.g. 'backend-api')" })),
        importance: Type.Optional(Type.Number({ minimum: 1, maximum: 5, description: "1-5, default 5" })),
        category: Type.Optional(
          Type.Union([
            Type.Literal("fact"),
            Type.Literal("decision"),
            Type.Literal("entity"),
            Type.Literal("convention"),
            Type.Literal("other"),
          ])
        ),
      }),
      async execute(_toolCallId: string, params: unknown) {
        if (!isRecord(params) || typeof params.text !== "string") {
          return {
            content: [{ type: "text", text: "Invalid input: text is required" }],
            details: { error: "validation_failed" },
          };
        }

        const args = [
          "inject",
          "--text", String(params.text),
          "--importance", String(params.importance ?? 5),
          "--category", String(params.category ?? "fact"),
          "--source", "human",
          "--via", "gateway",
        ];
        if (typeof params.project === "string") args.push("--project", params.project);
        if (typeof params.repo === "string") args.push("--repo", params.repo);

        try {
          const result = await runKnowledgeScript(args);
          const scope = (result as Record<string, string>).scope ?? "global";
          return {
            content: [{ type: "text", text: `Stored knowledge for ${scope}` }],
            details: result,
          };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            content: [{ type: "text", text: `Failed to store knowledge: ${msg}` }],
            details: { error: msg },
          };
        }
      },
    }),
    { name: "mc_add_knowledge" }
  );

  api.registerTool(
    () => ({
      name: "mc_list_knowledge",
      label: "Mission Control: List Knowledge",
      description: "List stored knowledge entries for a repo or project.",
      parameters: Type.Object({
        project: Type.Optional(Type.String()),
        repo: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Number({ minimum: 1, maximum: 100 })),
      }),
      async execute(_toolCallId: string, params: unknown) {
        const p = isRecord(params) ? params : {};
        const args = ["list", "--limit", String(p.limit ?? 20)];
        if (typeof p.project === "string") args.push("--project", String(p.project));
        if (typeof p.repo === "string") args.push("--repo", String(p.repo));

        try {
          const result = await runKnowledgeScript(args);
          const count = (result as Record<string, number>).count ?? 0;
          return {
            content: [{ type: "text", text: `Found ${count} knowledge entries` }],
            details: result,
          };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            content: [{ type: "text", text: `Failed to list knowledge: ${msg}` }],
            details: { error: msg },
          };
        }
      },
    }),
    { name: "mc_list_knowledge" }
  );
}
