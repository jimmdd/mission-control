// The command layer: chat text in, reply text out.
//
// Transport-agnostic by construction — nothing here knows whether the reply is going
// to Telegram or Slack, which is what lets a third surface (or an autonomous operator)
// reuse it later. Every command drives the EXISTING local HTTP API rather than the DB,
// so the side effects a click in the dashboard would have (relaunching an agent on
// feedback, resuming a task on checkpoint approval, rolling up delegation on done)
// happen identically from chat.
import type { SurfaceKind } from "./types.js";
import { randomUUID } from "node:crypto";
import { linearKey, normalizeRef, takeRef, taskLabel, taskTitle } from "./ref.js";

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
  /** Stable transport delivery id, used to make create-ticket retries idempotent. */
  requestId?: string;
}

type TaskRecord = Record<string, unknown>;

const FOLLOWUP_ACTIONS = ["review_comments", "merge_conflicts", "ci_lint", "rebuild_design"];

const HELP = [
  "Mission Control commands",
  "",
  "/status — board counts, what needs you",
  "/create [TEAM] <title> | <description> — create a linked MC + Linear ticket; include one GitHub PR URL to continue it",
  "/tasks [status] — list tickets (default: the ones needing attention)",
  "/search <words> — keyword search over key, title and description",
  "/task <ref> — one ticket: status, open questions, last activity",
  "/answer <ref> <text> — answer the next triage question, or leave feedback on a ticket in review",
  "/confirm <ref> — confirm triage once every question is answered (starts the work)",
  "/checkpoints — pending approvals, numbered",
  "/approve [ref] [note] — approve: /approve MET-639, or /approve 2 from the list, or bare when only one is pending",
  "/deny <ref> <reason> — reject it, with the reason the agent should act on",
  "/followup <ref> <action> — queue a canned follow-up and relaunch:",
  `    ${FOLLOWUP_ACTIONS.join(", ")}`,
  "/preview <ref> — start a local preview of the ticket's branch",
  "/hold <ref> — pause a ticket without deleting its plan, history, branch, or worktree",
  "/unhold <ref> — return a held ticket to the inbox for dispatch",
  "/done <ref> [reason] — mark a ticket done",
  "/agents — agent roster and what each is on",
  "",
  "A ref is a Linear key — MET-639, or just \"met 639\" — or a bit of the title.",
  "",
  "Or just talk: ask \"what's blocked?\" or say \"tell 639 to use UTC\" and I'll answer,",
  "or propose the command and wait for your /yes.",
].join("\n");

// Statuses shown by a bare /tasks: the ones where a human is the bottleneck.
const ATTENTION_STATUSES = ["inbox", "planning", "review", "testing", "on_hold"];

// The full set, so /tasks can tell "is this a status filter or a search?" apart.
const ALL_STATUSES = new Set([
  "pending_dispatch",
  "planning",
  "inbox",
  "assigned",
  "in_progress",
  "testing",
  "review",
  "on_hold",
  "done",
]);

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value.filter((v) => v && typeof v === "object") as Record<string, unknown>[]) : [];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
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

function matchesLinearKey(task: TaskRecord, key: string): boolean {
  return linearKey(task) === key.toUpperCase();
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
  const needle = normalizeRef(ref);
  if (!needle) return { error: "Which ticket? Add a ref, e.g. /task MET-639" };
  const tasks = asArray(await api.get("/tasks"));
  if (tasks.length === 0) return { error: "No tasks on the board." };

  const exact = tasks.find((t) => str(t.id) === needle);
  if (exact) return { task: exact };

  const candidates: Record<string, unknown>[][] = [];
  // Linear key first: it is what people actually type.
  if (/^[A-Za-z]{2,}-\d+$/.test(needle)) {
    candidates.push(tasks.filter((t) => matchesLinearKey(t, needle)));
  }
  if (needle.length >= 4) {
    candidates.push(tasks.filter((t) => str(t.id).toLowerCase().startsWith(needle.toLowerCase())));
  }
  candidates.push(tasks.filter((t) => str(t.title).toLowerCase().includes(needle.toLowerCase())));

  for (const round of candidates) {
    if (round.length === 1) return { task: round[0] };
    if (round.length > 1) {
      const lines = round.slice(0, 6).map((t) => `  ${taskLabel(t)} · ${taskTitle(t).slice(0, 60)}`);
      const more = round.length > 6 ? [`  … and ${round.length - 6} more`] : [];
      return {
        error: [`"${ref.trim()}" matches ${round.length} tickets — name one:`, ...lines, ...more].join("\n"),
      };
    }
  }
  return { error: `No ticket matches "${ref.trim()}".` };
}

