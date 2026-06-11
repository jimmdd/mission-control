# Mission Control

Mission Control is a **standalone command center for autonomous coding agents**.

It gives you a single place to:

- track tasks and task state
- orchestrate agent work across repos
- monitor running agents in tmux
- review artifacts and activity logs
- manage reusable project knowledge with Context Fabrica
- plug in external systems like Linear, GitHub, or OpenClaw **without making them part of the core runtime**

Mission Control is designed to be the **system of record for internal agent lifecycle**, while trackers, chat systems, and PR sync stay as optional integrations.

---

## What it does

Mission Control runs a practical agent workflow:

`task intake → triage → plan → execute → verify → review → complete`

It is built for teams running real coding agents, not just prompt demos.

### Core capabilities

- **Task lifecycle management**
  - tasks, workspaces, priorities, task types, deliverables, and activity history
- **Agent orchestration**
  - spawn agents in isolated git worktrees
  - track active sessions and retries
  - re-launch work on human feedback
  - choose agent profiles and models at runtime
- **Operational visibility**
  - dashboard for tasks, swarm status, health, and system stats
  - CLI for task operations and swarm session monitoring
- **Knowledge system**
  - Context Fabrica-backed storage for notes, facts, and procedural skills
  - repo exploration and distilled learnings from completed work
- **Review loop support**
  - GSD Core planning and verification artifacts
  - PR-aware orchestration for local swarm runtime
- **Standalone-first architecture**
  - external ticketing, PR sync, and gateway/chat systems live under `integrations/`

---

## Why this structure matters

Mission Control treats the **internal agent state machine** as core:

- task status
- agent assignment
- retries
- review transitions
- deliverables
- session tracking
- human escalation state

External tools like Linear or GitHub are useful, but they should not own the lifecycle. They are adapters around the core, not the core itself.

---

## Architecture

Mission Control runs as a standalone service on port `18790` by default.

```text
┌─────────────────────────────────────────────────────────────┐
│ Mission Control                                             │
│  ├── HTTP API (/api/*)                                      │
│  ├── Dashboard (/, /dashboard, /space)                      │
│  ├── CLI (./mc)                                             │
│  ├── SQLite task state                                      │
│  └── Local swarm runtime orchestration                      │
├─────────────────────────────────────────────────────────────┤
│ Context Fabrica                                             │
│  ├── knowledge records                                      │
│  ├── embeddings                                             │
│  └── graph-aware retrieval                                  │
├─────────────────────────────────────────────────────────────┤
│ Local swarm runtime                                         │
│  ├── planner / bridge                                       │
│  ├── GSD Core backend adapter                               │
│  ├── tmux agent sessions                                    │
│  ├── repo watcher                                           │
│  └── worktrees, prompts, progress, review loops             │
└─────────────────────────────────────────────────────────────┘
```

By default, local runtime files live under:

```text
~/.mission-control/
```

---

## How it works

```text
Task intake
  ↓
Bridge triage
  ↓
Planner creates structured execution plan
  ↓
Agent runtime executes in isolated worktree
  ↓
GSD Core verification + review loop
  ↓
Artifacts stored as deliverables
  ↓
Task moves to review / done
```

Human feedback can re-enter the system through Mission Control itself, and the swarm can be re-launched from internal state without relying on an external ticketing system.

---

## Dashboard

Mission Control ships with a built-in dashboard:

- `/` or `/dashboard` — main command center
- `/space` — operational space view

The dashboard gives you:

- task grid with status and priority
- task drawer with full activity and deliverables
- swarm/agent heartbeat visibility
- system stats
- knowledge browsing and review views

---

## CLI

Mission Control also ships with a local CLI.

### Example commands

```bash
# list tasks
./mc tasks list --status inbox

# create a task interactively
./mc tasks create --interactive

# create a task with GSD-oriented prompts for acceptance criteria and verification
./mc tasks gsd --interactive

# inspect a task
./mc tasks get <task-id>
./mc tasks activities <task-id>

# work with knowledge
./mc knowledge list --project myorg --repo backend-api
./mc knowledge add --interactive
./mc knowledge doctor
./mc knowledge recall --query "deploy worktree failure" --project myorg --repo backend-api
./mc knowledge reembed --schema mission_control
./mc knowledge share <record-id>

# watch the swarm
./mc swarm sessions
./mc swarm attach <task-id>
./mc swarm monitor

# operational views
./mc services health
./mc board --json
```

