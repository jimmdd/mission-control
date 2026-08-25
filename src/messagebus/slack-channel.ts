import { submitTaskInput, type ApiClient } from "./commands.js";
import { taskLabel, taskTitle } from "./ref.js";
import type { Logger, SlackChannelMessage } from "./types.js";

export interface SlackChannelHandlerOptions {
  api: ApiClient;
  send: (channelId: string, threadTs: string, text: string) => Promise<void>;
  logger?: Logger;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function titleFromMessage(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length > 120 ? `${compact.slice(0, 117)}…` : compact;
}

function mappingPath(message: SlackChannelMessage): string {
  const query = new URLSearchParams({
    surface: "slack",
    channel_id: message.channelId,
    thread_ts: message.threadTs,
  });
  return `/surface-threads?${query.toString()}`;
}

export function createSlackChannelHandler(
  opts: SlackChannelHandlerOptions,
): (message: SlackChannelMessage) => Promise<void> {
  return async (message) => {
    try {
      if (!message.text.trim()) {
        await opts.send(message.channelId, message.threadTs, "Tell me what ticket to create after the mention.");
        return;
      }

      let task: Record<string, unknown>;
      if (message.kind === "mention") {
        const result = record(await opts.api.post("/surface-threads", {
          surface: "slack",
          channel_id: message.channelId,
          thread_ts: message.threadTs,
          message_ts: message.messageTs,
          created_by_external_id: message.userId,
          title: titleFromMessage(message.text),
          description: message.text,
          source: "slack",
        }));
        task = record(result.task);
        if (result.created === true) {
          await opts.send(
            message.channelId,
            message.threadTs,
            `Created ${taskLabel(task)} · ${taskTitle(task)}. This thread is linked to the ticket; reply here to add input.`,
          );
          return;
        }
        // A redelivery of the root mention is the same ticket-creation event, not new
        // feedback. A later mention inside the linked thread has a different message ts
        // and intentionally goes through the normal ticket-input path below.
        if (message.messageTs === message.threadTs) {
          await opts.send(
            message.channelId,
            message.threadTs,
            `${taskLabel(task)} · ${taskTitle(task)} is already linked to this thread.`,
          );
          return;
        }
      } else {
        const result = record(await opts.api.get(mappingPath(message)));
        task = record(result.task);
      }

      if (!task.id) return;
      const reply = await submitTaskInput(
        { api: opts.api, surface: "slack", actor: `slack:${message.userId}` },
        task,
        message.text,
      );
      await opts.send(message.channelId, message.threadTs, reply);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (message.kind === "reply" && /not found/i.test(detail)) return;
      opts.logger?.error(`[messagebus] slack channel ${message.kind} failed: ${detail}`);
      await opts.send(
        message.channelId,
        message.threadTs,
        "Mission Control could not handle that message. Check the server log for details.",
      ).catch(() => {});
    }
  };
}