function describeTask(task: TaskRecord): string {
  const triage = parseTriage(task);
  const questions = triageQuestions(triage);
  const unanswered = questions.filter((q) => !str(q.answer).trim());
  const lines = [
    `${taskLabel(task)} · ${str(task.status)} · ${str(task.priority)}`,
    taskTitle(task),
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
      waiting.length ? ` (${waiting.slice(0, 5).map((t) => taskLabel(t)).join(", ")})` : ""
    }`,
  ].join("\n");
}

async function cmdCreate(ctx: CommandContext, rest: string): Promise<string> {
  let input = rest.trim();
  if (!input) return "Usage: /create [MET] <title> | <description>";

  let teamKey = "";
  const team = /^\[([A-Za-z][A-Za-z0-9_-]{1,15})\]\s*/.exec(input);
  if (team) {
    teamKey = team[1].toUpperCase();
    input = input.slice(team[0].length).trim();
  }

  const divider = input.indexOf("|");
  const title = (divider >= 0 ? input.slice(0, divider) : input).trim();
  const description = divider >= 0 ? input.slice(divider + 1).trim() : "";
  if (!title) return "Usage: /create [MET] <title> | <description>";
  if (title.length > 255) return "The Linear title must be 255 characters or fewer; put the rest after | as the description.";

  const result = asRecord(await ctx.api.post("/linear/issues", {
    title,
    description,
    ...(teamKey ? { team_key: teamKey } : {}),
    request_id: ctx.requestId ?? randomUUID(),
    actor: ctx.actor,
  }));
  const issue = asRecord(result.issue);
  const task = asRecord(result.task);
  if (!issue.identifier || !issue.url || !task.id) throw new Error("ticket creation returned an incomplete link");
  return [
    `${result.created === false ? "Already created" : "Created"} ${str(issue.identifier)} · ${taskTitle(task) || title}`,
    str(issue.url),
    "Mission Control is linked and will triage it now.",
  ].join("\n");
}

function listLines(tasks: Record<string, unknown>[], limit = 20): string {
  const lines = tasks.slice(0, limit).map((t) => `${taskLabel(t)} · ${str(t.status)} · ${taskTitle(t).slice(0, 60)}`);
  const more = tasks.length > limit ? `\n… ${tasks.length - limit} more` : "";
  return `${lines.join("\n")}${more}`;
}

/**
 * `/tasks` with no argument shows what is waiting on a human; with a status it filters;
 * with anything else it searches, because "/tasks metalex" is obviously a search and
 * answering "no tasks with status metalex" would be pedantry.
 */
async function cmdTasks(ctx: CommandContext, rest: string): Promise<string> {
  const arg = rest.trim().toLowerCase();
  if (arg && !ALL_STATUSES.has(arg)) return cmdSearch(ctx, rest);

  const tasks = asArray(await ctx.api.get("/tasks"));
  const wanted = arg
    ? tasks.filter((t) => str(t.status).toLowerCase() === arg)
    : tasks.filter((t) => ATTENTION_STATUSES.includes(str(t.status)));
  if (wanted.length === 0) {
    return arg ? `No tickets are ${arg}.` : "Nothing waiting on you.";
  }
  return `${arg ? `${wanted.length} ${arg}` : `${wanted.length} needing attention`}:\n${listLines(wanted)}`;
}

/**
 * Keyword search over key, title and description — every word must appear somewhere, so
 * adding words narrows. Title hits rank above description-only hits, and open tickets
 * above closed ones, since a search is nearly always about live work.
 */
async function cmdSearch(ctx: CommandContext, rest: string): Promise<string> {
  const query = rest.trim();
  if (!query) return "Search for what? e.g. /search metalex validation";
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const tasks = asArray(await ctx.api.get("/tasks"));

  const scored: Array<{ task: Record<string, unknown>; score: number }> = [];
  for (const task of tasks) {
    const label = taskLabel(task).toLowerCase();
    const title = `${label} ${taskTitle(task)}`.toLowerCase();
    const haystack = `${title} ${str(task.description)}`.toLowerCase();
    if (!words.every((w) => haystack.includes(w))) continue;
    let score = words.every((w) => title.includes(w)) ? 2 : 0;
    if (str(task.status) !== "done") score += 1;
    scored.push({ task, score });
  }
  if (scored.length === 0) return `Nothing matches "${query}".`;

  scored.sort((a, b) => b.score - a.score);
  const hits = scored.map((s) => s.task);
  const open = hits.filter((t) => str(t.status) !== "done").length;
  return [
    `${hits.length} match "${query}" (${open} open):`,
    listLines(hits, 15),
    hits.length === 1 ? "" : "\nName one to act on it, e.g. /task MET-639",
  ]
    .filter(Boolean)
    .join("\n");
}

async function cmdTask(ctx: CommandContext, rest: string): Promise<string> {
  const { task, error } = await resolveTask(ctx.api, rest);
  if (!task) return error ?? "Not found.";
  // listActivities returns newest first, so the head of the list is the recent end.
  const activities = asArray(await ctx.api.get(`/tasks/${str(task.id)}/activities`));
  const latest = activities.slice(0, 3).map((a) => `  ${str(a.activity_type)}: ${str(a.message).slice(0, 160)}`);
  return [describeTask(task), latest.length ? `recent:\n${latest.join("\n")}` : ""].filter(Boolean).join("\n");
}

/**
 * One verb for "here is my input", because that is how it feels in chat: if triage is
 * waiting on a question, this answers the next one; otherwise it lands as feedback of
 * the type that ticket's status implies — exactly what the dashboard's note box does
 * (planning → planning_answer, review/testing → manual_feedback, else updated).
 */
async function cmdAnswer(ctx: CommandContext, rest: string): Promise<string> {
  const { ref, rest: text } = takeRef(rest);
  if (!ref) return "Usage: /answer MET-639 <your answer>";
  if (!text) return "Nothing to say? Usage: /answer MET-639 <your answer>";

  const { task, error } = await resolveTask(ctx.api, ref);
  if (!task) return error ?? "Not found.";
  return submitTaskInput(ctx, task, text);
}

/**
 * Route human input into the same triage/feedback path regardless of whether it was
 * addressed with `/answer` in a DM or arrived as a reply in a linked Slack thread.
 */
export async function submitTaskInput(
  ctx: CommandContext,
  task: TaskRecord,
  text: string,
): Promise<string> {
  const taskId = str(task.id);
  const label = taskLabel(task);
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
      ? `${label} — answered "${asked}".\nAll ${questions.length} questions answered — send /confirm ${label} to start the work.`
      : `${label} — answered "${asked}".\n${remaining} question(s) left — /task ${label} to see the next one.`;
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
    ? `Feedback logged on ${label} — the bridge will relaunch the agent with it.`
    : `Logged on ${label} as ${activityType}.`;
}

async function cmdConfirm(ctx: CommandContext, rest: string): Promise<string> {
  const { task, error } = await resolveTask(ctx.api, rest);
  if (!task) return error ?? "Not found.";
  const triage = parseTriage(task);
  const questions = triageQuestions(triage);
  const label = taskLabel(task);
  if (!triage || questions.length === 0) return `${label} has no triage questions to confirm.`;
  const unanswered = questions.filter((q) => !str(q.answer).trim());
  if (unanswered.length) {
    return `${unanswered.length} question(s) still unanswered — /answer ${label} <text> first.`;
  }
  triage.confirmed = true;
  triage.status = "answered";
  await ctx.api.patch(`/tasks/${str(task.id)}`, { triage_state: JSON.stringify(triage) });
  return `Triage confirmed on ${label} — the bridge will dispatch the agent.`;
}

/**
 * Pending checkpoints, joined to their tickets so each one reads as "MET-639 · <what
 * the agent is asking>" rather than a checkpoint UUID nobody can place.
 */
async function pendingCheckpoints(
  ctx: CommandContext,
): Promise<Array<{ id: string; label: string; kind: string; prompt: string; options: string }>> {
  const [pending, tasks] = await Promise.all([ctx.api.get("/checkpoints"), ctx.api.get("/tasks")]);
  const byId = new Map(asArray(tasks).map((t) => [str(t.id), t]));
  return asArray(pending).map((c) => {
    const task = byId.get(str(c.task_id));
    return {
      id: str(c.id),
      label: task ? taskLabel(task) : shortId(c.task_id),
      kind: str(c.kind),
      prompt: str(c.prompt),
      options: str(c.options),
    };
  });
}

async function cmdCheckpoints(ctx: CommandContext): Promise<string> {
  const pending = await pendingCheckpoints(ctx);
  if (pending.length === 0) return "No pending approvals.";
  const lines = pending.slice(0, 10).map((c, i) =>
    [
      `${i + 1}. ${c.label} · ${c.kind}`,
      `   ${c.prompt.slice(0, 240)}`,
      c.options ? `   options: ${c.options.slice(0, 120)}` : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
  return [
    `${pending.length} pending:`,
    ...lines,
    "",
    "Approve with the ticket or the number: /approve MET-639 · /deny 2 wrong repo",
  ].join("\n");
}

/**
 * Accept the three things a person might reasonably say: the ticket it belongs to, its
 * position in the last listing, or nothing at all when only one is pending.
 */
async function resolveCheckpoint(
  ctx: CommandContext,
  ref: string,
): Promise<{ id?: string; label?: string; prompt?: string; error?: string }> {
  const pending = await pendingCheckpoints(ctx);
  if (pending.length === 0) return { error: "No pending approvals." };
  const pick = (c: (typeof pending)[number]) => ({ id: c.id, label: c.label, prompt: c.prompt });

  if (!ref) {
    // Zero-ref is only safe when there is exactly one thing it could mean.
    if (pending.length === 1) return pick(pending[0]);
    return { error: `${pending.length} pending — say which: /checkpoints to list them.` };
  }

  if (/^\d{1,2}$/.test(ref)) {
    const index = Number(ref) - 1;
    if (index >= 0 && index < pending.length) return pick(pending[index]);
    return { error: `There is no #${ref} — ${pending.length} pending. /checkpoints to list them.` };
  }

  const key = normalizeRef(ref).toUpperCase();
  const byTask = pending.filter((c) => c.label.toUpperCase() === key);
  if (byTask.length === 1) return pick(byTask[0]);
  if (byTask.length > 1) {
    return { error: `${key} has ${byTask.length} pending approvals — use the number from /checkpoints.` };
  }

  const byId = pending.filter((c) => c.id.toLowerCase().startsWith(ref.toLowerCase()));
  if (byId.length === 1) return pick(byId[0]);
  return { error: `No pending approval matches "${ref}". /checkpoints to list them.` };
}

