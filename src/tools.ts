import { Type } from "@sinclair/typebox";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type {
  CreateActivityInput,
  CreateTaskInput,
  CreateWorkspaceInput,
  MissionControlDB,
  UpdateTaskInput,
} from "./db.js";

const KNOWLEDGE_SCRIPT = join(homedir(), ".openclaw", "swarm", "knowledge-manage.py");

function runKnowledgeScript(args: string[]): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    execFile("python3", [KNOWLEDGE_SCRIPT, ...args], { timeout: 30000 }, (err, stdout, stderr) => {
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

export function registerTools(api: OpenClawPluginApi, db: MissionControlDB): void {
  api.registerTool(
    () => ({
      name: "mc_create_task",
      label: "Mission Control: Create Task",
      description: "Create a new mission task",
      parameters: Type.Object({
        title: Type.String({ minLength: 1 }),
        description: Type.Optional(Type.String()),
        priority: Type.Optional(
          Type.Union([
            Type.Literal("low"),
            Type.Literal("normal"),
            Type.Literal("high"),
            Type.Literal("urgent"),
          ])
        ),
        workspace_id: Type.Optional(Type.String()),
        assigned_agent_id: Type.Optional(Type.String()),
      }),
      async execute(_toolCallId: string, params: unknown) {
        if (!isRecord(params) || typeof params.title !== "string") {
          return {
            content: [{ type: "text", text: "Invalid input: title is required" }],
            details: { error: "validation_failed" },
          };
        }

        const input = params as unknown as CreateTaskInput;
        const task = db.createTask(input);
        return {
          content: [{ type: "text", text: `Created task ${task.id}: ${task.title}` }],
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

        const tasks = db.listTasks(filters);
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

        const update: UpdateTaskInput = {
          status: typeof params.status === "string" ? (params.status as UpdateTaskInput["status"]) : undefined,
          priority:
            typeof params.priority === "string" ? (params.priority as UpdateTaskInput["priority"]) : undefined,
          title: typeof params.title === "string" ? params.title : undefined,
          description:
            typeof params.description === "string" ? params.description : undefined,
          assigned_agent_id:
            typeof params.assigned_agent_id === "string"
              ? params.assigned_agent_id
              : undefined,
        };

        const task = db.updateTask(params.id, update);
        if (!task) {
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

        const task = db.getTask(params.id);
        if (!task) {
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

        const input: CreateActivityInput = {
          task_id: params.task_id,
          activity_type: params.activity_type,
          message: params.message,
        };
        const activity = db.createActivity(input);
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
        const workspaces = db.listWorkspaces();
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
        const input: CreateWorkspaceInput = {
          name: params.name,
          description:
            typeof params.description === "string" ? params.description : undefined,
        };
        const workspace = db.createWorkspace(input);
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
