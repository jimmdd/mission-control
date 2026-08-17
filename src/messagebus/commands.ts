// The command layer: chat text in, reply text out.
//
// Transport-agnostic by construction — nothing here knows whether the reply is going
// to Telegram or Slack, which is what lets a third surface (or an autonomous operator)
// reuse it later. Every command drives the EXISTING local HTTP API rather than the DB,
// so the side effects a click in the dashboard would have (relaunching an agent on
// feedback, resuming a task on checkpoint approval, rolling up delegation on done)
// happen identically from chat.
import type { SurfaceKind } from "./types.js";

export interface ApiClient {
  get(path: string): Promise<unknown>;
  post(path: string, body?: unknown): Promise<unknown>;
  patch(path: string, body?: unknown): Promise<unknown>;
}

export interface CommandContext {
  api: ApiClient;
  surface: SurfaceKind;
  /** Who is asking, e.g. "telegram:@jinglun" — recorded as activity metadata. */
  actor: string;
}

type TaskRecord = Record<string, unknown>;

const FOLLOWUP_ACTIONS = ["review_comments", "merge_conflicts", "ci_lint", "rebuild_design"];

const HELP = [
  "Mission Control commands",
  "",
  "/status — board counts, what needs you",
  "/tasks [status] — list tasks (default: the ones needing attention)",
  "/task <ref> — one ticket: status, open questions, last activity",
  "/answer <ref> <text> — answer the next triage question, or leave feedback on a ticket in review",
  "/confirm <ref> — confirm triage once every question is answered (starts the work)",
  "/checkpoints — pending approvals",
  "/approve [ref] [note] — approve a checkpoint (ref optional when only one is pending)",
  "/deny <ref> <reason> — reject a checkpoint",
  "/followup <ref> <action> — queue a canned follow-up and relaunch:",
  `    ${FOLLOWUP_ACTIONS.join(", ")}`,
  "/preview <ref> — start a local preview of the ticket's branch",
  "/done <ref> [reason] — mark a ticket done",
  "/agents — agent roster and what each is on",
  "",
  "A ref is a short task id (0e46593f), a Linear key (MET-639), or a bit of the title.",
].join("\n");

// Statuses shown by a bare /tasks: the ones where a human is the bottleneck.
const ATTENTION_STATUSES = ["inbox", "planning", "review", "testing", "on_hold"];

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value.filter((v) => v && typeof v === "object") as Record<string, unknown>[]) : [];
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function shortId(value: unknown): string {
  return str(value).slice(0, 8);
}

