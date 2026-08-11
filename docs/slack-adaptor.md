# Slack adaptor — design notes

> Status: **design only, not built.** Parked for phase P3 of the v2 plan.
> Captured 10 Aug 2026. See the approved plan at `~/.claude/plans/kind-mixing-pixel.md`.

## Framing — what this is and is not

**A Slack conversation is not an agent session.** Agent sessions live in git worktrees, tied to plan
steps. Slack is a remote control over tickets — a view and steering surface, not a place agents live.

This is the line that stops the adaptor from accidentally turning Mission Control into
[qm](https://github.com/yc-software/qm). There, the personal agent *is* the product, so every person
needs their own durable sandbox. Here the agents work on repos; people watch and steer.

---

## App shape

A Slack app with a **bot user** (`xoxb-` token), not a user token. It posts as Mission Control.

### Socket Mode, not the Events API

Non-negotiable given the deployment. Mission Control binds to `127.0.0.1` and refuses a non-local
bind without a token (`server.ts:13-34`). Socket Mode is an **outbound WebSocket** — Slack never
needs to reach the mini. No tunnel, no ngrok, no inbound port on a box that runs agents with
`--dangerously-skip-permissions`.

The Events API would require exposing that box. Don't.

### Bot scopes

```
app_mentions:read     hear @mentions
chat:write            post messages and thread replies
im:history            read DMs
im:write              send DMs
channels:history      read replies in public channels it's added to
groups:history        same, private channels
users:read            map Slack user -> actor
commands              /mc slash commands
reactions:write       ack with an emoji (optional)
```

Plus **Interactivity** enabled, for approve/deny buttons on checkpoints.

Auth: app-level token (`xapp-`) for the Socket Mode connection, bot token (`xoxb-`) for Web API calls.
With Socket Mode there is no request-signature verification to implement — the WebSocket itself is
authenticated. (If the Events API is ever used instead, signing-secret + timestamp verification
becomes mandatory.)

---

## Session separation

Three Slack containers, three different meanings:

| Slack thing | Maps to | Purpose |
|---|---|---|
| **DM** | one actor | Personal notifications, quick commands, read-only questions |
| **Channel** | one workspace / scope | Tickets raised here belong to that scope |
| **Thread** | **one ticket** | Every reply becomes an activity on that task |

### Thread = ticket

The load-bearing decision. `@mc add rate limiting to the API` in `#backend` creates a ticket in the
`backend` scope; the bot replies in-thread, and from then on **that thread is ENG-482**. Research
questions get posted there, answers come back as activities, approvals appear as buttons.

New table:

```sql
CREATE TABLE IF NOT EXISTS task_surface_threads (
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  surface     TEXT NOT NULL,          -- 'slack' | 'telegram' | 'linear'
  channel_id  TEXT NOT NULL,
  thread_ts   TEXT NOT NULL,          -- telegram: reply_to_message_id
  created_at  TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (surface, channel_id, thread_ts)
);
CREATE INDEX IF NOT EXISTS idx_surface_threads_task ON task_surface_threads(task_id);
```

### DM is deliberately not a ticket

It is the personal control channel: notifications land there, and you can ask read-only questions
("what's blocked?", "why did step 2 fail?"). If a conversational assistant is added in DM, give it a
**read-scoped token**. It queries the API; it never touches repos.

---

## Reference implementation already in the repo

`integrations/linear/linear-sync.py:1158-1276` implements this exact pattern against Linear:

- thread-parent resolution — `_resolve_thread_parent` (`:426-432`)
- bot-echo suppression — `_is_bot_comment` (`:411`)
- mention-tag triggering — (`:415`, `:1221`)
- comment dedup — `synced_comments` / `answered_comments` (`:1268-1274`)
- two-tier answer routing — simple inline answer vs spawned research agent (`:779-830`)

Slack is the same shape with different field names. Retrofit Linear onto the shared SPI rather than
writing the Slack adaptor from scratch.

---

## Gotchas

1. **Anyone in a channel can click an approve button.** The payload gives `user.id` → actor, so
   attribution is free — but permission must be *checked* before resolving, not merely recorded.
   This is why `actor_tokens` needs a `scopes` column rather than being a bare secret.
2. **Slack retries events** on any non-2xx, with `X-Slack-Retry-Num`. Store `event_id` and dedup, or
   one message becomes three tickets.
3. **Unknown Slack users.** On first interaction from someone with no actor, auto-create the actor as
   `pending` so attribution works immediately, but grant **no permissions** until promoted.
   Otherwise anyone in the workspace can dispatch agents on the mini.
4. **All three existing integrations send no auth header** — `integrations/openclaw/tools.ts:15`,
   `integrations/linear/linear-sync.py:163`, `integrations/github/watch-pr-reviews.sh:42,200`. They
   break silently the moment any token is enabled. Fix them in the same change.

---

## Schema this pins down (from P3)

```sql
actors            (id, kind, display_name, handle, created_at)
actor_identities  (actor_id, surface, external_id, status)   -- status: pending | active | blocked
actor_tokens      (actor_id, token_hash, scopes, expires_at)
```

Plus `actor_id` on `tasks` (`requested_by_actor_id`), `task_activities`, and `task_checkpoints`
(`assignee_actor_id`, `resolved_by_actor_id`).

## Surface SPI

```ts
interface Surface {
  ingest(event): MissionControlAction   // inbound -> task/activity/checkpoint resolution
  post(taskId, message, thread?)        // outbound into the ticket's thread
  prompt(checkpoint)                    // render approve/deny controls
  resolveActor(externalId): Actor       // identity mapping, auto-create as pending
}
```

`adapters/slack/` first, then `adapters/telegram/` against the same interface. Telegram is the useful
second implementation because its threading model differs enough
(`chat_id` + `reply_to_message_id` vs `channel` + `thread_ts`) to prove the SPI isn't Slack-shaped.
