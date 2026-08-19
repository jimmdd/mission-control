// Rate limiting for outbound alerts, shared by the notify hook/webhook
// (notifier.ts) and the Telegram/Slack bus (messagebus/index.ts) so one condition
// cannot be throttled generously on one channel and spam another.
//
// A flat per-(type, task) cooldown is the wrong shape for the failure that
// actually happens. A stuck ticket re-emits the same event every daemon tick, and
// a fixed 60s window just meters the spam to once a minute forever: MET-640 hit an
// unsupported planning provider and repeated "needs you" until someone complained.
// What a reader needs is to be told once, then left alone while nothing changes,
// and told again promptly when something does.
//
// So there are two rules, and the order matters:
//   1. The cooldown is a floor, enforced per key whatever the text says. Nothing
//      gets to jump the queue by wording itself differently.
//   2. Past the floor, an alert that keeps saying the same thing backs off,
//      doubling each repeat up to a ceiling; genuinely new text resets it.
//
// Rule 1 exists because the tempting version of rule 2 — "new text means a new
// condition, send it" — is a spam amplifier in practice. Detail strings carry
// counters ("no heartbeat for 300s", then 360s, then 420s), so keying on the raw
// text would make every tick look novel and defeat the throttle entirely. The
// fingerprint is therefore digit-normalised: a rising counter reads as the same
// condition and still backs off.

export interface AlertThrottleOptions {
  /** Quiet window after the first send of a given text. */
  cooldownMs?: number;
  /** Ceiling for the doubling, so a permanent condition still checks in. */
  maxCooldownMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Entries to keep before pruning expired ones. */
  maxEntries?: number;
}

// Collapse digit runs so a detail string with a ticking counter fingerprints as one
// condition: "no heartbeat for 300s" and "…360s" are the same thing happening twice.
function normalize(text: string): string {
  return text.replace(/\d+/g, "#").trim();
}

interface Entry {
  fingerprint: string;
  lastSentAt: number;
  /**
   * Sends of this fingerprint so far. The backoff doubles per *send*, not per
   * suppressed attempt — otherwise the schedule would depend on how often the
   * daemon happens to tick, and a busier poll loop would mute a condition faster
   * than a quiet one.
   */
  sends: number;
  /** Suppressed attempts since the last send, for "(xN)" wording. */
  suppressed: number;
}

export interface AlertThrottle {
  /**
   * Whether to send this alert now. Call once per (key, text) decision — it
   * records the send when it returns true.
   */
  allow: (key: string, fingerprint: string) => boolean;
  /** How many suppressed repeats preceded the current send, for "(xN)" wording. */
  suppressedBefore: (key: string) => number;
  size: () => number;
}

export function createAlertThrottle(opts: AlertThrottleOptions = {}): AlertThrottle {
  const cooldownMs = opts.cooldownMs ?? 60_000;
  const maxCooldownMs = opts.maxCooldownMs ?? 3_600_000;
  const now = opts.now ?? (() => Date.now());
  const maxEntries = opts.maxEntries ?? 500;
  const entries = new Map<string, Entry>();
  const lastSuppressed = new Map<string, number>();

  const prune = (at: number): void => {
    if (entries.size <= maxEntries) return;
    for (const [key, entry] of entries) {
      if (at - entry.lastSentAt > maxCooldownMs * 2) {
        entries.delete(key);
        lastSuppressed.delete(key);
      }
    }
  };

  return {
    allow(key, fingerprint) {
      const at = now();
      const prev = entries.get(key);
      const print = normalize(fingerprint);

      // Never seen this key — say it immediately.
      if (!prev) {
        lastSuppressed.set(key, 0);
        entries.set(key, { fingerprint: print, lastSentAt: at, sends: 1, suppressed: 0 });
        prune(at);
        return true;
      }

      const same = prev.fingerprint === print;
      // Rule 1 is the floor; rule 2 stretches it for a condition that keeps
      // saying the same thing. New text only ever has to clear the floor.
      const wait = same
        ? Math.min(cooldownMs * 2 ** (prev.sends - 1), maxCooldownMs)
        : cooldownMs;

      if (at - prev.lastSentAt < wait) {
        prev.suppressed += 1;
        return false;
      }

      lastSuppressed.set(key, prev.suppressed);
      entries.set(key, {
        fingerprint: print,
        lastSentAt: at,
        // A different condition starts its own escalation from scratch.
        sends: same ? prev.sends + 1 : 1,
        suppressed: 0,
      });
      prune(at);
      return true;
    },
    suppressedBefore(key) {
      return lastSuppressed.get(key) ?? 0;
    },
    size() {
      return entries.size;
    },
  };
}
