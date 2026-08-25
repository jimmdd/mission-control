// The conversational half of the chat interface (Telegram only).
//
// Commands are exact; this is for everything else — "what's blocked?", "why did MET-639
// stall?", "tell 639 to use UTC". The model never touches the board directly: it answers
// from a board snapshot, and when the ask implies an action it proposes one of the
// EXISTING commands, which then runs through the same command layer a typed command
// would. That is the safety property — ticket text can say whatever it likes, but the
// only way to a write is a command a human confirmed.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCommand, type ApiClient } from "./commands.js";
import { taskLabel, taskTitle } from "./ref.js";
import type { Logger } from "./types.js";

// Commands that only read. These run straight away — asking "confirm?" before showing a
// list is friction with no safety value.
const READ_ONLY = new Set(["help", "status", "tasks", "task", "search", "find", "checkpoints", "agents"]);

// Anything that changes the board. Always confirmed by a human first.
const WRITES = new Set(["create", "answer", "confirm", "approve", "deny", "reject", "followup", "preview", "hold", "unhold", "done"]);

const SYSTEM = `You are the Mission Control assistant, reached over a private Telegram DM by the single
operator who runs this instance. Mission Control orchestrates coding agents against real repos.

You answer from BOARD CONTEXT provided in the user message. Never invent ticket keys, statuses or
facts that are not in it. If the context does not contain the answer, say so plainly and suggest
which command would fetch it.

Tickets are named by Linear key (MET-639). Refer to them that way, never by UUID.

When the operator asks you to DO something, do not describe it — propose exactly one command:

  /status                          board counts, what needs a human
  /create [TEAM] <title> | <desc>  create a linked Mission Control + Linear ticket; one GitHub PR URL makes it an existing-PR handoff
  /tasks [status]                  list tickets
  /search <words>                  keyword search over key, title, description
  /task <ref>                      one ticket in detail
  /answer <ref> <text>             answer the next triage question, or leave feedback on a
                                   ticket in review (this relaunches its agent)
  /confirm <ref>                   confirm triage — starts the work
  /checkpoints                     pending approvals
  /approve <ref|number> [note]     approve an approval gate
  /deny <ref|number> <reason>      reject one, with a reason
  /followup <ref> <action>          review_comments | merge_conflicts | ci_lint | rebuild_design
  /preview <ref>                   start a local preview of the branch
  /hold <ref>                      pause a ticket while preserving its work
  /unhold <ref>                    return a held ticket to the dispatch inbox
  /done <ref> [reason]             close a ticket
  /agents                          agent roster

Reply with JSON only, no prose outside it, no markdown fence:
{"reply": "<what you say to the operator>", "command": "<a command, or null>"}

Rules:
- One command at most. If several steps are needed, propose the first and say what follows.
- Put the human-readable intent in "reply" and keep it short — this is a chat message, not a report.
- Only set "command" when the operator wants something done or fetched. For a question you can
  answer from context, set it to null.
- Never propose /hold, /unhold, /done, /approve or /deny unless the operator clearly asked for that outcome.
- Quote the operator's own words when passing text to /answer. Do not rewrite their instruction.`;

export interface AssistantReply {
  reply: string;
  command: string | null;
}

export type LlmCall = (input: { system: string; prompt: string; maxTokens: number }) => Promise<string>;

function resolveScript(): string {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const inRepo = join(repoRoot, "swarm", "llm-call.py");
  if (existsSync(inRepo)) return inRepo;
  const mcHome = process.env.MC_HOME ?? join(homedir(), ".mission-control");
  return join(mcHome, "swarm", "llm-call.py");
}

function resolvePython(): string {
  const override = (process.env.MC_PYTHON_BIN ?? "").trim();
  if (override) return override;
  const mcHome = process.env.MC_HOME ?? join(homedir(), ".mission-control");
  const venv = join(mcHome, "venv-3.12", "bin", "python3");
  return existsSync(venv) ? venv : "python3";
}

/**
 * Default transport: swarm/llm-call.py, which routes through planner._call_llm so the
 * assistant uses whatever provider the swarm is configured for, with its OpenRouter
 * fallback intact.
 */
export function createLlmCall(logger?: Logger): LlmCall {
  return ({ system, prompt, maxTokens }) =>
    new Promise((resolve, reject) => {
      const child = spawn(resolvePython(), [resolveScript()], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env },
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("assistant timed out"));
      }, 60_000);

      child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
      child.on("error", (err) => { clearTimeout(timer); reject(err); });
      child.on("close", () => {
        clearTimeout(timer);
        // A thinking model spends budget before it emits anything, so a small cap comes
        // back with no content at all — never let the floor drop near that.
        const payload = stdout.trim().split("\n").filter(Boolean).at(-1) ?? "";
        try {
          const parsed = JSON.parse(payload) as { ok?: boolean; text?: string; error?: string };
          if (parsed.ok && typeof parsed.text === "string") {
            resolve(parsed.text);
            return;
          }
          reject(new Error(parsed.error || "no completion"));
        } catch {
          logger?.error(`[messagebus] assistant transport: ${stderr.slice(0, 300)}`);
          reject(new Error("assistant transport returned no JSON"));
        }
      });

      child.stdin.end(JSON.stringify({ system, prompt, role: "assistant", max_tokens: Math.max(maxTokens, 512) }));
    });
}

