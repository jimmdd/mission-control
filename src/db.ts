import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export type AgentStatus = "standby" | "working" | "offline";
export type TaskStatus =
  | "pending_dispatch"
  | "planning"
  | "inbox"
  | "assigned"
  | "in_progress"
  | "testing"
  | "review"
  | "on_hold"
  | "done";
export type TaskPriority = "low" | "normal" | "high" | "urgent";
export type TaskType = "implementation" | "investigation" | "research";

export interface WorkspaceRecord {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  icon: string;
  created_at: string;
  updated_at: string;
}

export interface AgentRecord {
  id: string;
  name: string;
  role: string;
  description: string | null;
  avatar_emoji: string;
  status: AgentStatus;
  is_master: number;
  workspace_id: string;
  soul_md: string | null;
  user_md: string | null;
  agents_md: string | null;
  model: string | null;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface TaskRecord {
  id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  assigned_agent_id: string | null;
  created_by_agent_id: string | null;
  workspace_id: string;
  due_date: string | null;
  parent_task_id: string | null;
  external_id: string | null;
  external_url: string | null;
  source: string;
  task_type: string;
  triage_state: string | null;
  created_at: string;
  updated_at: string;
}

export interface EventRecord {
  id: string;
  type: string;
  agent_id: string | null;
  task_id: string | null;
  message: string;
  metadata: string | null;
  created_at: string;
}

export interface TaskActivityRecord {
  id: string;
  task_id: string;
  agent_id: string | null;
  activity_type: string;
  message: string;
  metadata: string | null;
  created_at: string;
}

export interface TaskDeliverableRecord {
  id: string;
  task_id: string;
  deliverable_type: string;
  title: string;
  path: string | null;
  description: string | null;
  created_at: string;
}

export interface SessionRecord {
  id: string;
  agent_id: string | null;
  openclaw_session_id: string;
  channel: string | null;
  status: string;
  session_type: string;
  task_id: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskFilters {
  status?: string;
  workspace_id?: string;
  assigned_agent_id?: string;
  limit?: number;
  offset?: number;
}

export interface AgentFilters {
  workspace_id?: string;
  status?: AgentStatus;
  limit?: number;
  offset?: number;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  assigned_agent_id?: string;
  created_by_agent_id?: string;
  workspace_id?: string;
  due_date?: string;
  parent_task_id?: string;
  external_id?: string;
  external_url?: string;
  source?: string;
  task_type?: TaskType;
  triage_state?: string;
}

export interface UpdateTaskInput {
  title?: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  assigned_agent_id?: string | null;
  created_by_agent_id?: string | null;
  workspace_id?: string;
  due_date?: string | null;
  parent_task_id?: string | null;
  external_id?: string | null;
  external_url?: string | null;
  source?: string;
  task_type?: TaskType;
  triage_state?: string | null;
}

export interface CreateAgentInput {
  name: string;
  role: string;
  description?: string;
  avatar_emoji?: string;
  status?: AgentStatus;
  is_master?: boolean;
  workspace_id?: string;
  soul_md?: string;
  user_md?: string;
  agents_md?: string;
  model?: string;
  source?: string;
}

export interface UpdateAgentInput {
  name?: string;
  role?: string;
  description?: string | null;
  avatar_emoji?: string;
  status?: AgentStatus;
  is_master?: boolean;
  workspace_id?: string;
  soul_md?: string | null;
  user_md?: string | null;
  agents_md?: string | null;
  model?: string | null;
  source?: string;
}

export interface CreateWorkspaceInput {
  name: string;
  slug?: string;
  description?: string;
  icon?: string;
}

export interface UpdateWorkspaceInput {
  name?: string;
  slug?: string;
  description?: string | null;
  icon?: string;
}

export interface CreateActivityInput {
  task_id: string;
  agent_id?: string;
  activity_type: string;
  message: string;
  metadata?: string;
}

export interface CreateDeliverableInput {
  task_id: string;
  deliverable_type: string;
  title: string;
  path?: string;
  description?: string;
}

export interface CreateEventInput {
  type: string;
  agent_id?: string;
  task_id?: string;
  message: string;
  metadata?: string;
}

export interface CreateSessionInput {
  agent_id?: string;
  openclaw_session_id: string;
  channel?: string;
  status?: string;
  session_type?: string;
  task_id?: string;
  ended_at?: string;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  icon TEXT DEFAULT '📁',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  description TEXT,
  avatar_emoji TEXT DEFAULT '🤖',
  status TEXT DEFAULT 'standby' CHECK (status IN ('standby', 'working', 'offline')),
  is_master INTEGER DEFAULT 0,
  workspace_id TEXT DEFAULT 'default' REFERENCES workspaces(id),
  soul_md TEXT,
  user_md TEXT,
  agents_md TEXT,
  model TEXT,
  source TEXT DEFAULT 'local',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'inbox' CHECK (status IN ('pending_dispatch', 'planning', 'inbox', 'assigned', 'in_progress', 'testing', 'review', 'on_hold', 'done')),
  priority TEXT DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  assigned_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  created_by_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  workspace_id TEXT DEFAULT 'default' REFERENCES workspaces(id),
  due_date TEXT,
  parent_task_id TEXT REFERENCES tasks(id),
  external_id TEXT,
  external_url TEXT,
  source TEXT DEFAULT 'manual',
  task_type TEXT DEFAULT 'implementation' CHECK (task_type IN ('implementation', 'investigation', 'research')),
  triage_state TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  metadata TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS task_activities (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  activity_type TEXT NOT NULL,
  message TEXT NOT NULL,
  metadata TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS task_deliverables (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  deliverable_type TEXT NOT NULL,
  title TEXT NOT NULL,
  path TEXT,
  description TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS openclaw_sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  openclaw_session_id TEXT NOT NULL,
  channel TEXT,
  status TEXT DEFAULT 'active',
  session_type TEXT DEFAULT 'persistent',
  task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  ended_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_agent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_workspace ON tasks(workspace_id);
CREATE INDEX IF NOT EXISTS idx_agents_workspace ON agents(workspace_id);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
CREATE INDEX IF NOT EXISTS idx_activities_task ON task_activities(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deliverables_task ON task_deliverables(task_id);
CREATE INDEX IF NOT EXISTS idx_openclaw_sessions_task ON openclaw_sessions(task_id);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_external_id ON tasks(external_id);
`;

function generateSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || randomUUID().slice(0, 8);
}

export class MissionControlDB {
  private readonly db: InstanceType<typeof Database>;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
  }

  initSchema(): void {
    this.db.exec(SCHEMA_SQL);
    this.migrateTaskStatus();
    this.migrateLinearColumns();
    this.migrateTaskType();
  }

  private normalizePagination(limit?: number, offset?: number): { limit: number; offset: number } {
    const normalizedLimit = Math.min(Math.max(limit ?? 100, 1), 1000);
    const normalizedOffset = Math.max(offset ?? 0, 0);
    return { limit: normalizedLimit, offset: normalizedOffset };
  }

  private buildDynamicUpdate(fields: Record<string, unknown>): { sql: string; values: unknown[] } {
    const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
    const updates = entries.map(([column]) => `${column} = ?`);
    const values = entries.map(([, value]) => value);

    updates.push("updated_at = ?");
    values.push(new Date().toISOString());

    return { sql: updates.join(", "), values };
  }

  private migrateLinearColumns(): void {
    const row = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'")
      .get() as { sql: string } | undefined;
    if (!row || !row.sql.includes("linear_issue_id")) return;

    this.db.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN;
      CREATE TABLE tasks_v2 (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT DEFAULT 'inbox' CHECK (status IN ('pending_dispatch', 'planning', 'inbox', 'assigned', 'in_progress', 'testing', 'review', 'on_hold', 'done')),
        priority TEXT DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
        assigned_agent_id TEXT REFERENCES agents(id),
        created_by_agent_id TEXT REFERENCES agents(id),
        workspace_id TEXT DEFAULT 'default' REFERENCES workspaces(id),
        due_date TEXT,
        parent_task_id TEXT REFERENCES tasks(id),
        external_id TEXT,
        external_url TEXT,
        source TEXT DEFAULT 'manual',
        triage_state TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      INSERT INTO tasks_v2(id, title, description, status, priority,
        assigned_agent_id, created_by_agent_id, workspace_id, due_date,
        parent_task_id, external_id, external_url, source, triage_state,
        created_at, updated_at)
      SELECT id, title, description, status, priority,
        assigned_agent_id, created_by_agent_id, workspace_id, due_date,
        parent_task_id, linear_issue_id, linear_issue_url, source, triage_state,
        created_at, updated_at
      FROM tasks;
      DROP TABLE tasks;
      ALTER TABLE tasks_v2 RENAME TO tasks;
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
  }

  private migrateTaskType(): void {
    const row = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'")
      .get() as { sql: string } | undefined;
    if (!row) return;
    if (!row.sql.includes("task_type")) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN task_type TEXT DEFAULT 'implementation' CHECK (task_type IN ('implementation', 'investigation', 'research'))`);
      return;
    }
    if (row.sql.includes("'research'")) return;

    this.db.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN;
      CREATE TABLE tasks_task_type_migrated (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT DEFAULT 'inbox' CHECK (status IN ('pending_dispatch', 'planning', 'inbox', 'assigned', 'in_progress', 'testing', 'review', 'on_hold', 'done')),
        priority TEXT DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
        assigned_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
        created_by_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
        workspace_id TEXT DEFAULT 'default' REFERENCES workspaces(id),
        due_date TEXT,
        parent_task_id TEXT REFERENCES tasks(id),
        external_id TEXT,
        external_url TEXT,
        source TEXT DEFAULT 'manual',
        task_type TEXT DEFAULT 'implementation' CHECK (task_type IN ('implementation', 'investigation', 'research')),
        triage_state TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      INSERT INTO tasks_task_type_migrated(
        id, title, description, status, priority, assigned_agent_id, created_by_agent_id,
        workspace_id, due_date, parent_task_id, external_id, external_url,
        source, task_type, triage_state, created_at, updated_at
      )
      SELECT
        id, title, description, status, priority, assigned_agent_id, created_by_agent_id,
        workspace_id, due_date, parent_task_id, external_id, external_url,
        source, task_type, triage_state, created_at, updated_at
      FROM tasks;
      DROP TABLE tasks;
      ALTER TABLE tasks_task_type_migrated RENAME TO tasks;
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
  }

  private migrateTaskStatus(): void {
    const row = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'")
      .get() as { sql: string } | undefined;
    if (!row || row.sql.includes("on_hold")) return;

    this.db.exec(`
      PRAGMA foreign_keys = OFF;
      BEGIN;
      CREATE TABLE tasks_migrated (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT DEFAULT 'inbox' CHECK (status IN ('pending_dispatch', 'planning', 'inbox', 'assigned', 'in_progress', 'testing', 'review', 'on_hold', 'done')),
        priority TEXT DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
        assigned_agent_id TEXT REFERENCES agents(id),
        created_by_agent_id TEXT REFERENCES agents(id),
        workspace_id TEXT DEFAULT 'default' REFERENCES workspaces(id),
        due_date TEXT,
        parent_task_id TEXT REFERENCES tasks(id),
        external_id TEXT,
        external_url TEXT,
        source TEXT DEFAULT 'manual',
        triage_state TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      INSERT INTO tasks_migrated(id, title, description, status, priority,
        assigned_agent_id, created_by_agent_id, workspace_id, due_date,
        parent_task_id, external_id, external_url, source, triage_state,
        created_at, updated_at)
      SELECT id, title, description, status, priority,
        assigned_agent_id, created_by_agent_id, workspace_id, due_date,
        parent_task_id, linear_issue_id, linear_issue_url, source, triage_state,
        created_at, updated_at
      FROM tasks;
      DROP TABLE tasks;
      ALTER TABLE tasks_migrated RENAME TO tasks;
      COMMIT;
      PRAGMA foreign_keys = ON;
    `);
  }

  seedDefaults(): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO workspaces (id, name, slug, description, icon)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run("default", "Default Workspace", "default", "Default workspace", "🏠");
  }

