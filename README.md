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

### Orchestrator (Planner)

The orchestrator sits between triage and execution. For simple single-repo tasks, agents go direct to GSD. For complex multi-repo or multi-step work, the orchestrator decomposes the task into coordinated agent sessions. Inspired by [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent)'s spec-driven approach.

**Key principle: the orchestrator defines WHAT, GSD defines HOW.** The orchestrator breaks work into steps with acceptance criteria. Each step agent runs the full GSD cycle internally (`/gsd:plan-phase` → `/gsd:execute-phase` → `/gsd:verify-work`). This creates a verifiable proof-of-work chain:

```
Orchestrator Plan (plan.json)          ← what to achieve, in what order
  └─ Step 1 Agent Session
       ├─ GSD PLAN.md                  ← how the agent will implement it
       ├─ GSD SUMMARY.md              ← what was actually done
       ├─ GSD VERIFICATION.md         ← did it meet acceptance criteria
       └─ git commits                  ← the actual code
  └─ Step 2 Agent Session (branches from step 1)
       ├─ GSD PLAN.md
       ├─ GSD VERIFICATION.md
       └─ git commits
  └─ Orchestrator Verification         ← MiniMax checks agent output vs criteria
  └─ PR Created                        ← final deliverable
Progress Tracker (progress.json)       ← real-time status of every step
```

**When does orchestration activate?**

| Scenario | Route |
|----------|-------|
| Single repo, clear requirements | Direct → GSD agent (no orchestrator overhead) |
| Multi-repo task | Orchestrator → step per repo, ordered by data flow |
| Complex task with sequential dependencies | Orchestrator → dependency-chained steps |
| Investigation task | Direct → read-only agent (no plan needed) |

The planner (Sonnet) evaluates every task and returns `needs_orchestration: true/false`. If false or single-step, it skips itself and dispatches directly.

**Model allocation (all configurable via `swarm-config.json`):**

| Role | Default Model | Cost |
|------|--------------|------|
| Orchestration planning | Claude Sonnet (API) | ~$0.05-0.15/plan |
| Step routing/classification | MiniMax M2.7 (Ollama) | Free |
| Step verification | MiniMax M2.7 (Ollama) | Free |
| Worker agents | Claude Code / Codex (subscription) | Free |
| GSD planning (inside agent) | Agent's own model | Free (part of agent session) |

**Plan structure** (saved as JSON + markdown in `~/.openclaw/bridge/plans/`):

```json
{
  "summary": "Add rate limiting across API gateway and client SDK",
  "needs_orchestration": true,
  "reasoning": "Cross-repo: API changes must land before client SDK update",
  "steps": [
    {
      "step": 1,
      "title": "Add rate limiting middleware to API gateway",
      "repo": "acme/backend-api",
      "description": "Add configurable rate limiter that returns 429 with Retry-After header",
      "acceptance_criteria": [
        "Rate limiter returns 429 after 100 req/s per client",
        "Retry-After header set correctly",
        "All existing tests pass"
      ],
      "verify_command": "npm test",
      "depends_on": [],
      "category": "deep"
    },
    {
      "step": 2,
      "title": "Update client SDK to handle 429 with backoff",
      "repo": "acme/client-sdk",
      "depends_on": [1],
      "category": "deep",
      "context_from_prior_steps": "API now returns 429 with Retry-After header"
    }
  ]
}
```

**Progress tracking** (`~/.openclaw/bridge/progress/{task-id}.json`):
- Per-step status: pending → in_progress → completed/failed
- Session resumption: bridge restarts pick up where they left off
- Retry logic: failed verification retries up to 2x before escalating
- Branch chaining: dependent steps branch from the prior step's branch (inheriting commits)

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

Supported providers: `anthropic`, `ollama`, `gemini`. Swap in your preferred models — use Gemini for planning to stay free, or route everything through Ollama.

Environment variables (`ANTHROPIC_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`, `OLLAMA_URL`) override config values. Set `ENABLE_PLANNER=0` to bypass the orchestrator entirely.

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

### Three Knowledge Tiers

Knowledge is stored in LanceDB with Gemini embeddings and retrieved via similarity search, scoped per repo/project.

**Tier 1 — Developer Notes** (human-injected, always surface with priority boost):
```
## Developer Notes (MUST FOLLOW)
- (repo:acme/firmware) Production branch is main. Feature
  branches from main or release-candidate. Only modify src/drivers.
```

**Tier 2 — Procedural Skills** (auto-created from complex tasks, full content injected):
```
# Skill: Adding API endpoints to odc-api
Domain: api

Add new REST endpoints following the existing pattern.

## Steps
1. Define route in src/routes/ following existing naming convention
2. Add validation schema in src/schemas/ using Zod
3. Add handler in src/handlers/ — use existing DB helpers, don't raw-query
4. Register route in src/app.ts
5. Run tests: `npm test -- --grep "api"`

## Pitfalls
- DB migrations must run first: `npm run migrate:test`
- The CI runs on Node 18 — avoid Node 20 APIs
- Rate limiter is applied globally; test with `X-Test-Bypass: true` header

## Verification
- `npm test` exits 0
- `tsc --noEmit` exits 0
- New endpoint responds with correct status codes
```

**Tier 3 — Atomic Facts** (auto-distilled one-liners, compact):
```
## Past Learnings (REFERENCE)
- [fact] (repo:acme/backend-api) Tests require NODE_ENV=test
- [decision] (repo:acme/network) Config loader reads from /etc/bee/config.json
```

### Skill Auto-Creation

Skills are automatically created when a completed task shows complexity signals:
- **5+ commits** — multi-step work worth documenting
- **4+ files changed** — broad impact across the codebase
- **Error recovery detected** — retry, fix, revert keywords in artifacts (hard-won knowledge)

When a skill already exists for the same repo+domain, it gets **patched** (merged with new learnings) rather than replaced. Over time, skills become battle-tested procedures.

### Progressive Disclosure

Token-efficient retrieval with three levels:
1. **Metadata scan** — titles and domains loaded first (~3k tokens)
2. **Full content** — top 3 matching skills loaded in full
3. **Overflow summary** — remaining skills show title + summary + char count

### Feedback Loop (Knowledge Lineage)

Each knowledge entry tracks:
- `recall_count` — how many times it was retrieved for a task
- `helped_count` — how many of those tasks succeeded
- `task_outcome` — whether the originating task succeeded or failed

During retrieval, entries with high help ratios (helped/recalled) get a scoring boost. Knowledge that consistently helps gets surfaced more; knowledge that doesn't help naturally decays in relevance.

```
knowledge-feedback.py --task-id TASK_ID --outcome success   # boost entries that helped
knowledge-feedback.py --entry-id ENTRY_ID --action recall   # track individual recall
```

### Knowledge Sources

Knowledge can be added through:
- **Auto-distillation** — `knowledge-distill.py` runs after each task, producing skills or facts
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
| Knowledge Distiller | `~/.openclaw/swarm/knowledge-distill.py` | On-demand | Extract skills + facts from completed tasks into LanceDB |
| Knowledge Feedback | `~/.openclaw/swarm/knowledge-feedback.py` | On-demand | Track recall/helped counts for knowledge quality scoring |

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