function parseTriage(task: TaskRecord): Record<string, unknown> | null {
  const raw = task.triage_state;
  if (!raw) return null;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function triageQuestions(triage: Record<string, unknown> | null): Record<string, unknown>[] {
  return triage ? asArray(triage.questions) : [];
}

/** The Linear key lives in the title prefix ("[MET-639] …") and the issue URL. */
function matchesLinearKey(task: TaskRecord, key: string): boolean {
  const upper = key.toUpperCase();
  return (
    str(task.title).toUpperCase().includes(`[${upper}]`) ||
    str(task.external_url).toUpperCase().includes(`/${upper}/`) ||
    str(task.external_url).toUpperCase().endsWith(`/${upper}`)
  );
}

interface ResolveOutcome {
  task?: TaskRecord;
  error?: string;
}

/**
 * Resolve a human-typed ref to exactly one task, in narrowing order: exact id, id
 * prefix, Linear key, then title substring. Ambiguity is reported rather than guessed —
 * acting on the wrong ticket is worse than one more message.
 */
export async function resolveTask(api: ApiClient, ref: string): Promise<ResolveOutcome> {
  const needle = ref.trim();
  if (!needle) return { error: "Which ticket? Add a ref: /task 0e46593f" };
  const tasks = asArray(await api.get("/tasks"));
  if (tasks.length === 0) return { error: "No tasks on the board." };

  const exact = tasks.find((t) => str(t.id) === needle);
  if (exact) return { task: exact };

  const candidates: Record<string, unknown>[][] = [];
  if (needle.length >= 4) {
    candidates.push(tasks.filter((t) => str(t.id).toLowerCase().startsWith(needle.toLowerCase())));
  }
  if (/^[A-Za-z]{2,}-\d+$/.test(needle)) {
    candidates.push(tasks.filter((t) => matchesLinearKey(t, needle)));
  }
  candidates.push(tasks.filter((t) => str(t.title).toLowerCase().includes(needle.toLowerCase())));

  for (const round of candidates) {
    if (round.length === 1) return { task: round[0] };
    if (round.length > 1) {
      const lines = round.slice(0, 6).map((t) => `  ${shortId(t.id)} · ${str(t.title).slice(0, 60)}`);
      return {
        error: [`"${needle}" matches ${round.length} tickets — be more specific:`, ...lines].join("\n"),
      };
    }
  }
  return { error: `No ticket matches "${needle}".` };
}

function describeTask(task: TaskRecord): string {
  const triage = parseTriage(task);
  const questions = triageQuestions(triage);
  const unanswered = questions.filter((q) => !str(q.answer).trim());
  const lines = [
    `${shortId(task.id)} · ${str(task.status)} · ${str(task.priority)}`,
    str(task.title),
  ];
  if (questions.length) {
    lines.push(
      `triage: ${questions.length - unanswered.length}/${questions.length} answered${
        triage && triage.confirmed ? " · confirmed" : ""
      }`,
    );
    const next = unanswered[0];
    if (next) lines.push(`next question: ${str(next.question).slice(0, 300)}`);
  }
  if (str(task.external_url)) lines.push(str(task.external_url));
  return lines.join("\n");
}

async function cmdStatus(ctx: CommandContext): Promise<string> {
  const [tasks, checkpoints] = await Promise.all([ctx.api.get("/tasks"), ctx.api.get("/checkpoints")]);
  const byStatus = new Map<string, number>();
  for (const task of asArray(tasks)) {
    const status = str(task.status) || "unknown";
    byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
  }
  const pending = asArray(checkpoints);
  const counts = [...byStatus.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([status, n]) => `${status} ${n}`)
    .join(" · ");
  const waiting = asArray(tasks).filter((t) => {
    const questions = triageQuestions(parseTriage(t));
    return questions.some((q) => !str(q.answer).trim());
  });
  return [
    `Board: ${counts || "empty"}`,
    `Pending approvals: ${pending.length}`,
    `Tickets with unanswered questions: ${waiting.length}${
      waiting.length ? ` (${waiting.slice(0, 5).map((t) => shortId(t.id)).join(", ")})` : ""
    }`,
  ].join("\n");
}

async function cmdTasks(ctx: CommandContext, rest: string): Promise<string> {
  const filter = rest.trim().toLowerCase();
  const tasks = asArray(await ctx.api.get("/tasks"));
  const wanted = filter
    ? tasks.filter((t) => str(t.status).toLowerCase() === filter)
    : tasks.filter((t) => ATTENTION_STATUSES.includes(str(t.status)));
  if (wanted.length === 0) {
    return filter ? `No tasks with status "${filter}".` : "Nothing waiting on you.";
  }
  const lines = wanted
    .slice(0, 20)
    .map((t) => `${shortId(t.id)} · ${str(t.status)} · ${str(t.title).slice(0, 60)}`);
  const header = filter ? `${wanted.length} ${filter}` : `${wanted.length} needing attention`;
  const more = wanted.length > 20 ? `\n… ${wanted.length - 20} more` : "";
  return `${header}:\n${lines.join("\n")}${more}`;
}

async function cmdTask(ctx: CommandContext, rest: string): Promise<string> {
  const { task, error } = await resolveTask(ctx.api, rest);
  if (!task) return error ?? "Not found.";
  const activities = asArray(await ctx.api.get(`/tasks/${str(task.id)}/activities`));
  const latest = activities.slice(-3).map((a) => `  ${str(a.activity_type)}: ${str(a.message).slice(0, 160)}`);
  return [describeTask(task), latest.length ? `recent:\n${latest.join("\n")}` : ""].filter(Boolean).join("\n");
}

/**
 * One verb for "here is my input", because that is how it feels in chat: if triage is
 * waiting on a question, this answers the next one; otherwise it lands as feedback of
 * the type that ticket's status implies — exactly what the dashboard's note box does
 * (planning → planning_answer, review/testing → manual_feedback, else updated).
 */
async function cmdAnswer(ctx: CommandContext, rest: string): Promise<string> {
  const [ref, ...words] = rest.trim().split(/\s+/);
  const text = words.join(" ").trim();
  if (!ref) return "Usage: /answer <ref> <your answer>";
  if (!text) return "Nothing to say? Usage: /answer <ref> <your answer>";

  const { task, error } = await resolveTask(ctx.api, ref);
  if (!task) return error ?? "Not found.";
  const taskId = str(task.id);
  const triage = parseTriage(task);
  const questions = triageQuestions(triage);
  const nextIndex = questions.findIndex((q) => !str(q.answer).trim());

  if (triage && nextIndex >= 0) {
    const question = questions[nextIndex];
    question.answer = text;
    question.answered = true;
    question.answered_by = "user";
    question.answered_via = ctx.surface;
    // Editing an answer un-confirms, same as the UI: the bridge must not proceed until
    // the human reviews the full set and confirms again.
    triage.confirmed = false;
    await ctx.api.patch(`/tasks/${taskId}`, { triage_state: JSON.stringify(triage) });
    const remaining = questions.filter((q) => !str(q.answer).trim()).length;
    const asked = str(question.question).slice(0, 120);
    return remaining === 0
      ? `Answered "${asked}".\nAll ${questions.length} questions answered — send /confirm ${shortId(taskId)} to start the work.`
      : `Answered "${asked}".\n${remaining} question(s) left — /task ${shortId(taskId)} to see the next one.`;
  }

  const status = str(task.status);
  const activityType =
    status === "planning" ? "planning_answer" : status === "review" || status === "testing" ? "manual_feedback" : "updated";
  await ctx.api.post(`/tasks/${taskId}/activities`, {
    activity_type: activityType,
    message: text,
    metadata: JSON.stringify({ source: "messagebus", surface: ctx.surface, actor: ctx.actor }),
  });
  return activityType === "manual_feedback"
    ? `Feedback logged on ${shortId(taskId)} — the bridge will relaunch the agent with it.`
    : `Logged on ${shortId(taskId)} as ${activityType}.`;
}

async function cmdConfirm(ctx: CommandContext, rest: string): Promise<string> {
  const { task, error } = await resolveTask(ctx.api, rest);
  if (!task) return error ?? "Not found.";
  const triage = parseTriage(task);
  const questions = triageQuestions(triage);
  if (!triage || questions.length === 0) return `${shortId(task.id)} has no triage questions to confirm.`;
  const unanswered = questions.filter((q) => !str(q.answer).trim());
  if (unanswered.length) {
    return `${unanswered.length} question(s) still unanswered — /answer ${shortId(task.id)} <text> first.`;
  }
  triage.confirmed = true;
  triage.status = "answered";
  await ctx.api.patch(`/tasks/${str(task.id)}`, { triage_state: JSON.stringify(triage) });
  return `Triage confirmed on ${shortId(task.id)} — the bridge will dispatch the agent.`;
}

async function cmdCheckpoints(ctx: CommandContext): Promise<string> {
  const pending = asArray(await ctx.api.get("/checkpoints"));
  if (pending.length === 0) return "No pending approvals.";
  const lines = pending.slice(0, 10).map((c) => {
    const options = str(c.options);
    return [
      `${shortId(c.id)} · ${str(c.kind)} · task ${shortId(c.task_id)}`,
      `  ${str(c.prompt).slice(0, 240)}`,
      options ? `  options: ${options.slice(0, 120)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  });
  return `${pending.length} pending:\n${lines.join("\n")}`;
}

async function resolveCheckpoint(
  ctx: CommandContext,
  ref: string,
): Promise<{ id?: string; error?: string }> {
  const pending = asArray(await ctx.api.get("/checkpoints"));
  if (pending.length === 0) return { error: "No pending approvals." };
  if (!ref) {
    // Zero-ref is only safe when there is exactly one thing it could mean.
    if (pending.length === 1) return { id: str(pending[0].id) };
    return { error: `${pending.length} pending — name one: /checkpoints to list them.` };
  }
  const matches = pending.filter((c) => str(c.id).toLowerCase().startsWith(ref.toLowerCase()));
  if (matches.length === 1) return { id: str(matches[0].id) };
  if (matches.length > 1) return { error: `"${ref}" matches ${matches.length} checkpoints — use more characters.` };
  return { error: `No pending checkpoint matches "${ref}".` };
}

async function cmdResolveCheckpoint(ctx: CommandContext, rest: string, decision: "approve" | "reject"): Promise<string> {
  const parts = rest.trim().split(/\s+/).filter(Boolean);
  // A denial without a reason is useless to the agent that has to act on it.
  const looksLikeRef = parts[0] && /^[0-9a-f-]{4,}$/i.test(parts[0]);
  const ref = looksLikeRef ? parts[0] : "";
  const note = (looksLikeRef ? parts.slice(1) : parts).join(" ").trim();
  if (decision === "reject" && !note) return "Usage: /deny <ref> <reason> — the reason is what the agent acts on.";

  const { id, error } = await resolveCheckpoint(ctx, ref);
  if (!id) return error ?? "Not found.";
  const result = await ctx.api.post(`/checkpoints/${id}/resolve`, {
    decision,
    response: note || undefined,
  });
  const checkpoint = result && typeof result === "object" ? (result as Record<string, unknown>).checkpoint : null;
  const taskId = checkpoint && typeof checkpoint === "object" ? shortId((checkpoint as Record<string, unknown>).task_id) : "";
  return `${decision === "approve" ? "Approved" : "Denied"} ${shortId(id)}${taskId ? ` on ${taskId}` : ""}${
    note ? ` — "${note}"` : ""
  }. The agent resumes from here.`;
}

async function cmdFollowup(ctx: CommandContext, rest: string): Promise<string> {
  const parts = rest.trim().split(/\s+/).filter(Boolean);
  const action = parts.find((p) => FOLLOWUP_ACTIONS.includes(p.toLowerCase()))?.toLowerCase();
  const ref = parts.filter((p) => p.toLowerCase() !== action).join(" ");
  if (!action) return `Usage: /followup <ref> <action>\nactions: ${FOLLOWUP_ACTIONS.join(", ")}`;
  const { task, error } = await resolveTask(ctx.api, ref);
  if (!task) return error ?? "Not found.";
  await ctx.api.post(`/tasks/${str(task.id)}/followup`, { action });
  return `Queued ${action.replace(/_/g, " ")} on ${shortId(task.id)} — relaunching the agent on its worktree.`;
}

async function cmdPreview(ctx: CommandContext, rest: string): Promise<string> {
  const { task, error } = await resolveTask(ctx.api, rest);
  if (!task) return error ?? "Not found.";
  const state = (await ctx.api.post(`/tasks/${str(task.id)}/preview`, {})) as Record<string, unknown>;
  const url = str(state?.url);
  return url ? `Preview up for ${shortId(task.id)}: ${url}` : `Preview started for ${shortId(task.id)}.`;
}

async function cmdDone(ctx: CommandContext, rest: string): Promise<string> {
  const [ref, ...words] = rest.trim().split(/\s+/);
  const { task, error } = await resolveTask(ctx.api, ref ?? "");
  if (!task) return error ?? "Not found.";
  const reason = words.join(" ").trim();
  const result = (await ctx.api.post(`/tasks/${str(task.id)}/done`, reason ? { reason } : {})) as Record<string, unknown>;
  return result?.alreadyDone
    ? `${shortId(task.id)} was already done.`
    : `Marked ${shortId(task.id)} done${reason ? ` — "${reason}"` : ""}.`;
}

async function cmdAgents(ctx: CommandContext): Promise<string> {
  const agents = asArray(await ctx.api.get("/agents"));
  if (agents.length === 0) return "No agents registered.";
  const lines = agents
    .slice(0, 20)
    .map((a) => `${str(a.avatar_emoji) || "🤖"} ${str(a.name)} · ${str(a.role)} · ${str(a.status)}`);
  return lines.join("\n");
}

export interface ParsedCommand {
  name: string;
  rest: string;
}

/**
 * Accepts "/status", "status", and Telegram's "/status@mc_bot" form. Returns null for
 * anything that does not look like a command so ordinary chatter is ignored rather
 * than answered with an error.
 */
export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const match = /^\/?([a-zA-Z]+)(?:@[\w_]+)?(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (!match) return null;
  const name = match[1].toLowerCase();
  if (!KNOWN_COMMANDS.has(name)) return null;
  return { name, rest: (match[2] ?? "").trim() };
}

const KNOWN_COMMANDS = new Set([
  "help",
  "start",
  "status",
  "tasks",
  "task",
  "answer",
  "confirm",
  "checkpoints",
  "approve",
  "deny",
  "reject",
  "followup",
  "preview",
  "done",
  "agents",
]);

/** Run a command and return the reply text. Never throws — errors come back as text. */
export async function executeCommand(text: string, ctx: CommandContext): Promise<string | null> {
  const parsed = parseCommand(text);
  if (!parsed) return null;
  try {
    switch (parsed.name) {
      case "help":
      case "start":
        return HELP;
      case "status":
        return await cmdStatus(ctx);
      case "tasks":
        return await cmdTasks(ctx, parsed.rest);
      case "task":
        return await cmdTask(ctx, parsed.rest);
      case "answer":
        return await cmdAnswer(ctx, parsed.rest);
      case "confirm":
        return await cmdConfirm(ctx, parsed.rest);
      case "checkpoints":
        return await cmdCheckpoints(ctx);
      case "approve":
        return await cmdResolveCheckpoint(ctx, parsed.rest, "approve");
      case "deny":
      case "reject":
        return await cmdResolveCheckpoint(ctx, parsed.rest, "reject");
      case "followup":
        return await cmdFollowup(ctx, parsed.rest);
      case "preview":
        return await cmdPreview(ctx, parsed.rest);
      case "done":
        return await cmdDone(ctx, parsed.rest);
      case "agents":
        return await cmdAgents(ctx);
      default:
        return HELP;
    }
  } catch (err) {
    return `Command failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}