/**
 * Does this start with a ref, or is it all reason?
 *
 * "/deny wrong repo" must deny the single pending item with reason "wrong repo", while
 * "/deny met 639 wrong repo" must target MET-639. So a ref has to be recognisable in
 * itself — a list number, a Linear key (however spaced), or an id prefix — and an
 * ordinary word is treated as prose, not as a ticket nobody can match.
 */
function looksLikeCheckpointRef(tokens: string[]): boolean {
  if (tokens.length === 0) return false;
  const [first, second] = tokens;
  if (/^\d{1,2}$/.test(first)) return true;
  if (/^[A-Za-z]{2,}[-_]?\d+$/.test(first)) return true;
  if (/^[A-Za-z]{2,}$/.test(first) && second !== undefined && /^\d+$/.test(second)) return true;
  return /^[0-9a-f]{4,}(-[0-9a-f]+)*$/i.test(first);
}

async function cmdResolveCheckpoint(ctx: CommandContext, rest: string, decision: "approve" | "reject"): Promise<string> {
  const tokens = rest.trim().split(/\s+/).filter(Boolean);
  const { ref, rest: note } = looksLikeCheckpointRef(tokens) ? takeRef(rest) : { ref: "", rest: rest.trim() };
  // A denial without a reason is useless to the agent that has to act on it.
  if (decision === "reject" && !note) return "Usage: /deny MET-639 <reason> — the reason is what the agent acts on.";

  const { id, label, prompt, error } = await resolveCheckpoint(ctx, ref);
  if (!id) return error ?? "Not found.";
  await ctx.api.post(`/checkpoints/${id}/resolve`, { decision, response: note || undefined });
  // Echo what was actually resolved: if a list number pointed somewhere unexpected, the
  // prompt in the reply is what makes that visible immediately.
  return [
    `${decision === "approve" ? "Approved" : "Denied"} on ${label}: "${(prompt ?? "").slice(0, 140)}"`,
    note ? `Note: ${note}` : "",
    "The agent resumes from here.",
  ]
    .filter(Boolean)
    .join("\n");
}

