// Shared vocabulary for the message bus. Kept transport-agnostic on purpose: the
// command layer must not know whether a reply is going to Telegram or Slack, so a
// third surface (or an autonomous operator) can be added without touching it.

export type SurfaceKind = "telegram" | "slack";

export interface Logger {
  error: (message: string, ...args: unknown[]) => void;
  info?: (message: string, ...args: unknown[]) => void;
}

export interface IncomingChatMessage {
  surface: SurfaceKind;
  /** Where a reply goes: Telegram chat id, or Slack DM channel/user id. */
  target: string;
  /** Who sent it, for attribution in the activity trail. */
  userId: string;
  userName?: string;
  text: string;
}