/**
 * A compact picture of the board: enough for the model to answer "what's blocked" or
 * name the right ticket, small enough to send on every message. Closed tickets are
 * omitted — /search reaches those when they are actually wanted.
 */
export async function boardSnapshot(api: ApiClient): Promise<string> {
  const [tasksRaw, checkpointsRaw] = await Promise.all([api.get("/tasks"), api.get("/checkpoints")]);
  const tasks = Array.isArray(tasksRaw) ? (tasksRaw as Record<string, unknown>[]) : [];
  const checkpoints = Array.isArray(checkpointsRaw) ? (checkpointsRaw as Record<string, unknown>[]) : [];

  const open = tasks.filter((t) => t.status !== "done");
  const lines: string[] = [`Open tickets (${open.length} of ${tasks.length} total):`];
  for (const task of open.slice(0, 40)) {
    let triage = "";
    try {
      const raw = task.triage_state;
      const state = typeof raw === "string" ? JSON.parse(raw) : raw;
      const questions = state && Array.isArray(state.questions) ? state.questions : [];
      if (questions.length) {
        const open_ = questions.filter((q: Record<string, unknown>) => !String(q?.answer ?? "").trim());
        triage = ` · triage ${questions.length - open_.length}/${questions.length}${
          state.confirmed ? " confirmed" : ""
        }`;
        if (open_.length) triage += ` · next question: ${String(open_[0]?.question ?? "").slice(0, 200)}`;
      }
    } catch {
      // unparseable triage state is simply not described
    }
    lines.push(`- ${taskLabel(task)} · ${String(task.status)} · ${taskTitle(task).slice(0, 80)}${triage}`);
  }

  if (checkpoints.length) {
    const byId = new Map(tasks.map((t) => [String(t.id), t]));
    lines.push(`Pending approvals (${checkpoints.length}):`);
    checkpoints.slice(0, 10).forEach((c, i) => {
      const task = byId.get(String(c.task_id));
      lines.push(`- #${i + 1} ${task ? taskLabel(task) : "?"} · ${String(c.prompt ?? "").slice(0, 160)}`);
    });
  } else {
    lines.push("Pending approvals: none");
  }
  return lines.join("\n");
}

function extractJson(text: string): AssistantReply | null {
  let body = text.trim();
  if (body.startsWith("```")) {
    body = body.replace(/^```[a-zA-Z]*\n?/, "").replace(/```\s*$/, "").trim();
  }
  // Models occasionally wrap JSON in a sentence; take the outermost object.
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(body.slice(start, end + 1)) as Record<string, unknown>;
    const reply = typeof parsed.reply === "string" ? parsed.reply.trim() : "";
    const raw = parsed.command;
    const command = typeof raw === "string" && raw.trim() && raw.trim().toLowerCase() !== "null" ? raw.trim() : null;
    if (!reply && !command) return null;
    return { reply, command };
  } catch {
    return null;
  }
}

export type ProposalKind = "none" | "read" | "write";

export interface AssistantOutcome {
  reply: string;
  command: string | null;
  kind: ProposalKind;
}

/**
 * Ask the model, then police what comes back: a proposed command must parse as a real
 * command, and is classified so writes can be gated behind a confirmation while reads
 * just run.
 */
export async function askAssistant(
  question: string,
  deps: { api: ApiClient; llm: LlmCall; logger?: Logger },
): Promise<AssistantOutcome> {
  const snapshot = await boardSnapshot(deps.api);
  const prompt = `BOARD CONTEXT\n${snapshot}\n\nOPERATOR SAID\n${question}`;
  const text = await deps.llm({ system: SYSTEM, prompt, maxTokens: 1024 });
  const parsed = extractJson(text);
  if (!parsed) {
    deps.logger?.error(`[messagebus] assistant returned unusable output: ${text.slice(0, 200)}`);
    return { reply: "I could not make sense of that. /help lists the commands I can run.", command: null, kind: "none" };
  }

  if (!parsed.command) return { reply: parsed.reply, command: null, kind: "none" };

  const command = parsed.command.startsWith("/") ? parsed.command : `/${parsed.command}`;
  const understood = parseCommand(command);
  if (!understood) {
    // A hallucinated command is dropped rather than echoed — offering a command that
    // does not exist would be worse than saying nothing about it.
    deps.logger?.error(`[messagebus] assistant proposed an unknown command: ${command.slice(0, 80)}`);
    return { reply: parsed.reply || "I am not sure which command does that. /help lists them.", command: null, kind: "none" };
  }
  if (READ_ONLY.has(understood.name)) return { reply: parsed.reply, command, kind: "read" };
  if (WRITES.has(understood.name)) return { reply: parsed.reply, command, kind: "write" };
  return { reply: parsed.reply, command: null, kind: "none" };
}
