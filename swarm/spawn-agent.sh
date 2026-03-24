#!/bin/bash
# Usage: spawn-agent.sh <task-id> <repo-path> <branch-name> [agent-type] [description]
# Example: spawn-agent.sh feat-templates ~/GitProjects/YourOrg/your-repo feat/templates claude "Add email templates"
#
# Environment variables (optional, forwarded to agent launcher):
#   MAX_BUDGET_USD    — dollar cap per agent run (e.g. 5.00)
#   MAX_TURNS         — turn limit (e.g. 50)
#   FALLBACK_MODEL    — model to fall back to (e.g. claude-sonnet-4-20250514)
#   AGENTS_JSON       — path to Agent Teams JSON file, or "default" for built-in testing agent
#   MAX_AGENT_RETRIES — retry limit (default: 3)
#   MC_TASK_ID        — Mission Control task ID (for monitor → webhook callback)
#   BASE_BRANCH       — base branch for worktree (default: origin/main)
set -euo pipefail

TASK_ID=$1
REPO_PATH=$2
BRANCH_NAME=$3
AGENT_TYPE=${4:-codex}   # codex | claude
DESCRIPTION=$5
SWARM_DIR="$HOME/.openclaw/swarm"
MC_URL="${MISSION_CONTROL_URL:-http://localhost:18789/ext/mission-control}"
WORKTREE_BASE="$(dirname "$REPO_PATH")/worktrees"
WORKTREE_PATH="$WORKTREE_BASE/$TASK_ID"
REGISTRY="$SWARM_DIR/active-tasks.json"
STATE_TOOL="$SWARM_DIR/swarm-state.py"

CONFIG="$SWARM_DIR/swarm-config.json"
CFG_MAX_CLAUDE=$(jq -r '.claude.maxAgents // 10' "$CONFIG" 2>/dev/null || echo 10)
CFG_MAX_CODEX=$(jq -r '.codex.maxAgents // 3' "$CONFIG" 2>/dev/null || echo 3)
MAX_CLAUDE_AGENTS=${MAX_CLAUDE_AGENTS:-$CFG_MAX_CLAUDE}
MAX_CODEX_AGENTS=${MAX_CODEX_AGENTS:-$CFG_MAX_CODEX}

if [ -z "$TASK_ID" ] || [ -z "$REPO_PATH" ] || [ -z "$BRANCH_NAME" ]; then
  echo "Usage: spawn-agent.sh <task-id> <repo-path> <branch-name> [codex|claude] [description]"
  echo ""
  echo "Env vars: MAX_BUDGET_USD, MAX_TURNS, FALLBACK_MODEL, AGENTS_JSON, MAX_AGENT_RETRIES, MAX_CLAUDE_AGENTS, MAX_CODEX_AGENTS"
  exit 1
fi

RUNNING_CLAUDE=$(jq '[.[] | select(.status == "running" and .agent == "claude")] | length' "$REGISTRY" 2>/dev/null || echo 0)
RUNNING_CODEX=$(jq '[.[] | select(.status == "running" and .agent == "codex")] | length' "$REGISTRY" 2>/dev/null || echo 0)

if [ "$AGENT_TYPE" = "claude" ] && [ "$RUNNING_CLAUDE" -ge "$MAX_CLAUDE_AGENTS" ]; then
  echo "Claude slots full ($RUNNING_CLAUDE/$MAX_CLAUDE_AGENTS), falling back to Codex..."
  AGENT_TYPE="codex"
fi

if [ "$AGENT_TYPE" = "codex" ] && [ "$RUNNING_CODEX" -ge "$MAX_CODEX_AGENTS" ]; then
  echo "ERROR: All agent slots full (Claude: $RUNNING_CLAUDE/$MAX_CLAUDE_AGENTS, Codex: $RUNNING_CODEX/$MAX_CODEX_AGENTS)"
  echo "Queue this task and retry later."
  exit 2
fi

TMUX_SESSION="${AGENT_TYPE}-${TASK_ID}"

if [ ! -f "$SWARM_DIR/prompts/${TASK_ID}.md" ]; then
  echo "ERROR: No prompt file at $SWARM_DIR/prompts/${TASK_ID}.md"
  echo "Create it first, then re-run."
  exit 1
fi

# Default testing agent definition — used when AGENTS_JSON=default
DEFAULT_AGENTS_FILE="$SWARM_DIR/agents-default.json"
if [ ! -f "$DEFAULT_AGENTS_FILE" ]; then
  cat > "$DEFAULT_AGENTS_FILE" <<'AGENTEOF'
{
  "testing-agent": {
    "description": "Dedicated testing agent for all code changes.",
    "prompt": "You are a Testing Agent. Write comprehensive tests, run them, check edge cases. Report results. If tests fail, communicate failures to the lead. Never mark work done until all tests pass.",
    "tools": ["Read", "Edit", "Write", "Bash", "Glob", "Grep"],
    "model": "sonnet"
  }
}
AGENTEOF
  echo "Created default Agent Teams definition at $DEFAULT_AGENTS_FILE"
fi

# Resolve AGENTS_JSON="default" to the actual file path
if [ "${AGENTS_JSON:-}" = "default" ]; then
  AGENTS_JSON="$DEFAULT_AGENTS_FILE"
fi

# Create worktree
mkdir -p "$WORKTREE_BASE"
cd "$REPO_PATH"
git fetch origin
WORKTREE_BASE_REF="${BASE_BRANCH:-origin/main}"
git worktree add "$WORKTREE_PATH" -b "$BRANCH_NAME" "$WORKTREE_BASE_REF"

