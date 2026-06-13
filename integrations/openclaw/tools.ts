import { Type } from "@sinclair/typebox";
import { execFile } from "node:child_process";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { homedir } from "node:os";
import type { OpenClawPluginApi } from "./sdk-shim.js";

const MC_URL = process.env.MISSION_CONTROL_URL ?? "http://127.0.0.1:18900";
const API_PREFIX = "/api";
const MC_HOME = process.env.MC_HOME ?? join(homedir(), ".mission-control");

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

const KNOWLEDGE_SCRIPT = join(MC_HOME, "swarm", "knowledge-manage.py");
const PYTHON_BIN = process.env.MC_PYTHON_BIN ?? join(MC_HOME, "venv-3.12", "bin", "python3");

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
      description: "Create a new task in standalone Mission Control.",
      parameters: Type.Object({
        title: Type.String({ minLength: 1 }),
        description: Type.Optional(Type.String()),
        priority: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("normal"), Type.Literal("high"), Type.Literal("urgent")])),
        status: Type.Optional(Type.String()),
        parent_task_id: Type.Optional(Type.String()),
        workspace_id: Type.Optional(Type.String()),
        assigned_agent_id: Type.Optional(Type.String()),
        source: Type.Optional(Type.String()),
      }),
      async execute(_toolCallId: string, params: unknown) {
        if (!isRecord(params) || typeof params.title !== "string") {
          return { content: [{ type: "text", text: "Invalid input: title is required" }], details: { error: "validation_failed" } };
        }

        const input: Record<string, unknown> = {
          title: params.title,
          description: typeof params.description === "string" ? params.description : undefined,
          priority: typeof params.priority === "string" ? params.priority : undefined,
          status: typeof params.status === "string" ? params.status : "inbox",
          parent_task_id: typeof params.parent_task_id === "string" ? params.parent_task_id : undefined,
          workspace_id: typeof params.workspace_id === "string" ? params.workspace_id : undefined,
          assigned_agent_id: typeof params.assigned_agent_id === "string" ? params.assigned_agent_id : undefined,
          source: typeof params.source === "string" ? params.source : "openclaw",
        };
        const task = await mcFetch("POST", `${API_PREFIX}/tasks`, input);
        await mcFetch("POST", `${API_PREFIX}/tasks/${task.id}/activities`, {
          task_id: task.id,
          activity_type: "created",
          message: `Task created via ${input.source ?? "openclaw"}`,
        });
        return { content: [{ type: "text", text: `Created task ${task.id}: ${task.title}` }], details: task };
      },
    }),
    { name: "mc_create_task" },
  );

  api.registerTool(
    () => ({
      name: "mc_list_tasks",
      label: "Mission Control: List Tasks",
      description: "List tasks from standalone Mission Control.",
      parameters: Type.Object({ status: Type.Optional(Type.String()), workspace_id: Type.Optional(Type.String()), assigned_agent_id: Type.Optional(Type.String()) }),
      async execute(_toolCallId: string, params: unknown) {
        const filters = isRecord(params) ? params : {};
        const queryParts: string[] = [];
        if (typeof filters.status === "string") queryParts.push(`status=${encodeURIComponent(filters.status)}`);
        if (typeof filters.workspace_id === "string") queryParts.push(`workspace_id=${encodeURIComponent(filters.workspace_id)}`);
        if (typeof filters.assigned_agent_id === "string") queryParts.push(`assigned_agent_id=${encodeURIComponent(filters.assigned_agent_id)}`);
        const qs = queryParts.length ? `?${queryParts.join("&")}` : "";
        const result = await mcFetch("GET", `${API_PREFIX}/tasks${qs}`);
        const tasks = Array.isArray(result) ? result : (Array.isArray(result.tasks) ? result.tasks as unknown[] : [result]);
        return { content: [{ type: "text", text: `Found ${tasks.length} tasks` }], details: { count: tasks.length, tasks } };
      },
    }),
    { name: "mc_list_tasks" },
  );

  api.registerTool(
    () => ({
      name: "mc_add_knowledge",
      label: "Mission Control: Add Knowledge",
      description: "Store knowledge in standalone Mission Control.",
      parameters: Type.Object({ text: Type.String({ minLength: 1 }), project: Type.Optional(Type.String()), repo: Type.Optional(Type.String()), importance: Type.Optional(Type.Number()), category: Type.Optional(Type.String()) }),
      async execute(_toolCallId: string, params: unknown) {
        if (!isRecord(params) || typeof params.text !== "string") {
          return { content: [{ type: "text", text: "Invalid input: text is required" }], details: { error: "validation_failed" } };
        }
        const args = ["inject", "--text", String(params.text), "--importance", String(params.importance ?? 5), "--category", String(params.category ?? "fact"), "--source", "human", "--via", "openclaw"];
        if (typeof params.project === "string") args.push("--project", params.project);
        if (typeof params.repo === "string") args.push("--repo", params.repo);
        try {
          const result = await runKnowledgeScript(args);
          const scope = (result as Record<string, string>).scope ?? "global";
          return { content: [{ type: "text", text: `Stored knowledge for ${scope}` }], details: result };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return { content: [{ type: "text", text: `Failed to store knowledge: ${msg}` }], details: { error: msg } };
        }
      },
    }),
    { name: "mc_add_knowledge" },
  );
}
