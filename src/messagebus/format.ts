// What reaches chat, and how it reads.
//
// The routing table is deliberately conservative: chat is an interrupt channel, so
// only events a human must act on (plus terminal milestones) get through by default.
// Everything about wording comes from notifier.describe() so the bus, the notify hook
// and the webhook never drift apart.
import type { McEvent } from "../events.js";
import { describe } from "../notifier.js";
import type { EventScope } from "./config.js";

// Always pushed — you get pinged without watching the board.
export const ACTION_TYPES = new Set([
  "needs_human",
  "awaiting_approval",
  "agent_exited",
  "agent_stalled",
  "new_triage_question",
  "task_completed",
]);

// Added only when the surface's event scope is "all" — lower-signal lifecycle events.
export const ALL_EXTRA = new Set([
  "delegated",
  "subtask_completed",
  "parent_resumed",
  "checkpoint_resolved",
  "objective_created",
  "objective_scope_approved",
]);

// Never pushed at any scope. progress/liveness fire constantly; settings_updated would
// echo back the very Settings edit that turned the bus on.
export const NEVER = new Set(["progress", "liveness", "settings_updated"]);

const EMOJI: Record<string, string> = {
  needs_human: "🔔",
  awaiting_approval: "🔔",
  new_triage_question: "🔔",
  agent_exited: "⚠️",
  agent_stalled: "⚠️",
  task_completed: "✅",
};

export function shouldSend(type: string, scope: EventScope): boolean {
  if (NEVER.has(type)) return false;
  if (ACTION_TYPES.has(type)) return true;
  return scope === "all" && ALL_EXTRA.has(type);
}

/** What the bus knows about the event's ticket, when it can look it up. */
export interface TaskContext {
  /** How a person names it: "MET-639", or the short id if it has no Linear key. */
  label: string;
  /** Title with any "[MET-639]" prefix stripped — the label already says that. */
  title?: string;
  url?: string;
}

/**
 * Render an event as chat text. Plain text, no Markdown/mrkdwn: arbitrary agent output
 * (backticks, underscores, stray asterisks) must never turn into a Telegram 400 or a
 * mangled Slack message.
 *
 * An alert has to answer "which ticket, and what do I do about it" on its own. A bare
 * UUID answers neither, so when the ticket can be resolved the message leads with its
 * Linear key and title, and the footer is a command that can be typed as-is.
 */
export function formatEvent(event: McEvent, task?: TaskContext): string {
  const shortId = typeof event.taskId === "string" ? event.taskId.slice(0, 8) : "";
  const label = task?.label ?? shortId;
  const { title, message } = describe(event, label || undefined);
  const emoji = EMOJI[event.type] ?? "•";
  const body = message.trim();

  // "Task MET-639 needs you" → "MET-639 needs you". The shared wording keeps the "Task"
  // prefix because a bare id needs it ("df544305 needs you" reads like nothing), but a
  // Linear key is already a name.
  const headline = task?.label ? title.replace(/^Task\s+/, "") : title;

  const lines = [`${emoji} ${headline}`];
  if (task?.title) lines.push(task.title);
  if (body) lines.push(body);
  if (task?.url) lines.push(task.url);
  if (label) lines.push(`↳ /task ${label}`);
  return lines.join("\n");
}