async function cmdFollowup(ctx: CommandContext, rest: string): Promise<string> {
  const parts = rest.trim().split(/\s+/).filter(Boolean);
  const action = parts.find((p) => FOLLOWUP_ACTIONS.includes(p.toLowerCase()))?.toLowerCase();
  if (!action) return `Usage: /followup MET-639 <action>\nactions: ${FOLLOWUP_ACTIONS.join(", ")}`;
  const ref = parts.filter((p) => p.toLowerCase() !== action).join(" ");
  const { task, error } = await resolveTask(ctx.api, ref);
  if (!task) return error ?? "Not found.";
  await ctx.api.post(`/tasks/${str(task.id)}/followup`, { action });
  return `Queued ${action.replace(/_/g, " ")} on ${taskLabel(task)} — relaunching the agent on its worktree.`;
}

async function cmdPreview(ctx: CommandContext, rest: string): Promise<string> {
  const { task, error } = await resolveTask(ctx.api, rest);
  if (!task) return error ?? "Not found.";
  const state = (await ctx.api.post(`/tasks/${str(task.id)}/preview`, {})) as Record<string, unknown>;
  const url = str(state?.url);
  return url ? `Preview up for ${taskLabel(task)}: ${url}` : `Preview started for ${taskLabel(task)}.`;
}

