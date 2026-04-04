# Mission Control

Standalone service + OpenClaw plugin for managing autonomous AI agent swarms. Provides task management, a real-time command center dashboard, knowledge management with graph-aware retrieval, service health monitoring, and agent tools.

Orchestrates an autonomous coding pipeline: Linear ticket → triage → plan → step-by-step execution → verify → PR → review → done.

## Architecture

Mission Control runs as a **standalone HTTP service** (port 18790) independent of the OpenClaw gateway. OpenClaw connects via a thin proxy plugin — MC stays up even when the gateway restarts.

```
┌─────────────────────────────────────────────────────────────┐
│ Mission Control (standalone, port 18790)                     │
│  ├── SQLite (tasks, activities, deliverables, workspaces)    │
│  ├── HTTP API (/ext/mission-control/api/*)                   │
│  ├── Dashboard UI (/ext/mission-control/)                    │
│  ├── Service Health Monitor                                  │
│  └── Knowledge Review UI                                     │
├─────────────────────────────────────────────────────────────┤
│ Context Fabrica (PostgreSQL + pgvector)                      │
│  ├── Knowledge records (218+ entries)                        │
│  ├── Embeddings (3072-dim Gemini)                            │
│  ├── Entity relations (645+ edges)                           │
│  └── Graph-aware retrieval                                   │
├─────────────────────────────────────────────────────────────┤
│ OpenClaw Gateway (port 18789)                                │
│  ├── Proxy plugin → MC API                                   │
│  ├── mc_* agent tools                                        │
│  ├── memory plugin → Context Fabrica                         │
│  └── Slack / Telegram channels                               │
└─────────────────────────────────────────────────────────────┘
```

## How It Works

```
Linear (ticket created)
  │
  ▼
Linear Sync ─────────────────── pulls tickets with a configured label
  │                              into Mission Control as tasks
  ▼
Bridge (triage) ─────────────── asks codebase-aware questions,
  │                              self-answers from codebase when possible,
  │                              extracts knowledge from ticket + Notion,
  │                              posts to Linear, waits for answers
  ▼
Planner (Sonnet) ────────────── generates structured execution plan
  ▼
Agent (Claude Code) ────────── works in git worktree with GSD:
  │                              /gsd:plan-phase → /gsd:execute-phase
  │                              → /gsd:verify-work (GUARDRAIL)
  ▼
Review Loop ─────────────────── self-review + codex review + re-verify
  ▼
PR Created ─────────────────── GSD artifacts saved as deliverables,
  │                              completion comment posted to Linear,
  │                              knowledge distilled from artifacts
  ▼
Watch-PR-Reviews ────────────── polls GitHub for human review comments,
  │                              relaunches agent on feedback
  ▼
Done ────────────────────────── Linear sync detects completion
```

## Knowledge System

Knowledge is stored in **Context Fabrica** (PostgreSQL + pgvector), replacing the previous LanceDB backend. All knowledge consumers — OpenClaw chat, bridge triage, agent tools — read and write from the same database.

### Knowledge Sources (Auto-Extraction)

| Source | When | Stage | Trigger |
|--------|------|-------|---------|
| Codebase scanning | On-demand / every 10 min | staged | `mc-explore` CLI / repo-watcher |
| Linear ticket descriptions | During triage | staged | Bridge auto-extract |
| Notion page content | During triage | staged | Bridge auto-extract |
| Task completion (GSD artifacts) | Task → review | canonical | Bridge + knowledge-distill |
| Research Q&A | Research task done | canonical | linear-sync |
| OpenClaw chat (Slack/Telegram) | User interaction | canonical | memory plugin |
| Manual injection | Anytime | canonical | `mc_add_knowledge` tool / CLI |
| Cross-repo architecture | On-demand | canonical | `mc-explore --cross-repo` |

### Knowledge Tiers

- **Developer Notes** (human-injected, 1.5x scoring boost, always surface)
- **Procedural Skills** (auto-created from complex tasks, full content injected)
- **Atomic Facts** (auto-distilled one-liners, compact)

### Staged Review

Auto-extracted knowledge enters as `staged` and must be reviewed before it surfaces in agent recall. The MC dashboard includes a Knowledge Review panel for approving/rejecting staged entries.

### Entity Relations & Graph Scoring