  listTasks(filters: TaskFilters = {}): TaskRecord[] {
    let sql = "SELECT * FROM tasks WHERE 1=1";
    const params: unknown[] = [];

    if (filters.status) {
      sql += " AND status = ?";
      params.push(filters.status);
    }
    if (filters.workspace_id) {
      sql += " AND workspace_id = ?";
      params.push(filters.workspace_id);
    }
    if (filters.assigned_agent_id) {
      sql += " AND assigned_agent_id = ?";
      params.push(filters.assigned_agent_id);
    }

    const { limit, offset } = this.normalizePagination(filters.limit, filters.offset);
    sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    return this.db.prepare(sql).all(...params) as TaskRecord[];
  }

  getTask(id: string): TaskRecord | undefined {
    return this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as
      | TaskRecord
      | undefined;
  }

  createTask(data: CreateTaskInput): TaskRecord {
    const id = randomUUID();
    const now = new Date().toISOString();

    try {
      this.db
        .prepare(
          `INSERT INTO tasks (
            id, title, description, status, priority, assigned_agent_id, created_by_agent_id,
            workspace_id, due_date, parent_task_id, external_id, external_url,
            source, task_type, triage_state, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          data.title,
          data.description ?? null,
          data.status ?? "inbox",
          data.priority ?? "normal",
          data.assigned_agent_id ?? null,
          data.created_by_agent_id ?? null,
          data.workspace_id ?? "default",
          data.due_date ?? null,
          data.parent_task_id ?? null,
          data.external_id ?? null,
          data.external_url ?? null,
          data.source ?? "manual",
          data.task_type ?? "implementation",
          data.triage_state ?? null,
          now,
          now
        );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to create task (title: \"${data.title}\"): ${detail}`);
    }

    const task = this.getTask(id);
    if (!task) {
      throw new Error(`Failed to create task (title: \"${data.title}\"): record not found after insert`);
    }
    return task;
  }