The CLI talks to the same standalone API as the dashboard.

Environment:

```bash
MISSION_CONTROL_URL=http://127.0.0.1:18790
```

The bridge claims inbox work through a durable task lease so multiple bridge
processes do not dispatch the same task. The default lease is 15 minutes and
can be tuned with:

```bash
MISSION_CONTROL_BRIDGE_OWNER=bridge-host-a
MISSION_CONTROL_BRIDGE_LEASE_SECONDS=900
```

`./mc services health` reports service liveness plus local runtime readiness
for tools such as `tmux`, `git`, `gh`, Node/npm, model keys, PostgreSQL, and
context-fabrica knowledge diagnostics.

---

## Model and agent configuration

Mission Control is not limited to one hosted model or one agent runtime. It supports:

- planner models by provider (`anthropic`, `gemini`, `ollama`)
- agent **profiles** for the swarm runtime
- per-profile model selection
- per-profile env injection for local or OpenAI-compatible backends

The key idea is:

- the **planner** chooses a profile name for a step
- the **swarm runtime** launches the matching profile
- relaunches, retries, and review cycles keep using the same profile and model metadata

### Example agent profiles

```json
{
  "agents": {
    "defaultProfile": "pi",
    "profiles": {
      "pi": {
        "launcher": "pi",
        "provider": "google",
        "model": "google/gemini-2.5-pro",
        "thinking": "high",
        "maxAgents": 5,
        "fallbackProfile": "codex",
        "env": {}
      },
      "claude": {
        "launcher": "claude",
        "model": "claude-opus-4-6",
        "maxAgents": 10,
        "fallbackProfile": "codex",
        "env": {}
      },
      "codex": {
        "launcher": "codex",
        "model": "gpt-5.4",
        "effort": "medium",
        "maxAgents": 3,
        "env": {}
      },
      "ollama-local": {
        "launcher": "codex",
        "model": "qwen2.5-coder:14b",
        "maxAgents": 2,
        "env": {
          "OPENAI_BASE_URL": "http://127.0.0.1:11434/v1",
          "OPENAI_API_KEY": "ollama"
        }
      }
    }
  }
}
```

### Notes on Ollama

Mission Control now supports **Pi as a built-in agent profile** and also supports configuring local-model agent profiles, including Ollama-compatible setups, by passing profile-specific environment variables through spawn and relaunch flows.

That means Mission Control itself is agent/model agnostic at the orchestration layer.

Whether a given runtime can actually use a local model depends on the launcher you choose:

- `launcher: "pi"` → Pi CLI runtime
- `launcher: "claude"` → Claude CLI runtime
- `launcher: "codex"` → Codex CLI runtime

If your CLI runtime supports OpenAI-compatible endpoints, you can point it at Ollama with profile `env` values like:

```json
{
  "OPENAI_BASE_URL": "http://127.0.0.1:11434/v1",
  "OPENAI_API_KEY": "ollama"
}
```

So Mission Control is now **profile-driven**, even if the final capability still depends on the launcher runtime you attach.

If you already have `pi` installed, Mission Control can use it out of the box as the default agent profile.

---

## GSD backend

Mission Control currently targets **GSD Core** through a small backend adapter in `swarm/gsd_backend.py`.

Supported backend:

```bash
MISSION_CONTROL_GSD_BACKEND=core
```

In `core` mode, Mission Control prompts agents to use the maintained `@opengsd/gsd-core` command surface:

- `/gsd:plan-phase --prd`
- `/gsd:execute-phase`
- `/gsd:verify-work`
- `/gsd:plan-phase --gaps`
- `/gsd:new-project --auto` for greenfield work

The monitor and knowledge distiller expect GSD Core artifacts under `.planning/`, especially:

- `.planning/phases/*/*-PLAN.md`
- `.planning/phases/*/*-VERIFICATION.md`
- `.planning/SUMMARY.md`

If `MISSION_CONTROL_GSD_BACKEND` is set to anything other than `core`, the monitor fails closed instead of pretending the artifacts are valid. This leaves a clean path for a future `gsd-pi` adapter, which will need to read `.gsd` state and use Pi's command/runtime model rather than GSD Core's `.planning` files.

---

## Knowledge system

Mission Control uses **Context Fabrica** for durable operational memory.

Mission Control uses the installed `context-fabrica` package directly, but it defaults to a separate Postgres schema:

```bash
CONTEXT_FABRICA_SCHEMA=mission_control
CONTEXT_FABRICA_EMBEDDING_MODEL=gemini-embedding-001
CONTEXT_FABRICA_EMBEDDING_DIMENSIONS=1536
CONTEXT_FABRICA_INCLUDE_EXISTING=true
CONTEXT_FABRICA_EXISTING_SCHEMA=context_fabrica
CONTEXT_FABRICA_EXISTING_EMBEDDER=fastembed
CONTEXT_FABRICA_EXISTING_EMBEDDING_DIMENSIONS=384
```

This avoids clobbering an existing Context Fabrica installation while still letting Mission Control read from it. Mission Control writes its own knowledge to `mission_control` with Gemini 1536-dimension embeddings, then also queries the existing `context_fabrica` schema read-only with the local embedder/dimension configured above. Sharing a write schema with a different embedding dimension can create pgvector dimension conflicts, so use separate schemas when changing models or dimensions.

For existing-schema read-through, install the same local embedder dependency used to create that schema's vectors. The default assumes Context Fabrica's local FastEmbed/MiniLM path.

Canonical Mission Control knowledge can also be explicitly copied into the shared Context Fabrica schema so agents using the Context Fabrica MCP directly can recall it:

```bash
./mc knowledge share <record-id>
```

The dashboard exposes the same action as **SHARE** on canonical knowledge entries. Sharing re-embeds the record with the shared schema's configured embedder and writes it to `CONTEXT_FABRICA_EXISTING_SCHEMA`.

### Knowledge sources

- codebase exploration
- linked docs / contextual references
- task completion artifacts
- research findings
- manual injection from CLI or API
- cross-repo architecture scans

### Knowledge tiers

- **Developer Notes** — human-authored guidance
- **Procedural Skills** — workflows distilled from complex tasks
- **Atomic Facts** — compact reusable findings

### Codebase explorer examples

```bash
mc-explore myorg/backend-api
mc-explore myorg/backend-api --focus "API endpoints"
mc-explore myorg/platform --package api
mc-explore myorg/backend-api --dry-run
  mc-explore myorg/backend-api --trust
```

### Knowledge operations

Mission Control includes operational checks for the memory layer:

```bash
# Check configured vs actual pgvector dimensions for write/read schemas
./mc knowledge doctor

# Inspect what would be recalled, including source schema and score
./mc knowledge recall --query "auth middleware retry loop" --project myorg --repo backend-api

# Rebuild Mission Control vectors after changing embedding model or dimensions
./mc knowledge reembed --schema mission_control

# Copy reviewed Mission Control knowledge into shared Context Fabrica MCP memory
./mc knowledge share <record-id>
```

The dashboard also exposes recall diagnostics in the Knowledge Base panel and
shows a `SHARED` badge for canonical records copied into shared Context Fabrica.

---

## API

All standalone endpoints are served under:

```text
/api/
```

### Main endpoint groups

- `tasks`
- `activities`
- `deliverables`
- `workspaces`
- `agents`
- `agent-status`
- `board`
- `system-stats`
- `services/health`
- `knowledge`
- `repos`
- `stream` (server-sent events)

Mission Control’s core API is standalone and tracker-agnostic.

### Live coordination

Beyond the task lifecycle, Mission Control surfaces what agents are doing in
real time and lets them coordinate:

- **Structured progress** — agents/bridge report `state`, `phase`, current
  step, and a `blocked_reason` via `PUT /api/tasks/:id/progress`. The board
  shows this per task (and a `blockedAgents` count) instead of only a heartbeat.
