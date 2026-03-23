# Mission Control

OpenClaw embedded plugin for managing autonomous AI agent swarms. Provides task management, a real-time command center dashboard, knowledge management, and agent tools — all backed by SQLite.

Orchestrates an autonomous coding pipeline: Linear ticket → triage → plan → step-by-step execution → verify → PR → review → done.

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
  │                              posts to Linear, waits for answers
  ▼
Planner (Sonnet) ────────────── generates structured execution plan:
  │                              numbered steps with dependencies,
  │                              scoped files, done-when criteria,
  │                              verification commands, parallel groups
  ▼
Dispatcher ──────────────────── walks the plan step-by-step:
  │                              routes by category (deep/quick/test/review),
  │                              dispatches parallel groups concurrently,
  │                              chains dependent steps on prior branches
  ▼
Agent (Claude / Codex) ──────── works in git worktree, executes ONE step
  │                              with scoped prompt (files, criteria, verify)
  ▼
Verifier (MiniMax local) ────── checks agent output against done-when
  │                              criteria. Retries failed steps (up to 2x).
  │                              On pass → dispatcher picks next step
  ▼
Plan Complete ───────────────── all steps done → creates PR from
  │                              final branch, moves to review
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

### Planner

The planner sits between triage and execution, converting vague tickets into precise execution contracts. Inspired by [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent)'s spec-driven approach but optimized for minimal token cost.

**Model allocation:**

| Role | Model | Cost |
|------|-------|------|
| Plan generation | Claude Sonnet (API) | ~$0.05-0.15/plan |
| Step routing/classification | MiniMax M2.7 (Ollama, local) | Free |
| Step verification | MiniMax M2.7 (Ollama, local) | Free |
| Worker agents | Claude Code / Codex (subscription) | Free |

**Plan structure** (saved as JSON + markdown in `~/.openclaw/bridge/plans/`):

```json
{
  "summary": "Add rate limiting to API gateway",
  "estimated_complexity": "moderate",
  "steps": [
    {
      "step": 1,
      "title": "Add rate limiter middleware",
      "repo": "acme/backend-api",
      "files_to_modify": ["src/middleware/rate-limit.ts"],
      "done_when": ["Rate limiter configured at 100 req/s", "Middleware registered in app.ts"],
      "verify_command": "npm test -- --grep rate-limit",
      "depends_on": [],
      "category": "deep"
    },
    {
      "step": 2,
      "title": "Add rate limit tests",
      "depends_on": [1],
      "category": "test"
    }
  ],
  "parallel_groups": [[1], [2]]
}
```

**Step dispatch prompts** are scoped and precise — each agent gets:
- TASK: what to do (from plan step)
- SCOPE: exact files to modify/create
- DONE WHEN: verifiable criteria
- MUST NOT: boundary constraints
- CONTEXT: summary of completed prior steps
- VERIFY: command to confirm work

**Progress tracking** (`~/.openclaw/bridge/progress/{task-id}.json`):
- Tracks per-step status: pending → in_progress → completed/failed
- Enables session resumption if bridge restarts mid-plan
- Failed steps retry up to 2x before escalating to on_hold
- Dependent steps branch from the previous step's git branch (not origin/main)

**Configuration** (all models configurable via `swarm-config.json`):

```json
{
  "triage": {
    "triage_model": "gemini-2.5-flash",
    "triage_model_deep": "gemini-2.5-pro",
    "embedding_model": "gemini-embedding-001"
  },
  "planner": {
    "planning_model": "claude-sonnet-4-20250514",
    "planning_provider": "anthropic",
    "routing_model": "minimax-m2.7:cloud",
    "routing_provider": "ollama",
    "verification_model": "minimax-m2.7:cloud",
    "verification_provider": "ollama",
    "ollama_url": "http://localhost:11434",
    "max_step_retries": 2,
    "step_categories": {
      "deep": { "agent": "claude" },
      "quick": { "agent": "claude" },
      "test": { "agent": "claude" },
      "research": { "agent": "claude" },
      "review": { "agent": "codex" }
    }
  }
}
```

Supported providers: `anthropic`, `ollama`, `gemini`. Any model available through these providers can be used — swap in your preferred local models, use Gemini for planning to stay free, or route everything through Ollama.