  updateTask(id: string, data: UpdateTaskInput): TaskRecord | undefined {
    const fields: Record<string, unknown> = {
      title: data.title,
      description: data.description,
      status: data.status,
      priority: data.priority,
      assigned_agent_id: data.assigned_agent_id,
      created_by_agent_id: data.created_by_agent_id,
      workspace_id: data.workspace_id,
      due_date: data.due_date,
      parent_task_id: data.parent_task_id,
      external_id: data.external_id,
      external_url: data.external_url,
      source: data.source,
      task_type: data.task_type,
      triage_state: data.triage_state,
    };

    const hasUpdates = Object.values(fields).some((value) => value !== undefined);
    if (!hasUpdates) {
      return this.getTask(id);
    }

    const { sql, values } = this.buildDynamicUpdate(fields);
    this.db.prepare(`UPDATE tasks SET ${sql} WHERE id = ?`).run(...values, id);
    return this.getTask(id);
  }

  deleteTask(id: string): boolean {
    return this.db.transaction(() => {
      this.db.prepare("DELETE FROM openclaw_sessions WHERE task_id = ?").run(id);
      this.db.prepare("DELETE FROM events WHERE task_id = ?").run(id);
      const result = this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
      return result.changes > 0;
    })();
  }

  listAgents(filters: AgentFilters = {}): AgentRecord[] {
    let sql = "SELECT * FROM agents WHERE 1=1";
    const params: unknown[] = [];

    if (filters.workspace_id) {
      sql += " AND workspace_id = ?";
      params.push(filters.workspace_id);
    }
    if (filters.status) {
      sql += " AND status = ?";
      params.push(filters.status);
    }

    const { limit, offset } = this.normalizePagination(filters.limit, filters.offset);
    sql += " ORDER BY is_master DESC, name ASC LIMIT ? OFFSET ?";
    params.push(limit, offset);

    return this.db.prepare(sql).all(...params) as AgentRecord[];
  }