Knowledge entries include entity relations (DEPENDS_ON, OWNS, CALLS, IMPLEMENTS, USES, etc.) stored in `memory_relations`. Query-time scoring blends:
- **50% semantic** (BM25 + embedding similarity)
- **30% graph** (entity relation proximity, multi-hop traversal)
- **12% recency** (temporal freshness)
- **8% confidence** (source credibility)

### Codebase Explorer

```bash
# Scan a repo, extract architectural knowledge
mc-explore myorg/backend-api

# Focus on specific area
mc-explore myorg/backend-api --focus "API endpoints"

# Monorepo — auto-detects packages
mc-explore myorg/platform

# Specific monorepo package
mc-explore myorg/platform --package api

# Preview without storing
mc-explore myorg/backend-api --dry-run

# Trust mode — store as canonical (skip staged review)
mc-explore myorg/backend-api --trust
```

### Repo Watcher

Background service (every 10 min) that detects code changes and incrementally updates knowledge:
- Compares git SHAs, pulls latest, analyzes diffs
- Extracts new architectural facts from changed files
- Supersedes outdated knowledge (old records get `valid_to`, new records link via `supersedes`)
- Skips non-architectural changes (lock files, tests, CI configs)

## Service Health Monitoring

MC monitors 9 services with auto-refresh every 30s:

| Service | Type | Purpose |
|---------|------|---------|
| Mission Control | HTTP (18790) | Task management, API, dashboard |
| OpenClaw Gateway | HTTP (18789) | Agent communication, Slack/Telegram |
| Bridge | launchd (60s) | Triage, planning, dispatch |
| Linear Sync | launchd (300s) | Ticket sync from Linear |
| Watch PR Reviews | launchd (120s) | GitHub review comment detection |
| Review PRs | launchd | PR review orchestration |
| Check Agents | launchd (120s) | Agent health, tmux validation |
| Repo Watcher | launchd (600s) | Codebase knowledge updates |
| PostgreSQL | pg_isready | Context Fabrica database |

Health API: `GET /ext/mission-control/api/services/health`

Auto-restart: MC uses `KeepAlive: true` in launchd. Bridge uses `KeepAlive.SuccessfulExit: false` (restart on crash, not on normal exit). Health monitor script alerts via Telegram/Slack after 2+ consecutive failures.

## Dashboard

The command center dashboard (`http://localhost:18790/ext/mission-control/`) provides:

- **Services panel** — real-time health of all 9 services with status badges
- **Pipeline bar** — INTAKE → TRIAGE → DISPATCH → SWARM OPS → REVIEW → COMPLETE
- **Task card grid** — status badges, agent indicators, priority highlights
- **Task drawer** — description, triage Q&A, deliverables (PLAN.md, VERIFICATION.md), activity log
- **Knowledge panel** — Browse/Review/Canonical tabs, approve/reject staged entries
- **System stats** — CPU, memory, agent concurrency

## API Endpoints

All endpoints served under `/ext/mission-control/api/`:

### Tasks
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/tasks` | List tasks (query: `status`, `workspace_id`, `assigned_agent_id`) |
| POST | `/tasks` | Create task |
| GET | `/tasks/:id` | Get task by ID |
| PATCH | `/tasks/:id` | Update task |
| DELETE | `/tasks/:id` | Delete task |
| GET | `/tasks/:id/activities` | List task activities |
| POST | `/tasks/:id/activities` | Log activity |
| GET | `/tasks/:id/deliverables` | List task deliverables (GSD artifacts) |
| POST | `/tasks/:id/deliverables` | Add deliverable |

### Knowledge
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/knowledge` | List entries (query: `stage`, `project`, `repo`, `scope`, `limit`) |
| POST | `/knowledge` | Add knowledge entry |
| DELETE | `/knowledge/:id` | Delete entry |
| POST | `/knowledge/:id/promote` | Promote staged → canonical |
| POST | `/knowledge/:id/reject` | Reject (delete) staged entry |
| PATCH | `/knowledge/:id` | Update entry text/domain |

### Services
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/services/health` | Health status of all services |

### Other
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/agents` | List agents |
| GET | `/agent-status` | Live agent status with tmux detection |
| GET | `/workspaces` | List workspaces |
| GET | `/board` | Dashboard board data |
| GET | `/system-stats` | CPU, memory, concurrency |

## Setup

### Prerequisites

- Node.js 20+ with tsx
- PostgreSQL 17 with pgvector extension
- Python 3.12+ with context-fabrica installed
- OpenClaw gateway (optional, for Slack/Telegram integration)

