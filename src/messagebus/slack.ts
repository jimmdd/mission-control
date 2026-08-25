// Slack transport, scoped to DMs with named users plus explicitly allowlisted
// public-channel ticket threads.
//
// Outbound: conversations.open to get the DM channel for a user id, then
// chat.postMessage. Inbound: Socket Mode — an OUTBOUND WebSocket Slack pushes events
// down. That choice is not stylistic: Mission Control binds to 127.0.0.1 and runs
// agents with --dangerously-skip-permissions, so the Events API's requirement of an
// inbound public URL is not acceptable here (see docs/slack-adaptor.md).
//
// Dependency-free: Web API is fetch, Socket Mode uses Node's global WebSocket (>=22).
import type { IncomingChatMessage, Logger, SlackChannelMessage } from "./types.js";

const API = "https://slack.com/api";

async function slackCall(
  token: string,
  method: string,
  body: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text().catch(() => "");
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`Slack ${method}: unparseable response (HTTP ${res.status})`);
  }
  if (payload.ok !== true) {
    // Slack reports failures in-band with ok:false and a machine-readable code, which
    // is the useful part (e.g. missing_scope, invalid_auth, channel_not_found).
    const detail = typeof payload.error === "string" ? payload.error : `HTTP ${res.status}`;
    const needed = typeof payload.needed === "string" ? ` (needs scope: ${payload.needed})` : "";
    throw new Error(`Slack ${method}: ${detail}${needed}`);
  }
  return payload;
}

export async function slackAuthTest(botToken: string): Promise<{ team?: string; user?: string; userId?: string }> {
  const out = await slackCall(botToken, "auth.test");
  return {
    team: typeof out.team === "string" ? out.team : undefined,
    user: typeof out.user === "string" ? out.user : undefined,
    userId: typeof out.user_id === "string" ? out.user_id : undefined,
  };
}

/**
 * Resolve the DM channel for a target. Accepts a user id (U…/W…) which is opened via
 * conversations.open, or an already-known DM channel id (D…) which is used as-is.
 */
export async function resolveSlackDm(botToken: string, target: string): Promise<string> {
  if (/^D[A-Z0-9]+$/i.test(target)) return target;
  const out = await slackCall(botToken, "conversations.open", { users: target });
  const channel = out.channel;
  const id = channel && typeof channel === "object" ? (channel as Record<string, unknown>).id : null;
  if (typeof id !== "string" || !id) throw new Error(`Slack conversations.open returned no channel for ${target}`);
  return id;
}

// Plain text, no blocks: agent output is arbitrary, and mrkdwn would mangle code and
// underscores. Slack's practical per-message limit is 4000 characters.
export async function sendSlackMessage(botToken: string, target: string, text: string): Promise<void> {
  const channel = await resolveSlackDm(botToken, target);
  const body = text.length > 3900 ? `${text.slice(0, 3900)}\n… (truncated)` : text;
  await slackCall(botToken, "chat.postMessage", { channel, text: body, mrkdwn: false });
}

export async function sendSlackThreadMessage(
  botToken: string,
  channelId: string,
  threadTs: string,
  text: string,
): Promise<void> {
  const body = text.length > 3900 ? `${text.slice(0, 3900)}\n… (truncated)` : text;
  await slackCall(botToken, "chat.postMessage", {
    channel: channelId,
    thread_ts: threadTs,
    reply_broadcast: false,
    text: body,
    mrkdwn: false,
  });
}

export interface SlackListenerOptions {
  botToken: string;
  appToken: string;
  /** User ids allowed to command in DMs or admitted public channels. */
  userIds: string[];
  /** Explicitly admitted channel ids. Empty keeps the existing DM-only behavior. */
  channelIds?: string[];
  onMessage: (message: IncomingChatMessage) => Promise<void> | void;
  onChannelMessage?: (message: SlackChannelMessage) => Promise<void> | void;
  logger?: Logger;
}

interface SocketEnvelope {
  type?: string;
  envelope_id?: string;
  payload?: {
    event?: {
      type?: string;
      channel_type?: string;
      channel?: string;
      user?: string;
      text?: string;
      bot_id?: string;
      subtype?: string;
      ts?: string;
      thread_ts?: string;
    };
    event_id?: string;
  };
}

export interface SlackEnvelopeClassifierOptions {
  botUserId: string;
  userIds: string[];
  channelIds: string[];
}