- **Agent-to-agent delegation** — a blocked or specializing agent can spin up a
  focused subtask with `POST /api/tasks/:id/delegate` (`{ "wait": true }` pauses
  the parent until children finish, then auto-resumes it). `GET
  /api/tasks/:id/children` lists subtasks with their progress.
- **Reactive event stream** — `GET /api/stream` is a server-sent-events feed of
  progress, delegation, completion, and agent-liveness events, so the dashboard
  updates without polling.
- **Liveness detection** — a built-in reaper flags dead (tmux gone) or stalled
  (no heartbeat) agents within seconds, marking the task blocked and emitting an
  event, rather than waiting for the monitor cron. Tunable via
  `MISSION_CONTROL_REAPER_INTERVAL_MS` / `MISSION_CONTROL_STALE_HEARTBEAT_MS`,
  or disable with `MISSION_CONTROL_DISABLE_REAPER=1`.

---

## Setup

### Prerequisites

- Node.js 22+
- PostgreSQL 17 + pgvector
- Python 3.12+
- Context Fabrica installed

### Install

```bash
git clone https://github.com/jimmdd/mission-control.git
cd mission-control
npm install

brew install postgresql@17 pgvector
brew services start postgresql@17
createdb context_fabrica
psql -d context_fabrica -c "CREATE EXTENSION IF NOT EXISTS vector;"

pip install context-fabrica

mkdir -p ~/.mission-control
cat >> ~/.mission-control/.env << 'EOF'
CONTEXT_FABRICA_DSN=postgresql://$(whoami)@localhost/context_fabrica
CONTEXT_FABRICA_SCHEMA=mission_control
CONTEXT_FABRICA_EMBEDDING_MODEL=gemini-embedding-001
CONTEXT_FABRICA_EMBEDDING_DIMENSIONS=1536
CONTEXT_FABRICA_INCLUDE_EXISTING=true
CONTEXT_FABRICA_EXISTING_SCHEMA=context_fabrica
CONTEXT_FABRICA_EXISTING_EMBEDDER=fastembed
CONTEXT_FABRICA_EXISTING_EMBEDDING_DIMENSIONS=384
MISSION_CONTROL_GSD_BACKEND=core
GOOGLE_GENERATIVE_AI_API_KEY=your-gemini-key
ANTHROPIC_API_KEY=your-anthropic-key
MISSION_CONTROL_URL=http://127.0.0.1:18790
EOF
```

The knowledge and health endpoints shell out to the Python scripts under
`swarm/` and `health/`. By default the server runs the copies shipped in this
repo using `python3` on your `PATH`, so a plain `pip install context-fabrica`
into that interpreter is enough — no separate copy into `~/.mission-control` is
required. If you prefer an isolated interpreter, set `MC_PYTHON_BIN` (or place a
venv at `~/.mission-control/venv-3.12`, which is auto-detected). Set `MC_HOME`
only if you keep runtime scripts outside the checkout.

Mission Control uses the installed `context-fabrica` package, but defaults to a
separate Postgres schema (`mission_control`) so its Gemini embeddings do not
alter or conflict with an existing context-fabrica schema. It also reads from
the existing `context_fabrica` schema by default, without bootstrapping or
writing to that schema. Set `CONTEXT_FABRICA_SCHEMA` explicitly if you want to
use a different write schema.
Set `CONTEXT_FABRICA_EMBEDDING_DIMENSIONS` to change the vector size, but do
that before indexing records; an existing schema should be re-embedded after a
dimension change.

Mission Control currently uses the maintained `@opengsd/gsd-core` package for
agent planning and verification. The `core` backend expects agents to produce
GSD Core `.planning/` artifacts and run commands such as `/gsd:plan-phase`,
`/gsd:execute-phase`, and `/gsd:verify-work`. `MISSION_CONTROL_GSD_BACKEND`
defaults to `core`; `gsd-pi` will need a separate adapter because it uses `.gsd`
state and a different command/runtime model.

### Start the service

```bash
npm start

# verify
curl http://localhost:18790/health
open http://localhost:18790/
```