# Inject MCP config for code-review-graph (if venv exists)
cd "$WORKTREE_PATH"
CRG_BIN="$HOME/.openclaw/venv-3.12/bin/code-review-graph"
if [ -x "$CRG_BIN" ] && [ ! -f ".mcp.json" ]; then
  cat > .mcp.json <<MCPEOF
{
  "mcpServers": {
    "code-review-graph": {
      "command": "$CRG_BIN",
      "args": ["serve"]
    }
  }
}
MCPEOF
  echo "  Injected .mcp.json for code-review-graph"
fi

# Install dependencies
if [ -f "pnpm-lock.yaml" ]; then
  pnpm install
elif [ -f "yarn.lock" ]; then
  yarn install
elif [ -f "package-lock.json" ]; then
  npm install
fi

# Determine launcher
if [ "$AGENT_TYPE" = "claude" ]; then
  LAUNCHER="$SWARM_DIR/run-claude.sh"
else
  LAUNCHER="$SWARM_DIR/run-codex.sh"
fi

# Build env var string for tmux session
# tmux send-keys doesn't inherit our env, so we export explicitly
ENV_EXPORTS=""
[ -n "${MAX_BUDGET_USD:-}" ]    && ENV_EXPORTS+="export MAX_BUDGET_USD='$MAX_BUDGET_USD'; "
[ -n "${MAX_TURNS:-}" ]         && ENV_EXPORTS+="export MAX_TURNS='$MAX_TURNS'; "
[ -n "${FALLBACK_MODEL:-}" ]    && ENV_EXPORTS+="export FALLBACK_MODEL='$FALLBACK_MODEL'; "
[ -n "${AGENTS_JSON:-}" ]       && ENV_EXPORTS+="export AGENTS_JSON='$AGENTS_JSON'; "
[ -n "${MAX_AGENT_RETRIES:-}" ] && ENV_EXPORTS+="export MAX_AGENT_RETRIES='$MAX_AGENT_RETRIES'; "

# Spawn tmux session with env vars forwarded
tmux new-session -d -s "$TMUX_SESSION" -c "$WORKTREE_PATH" \
  "bash -c '${ENV_EXPORTS}exec $LAUNCHER $TASK_ID'"

# Register task
BUDGET_DISPLAY="${MAX_BUDGET_USD:-unlimited}"
TURNS_DISPLAY="${MAX_TURNS:-unlimited}"
AGENTS_DISPLAY="${AGENTS_JSON:-none}"

TASK_JSON=$(jq -n \
  --arg id "$TASK_ID" \
  --arg session "$TMUX_SESSION" \
  --arg agent "$AGENT_TYPE" \
  --arg desc "$DESCRIPTION" \
  --arg repo "$REPO_PATH" \
  --arg worktree "$WORKTREE_PATH" \
  --arg branch "$BRANCH_NAME" \
  --arg baseBranch "$WORKTREE_BASE_REF" \
  --arg mcTaskId "${MC_TASK_ID:-}" \
  --arg fallbackModel "${FALLBACK_MODEL:-}" \
  --argjson startedAt "$(date +%s)000" \
  --argjson agentTeams "$([ -n "${AGENTS_JSON:-}" ] && echo true || echo false)" \
  --argjson maxBudgetUsd "${MAX_BUDGET_USD:-null}" \
  --argjson maxTurns "${MAX_TURNS:-null}" \
  '{
    id: $id,
    tmuxSession: $session,
    agent: $agent,
    description: $desc,
    repo: $repo,
    worktree: $worktree,
    branch: $branch,
    baseBranch: $baseBranch,
    mcTaskId: $mcTaskId,
    startedAt: $startedAt,
    status: "running",
    notifyOnComplete: true,
    costControls: {
      maxBudgetUsd: $maxBudgetUsd,
      maxTurns: $maxTurns,
      fallbackModel: (if $fallbackModel == "" then null else $fallbackModel end)
    },
    agentTeams: $agentTeams,
    retryCount: 0,
    reviewCycles: 0
  }')

python3 "$STATE_TOOL" upsert --task-json "$TASK_JSON"

# Append to spawn history log (append-only JSONL backup)
HISTORY_FILE="$SWARM_DIR/spawn-history.jsonl"
echo "$TASK_JSON" | jq -c '. + {"spawnedAt": "'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}' >> "$HISTORY_FILE"

if [ -n "${MC_TASK_ID:-}" ]; then
  PROMPT_CONTENT=$(cat "$SWARM_DIR/prompts/${TASK_ID}.md" 2>/dev/null | head -c 4000)
  if [ -n "$PROMPT_CONTENT" ]; then
    curl -s -X POST "$MC_URL/api/tasks/$MC_TASK_ID/activities" \
      -H "Content-Type: application/json" \
      -d "{\"activity_type\":\"prompt_sent\",\"message\":$(echo "$PROMPT_CONTENT" | jq -Rs .)}" \
      > /dev/null 2>&1 || true
  fi
fi

echo "Agent spawned: $TMUX_SESSION"
echo "  Worktree: $WORKTREE_PATH"
echo "  Branch:   $BRANCH_NAME"
echo "  Budget:   \$$BUDGET_DISPLAY | Turns: $TURNS_DISPLAY"
echo "  Agents:   $AGENTS_DISPLAY"
echo "  View:     tmux attach -t $TMUX_SESSION"