function stripBotMention(text: string, botUserId: string): string {
  return text
    .split(`<@${botUserId}>`)
    .join(" ")
    .replace(/^\s*[:,;\-]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Pure event gate: explicit mentions start a thread; only replies in a thread may follow it. */
export function classifySlackEnvelope(
  envelope: SocketEnvelope,
  opts: SlackEnvelopeClassifierOptions,
): SlackChannelMessage | null {
  if (envelope.type !== "events_api") return null;
  const event = envelope.payload?.event;
  if (!event || event.subtype || event.bot_id) return null;

  const channelId = (event.channel ?? "").toUpperCase();
  const userId = (event.user ?? "").toUpperCase();
  const messageTs = event.ts ?? "";
  const allowedUsers = new Set(opts.userIds.map((id) => id.toUpperCase()));
  const allowedChannels = new Set(opts.channelIds.map((id) => id.toUpperCase()));
  if (!channelId || !userId || !messageTs) return null;
  if (!allowedUsers.has(userId) || !allowedChannels.has(channelId)) return null;
  if (userId === opts.botUserId.toUpperCase()) return null;

  const text = typeof event.text === "string" ? event.text.trim() : "";
  if (event.type === "app_mention") {
    return {
      kind: "mention",
      channelId,
      threadTs: event.thread_ts || messageTs,
      messageTs,
      userId,
      text: stripBotMention(text, opts.botUserId),
    };
  }

  if (
    event.type !== "message" ||
    event.channel_type !== "channel" ||
    !event.thread_ts ||
    event.thread_ts === messageTs ||
    text.includes(`<@${opts.botUserId}>`)
  ) {
    return null;
  }
  return {
    kind: "reply",
    channelId,
    threadTs: event.thread_ts,
    messageTs,
    userId,
    text,
  };
}

/**
 * Hold a Socket Mode connection open, reconnecting with backoff, until stop() is called.
 *
 * Slack redelivers an envelope that is not acked, and reconnects are routine (it asks
 * for one roughly every hour), so envelopes are acked immediately and deduped by
 * message identity — otherwise one "/done" or channel reply could execute several times.
 */
export function startSlackListener(opts: SlackListenerOptions): () => void {
  const allowed = new Set(opts.userIds.map((id) => id.toUpperCase()));
  const log = opts.logger;
  const seenEventIds = new Set<string>();
  let stopped = false;
  let socket: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let backoffMs = 1_000;
  let botUserId = "";

  const alreadySeen = (key: string | undefined): boolean => {
    if (!key) return false;
    if (seenEventIds.has(key)) return true;
    seenEventIds.add(key);
    // Bounded memory: the id only needs to outlive Slack's retry window.
    if (seenEventIds.size > 500) {
      for (const id of seenEventIds) {
        seenEventIds.delete(id);
        if (seenEventIds.size <= 250) break;
      }
    }
    return false;
  };

  const connect = async () => {
    if (stopped) return;
    try {
      const [out, auth] = await Promise.all([
        slackCall(opts.appToken, "apps.connections.open"),
        slackAuthTest(opts.botToken),
      ]);
      botUserId = auth.userId ?? botUserId;
      const url = typeof out.url === "string" ? out.url : "";
      if (!url) throw new Error("apps.connections.open returned no url");

      const ws = new WebSocket(url);
      socket = ws;

      ws.addEventListener("message", (raw: MessageEvent) => {
        let envelope: SocketEnvelope;
        try {
          envelope = JSON.parse(String(raw.data)) as SocketEnvelope;
        } catch {
          return;
        }
        // Ack first, always: an unacked envelope is redelivered, and slow command work
        // must not turn into a duplicate execution.
        if (envelope.envelope_id) {
          try {
            ws.send(JSON.stringify({ envelope_id: envelope.envelope_id }));
          } catch {
            /* socket already gone; the reconnect path handles it */
          }
        }
        if (envelope.type === "hello") {
          backoffMs = 1_000;
          log?.info?.("[messagebus] slack socket mode connected");
          return;
        }
        if (envelope.type === "disconnect") {
          try {
            ws.close();
          } catch {
            /* closing is best-effort */
          }
          return;
        }
        if (envelope.type !== "events_api") return;

        const event = envelope.payload?.event;
        const eventId = envelope.payload?.event_id;
        const dedupeKey = event?.channel && event.ts ? `${event.channel}:${event.ts}` : eventId;

        const channelMessage = botUserId && opts.onChannelMessage
          ? classifySlackEnvelope(envelope, {
              botUserId,
              userIds: opts.userIds,
              channelIds: opts.channelIds ?? [],
            })
          : null;
        if (channelMessage) {
          if (alreadySeen(dedupeKey)) return;
          void opts.onChannelMessage?.(channelMessage);
          return;
        }

        if (!event || event.type !== "message") return;
        // Ignore edits/joins/etc and anything the bot itself said.
        if (event.subtype || event.bot_id) return;
        if (event.channel_type !== "im") return;
        const text = typeof event.text === "string" ? event.text.trim() : "";
        const user = (event.user ?? "").toUpperCase();
        if (!text || !user) return;
        if (!allowed.has(user)) {
          log?.info?.(`[messagebus] slack: ignored DM from ${user} (not allowlisted)`);
          return;
        }
        if (alreadySeen(dedupeKey)) return;
        void opts.onMessage({
          surface: "slack",
          target: event.channel ?? user,
          userId: event.user ?? "",
          text,
        });
      });

      const scheduleReconnect = () => {
        if (stopped || retryTimer) return;
        retryTimer = setTimeout(() => {
          retryTimer = null;
          void connect();
        }, backoffMs);
        backoffMs = Math.min(backoffMs * 2, 60_000);
      };

      ws.addEventListener("close", scheduleReconnect);
      ws.addEventListener("error", () => {
        log?.error("[messagebus] slack socket error; reconnecting");
        try {
          ws.close();
        } catch {
          /* already closed */
        }
      });
    } catch (err) {
      log?.error(`[messagebus] slack connect failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!stopped && !retryTimer) {
        retryTimer = setTimeout(() => {
          retryTimer = null;
          void connect();
        }, backoffMs);
        backoffMs = Math.min(backoffMs * 2, 60_000);
      }
    }
  };

  void connect();

  return () => {
    stopped = true;
    if (retryTimer) clearTimeout(retryTimer);
    try {
      socket?.close();
    } catch {
      /* nothing to do */
    }
  };
}
