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
import { createAlertThrottle } from "../alert-throttle.js";
import { createLocalApiClient } from "./api.js";
import type { ApiClient } from "./commands.js";
import {
  readBusConfig,
  slackChannelInboundReady,
  slackInboundReady,
  slackOutboundReady,
  telegramInboundReady,
  telegramOutboundReady,
  type BusConfig,
} from "./config.js";
import { executeCommand } from "./commands.js";
import { askAssistant, createLlmCall, type AssistantOutcome, type LlmCall } from "./assistant.js";
import { formatEvent, shouldSend, type TaskContext } from "./format.js";
import { taskLabel, taskTitle } from "./ref.js";
import { createSlackChannelHandler } from "./slack-channel.js";
import { sendSlackMessage, sendSlackThreadMessage, startSlackListener } from "./slack.js";
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
  /** Test seam: replace the model call behind the natural-language assistant. */
  llm?: LlmCall;
}

function inboundSignature(cfg: BusConfig): string {
  // Only the parts that change what a listener IS — restarting a healthy long-poll on
  // an unrelated Settings edit would drop updates.
  return JSON.stringify([
    telegramInboundReady(cfg.telegram) ? [cfg.telegram.token, cfg.telegram.chatIds] : null,
    slackInboundReady(cfg.slack)
      ? [cfg.slack.botToken, cfg.slack.appToken, cfg.slack.userIds, cfg.slack.channelIds]
      : null,
  ]);
}

export interface InboundHandlerDeps {
  api: ApiClient;
  send: (surface: SurfaceKind, target: string, text: string) => Promise<void>;
  logger?: Logger;
  /**
   * Natural-language fallback for text that is not a command. Telegram only, by request:
   * Slack stays commands-only, so a stray DM there can never spend a generation call or
   * touch a ticket. Absent = plain text is ignored, as before.
   */
  assistant?: {
    ask: (question: string) => Promise<AssistantOutcome>;
    /** Live gate, re-read per message, so it can be switched off without a restart. */
    enabled: (surface: SurfaceKind) => boolean;
  };
}

// A write the assistant proposed, waiting on /yes. Keyed per chat, single-slot: a second
// proposal replaces the first, so /yes can never resolve something older than the last
// thing discussed.
interface PendingWrite {
  command: string;
  at: number;
}
const PENDING_TTL_MS = 5 * 60_000;

/**
 * Turn one inbound chat message into a command run and a reply. Exported so the inbound
 * path can be tested without a network transport, and so a future surface (an
 * autonomous operator over the same bus) can reuse it verbatim.
 */
export function makeInboundHandler(deps: InboundHandlerDeps): (message: IncomingChatMessage) => Promise<void> {
  const pending = new Map<string, PendingWrite>();

  return async (message) => {
    const actor = message.userName
      ? `${message.surface}:@${message.userName}`
      : `${message.surface}:${message.userId || "unknown"}`;
    const ctx = {
      api: deps.api,
      surface: message.surface,
      actor,
      requestId: message.messageId ? `${message.surface}:${message.target}:${message.messageId}` : undefined,
    };
    const chatKey = `${message.surface}:${message.target}`;
    const text = message.text.trim();
    const spoken = text.toLowerCase().replace(/^\//, "");
    let reply: string | null;

    try {
      // Confirmation of a proposed write, before anything else can claim the message.
      if (spoken === "yes" || spoken === "no") {
        const held = pending.get(chatKey);
        pending.delete(chatKey);
        if (!held || Date.now() - held.at > PENDING_TTL_MS) {
          reply = held ? "That proposal expired — ask me again." : "Nothing is waiting for confirmation.";
        } else if (spoken === "no") {
          reply = `Dropped: ${held.command}`;
        } else {
          const result = await executeCommand(held.command, ctx);
          reply = result ?? `Ran ${held.command}.`;
        }
      } else {
        reply = await executeCommand(text, ctx);

        if (reply === null && deps.assistant?.enabled(message.surface)) {
          // Not a command — hand it to the assistant. A read runs immediately; a write is
          // held until the operator says /yes, so a sentence can never silently relaunch
          // an agent or close a ticket.
          const outcome = await deps.assistant.ask(text);
          if (outcome.kind === "read" && outcome.command) {
            const result = await executeCommand(outcome.command, ctx);
            reply = [outcome.reply, result].filter(Boolean).join("\n\n");
          } else if (outcome.kind === "write" && outcome.command) {
            pending.set(chatKey, { command: outcome.command, at: Date.now() });
            reply = [outcome.reply, `→ ${outcome.command}`, "Confirm? /yes · /no"].filter(Boolean).join("\n");
          } else {
            reply = outcome.reply;
          }
        } else if (reply === null && text.startsWith("/")) {
          // An unrecognised slash command gets a nudge; ordinary chatter on a surface with
          // no assistant is left alone, so the bot is not a participant in every message.
          reply = "Unknown command. /help lists what I can do.";
        }
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
  // Content-aware with backoff, shared with notifier.ts so both channels throttle
  // one condition the same way.
  const throttle = createAlertThrottle({ cooldownMs, now });

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
      text ??= formatEvent(event, context);
      // Keyed on the rendered text, so a condition repeating every tick backs off
      // instead of arriving once a minute forever. See src/alert-throttle.ts.
      const key = `${surface}:${event.type}:${taskId}`;
      if (!throttle.allow(key, text)) continue;
      for (const target of targets) {
        void send(surface, cfg, target, text).catch((err) =>
          log?.error(`[messagebus] ${surface} send failed: ${err instanceof Error ? err.message : String(err)}`),
        );
      }
    }
  };

  const unsubscribe = events.subscribe(fanOut);

  // ---- inbound -------------------------------------------------------------------

  // Natural-language fallback. Telegram only — Slack is commands-only by request, so a
  // stray Slack DM neither spends a generation call nor proposes a write.
  const llm = opts.llm ?? createLlmCall(log);
  const handleMessage = makeInboundHandler({
    api,
    logger: log,
    send: (surface, target, text) => send(surface, readBusConfig(opts.mcHome), target, text),
    assistant: {
      ask: (question) => askAssistant(question, { api, llm, logger: log }),
      enabled: (surface) => surface === "telegram" && readBusConfig(opts.mcHome).telegram.assistant,
    },
  });
  const handleSlackChannelMessage = createSlackChannelHandler({
    api,
    logger: log,
    send: (channelId, threadTs, text) =>
      sendSlackThreadMessage(readBusConfig(opts.mcHome).slack.botToken, channelId, threadTs, text),
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
      log?.info?.(
        `[messagebus] slack commands enabled for ${cfg.slack.userIds.length} user(s)` +
        (slackChannelInboundReady(cfg.slack) ? ` in ${cfg.slack.channelIds.length} channel(s)` : ""),
      );
      stopSlack = startSlackListener({
        botToken: cfg.slack.botToken,
        appToken: cfg.slack.appToken,
        userIds: cfg.slack.userIds,
        channelIds: cfg.slack.channelIds,
        onMessage: handleMessage,
        onChannelMessage: slackChannelInboundReady(cfg.slack) ? handleSlackChannelMessage : undefined,
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
