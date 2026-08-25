# Message bus — the chat interface

> Status: **shipped.** Telegram and Slack DM, outbound alerts and inbound commands;
> allowlisted Slack channel mentions can create tickets whose replies stay linked to
> the ticket. Actor identity, broad channel ingestion, and approve buttons remain design work.

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
| `action` (default) | `needs_human`, `awaiting_approval`, `new_triage_question`, `agent_exited`, `agent_stalled`, `task_completed` (only when the ticket becomes `done`) |
| `all` | adds `delegated`, `subtask_completed`, `parent_resumed`, `checkpoint_resolved`, `objective_created`, `objective_scope_approved` |
| never | `progress`, `liveness`, `settings_updated` — at any scope |

## What an alert looks like

```
🔔 MET-639 needs you
metalex for new ui
The launch flow spans two repos — which one owns the MetaLeX step?
https://linear.app/organizationtechnology/issue/MET-639/metalex-step-validation…
↳ /task MET-639
```

Key, title, what happened, the Linear link, and a command you can type back. An alert
that only carried a UUID prefix answered neither "which ticket" nor "what do I do", so
the bus resolves the task (`db.getTask`, synchronously — an alert must not wait on a
round trip) and degrades to the short id only when it cannot.

Deduped per (surface, type, task) with a 60s window, because a flapping condition
otherwise becomes 177 messages — the MET-536 "✅ Completed" incident is why that ledger
exists.

## Commands

A **ref** is a Linear key — `MET-639`, or loosely as `met 639` / `met639` / `met-639` —
or a piece of the title (a short task id still works, but nothing asks you for one).
Ambiguous refs are reported, never guessed.

Nothing user-facing prints a UUID: every listing, alert and reply names a ticket by its
Linear key and title, and every ref the bot suggests can be typed back verbatim.

| Command | What it does |
|---|---|
| `/status` | board counts, pending approvals, tickets with unanswered questions |
| `/create [TEAM] <title> \| <description>` | create the Linear issue and linked MC task together. `TEAM` is optional when `LINEAR_CREATE_TEAM_KEY` is configured; Telegram delivery retries resolve the same issue instead of duplicating it. Put exactly one GitHub PR URL in the description to hand off that open draft/ready PR to the engineer; MC reuses its head branch and PR instead of creating another one |
| `/tasks [status]` | list tickets; bare = the ones where a human is the bottleneck; a non-status argument is treated as a search |
| `/search <words>` | keyword search over key, title and description — every word must match, so more words narrow. `/find` is an alias. Title hits and open tickets rank first |
| `/task <ref>` | one ticket: status, triage progress, next question, recent activity |
| `/answer <ref> <text>` | answers the next open triage question; on a review/testing ticket it lands as `manual_feedback` (which relaunches the agent), in planning as `planning_answer` |
| `/confirm <ref>` | confirm triage once every question is answered — this is what starts the work |
| `/checkpoints` | pending approvals, numbered, each named by its ticket |
| `/approve [ref] [note]` | resolve one: by ticket (`/approve MET-639`), by list number (`/approve 2`), or bare when exactly one is pending. The reply echoes the prompt it resolved, so a mis-aimed number is visible immediately |
| `/deny <ref> <reason>` | reject it — the reason is required, since that is what the agent acts on. A bare `/deny wrong repo` is read as a reason, not a ref |
| `/followup <ref> <action>` | queue a canned follow-up + relaunch: `review_comments`, `merge_conflicts`, `ci_lint`, `rebuild_design` |
| `/preview <ref>` | start a local preview of the ticket's branch |
| `/hold <ref>` | pause an active ticket while preserving its plan, history, branch, and worktree; repeated holds are safe, and completed tickets stay done |
| `/unhold <ref>` | move a held ticket back to `inbox` so normal dispatch can resume it; active and completed tickets are left unchanged |
| `/done <ref> [reason]` | close a ticket |
| `/agents` | roster and status |

### Direct one-shot work (Telegram only)

`/run <claude|codex> <repo> <instruction>` launches the named agent directly in an
isolated worktree. For example:

```
/run codex backend fix the flaky mobile-wallet reconnect integration test
/run claude staging-dashboard review PR 740 and report critical findings
```

The repository must be in `REPO_WATCH_REPOS`. The command creates no Mission Control or
Linear ticket, acknowledges immediately, and a detached worker posts the final agent
report back to the originating Telegram chat. Delivery retries reuse the same job id,
so one Telegram update cannot launch duplicate work.

This command is outside the transport-agnostic command table on purpose. It is private-
Telegram-DM-only: Telegram groups, Slack DMs, and Slack channels have no route to the
runner; Slack `/help` does not advertise it, and a Slack `/run` receives the ordinary
unknown-command response. The coding-agent child process
also has Telegram, Slack, Mission Control, and Linear control credentials removed from
its environment; only the detached reporter retains the Telegram token.

`/answer` is one verb on purpose: in chat you type your input and expect the system to
know where it belongs. The status decides — that mirrors the dashboard's note box exactly.

The review monitor permits three automated `review_comments` fix rounds for an open PR.
If fresh actionable feedback arrives for a fourth round, Mission Control moves the ticket
to `on_hold`, records a `needs_human` checkpoint, and sends the normal action alert instead
of relaunching again. After reviewing the loop, `/unhold <ref>` returns it to dispatch.

An unrecognised `/command` gets pointed at `/help`.

For chat-created tickets, set `LINEAR_INTERACTION=updates` (or `full`),
`LINEAR_CREATE_TEAM_KEY`, and optionally `LINEAR_CREATE_ASSIGNEE`. The command replies
with the new Linear key and URL; normal triage-question and lifecycle sync starts from
that point.