  getAgent(id: string): AgentRecord | undefined {
    return this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as
      | AgentRecord
      | undefined;
  }

  createAgent(data: CreateAgentInput): AgentRecord {
    const id = randomUUID();
    const now = new Date().toISOString();

    try {
      this.db
        .prepare(
          `INSERT INTO agents (
            id, name, role, description, avatar_emoji, status, is_master,
            workspace_id, soul_md, user_md, agents_md, model, source,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          data.name,
          data.role,
          data.description ?? null,
          data.avatar_emoji ?? "🤖",
          data.status ?? "standby",
          data.is_master ? 1 : 0,
          data.workspace_id ?? "default",
          data.soul_md ?? null,
          data.user_md ?? null,
          data.agents_md ?? null,
          data.model ?? null,
          data.source ?? "local",
          now,
          now
        );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to create agent (name: \"${data.name}\"): ${detail}`);
    }

    const agent = this.getAgent(id);
    if (!agent) {
      throw new Error(`Failed to create agent (name: \"${data.name}\"): record not found after insert`);
    }
    return agent;
  }

  updateAgent(id: string, data: UpdateAgentInput): AgentRecord | undefined {
    const fields: Record<string, unknown> = {
      name: data.name,
      role: data.role,
      description: data.description,
      avatar_emoji: data.avatar_emoji,
      status: data.status,
      is_master: data.is_master === undefined ? undefined : data.is_master ? 1 : 0,
      workspace_id: data.workspace_id,
      soul_md: data.soul_md,
      user_md: data.user_md,
      agents_md: data.agents_md,
      model: data.model,
      source: data.source,
    };

    const hasUpdates = Object.values(fields).some((value) => value !== undefined);
    if (!hasUpdates) {
      return this.getAgent(id);
    }

    const { sql, values } = this.buildDynamicUpdate(fields);
    this.db.prepare(`UPDATE agents SET ${sql} WHERE id = ?`).run(...values, id);
    return this.getAgent(id);
  }

