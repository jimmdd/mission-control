// Message-bus configuration, read LIVE from ~/.mission-control/.env.
//
// Two reasons this does not go through process.env alone:
//   1. the launchd-run server never loads that file into its environment (the same
//      gotcha previews hit), so a token pasted into Settings would be invisible;
//   2. reading per use means Settings edits (token, allowlist, interaction mode,
//      event set) take effect without restarting the server.
//
// process.env still wins when set, so a shell-exported token overrides the file.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// off     — surface disabled entirely
// notify  — outbound only: Mission Control talks, nothing listens
// command — outbound plus inbound commands from the allowlisted chats
export type Interaction = "off" | "notify" | "command";

// action — human-action-required plus task milestones (the default)
// all    — adds lower-signal lifecycle events
export type EventScope = "action" | "all";

export interface TelegramConfig {
  token: string;
  /** Chats that receive alerts AND may issue commands. Both directions, one list. */
  chatIds: string[];
  interaction: Interaction;
  events: EventScope;
  /**
   * Natural-language replies to non-command text. Telegram only — Slack is
   * commands-only by request, so there is no equivalent key for it. Defaults on:
   * the surface is a private DM with one allowlisted operator, and every write it
   * proposes still needs an explicit /yes.
   */
  assistant: boolean;
}

export interface SlackConfig {
  /** xoxb- bot token: Web API calls (chat.postMessage, conversations.open). */
  botToken: string;
  /** xapp- app-level token: Socket Mode connection. Only needed for inbound. */
  appToken: string;
  /**
   * Slack user IDs (U…) to DM and accept commands from. Scoped to DMs on purpose —
   * a DM is one person's control channel, so there is no "anyone in the channel can
   * click approve" problem to solve yet (see docs/slack-adaptor.md).
   */
  userIds: string[];
  interaction: Interaction;
  events: EventScope;
}

export interface BusConfig {
  telegram: TelegramConfig;
  slack: SlackConfig;
}

export function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    if (!existsSync(path)) return out;
    for (const line of readFileSync(path, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
      const eq = trimmed.indexOf("=");
      out[trimmed.slice(0, eq).trim()] = trimmed
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
    }
  } catch {
    // unreadable — treated as empty, never fatal
  }
  return out;
}

function parseInteraction(raw: string, fallback: Interaction = "notify"): Interaction {
  const value = raw.trim().toLowerCase();
  return value === "off" || value === "notify" || value === "command" ? value : fallback;
}

function parseList(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function readBusConfig(mcHome: string): BusConfig {
  const env = parseEnvFile(join(mcHome, ".env"));
  const get = (key: string) => (process.env[key] ?? env[key] ?? "").trim();
  const scope = (key: string): EventScope => (get(key).toLowerCase() === "all" ? "all" : "action");

  return {
    telegram: {
      token: get("TELEGRAM_BOT_TOKEN"),
      chatIds: parseList(get("TELEGRAM_ALLOWED_CHAT_IDS")),
      interaction: parseInteraction(get("TELEGRAM_INTERACTION")),
      events: scope("TELEGRAM_EVENTS"),
      assistant: !["off", "0", "false", "no"].includes(get("TELEGRAM_ASSISTANT").toLowerCase()),
    },
    slack: {
      botToken: get("SLACK_BOT_TOKEN"),
      appToken: get("SLACK_APP_TOKEN"),
      userIds: parseList(get("SLACK_ALLOWED_USER_IDS")),
      interaction: parseInteraction(get("SLACK_INTERACTION")),
      events: scope("SLACK_EVENTS"),
    },
  };
}

/** Can this surface send at all? Used to skip work and to drive the Settings dots. */
export function telegramOutboundReady(cfg: TelegramConfig): boolean {
  return Boolean(cfg.token) && cfg.chatIds.length > 0 && cfg.interaction !== "off";
}

export function slackOutboundReady(cfg: SlackConfig): boolean {
  return Boolean(cfg.botToken) && cfg.userIds.length > 0 && cfg.interaction !== "off";
}

/** Inbound needs command mode; Slack additionally needs the Socket Mode app token. */
export function telegramInboundReady(cfg: TelegramConfig): boolean {
  return Boolean(cfg.token) && cfg.chatIds.length > 0 && cfg.interaction === "command";
}

export function slackInboundReady(cfg: SlackConfig): boolean {
  return (
    Boolean(cfg.botToken) &&
    Boolean(cfg.appToken) &&
    cfg.userIds.length > 0 &&
    cfg.interaction === "command"
  );
}
