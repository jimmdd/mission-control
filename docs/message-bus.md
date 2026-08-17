# Message bus — the chat interface

> Status: **shipped.** Telegram and Slack DM, outbound alerts and inbound commands.
> The deeper Slack model (thread = ticket, actor identity, approve buttons) is still a
> design: see `docs/slack-adaptor.md`.

Mission Control pings you where you already are, and takes instructions back. The point
is that no one has to sit watching the board: when an agent is blocked, a question needs
answering, or a checkpoint needs a decision, the chat message arrives with a ref you can
act on in the same thread.

## Shape

```
                   ┌──────────────── McEventBus (in-process) ────────────────┐
   agents/bridge → │ needs_human · awaiting_approval · new_triage_question    │
   reaper         →│ agent_exited · agent_stalled · task_completed            │
                   └────────────────────────┬────────────────────────────────┘
                                            │  format.ts (routing + wording)
                              ┌─────────────┴─────────────┐
                        telegram.ts                    slack.ts
                     sendMessage / getUpdates    chat.postMessage / Socket Mode
                              └─────────────┬─────────────┘
                                    commands.ts (transport-agnostic)
                                            │  local HTTP API, same routes as the UI
                                            ▼
                                   tasks · checkpoints · activities
```

`src/messagebus/` holds it: `config.ts` (live config), `format.ts` (what reaches chat),
`telegram.ts` / `slack.ts` (transports), `commands.ts` (the verbs), `api.ts` (local API
client), `index.ts` (fan-out + listener supervision).

Two properties are deliberate:

- **Commands drive the HTTP API, not the DB.** A command from chat takes the same path a
  click in the dashboard takes, so the side effects that live in the route handlers —
  relaunching an agent on feedback, resuming a task on approval, delegation roll-up on
  done — happen identically. No second implementation to drift.
- **Config is read live from `~/.mission-control/.env`, per event and per supervise
  tick.** The launchd-run server never loads that file into its environment, and editing
  Settings must not require a restart: restarting drops in-flight agent work.

## Events that reach chat

| Scope | Types |
|---|---|
| `action` (default) | `needs_human`, `awaiting_approval`, `new_triage_question`, `agent_exited`, `agent_stalled`, `task_completed` |
| `all` | adds `delegated`, `subtask_completed`, `parent_resumed`, `checkpoint_resolved`, `objective_created`, `objective_scope_approved` |
| never | `progress`, `liveness`, `settings_updated` — at any scope |

Deduped per (surface, type, task) with a 60s window, because a flapping condition
otherwise becomes 177 messages — the MET-536 "✅ Completed" incident is why that ledger
exists.

## Commands

A **ref** is a short task id (`0e46593f`), a Linear key (`MET-639`), or a piece of the
title. Ambiguous refs are reported, never guessed.

| Command | What it does |
|---|---|
| `/status` | board counts, pending approvals, tickets with unanswered questions |
| `/tasks [status]` | list tasks; bare = the ones where a human is the bottleneck |
| `/task <ref>` | one ticket: status, triage progress, next question, recent activity |
| `/answer <ref> <text>` | answers the next open triage question; on a review/testing ticket it lands as `manual_feedback` (which relaunches the agent), in planning as `planning_answer` |
| `/confirm <ref>` | confirm triage once every question is answered — this is what starts the work |
| `/checkpoints` | pending approvals with their prompts |
| `/approve [ref] [note]` | resolve a checkpoint; the ref is optional when exactly one is pending |
| `/deny <ref> <reason>` | reject it — the reason is required, since that is what the agent acts on |
| `/followup <ref> <action>` | queue a canned follow-up + relaunch: `review_comments`, `merge_conflicts`, `ci_lint`, `rebuild_design` |
| `/preview <ref>` | start a local preview of the ticket's branch |
| `/done <ref> [reason]` | close a ticket |
| `/agents` | roster and status |

`/answer` is one verb on purpose: in chat you type your input and expect the system to
know where it belongs. The status decides — that mirrors the dashboard's note box exactly.

Ordinary chatter gets no reply; an unrecognised `/command` gets pointed at `/help`.

## Setup — Telegram

1. `@BotFather` → `/newbot` → copy the token.
2. Message your new bot once, then get your chat id from `@userinfobot`.
3. Settings (⚙) → **Message bus — Telegram**: paste token + chat id, set interaction to
   **Command**, hit **Send test message**.

Env keys: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_CHAT_IDS`, `TELEGRAM_INTERACTION`
(`off|notify|command`), `TELEGRAM_EVENTS` (`action|all`).

## Setup — Slack (DM-scoped)

1. Create a Slack app with a **bot user**. Bot scopes: `chat:write`, `im:write`,
   `im:history`.
2. For commands, enable **Socket Mode** and generate an **app-level token** (`xapp-`,
   scope `connections:write`), plus event subscription `message.im`.
3. Get your own user id (Slack profile → ⋮ → Copy member ID, `U…`).
4. Settings → **Message bus — Slack DM**: paste both tokens + your user id, **Send test**.

Env keys: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_ALLOWED_USER_IDS`,
`SLACK_INTERACTION`, `SLACK_EVENTS`.

Socket Mode is not a preference. Mission Control binds to `127.0.0.1` and runs agents
with `--dangerously-skip-permissions`; the Events API would require exposing that box to
the internet. Socket Mode is an outbound WebSocket — no tunnel, no inbound port.

## Security model

- **Allowlist is the authorization.** Telegram chat ids / Slack user ids on the list can
  command; everything else is dropped silently (a reply would confirm the bot exists).
- Inbound only runs at `interaction=command`; `notify` is outbound-only, `off` is silent.
- Slack input is accepted **only from DMs** (`channel_type=im`). Channels are excluded
  precisely because anyone in a channel could otherwise click an approve — the identity
  and scopes work that makes channels safe is the `docs/slack-adaptor.md` phase.
- Slack envelopes are acked immediately and deduped by `event_id`; Telegram updates are
  primed past the existing backlog on start, so a stale `/done` from yesterday is never
  replayed.

## Operational notes

- **One poller per bot token.** Telegram `getUpdates` splits updates between competing
  pollers, so two Mission Controls (this Mac and macbot) must not run the bus on the same
  token — the log says so explicitly on a 409. Same rule as the Linear pipeline.
- Both listeners live in the server process, supervised on a 15s tick: change a token or
  switch interaction mode in Settings and the listener restarts itself.
- Failures are best-effort and logged (`[messagebus] …` in `mc-server.launchd.log`); a
  blocked bot or a revoked token never takes the server down.