  deleteAgent(id: string): boolean {
    return this.db.transaction(() => {
      this.db.prepare("DELETE FROM openclaw_sessions WHERE agent_id = ?").run(id);
      this.db.prepare("DELETE FROM events WHERE agent_id = ?").run(id);
      this.db
        .prepare("UPDATE tasks SET assigned_agent_id = NULL WHERE assigned_agent_id = ?")
        .run(id);
      this.db
        .prepare("UPDATE tasks SET created_by_agent_id = NULL WHERE created_by_agent_id = ?")
        .run(id);
      this.db.prepare("UPDATE task_activities SET agent_id = NULL WHERE agent_id = ?").run(id);
      const result = this.db.prepare("DELETE FROM agents WHERE id = ?").run(id);
      return result.changes > 0;
    })();
  }

  listWorkspaces(limit?: number, offset?: number): WorkspaceRecord[] {
    const pagination = this.normalizePagination(limit, offset);
    return this.db
      .prepare("SELECT * FROM workspaces ORDER BY name ASC LIMIT ? OFFSET ?")
      .all(pagination.limit, pagination.offset) as WorkspaceRecord[];
  }

  getWorkspace(id: string): WorkspaceRecord | undefined {
    return this.db
      .prepare("SELECT * FROM workspaces WHERE id = ? OR slug = ?")
      .get(id, id) as WorkspaceRecord | undefined;
  }