## Talking to it (Telegram only)

Anything that is not a command goes to an assistant, because in chat you expect to be able
to just say what you mean:

```
  → what's blocked right now?
  ← The following tickets are waiting for a human answer to proceed:
    - MET-635: Implement brand guideline changes from Paper prototype
    - MET-597: merge accounting into backoffice
    …

  → what is MET-635 stuck on?
  ← MET-635 is stuck because the agent cannot access the attached HTML file and
    linked zip. It needs you to provide the content or clarify how to proceed.

  → tell 639 to use UTC everywhere
  ← Okay, I'll tell MET-639 to use UTC everywhere.
    → /answer MET-639 use UTC everywhere
    Confirm? /yes · /no
```

**The model never touches the board.** It answers from a board snapshot, and when an ask
implies an action it proposes one of the existing commands — which then runs through the
same command layer a typed command would. Reads (`/status`, `/tasks`, `/search`, `/task`,
`/checkpoints`, `/agents`) run immediately, since a confirmation before showing a list is
friction with no safety value. Every **write** waits for `/yes`, expires after 5 minutes,
and is single-slot per chat so `/yes` can never resolve something older than the last
thing discussed.

That gate is the security boundary, and it is why ticket content cannot drive the system:
a malicious description can influence what the assistant *says*, but reaching a write
still needs a command a human confirmed. A proposed command that is not in the known set
is dropped rather than offered.

Provider selection is not duplicated here — `swarm/llm-call.py` routes through
`planner._call_llm`, so the assistant uses whatever the swarm is configured for (with its
OpenRouter fallback intact). One caveat worth knowing: the small/fast tier is a *thinking*
model, and a low token cap can be consumed entirely by thinking, returning a response with
no content at all — the floor here is 512 for that reason.

**Telegram only, deliberately.** Slack stays commands-only, so a stray Slack DM neither
spends a generation call nor proposes a write. Switch it off with
`TELEGRAM_ASSISTANT=off` (Settings → "Plain-text messages"), and plain text is ignored
as before.

## Setup — Telegram

1. `@BotFather` → `/newbot` → copy the token.
2. Message your new bot once, then get your chat id from `@userinfobot`.
3. Settings (⚙) → **Message bus — Telegram**: paste token + chat id, set interaction to
   **Command**, hit **Send test message**.

Env keys: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_CHAT_IDS`, `TELEGRAM_INTERACTION`
(`off|notify|command`), `TELEGRAM_EVENTS` (`action|all`), `TELEGRAM_ASSISTANT`
(`on|off`, default on — the natural-language fallback above).

## Setup — Slack (DMs + allowlisted ticket channels)

1. Create or update the Slack app from [`slack-app-manifest.json`](./slack-app-manifest.json).
   Its minimal scopes are `chat:write`, `im:write`, `im:history`, `app_mentions:read`,
   and `channels:history`; its events are `message.im`, `app_mention`, and
   `message.channels`.
2. Enable **Socket Mode** and generate an **app-level token** (`xapp-`, scope
   `connections:write`). Reinstall the app after adding scopes or event subscriptions.
3. Get your own user id (Slack profile → ⋮ → Copy member ID, `U…`).
4. Invite the bot to each public channel it may use. Copy each channel id from the
   channel's **View channel details → About** panel.
5. Settings → **Message bus — Slack**: paste both tokens, your user id, and the allowed
   channel ids; set interaction to **Command**, then **Send test**.

Env keys: `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_ALLOWED_USER_IDS`,
`SLACK_ALLOWED_CHANNEL_IDS`, `SLACK_INTERACTION`, `SLACK_EVENTS`.

### Channel behavior

- A top-level `@mission-control <request>` in an allowlisted public channel creates one
  inbox ticket and posts the ticket reference as a reply. The Slack root timestamp is
  the durable ticket-thread identity, so a retried mention cannot create a second task.
- Later replies in that thread go through the same input path as `/answer`: they answer
  open triage questions, become planning input, or become review feedback according to
  the ticket's current status.
- Top-level chatter, unallowlisted users, unallowlisted channels, bot messages, and
  replies in threads that Mission Control has not linked are ignored.
- Replies stay in-thread (`reply_broadcast=false`). Mission Control does not ingest the
  rest of the channel or treat a Slack conversation as an agent session.

Socket Mode is not a preference. Mission Control binds to `127.0.0.1` and runs agents
with `--dangerously-skip-permissions`; the Events API would require exposing that box to
the internet. Socket Mode is an outbound WebSocket — no tunnel, no inbound port.

## Security model

- **Allowlist is the authorization.** Telegram chat ids / Slack user ids on the list can
  command; Slack channel behavior additionally requires an exact channel id allowlist.
  Everything else is dropped silently (a reply would confirm the bot exists).
- **Direct execution is private-Telegram-DM-only.** `/run` is gated before the shared command layer,
  is limited to the repository execution allowlist and the exact `claude|codex` agent
  set, and reports only to its originating Telegram chat. Slack cannot invoke it.
- Inbound only runs at `interaction=command`; `notify` is outbound-only, `off` is silent.
- Slack commands are accepted from DMs. Public channels have the narrower ticket-thread
  contract above: an allowlisted user's mention creates or addresses a ticket, and only
  replies in that linked thread are ingested. Interactive approvals are still excluded.
- Slack envelopes are acked immediately and deduped by channel + message timestamp (with
  `event_id` as fallback); Telegram updates are
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