### Install

```bash
# Clone
cd ~/GitProjects/openclaw-plugins
git clone https://github.com/jimmdd/mission-control.git
cd mission-control
npm install

# Set up PostgreSQL
brew install postgresql@17 pgvector
brew services start postgresql@17
createdb context_fabrica
psql -d context_fabrica -c "CREATE EXTENSION IF NOT EXISTS vector;"

# Install context-fabrica
pip install context-fabrica
python -m context_fabrica.bootstrap_cli --dsn "postgresql://$(whoami)@localhost/context_fabrica"

# Configure environment
cat >> ~/.openclaw/.env << 'EOF'
CONTEXT_FABRICA_DSN=postgresql://$(whoami)@localhost/context_fabrica
GOOGLE_GENERATIVE_AI_API_KEY=your-gemini-key
ANTHROPIC_API_KEY=your-anthropic-key
MISSION_CONTROL_URL=http://127.0.0.1:18790/ext/mission-control
EOF
```

### Start Standalone Service

```bash
# Start MC
npm start
# Or via launchd (auto-restart on crash):
launchctl load ~/Library/LaunchAgents/ai.openclaw.mission-control.plist

# Verify
curl http://localhost:18790/health
open http://localhost:18790/ext/mission-control/
```

### Register with OpenClaw (optional)

The plugin proxies to the standalone MC service. Set `dbPath` to the PostgreSQL DSN:

```json
{
  "plugins": {
    "entries": {
      "mission-control": {
        "config": {
          "dbPath": "postgresql://user@localhost/context_fabrica"
        }
      }
    }
  }
}
```

### Initial Knowledge Extraction

```bash
# Scan all repos in a project
for repo in $(ls ~/GitProjects/myorg/); do
  mc-explore myorg/$repo
done

# Review staged entries in the dashboard
open http://localhost:18790/ext/mission-control/
```

## Project Structure

```
mission-control/
├── server.ts                        # Standalone HTTP server entry point
├── index.ts                         # OpenClaw plugin (thin proxy to standalone MC)
├── openclaw.plugin.json             # Plugin manifest
├── package.json
├── public/
│   ├── index.html                   # Dashboard (services, tasks, knowledge review)
│   └── space.html                   # Space page (operational view)
├── src/
│   ├── db.ts                        # SQLite schema, CRUD operations
│   ├── routes.ts                    # HTTP API + dashboard serving
│   └── tools.ts                     # Agent-callable tools (proxy to MC API)
├── health/
│   ├── service-health.py            # Service health checker (9 services)
│   └── mc-health-check.sh           # Health monitor with alerting
└── swarm/                           # Orchestration scripts
    ├── bridge.py                    # Triage, plan, dispatch, Q&A loop
    ├── linear-sync.py               # Linear ticket sync + research distillation
    ├── knowledge-manage.py          # Knowledge CRUD via context-fabrica
    ├── knowledge-distill.py         # Extract skills + facts from completed tasks
    ├── knowledge-review.py          # Review staged knowledge (promote/reject)
    ├── knowledge-feedback.py        # Track recall/helped counts
    ├── mc-explore.py                # Codebase knowledge extractor CLI
    ├── mc_explore_common.py         # Shared utilities for explore + watcher
    ├── repo-watcher.py              # Background repo change → knowledge updater
    ├── repo-watcher-precheck.sh     # SHA comparison precheck (zero tokens)
    ├── watch-pr-reviews.sh          # GitHub PR review comment detection
    ├── check-agents.sh              # Agent health monitor
    ├── spawn-agent.sh               # Create worktree, register agent, start tmux
    ├── run-claude.sh                # Launch Claude Code agent
    └── run-codex.sh                 # Launch Codex agent (fallback)
```

## Dependencies

- **[context-fabrica](https://github.com/jimmdd/context-fabrica)** — Knowledge storage (PostgreSQL + pgvector + entity relations)
- **[OpenClaw](https://github.com/openclaw-ai/openclaw)** — Agent gateway (optional, for Slack/Telegram/tool registration)
- **better-sqlite3** — Task database
- **Gemini API** — Embeddings (gemini-embedding-001) + knowledge extraction (gemini-2.5-flash)
- **Anthropic API** — Agent model (claude-sonnet-4-6) + planning

## License

MIT
