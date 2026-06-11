import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import type { McEvent, McEventBus } from "./events.js";

export interface Notification {
  type: string;
  taskId?: string;
  title: string;
  message: string;
  event: McEvent;
}

export type NotificationSink = (notification: Notification) => void | Promise<void>;

export interface NotifierOptions {
  // Custom sinks (used by tests); when omitted, sinks are built from
  // notifyScript + webhookUrl below.
  sinks?: NotificationSink[];
  notifyScript?: string;
  webhookUrl?: string;
  types?: Set<string>;
  cooldownMs?: number;
  logger?: { error: (message: string, ...args: unknown[]) => void };
}

// Events that warrant pinging a human. The agent pinged you — you don't have to
// be watching the board.
const HUMAN_RELEVANT = new Set(["needs_human", "awaiting_approval", "agent_exited", "agent_stalled"]);

function describe(event: McEvent): { title: string; message: string } {
  const id = typeof event.taskId === "string" ? event.taskId.slice(0, 8) : "";
  const detail = String(event.message ?? event.prompt ?? event.reason ?? "").trim();
  switch (event.type) {
    case "needs_human":
      return { title: `Task ${id} needs you`, message: detail || "An agent is blocked and needs human input." };
    case "awaiting_approval":
      return { title: `Approval needed on ${id}`, message: detail || "An agent is waiting for your decision." };
    case "agent_exited":
      return { title: `Agent exited on ${id}`, message: detail || "The agent session ended unexpectedly." };
    case "agent_stalled":
      return { title: `Agent stalled on ${id}`, message: detail || "The agent stopped sending heartbeats." };
    default:
      return { title: `Mission Control: ${event.type} (${id})`, message: detail };
  }
}

function buildDefaultSinks(opts: NotifierOptions): NotificationSink[] {
  const sinks: NotificationSink[] = [];
  const log = opts.logger;

  if (opts.notifyScript) {
    const script = opts.notifyScript;
    sinks.push((n) => {
      if (!existsSync(script)) return; // optional hook
      execFile(
        script,
        [n.title, n.message, JSON.stringify(n.event)],
        { timeout: 10_000 },
        (err) => {
          if (err) log?.error(`notify script failed: ${err.message}`);
        },
      );
    });
  }

  if (opts.webhookUrl) {
    const url = opts.webhookUrl;
    sinks.push(async (n) => {
      try {
        await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: n.title, message: n.message, type: n.type, taskId: n.taskId, event: n.event }),
          signal: AbortSignal.timeout(10_000),
        });
      } catch (err) {
        log?.error(`notify webhook failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  return sinks;
}

// Subscribes to the event bus and pushes human-relevant events to the configured
// channels (a local notify.sh hook and/or a webhook). Best-effort and
// rate-limited per (type, task) so a flapping condition cannot spam.
export function startNotifier(events: McEventBus, opts: NotifierOptions = {}): () => void {
  const types = opts.types ?? HUMAN_RELEVANT;
  const cooldownMs = opts.cooldownMs ?? 60_000;
  const sinks = opts.sinks ?? buildDefaultSinks(opts);
  const lastSent = new Map<string, number>();

  const unsubscribe = events.subscribe((event: McEvent) => {
    if (!types.has(event.type)) return;

    const key = `${event.type}:${typeof event.taskId === "string" ? event.taskId : ""}`;
    const now = Date.now();
    const prev = lastSent.get(key);
    if (prev !== undefined && now - prev < cooldownMs) return;
    lastSent.set(key, now);

    const { title, message } = describe(event);
    const notification: Notification = {
      type: event.type,
      taskId: typeof event.taskId === "string" ? event.taskId : undefined,
      title,
      message,
      event,
    };
    for (const sink of sinks) {
      try {
        void sink(notification);
      } catch (err) {
        opts.logger?.error(`notification sink threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });

  return unsubscribe;
}