Mission Control binds to `127.0.0.1` by default. For normal local use, no token
is required. If you expose it beyond localhost, set one shared token:

```bash
export MISSION_CONTROL_ACCESS_TOKEN="use-a-long-random-value"
```

Clients can pass it as `Authorization: Bearer ...` or `?token=...`. The older
`MISSION_CONTROL_READ_ACCESS_TOKEN` name still works for compatibility.

### Built-in protections

Even with no token, the default localhost deployment is hardened against the
common ways a browser can be tricked into reaching a local service:

- **DNS-rebinding protection** — requests are only served when the `Host`
  header is an allowlisted name (`127.0.0.1`, `localhost`, `::1`, plus
  `MC_HOST`). A malicious site that rebinds its DNS to `127.0.0.1` still sends
  its own hostname and is rejected.
- **CSRF protection** — state-changing requests (`POST`/`PATCH`/`PUT`/`DELETE`)
  from a cross-site browser context are blocked via `Sec-Fetch-Site`/`Origin`
  checks. Same-origin dashboard calls and non-browser clients (CLI, bridge,
  curl) are unaffected.
- **SSRF protection** — the knowledge `fetch-url` endpoint resolves the target
  host and refuses loopback/private/link-local addresses, including
  integer-encoded IP literals and redirects that point back inside the network.

If you expose Mission Control under a custom hostname (e.g. behind a reverse
proxy), add it to the Host allowlist:

```bash
export MISSION_CONTROL_ALLOWED_HOSTS="mc.internal.example.com"
```

Team installs can opt into scoped tokens only when needed:

```bash
export MISSION_CONTROL_AUTH_MODE=scoped
export MISSION_CONTROL_READ_TOKEN="read"
export MISSION_CONTROL_WRITE_TOKEN="write"
export MISSION_CONTROL_ADMIN_TOKEN="admin"
export MISSION_CONTROL_WEBHOOK_SECRET="webhook"
```

Unset scoped tokens fall back to the shared token, so simple one-token installs
stay simple.

---

## Development

```bash
npm install          # first time (rebuilds the native better-sqlite3 binding)
npm run build        # typecheck (tsc --noEmit)
npm test             # behavioral test suite (node --test)
```

If `npm test` fails to load `better-sqlite3` with a `NODE_MODULE_VERSION`
mismatch after switching Node versions, run `npm rebuild better-sqlite3`.
GitHub Actions runs build + tests on every push and pull request.

---

## Project structure

```text
mission-control/
├── server.ts
├── package.json
├── public/
├── src/
│   ├── cli.ts
│   ├── db.ts
│   ├── routes.ts
│   ├── events.ts        # in-process event bus (SSE)
│   └── reaper.ts        # agent liveness detection
├── tests/
├── health/
├── swarm/
│   ├── gsd_backend.py
│   ├── context_fabrica_config.py
│   ├── bridge.py
│   ├── planner.py
│   └── check-agents.sh
└── integrations/
    ├── github/
    ├── linear/
    └── openclaw/
```

### Core vs integrations

**Core**
- task state
- dashboard
- CLI
- local swarm orchestration
- structured agent progress, delegation, and a reactive event stream
- Context Fabrica integration
- GSD Core backend adapter
- task artifact harvesting and knowledge distillation

**Integrations**
- issue trackers
- PR review sync
- gateways/chat systems
- optional OpenClaw adapter

---

## Optional integrations

Mission Control is intentionally **standalone-first**.

Optional adapters live under:

```text
integrations/
```

Current integration areas:

- `integrations/linear/`
- `integrations/github/`
- `integrations/openclaw/`

These can create tasks, sync comments, or react to review events, but the internal Mission Control lifecycle remains authoritative.

---

## Dependencies

- **[context-fabrica](https://github.com/TaskForest/context-fabrica)** — knowledge storage and retrieval
- **[@opengsd/gsd-core](https://github.com/open-gsd/gsd-core)** — current GSD planning and verification backend
- **better-sqlite3** — local task database
- **Gemini API** — embeddings and knowledge extraction
- **Anthropic API** — planning and agent support

---

## License

MIT