  createWorkspace(data: CreateWorkspaceInput): WorkspaceRecord {
    const id = randomUUID();
    const now = new Date().toISOString();
    const baseSlug = data.slug ? generateSlug(data.slug) : generateSlug(data.name);

    let candidateSlug = baseSlug;
    let inserted = false;
    let lastError: unknown;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        this.db
          .prepare(
            `INSERT INTO workspaces (id, name, slug, description, icon, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(id, data.name, candidateSlug, data.description ?? null, data.icon ?? "📁", now, now);

        inserted = true;
        break;
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        const isSlugCollision =
          message.includes("UNIQUE") &&
          (message.includes("workspaces.slug") || message.includes("workspaces.slug".replace(".", "_")) || message.includes("slug"));

        if (isSlugCollision && attempt < 2) {
          candidateSlug = `${baseSlug}-${randomUUID().slice(0, 4)}`;
          continue;
        }

        throw new Error(`Failed to create workspace (name: \"${data.name}\", slug: \"${candidateSlug}\"): ${message}`);
      }
    }

    if (!inserted) {
      const detail = lastError instanceof Error ? lastError.message : String(lastError);
      throw new Error(`Failed to create workspace (name: \"${data.name}\", slug: \"${candidateSlug}\"): ${detail}`);
    }

    const workspace = this.getWorkspace(id);
    if (!workspace) {
      throw new Error(`Failed to create workspace (name: \"${data.name}\", slug: \"${candidateSlug}\"): record not found after insert`);
    }
    return workspace;
  }

  updateWorkspace(id: string, data: UpdateWorkspaceInput): WorkspaceRecord | undefined {
    const fields: Record<string, unknown> = {
      name: data.name,
      slug: data.slug === undefined ? undefined : generateSlug(data.slug),
      description: data.description,
      icon: data.icon,
    };

    const hasUpdates = Object.values(fields).some((value) => value !== undefined);
    if (!hasUpdates) {
      return this.getWorkspace(id);
    }

    const { sql, values } = this.buildDynamicUpdate(fields);
    this.db.prepare(`UPDATE workspaces SET ${sql} WHERE id = ?`).run(...values, id);
    return this.getWorkspace(id);
  }

  deleteWorkspace(id: string): boolean {
    const result = this.db.prepare("DELETE FROM workspaces WHERE id = ?").run(id);
    return result.changes > 0;
  }

  listActivities(taskId: string, limit?: number, offset?: number): TaskActivityRecord[] {
    const pagination = this.normalizePagination(limit, offset);
    return this.db
      .prepare(
        "SELECT * FROM task_activities WHERE task_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?"
      )
      .all(taskId, pagination.limit, pagination.offset) as TaskActivityRecord[];
  }

  createActivity(data: CreateActivityInput): TaskActivityRecord {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO task_activities (id, task_id, agent_id, activity_type, message, metadata)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        data.task_id,
        data.agent_id ?? null,
        data.activity_type,
        data.message,
        data.metadata ?? null
      );

    return this.db
      .prepare("SELECT * FROM task_activities WHERE id = ?")
      .get(id) as TaskActivityRecord;
  }

  listDeliverables(taskId: string, limit?: number, offset?: number): TaskDeliverableRecord[] {
    const pagination = this.normalizePagination(limit, offset);
    return this.db
      .prepare(
        "SELECT * FROM task_deliverables WHERE task_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?"
      )
      .all(taskId, pagination.limit, pagination.offset) as TaskDeliverableRecord[];
  }

  createDeliverable(data: CreateDeliverableInput): TaskDeliverableRecord {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO task_deliverables (id, task_id, deliverable_type, title, path, description)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        data.task_id,
        data.deliverable_type,
        data.title,
        data.path ?? null,
        data.description ?? null
      );

    return this.db
      .prepare("SELECT * FROM task_deliverables WHERE id = ?")
      .get(id) as TaskDeliverableRecord;
  }

  listEvents(limit = 100, since?: string, offset = 0): EventRecord[] {
    const pagination = this.normalizePagination(limit, offset);
    if (since) {
      return this.db
        .prepare(
          "SELECT * FROM events WHERE created_at > ? ORDER BY created_at DESC LIMIT ? OFFSET ?"
        )
        .all(since, pagination.limit, pagination.offset) as EventRecord[];
    }
    return this.db
      .prepare("SELECT * FROM events ORDER BY created_at DESC LIMIT ? OFFSET ?")
      .all(pagination.limit, pagination.offset) as EventRecord[];
  }