Environment variables (`ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `OLLAMA_URL`) can also override config values. Set `ENABLE_PLANNER=0` to bypass the planner entirely.

Investigation tasks bypass the planner and go directly to agent dispatch (read-only, no plan needed).

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
| `mc_add_knowledge` | Store developer knowledge (branch rules, conventions, gotchas) |
| `mc_list_knowledge` | List stored knowledge entries by repo/project scope |

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
| GET | `/system-stats` | CPU load, memory usage, concurrency limits |
| GET | `/knowledge` | List knowledge entries (query: `project`, `repo`, `scope`, `limit`) |
| POST | `/knowledge` | Add knowledge entry (`text`, `project`, `repo`, `importance`, `category`) |
| DELETE | `/knowledge/:id` | Delete knowledge entry |

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

## Memory & Knowledge Integration

Mission Control integrates with [claw-memory-ultra](https://github.com/jimmdd/claw-memory-ultra) (LanceDB-backed vector memory) to give agents context about repositories they're working on.

Knowledge flows through two paths:

1. **Auto-distilled** — When an agent completes a task, `knowledge-distill.py` extracts learnings (API contracts, gotchas, architectural decisions) and stores them in LanceDB with Gemini embeddings.
2. **Human-injected** — Developers add knowledge directly via the dashboard, gateway chat, or API. These entries are marked `source: human` and get priority during recall.

During triage, the bridge calls `recall_knowledge()` which:
- Searches LanceDB for entries scoped to the target repo/project
- Separates results into **Developer Notes** (human-injected, always surfaced) and **Past Learnings** (auto-distilled, similarity-ranked)
- Injects both into the agent prompt with clear hierarchy

```
## Developer Notes (MUST FOLLOW)
- (repo:acme/firmware) Production branch is main. Feature
  branches from main or release-candidate. Only modify src/drivers.

## Past Learnings (REFERENCE)
- [fact] (repo:acme/backend-api) Tests require NODE_ENV=test
```

Knowledge can be added through:
- **Dashboard** — Knowledge Base panel with scope picker and text input
- **Gateway chat** — Agent calls `mc_add_knowledge` tool
- **REST API** — `POST /ext/mission-control/api/knowledge`
- **CLI** — `python3 ~/.openclaw/swarm/knowledge-manage.py inject --text "..." --project X --repo Y`

## Swarm Infrastructure

Mission Control is the central hub. The surrounding scripts live in `~/.openclaw/swarm/`:

| Component | Path | Interval | Purpose |
|-----------|------|----------|---------|
| Linear Sync | `~/.openclaw/sync/linear-sync.py` | 300s | Sync tickets from Linear, detect done state |
| Bridge | `~/.openclaw/bridge/bridge.py` | 60s | Triage tasks, plan, dispatch steps, handle Q&A |
| Planner | `~/.openclaw/bridge/planner.py` | On-demand | Generate structured plans (Sonnet), verify steps (MiniMax) |
| Agent Monitor | `~/.openclaw/swarm/check-agents.sh` | 120s | Health checks, Codex reviews, retry logic |
| PR Watcher | `~/.openclaw/swarm/watch-pr-reviews.sh` | 120s | Detect GitHub review comments and approvals |
| Agent Launcher | `~/.openclaw/swarm/run-claude.sh` | On-demand | Launch Claude with prompt, retry, cost controls |
| Spawn Script | `~/.openclaw/swarm/spawn-agent.sh` | On-demand | Create worktree, register agent, start tmux |
| Knowledge Manager | `~/.openclaw/swarm/knowledge-manage.py` | On-demand | Inject/list/delete knowledge entries in LanceDB |
| Knowledge Distiller | `~/.openclaw/swarm/knowledge-distill.py` | On-demand | Extract learnings from completed tasks into LanceDB |

### Concurrency

Configurable via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_CLAUDE_AGENTS` | 10 | Max concurrent Claude Code agents |
| `MAX_CODEX_AGENTS` | 3 | Max concurrent Codex agents (fallback) |

Agents run in tmux sessions for isolation. Each agent gets its own git worktree. When Claude slots are full, new tasks fall back to Codex.

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
