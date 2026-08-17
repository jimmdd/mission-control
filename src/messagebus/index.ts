// The message bus: Mission Control's chat interface.
//
// Outbound, it subscribes to the same in-process event bus the dashboard and notifier
// use and pushes action-required events to every configured surface. Inbound, it holds
// a listener per surface (Telegram long-poll, Slack Socket Mode) and runs what comes
// back through the transport-agnostic command layer.
//
// Everything self-gates on config that is re-read live, so the bus costs nothing until
// a token is pasted into Settings, and a Settings edit takes effect within a tick —
// no restart, which matters because restarting the server drops in-flight agent work.
import type { McEvent, McEventBus } from "../events.js";
import { createLocalApiClient } from "./api.js";
import type { ApiClient } from "./commands.js";
import {
  readBusConfig,
  slackInboundReady,
  slackOutboundReady,
  telegramInboundReady,
  telegramOutboundReady,
  type BusConfig,
} from "./config.js";
import { executeCommand, parseCommand } from "./commands.js";
import { formatEvent, shouldSend, type TaskContext } from "./format.js";
import { taskLabel, taskTitle } from "./ref.js";
import { sendSlackMessage, startSlackListener } from "./slack.js";
import { sendTelegramMessage, startTelegramListener } from "./telegram.js";
import type { IncomingChatMessage, Logger, SurfaceKind } from "./types.js";

export type SendFn = (target: string, text: string) => Promise<void>;

export interface MessageBusOptions {
  mcHome: string;
  /** Where the command layer reaches this same server, e.g. http://127.0.0.1:18900. */
  apiBaseUrl: string;
  logger?: Logger;
  /** Per (surface, type, task) mute window. Stops a flapping condition spamming chat. */
  cooldownMs?: number;
  /** How often live config is re-read to start/stop inbound listeners. */
  superviseIntervalMs?: number;
  /** Test seam: replace the network transports. */
  senders?: Partial<Record<SurfaceKind, SendFn>>;
  /** Test seam: skip inbound listeners entirely. */
  inbound?: boolean;
  now?: () => number;
  /**
   * Resolve a task so an alert can name it the way a person does. Synchronous by design
   * (the server passes db.getTask) — an alert must not wait on an HTTP round trip, and
   * an unresolvable task just degrades to the short id.
   */
  lookupTask?: (taskId: string) => Record<string, unknown> | null | undefined;
}

function inboundSignature(cfg: BusConfig): string {
  // Only the parts that change what a listener IS — restarting a healthy long-poll on
  // an unrelated Settings edit would drop updates.
  return JSON.stringify([
    telegramInboundReady(cfg.telegram) ? [cfg.telegram.token, cfg.telegram.chatIds] : null,
    slackInboundReady(cfg.slack) ? [cfg.slack.botToken, cfg.slack.appToken, cfg.slack.userIds] : null,
  ]);
}

export interface InboundHandlerDeps {
  api: ApiClient;
  send: (surface: SurfaceKind, target: string, text: string) => Promise<void>;
  logger?: Logger;
}

/**
 * Turn one inbound chat message into a command run and a reply. Exported so the inbound
 * path can be tested without a network transport, and so a future surface (an
 * autonomous operator over the same bus) can reuse it verbatim.
 */