  createEvent(data: CreateEventInput): EventRecord {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO events (id, type, agent_id, task_id, message, metadata)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        data.type,
        data.agent_id ?? null,
        data.task_id ?? null,
        data.message,
        data.metadata ?? null
      );

    return this.db.prepare("SELECT * FROM events WHERE id = ?").get(id) as EventRecord;
  }

  getTriageState(taskId: string): Record<string, unknown> | null {
    const row = this.db.prepare("SELECT triage_state FROM tasks WHERE id = ?").get(taskId) as
      | { triage_state: string | null }
      | undefined;
    if (!row || !row.triage_state) {
      return null;
    }

    try {
      return JSON.parse(row.triage_state) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  updateTriageState(taskId: string, data: Record<string, unknown>): Record<string, unknown> {
    let current: Record<string, unknown> = {};
    try {
      current = this.getTriageState(taskId) ?? {};
    } catch {
      current = {};
    }

    if (typeof data.questionId === "string" && typeof data.answer === "string") {
      const questions = Array.isArray(current.questions) ? current.questions as Record<string, unknown>[] : [];
      const q = questions.find((q) => q.id === data.questionId);
      if (q) {
        q.answer = data.answer;
        q.answered = true;
        q.answered_at = new Date().toISOString();
      }
      const allAnswered = questions.every((q) => q.answer || q.answered);
      const next = { ...current, questions, updated_at: new Date().toISOString(), ...(allAnswered ? { status: "answered" } : {}) };
      const triageStateJson = JSON.stringify(next);
      this.db
        .prepare("UPDATE tasks SET triage_state = ?, updated_at = ? WHERE id = ?")
        .run(triageStateJson, new Date().toISOString(), taskId);
      return next;
    }

    const next = { ...current, ...data, updated_at: new Date().toISOString() };

    let triageStateJson: string;
    try {
      triageStateJson = JSON.stringify(next);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to update triage state for task ${taskId}: ${detail}`);
    }

    this.db
      .prepare("UPDATE tasks SET triage_state = ?, updated_at = ? WHERE id = ?")
      .run(triageStateJson, new Date().toISOString(), taskId);

    return next;
  }

  replaceTriageState(taskId: string, data: Record<string, unknown>): Record<string, unknown> {
    let triageStateJson: string;
    try {
      triageStateJson = JSON.stringify(data);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to replace triage state for task ${taskId}: ${detail}`);
    }

    this.db
      .prepare("UPDATE tasks SET triage_state = ?, updated_at = ? WHERE id = ?")
      .run(triageStateJson, new Date().toISOString(), taskId);
    return data;
  }

  listSessions(taskId?: string, limit?: number, offset?: number): SessionRecord[] {
    const pagination = this.normalizePagination(limit, offset);

    if (taskId) {
      return this.db
        .prepare(
          "SELECT * FROM openclaw_sessions WHERE task_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?"
        )
        .all(taskId, pagination.limit, pagination.offset) as SessionRecord[];
    }
    return this.db
      .prepare("SELECT * FROM openclaw_sessions ORDER BY created_at DESC LIMIT ? OFFSET ?")
      .all(pagination.limit, pagination.offset) as SessionRecord[];
  }

  createSession(data: CreateSessionInput): SessionRecord {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO openclaw_sessions (
          id, agent_id, openclaw_session_id, channel, status, session_type,
          task_id, ended_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        data.agent_id ?? null,
        data.openclaw_session_id,
        data.channel ?? null,
        data.status ?? "active",
        data.session_type ?? "persistent",
        data.task_id ?? null,
        data.ended_at ?? null,
        now,
        now
      );

    return this.db
      .prepare("SELECT * FROM openclaw_sessions WHERE id = ?")
      .get(id) as SessionRecord;
  }

  clearBlockingActivities(taskId: string): void {
    this.db.prepare(
      `DELETE FROM task_activities WHERE task_id = ? AND (
        message LIKE '%Manual intervention%' OR message LIKE '%spawning agents%'
      )`
    ).run(taskId);
  }

  close(): void {
    this.db.close();
  }
}