async function cmdHold(ctx: CommandContext, rest: string): Promise<string> {
  const { task, error } = await resolveTask(ctx.api, rest);
  if (!task) return error ?? "Not found.";
  const label = taskLabel(task);
  if (task.status === "on_hold") return `${label} is already on hold.`;
  if (task.status === "done") return `${label} is done; completed tickets cannot be put on hold.`;
  await ctx.api.patch(`/tasks/${str(task.id)}`, { status: "on_hold" });
  return `Put ${label} on hold. Its plan, history, branch, and worktree are preserved.`;
}

async function cmdUnhold(ctx: CommandContext, rest: string): Promise<string> {
  const { task, error } = await resolveTask(ctx.api, rest);
  if (!task) return error ?? "Not found.";
  const label = taskLabel(task);
  if (task.status === "done") return `${label} is done; completed tickets cannot be resumed.`;
  if (task.status !== "on_hold") return `${label} is ${str(task.status) || "not on hold"}; only held tickets can be resumed.`;
  await ctx.api.patch(`/tasks/${str(task.id)}`, { status: "inbox" });
  return `Resumed ${label} — moved it back to the inbox for dispatch.`;
}

async function cmdDone(ctx: CommandContext, rest: string): Promise<string> {
  const { ref, rest: reason } = takeRef(rest);
  const { task, error } = await resolveTask(ctx.api, ref);
  if (!task) return error ?? "Not found.";
  const label = taskLabel(task);
  const result = (await ctx.api.post(`/tasks/${str(task.id)}/done`, reason ? { reason } : {})) as Record<string, unknown>;
  return result?.alreadyDone
    ? `${label} was already done.`
    : `Marked ${label} done${reason ? ` — "${reason}"` : ""}.`;
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
  "create",
  "tasks",
  "task",
  "search",
  "find",
  "answer",
  "confirm",
  "checkpoints",
  "approve",
  "deny",
  "reject",
  "followup",
  "preview",
  "hold",
  "unhold",
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
      case "create":
        return await cmdCreate(ctx, parsed.rest);
      case "tasks":
        return await cmdTasks(ctx, parsed.rest);
      case "search":
      case "find":
        return await cmdSearch(ctx, parsed.rest);
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
      case "hold":
        return await cmdHold(ctx, parsed.rest);
      case "unhold":
        return await cmdUnhold(ctx, parsed.rest);
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