export function makeInboundHandler(deps: InboundHandlerDeps): (message: IncomingChatMessage) => Promise<void> {
  return async (message) => {
    const actor = message.userName
      ? `${message.surface}:@${message.userName}`
      : `${message.surface}:${message.userId || "unknown"}`;
    let reply: string | null;
    try {
      reply = await executeCommand(message.text, { api: deps.api, surface: message.surface, actor });
      // An unrecognised slash command gets a nudge; ordinary chatter is left alone so
      // the bot is not a participant in every conversation.
      if (reply === null && message.text.trim().startsWith("/")) {
        reply = "Unknown command. /help lists what I can do.";
      }
    } catch (err) {
      reply = `Command failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    if (reply === null) return;
    deps.logger?.info?.(`[messagebus] ${actor}: ${message.text.slice(0, 120)}`);
    await deps.send(message.surface, message.target, reply).catch((err) =>
      deps.logger?.error(`[messagebus] ${message.surface} reply failed: ${err instanceof Error ? err.message : String(err)}`),
    );
  };
}

export function startMessageBus(events: McEventBus, opts: MessageBusOptions): () => void {
  const cooldownMs = opts.cooldownMs ?? 60_000;
  const now = opts.now ?? (() => Date.now());
  const log = opts.logger;
  const api = createLocalApiClient(opts.apiBaseUrl);
  const lastSent = new Map<string, number>();

  const send = async (surface: SurfaceKind, cfg: BusConfig, target: string, text: string): Promise<void> => {
    const override = opts.senders?.[surface];
    if (override) return override(target, text);
    if (surface === "telegram") return sendTelegramMessage(cfg.telegram.token, target, text);
    return sendSlackMessage(cfg.slack.botToken, target, text);
  };

  // ---- outbound ------------------------------------------------------------------

  const fanOut = (event: McEvent): void => {
    const cfg = readBusConfig(opts.mcHome);
    const surfaces: Array<{ surface: SurfaceKind; targets: string[]; scope: "action" | "all" }> = [];
    if (telegramOutboundReady(cfg.telegram)) {
      surfaces.push({ surface: "telegram", targets: cfg.telegram.chatIds, scope: cfg.telegram.events });
    }
    if (slackOutboundReady(cfg.slack)) {
      surfaces.push({ surface: "slack", targets: cfg.slack.userIds, scope: cfg.slack.events });
    }
    if (surfaces.length === 0) return;

    const taskId = typeof event.taskId === "string" ? event.taskId : "";
    let text: string | null = null;

    let context: TaskContext | undefined;
    if (taskId && opts.lookupTask) {
      try {
        const task = opts.lookupTask(taskId);
        if (task) {
          const title = taskTitle(task);
          const url = typeof task.external_url === "string" ? task.external_url : "";
          context = { label: taskLabel(task), title: title || undefined, url: url || undefined };
        }
      } catch (err) {
        // A lookup failure must not swallow the alert — degrade to the short id.
        log?.error(`[messagebus] task lookup failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    for (const { surface, targets, scope } of surfaces) {
      if (!shouldSend(event.type, scope)) continue;
      const key = `${surface}:${event.type}:${taskId}`;
      const at = now();
      const previous = lastSent.get(key);
      if (previous !== undefined && at - previous < cooldownMs) continue;
      lastSent.set(key, at);
      text ??= formatEvent(event, context);
      for (const target of targets) {
        void send(surface, cfg, target, text).catch((err) =>
          log?.error(`[messagebus] ${surface} send failed: ${err instanceof Error ? err.message : String(err)}`),
        );
      }
    }

    // Keep the dedup ledger from growing without bound in a long-lived process.
    if (lastSent.size > 500) {
      const cutoff = now() - cooldownMs * 10;
      for (const [key, at] of lastSent) if (at < cutoff) lastSent.delete(key);
    }
  };

  const unsubscribe = events.subscribe(fanOut);

  // ---- inbound -------------------------------------------------------------------

  const handleMessage = makeInboundHandler({
    api,
    logger: log,
    send: (surface, target, text) => send(surface, readBusConfig(opts.mcHome), target, text),
  });

  let stopTelegram: (() => void) | null = null;
  let stopSlack: (() => void) | null = null;
  let signature = "";
  let supervisor: ReturnType<typeof setInterval> | null = null;

  const supervise = (): void => {
    const cfg = readBusConfig(opts.mcHome);
    const next = inboundSignature(cfg);
    if (next === signature) return;
    signature = next;

    stopTelegram?.();
    stopTelegram = null;
    stopSlack?.();
    stopSlack = null;

    if (telegramInboundReady(cfg.telegram)) {
      log?.info?.(`[messagebus] telegram commands enabled for ${cfg.telegram.chatIds.length} chat(s)`);
      stopTelegram = startTelegramListener({
        token: cfg.telegram.token,
        chatIds: cfg.telegram.chatIds,
        onMessage: handleMessage,
        logger: log,
      });
    }
    if (slackInboundReady(cfg.slack)) {
      log?.info?.(`[messagebus] slack commands enabled for ${cfg.slack.userIds.length} user(s)`);
      stopSlack = startSlackListener({
        botToken: cfg.slack.botToken,
        appToken: cfg.slack.appToken,
        userIds: cfg.slack.userIds,
        onMessage: handleMessage,
        logger: log,
      });
    }
  };

  if (opts.inbound !== false) {
    supervise();
    supervisor = setInterval(supervise, opts.superviseIntervalMs ?? 15_000);
    supervisor.unref?.();
  }

  return () => {
    unsubscribe();
    if (supervisor) clearInterval(supervisor);
    stopTelegram?.();
    stopSlack?.();
  };
}
