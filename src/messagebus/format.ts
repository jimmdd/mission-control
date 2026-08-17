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

/**
 * Render an event as chat text. Plain text, no Markdown/mrkdwn: arbitrary agent output
 * (backticks, underscores, stray asterisks) must never turn into a Telegram 400 or a
 * mangled Slack message.
 */
export function formatEvent(event: McEvent): string {
  const { title, message } = describe(event);
  const emoji = EMOJI[event.type] ?? "•";
  const taskId = typeof event.taskId === "string" ? event.taskId : "";
  const body = message.trim();
  const lines = [`${emoji} ${title}`];
  if (body) lines.push(body);
  // The short id is what every command takes as a ref, so the reply is actionable.
  if (taskId) lines.push(`↳ ${taskId.slice(0, 8)} · reply /task ${taskId.slice(0, 8)}`);
  return lines.join("\n");
}
