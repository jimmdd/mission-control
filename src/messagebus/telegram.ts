// Telegram transport: outbound sendMessage, inbound getUpdates long-poll.
//
// Dependency-free — the Bot API is plain HTTPS, done with fetch.
import type { IncomingChatMessage, Logger } from "./types.js";

const API = "https://api.telegram.org";

async function callTelegram(
  token: string,
  method: string,
  body: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(`Telegram ${method} ${res.status}: ${text.slice(0, 200)}`);
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`Telegram ${method}: unparseable response`);
  }
}

// Sent without parse_mode so arbitrary message content can never produce a 400 from
// unescaped Markdown. Long messages are truncated — Telegram's hard cap is 4096.
export async function sendTelegramMessage(token: string, chatId: string, text: string): Promise<void> {
  const body = text.length > 3900 ? `${text.slice(0, 3900)}\n… (truncated)` : text;
  await callTelegram(token, "sendMessage", { chat_id: chatId, text: body, disable_web_page_preview: true }, 10_000);
}

export async function telegramGetMe(token: string): Promise<{ username?: string; id?: number }> {
  const out = await callTelegram(token, "getMe", {}, 10_000);
  const result = (out.result ?? {}) as Record<string, unknown>;
  return {
    username: typeof result.username === "string" ? result.username : undefined,
    id: typeof result.id === "number" ? result.id : undefined,
  };
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id?: number;
    text?: string;
    chat?: { id?: number | string };
    from?: { id?: number | string; username?: string; is_bot?: boolean };
  };
}

function extractUpdates(payload: Record<string, unknown>): TelegramUpdate[] {
  const result = payload.result;
  if (!Array.isArray(result)) return [];
  return result.filter((u): u is TelegramUpdate => Boolean(u) && typeof (u as TelegramUpdate).update_id === "number");
}

export interface TelegramListenerOptions {
  token: string;
  /** Chats allowed to command. Anything else is dropped without a reply. */
  chatIds: string[];
  onMessage: (message: IncomingChatMessage) => Promise<void> | void;
  logger?: Logger;
  /** Long-poll seconds handed to Telegram. Tests use 0 to keep it instant. */
  pollSeconds?: number;
}

/**
 * Long-poll for commands until the returned stop() is called.
 *
 * Starts from the CURRENT end of the update queue: a backlog that piled up while the
 * bus was off is acknowledged and dropped rather than replayed, because replaying
 * "/done" from yesterday would act on a stale intent.
 */
export function startTelegramListener(opts: TelegramListenerOptions): () => void {
  const controller = new AbortController();
  const pollSeconds = opts.pollSeconds ?? 50;
  const allowed = new Set(opts.chatIds.map(String));
  const log = opts.logger;
  let offset: number | null = null;

  const run = async () => {
    // Prime the offset past whatever is already queued.
    try {
      const primed = extractUpdates(
        await callTelegram(opts.token, "getUpdates", { offset: -1, timeout: 0 }, 15_000, controller.signal),
      );
      const last = primed.at(-1);
      offset = last ? last.update_id + 1 : null;
    } catch (err) {
      if (controller.signal.aborted) return;
      log?.error(`[messagebus] telegram prime failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    let backoffMs = 1_000;
    while (!controller.signal.aborted) {
      try {
        const payload = await callTelegram(
          opts.token,
          "getUpdates",
          {
            ...(offset === null ? {} : { offset }),
            timeout: pollSeconds,
            allowed_updates: ["message"],
          },
          (pollSeconds + 15) * 1_000,
          controller.signal,
        );
        backoffMs = 1_000;
        for (const update of extractUpdates(payload)) {
          offset = update.update_id + 1;
          const message = update.message;
          const text = typeof message?.text === "string" ? message.text.trim() : "";
          const chatId = message?.chat?.id;
          if (!text || chatId === undefined || message?.from?.is_bot) continue;
          if (!allowed.has(String(chatId))) {
            // Silence is the right answer to an unknown chat: replying confirms the
            // bot exists and invites probing.
            log?.info?.(`[messagebus] telegram: ignored message from chat ${String(chatId)} (not allowlisted)`);
            continue;
          }
          await opts.onMessage({
            surface: "telegram",
            target: String(chatId),
            userId: message?.from?.id === undefined ? "" : String(message.from.id),
            userName: message?.from?.username,
            messageId: String(update.update_id),
            text,
          });
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        const detail = err instanceof Error ? err.message : String(err);
        // 409 means a second poller (another machine, another MC) is competing for the
        // same bot — worth saying plainly, since updates then arrive at random.
        if (detail.includes("409")) {
          log?.error("[messagebus] telegram: another getUpdates poller is running for this bot token");
        } else if (!detail.includes("timeout")) {
          log?.error(`[messagebus] telegram poll failed: ${detail}`);
        }
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        backoffMs = Math.min(backoffMs * 2, 60_000);
      }
    }
  };

  void run();
  return () => controller.abort();
}
