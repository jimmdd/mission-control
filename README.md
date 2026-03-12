# Mission Control

OpenClaw embedded plugin for managing autonomous AI agent swarms. Provides task management, a real-time command center dashboard, and agent tools — all backed by SQLite.

Built to orchestrate [Hive Claw](https://github.com/jimmdd), an autonomous coding pipeline: Linear ticket → triage → agent spawn → code → review → iterate → PR → merge → done.

## How It Works

```
Linear (ticket created)
  │
  ▼
Linear Sync ─────────────────── pulls tickets with `hiveclaw` label
  │                              into Mission Control as tasks
  ▼
Bridge (triage) ─────────────── asks codebase-aware questions,
  │                              posts to Linear, waits for answers
  ▼
Bridge (dispatch) ───────────── splits multi-repo tasks into children,
  │                              spawns agents per repo
  ▼
Agent (Claude / Codex) ──────── works in git worktree, writes code,
  │                              runs tests, creates PR
  ▼
Check-Agents (monitor) ──────── detects PR, runs Codex review,
  │                              iterates if blocking issues found
  ▼
Watch-PR-Reviews ────────────── polls GitHub for human review comments
  │                              and approvals, relaunches agent on feedback
  ▼
Linear Sync (done) ──────────── detects Linear ticket closed → marks
                                 MC parent + children as done
```

### Dashboard

The command center dashboard (`/ext/mission-control/`) provides real-time visibility:

- **Pipeline bar** — INTAKE → TRIAGE → DISPATCH → SWARM OPS → REVIEW → COMPLETE
- **Telemetry strip** — Swarm pressure (agent slots), active agents, 24h throughput, CPU/memory, last event
- **Task card grid** — 3-4 cards per row with status badges, agent indicators, milestone progress, priority highlights
- **Process graph** — Collapsible node graph showing parent → child task hierarchy with horizontal lifecycle timelines per child (PROMPT → SPAWN → REVIEW → PR FEEDBACK → LINEAR DONE)
- **Task drawer** — Click any card for full details: description, triage Q&A, agent info, activity log with expandable prompts

### Agent Tools

Agents interact with Mission Control through registered tools:

| Tool | Description |
|------|-------------|
| `mc_create_task` | Create a new task with title, description, priority |
| `mc_list_tasks` | List tasks with optional status/workspace filters |
| `mc_update_task` | Update task status, priority, description, assignment |
| `mc_delete_task` | Remove a task |
| `mc_log_activity` | Log an activity entry on a task |
| `mc_list_workspaces` | List available workspaces |
| `mc_create_workspace` | Create a new workspace |

### API Endpoints

All endpoints are served under `/ext/mission-control/api/`:

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/tasks` | List tasks (query: `status`, `workspace_id`, `assigned_agent_id`) |
| POST | `/tasks` | Create task |
| GET | `/tasks/:id` | Get task by ID |
| PATCH | `/tasks/:id` | Update task |
| DELETE | `/tasks/:id` | Delete task |
| GET | `/tasks/:id/activities` | List task activities |
| POST | `/tasks/:id/activities` | Log activity |
| GET | `/tasks/:id/deliverables` | List task deliverables |
| POST | `/tasks/:id/deliverables` | Add deliverable |
| GET | `/tasks/:id/triage` | Get triage state |
| PUT | `/tasks/:id/triage` | Replace triage state |
| PATCH | `/tasks/:id/triage` | Merge-update triage state |
| POST | `/tasks/:id/status` | Transition task status with event logging |
| GET | `/agents` | List agents |
| POST | `/agents` | Create agent |
| GET | `/agents/:id` | Get agent |
| PATCH | `/agents/:id` | Update agent |
| DELETE | `/agents/:id` | Delete agent |
| GET | `/workspaces` | List workspaces |
| POST | `/workspaces` | Create workspace |
| GET | `/workspaces/:id` | Get workspace |
| PATCH | `/workspaces/:id` | Update workspace |
| DELETE | `/workspaces/:id` | Delete workspace |
| GET | `/events` | List events (query: `since`, `limit`) |
| POST | `/events` | Create event |
| GET | `/sessions` | List sessions |
| POST | `/sessions` | Create session |
| GET | `/agent-status` | Live agent status with tmux session detection |
| GET | `/system-stats` | CPU load and memory usage |

## Setup

### Prerequisites

- [OpenClaw](https://github.com/openclaw-ai/openclaw) gateway running locally
- Node.js 20+
- SQLite (bundled via `better-sqlite3`)

### Install

```bash
# Clone into your OpenClaw plugins directory
cd ~/GitProjects/openclaw-plugins
git clone https://github.com/jimmdd/mission-control.git
cd mission-control
npm install

# Verify TypeScript compiles
npm run build
```

### Register with OpenClaw

Add to your OpenClaw gateway config (`~/.openclaw/config.yaml`):

```yaml
plugins:
  - path: ~/GitProjects/openclaw-plugins/mission-control
    config:
      dbPath: ~/.openclaw/mission-control/mc.db
```

Restart the gateway:

```bash
launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway
```

### Verify

```bash
# Dashboard should load at:
open http://localhost:18789/ext/mission-control/

# API should respond:
curl http://localhost:18789/ext/mission-control/api/tasks
```

## Swarm Infrastructure

Mission Control is the central hub. The surrounding scripts live in `~/.openclaw/swarm/`:

| Component | Path | Interval | Purpose |
|-----------|------|----------|---------|
| Linear Sync | `~/.openclaw/sync/linear-sync.py` | 300s | Sync tickets from Linear, detect done state |
| Bridge | `~/.openclaw/bridge/hiveclaw-bridge.py` | 60s | Triage tasks, spawn agents, handle Q&A |
| Agent Monitor | `~/.openclaw/swarm/check-agents.sh` | 120s | Health checks, Codex reviews, retry logic |
| PR Watcher | `~/.openclaw/swarm/watch-pr-reviews.sh` | 120s | Detect GitHub review comments and approvals |
| Agent Launcher | `~/.openclaw/swarm/run-claude.sh` | On-demand | Launch Claude with prompt, retry, cost controls |
| Spawn Script | `~/.openclaw/swarm/spawn-agent.sh` | On-demand | Create worktree, register agent, start tmux |

### Concurrency

- Max 10 Claude Code agents (Claude Max subscription)
- Max 3 Codex agents (fallback when Claude slots full)
- Agents run in tmux sessions for isolation
- Each agent gets its own git worktree

## Project Structure

```
mission-control/
├── index.ts                 # Plugin entry point
├── openclaw.plugin.json     # Plugin manifest
├── package.json
├── tsconfig.json
├── public/
│   └── index.html           # Dashboard (single-file vanilla HTML/CSS/JS)
└── src/
    ├── db.ts                # SQLite schema, CRUD operations
    ├── routes.ts            # HTTP API + dashboard serving
    ├── tools.ts             # Agent-callable tools
    └── shims.d.ts           # Type shims
```

## License

MIT
