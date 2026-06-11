#!/bin/bash
# Usage: spawn-agent.sh <task-id> <repo-path> <branch-name> [agent-profile] [description]
# Example: spawn-agent.sh feat-templates ~/GitProjects/YourOrg/your-repo feat/templates pi "Add email templates"
#
# Environment variables (optional, forwarded to agent launcher):
#   MAX_BUDGET_USD    — dollar cap per agent run (e.g. 5.00)
#   MAX_TURNS         — turn limit (e.g. 50)
#   FALLBACK_MODEL    — model to fall back to (legacy override)
#   AGENTS_JSON       — path to Agent Teams JSON file, or "default" for built-in testing agent
#   MAX_AGENT_RETRIES — retry limit (default: 3)
#   MC_TASK_ID        — Mission Control task ID (for monitor → webhook callback)
#   BASE_BRANCH       — base branch for worktree (default: origin/main)
set -euo pipefail

TASK_ID=$1
REPO_PATH=$2
BRANCH_NAME=$3
DESCRIPTION=${5:-$1}
MC_HOME="${MC_HOME:-$HOME/.mission-control}"
SWARM_DIR="$MC_HOME/swarm"
MC_URL="${MISSION_CONTROL_URL:-http://localhost:18790}"
WORKTREE_BASE="$(dirname "$REPO_PATH")/worktrees"
WORKTREE_PATH="$WORKTREE_BASE/$TASK_ID"
REGISTRY="$SWARM_DIR/active-tasks.json"
STATE_TOOL="$SWARM_DIR/swarm-state.py"

CONFIG="$SWARM_DIR/swarm-config.json"
DEFAULT_PROFILE=$(jq -r '.agents.defaultProfile // "codex"' "$CONFIG" 2>/dev/null || echo codex)
AGENT_PROFILE=${4:-$DEFAULT_PROFILE}

if [ -z "$TASK_ID" ] || [ -z "$REPO_PATH" ] || [ -z "$BRANCH_NAME" ]; then
  echo "Usage: spawn-agent.sh <task-id> <repo-path> <branch-name> [agent-profile] [description]"
  echo ""
  echo "Env vars: MAX_BUDGET_USD, MAX_TURNS, FALLBACK_MODEL, AGENTS_JSON, MAX_AGENT_RETRIES"
  exit 1
fi

resolve_profile_json() {
  local profile="$1"
  jq -c --arg profile "$profile" '
    if .agents.profiles[$profile] then
      .agents.profiles[$profile]
    elif $profile == "claude" then
      {
        launcher: "claude",
        model: (.claude.model // "claude-opus-4-6"),
        fallbackModel: (.claude.fallbackModel // ""),
        maxAgents: (.claude.maxAgents // 10),
        fallbackProfile: "codex",
        env: {}
      }
    elif $profile == "pi" then
      {
        launcher: "pi",
        provider: "google",
        model: "google/gemini-2.5-pro",
        thinking: "high",
        maxAgents: 5,
        fallbackProfile: "codex",
        env: {}
      }
    elif $profile == "codex" then
      {
        launcher: "codex",
        model: (.codex.model // "codex-mini"),
        effort: (.codex.effort // "high"),
        reviewEffort: (.codex.reviewEffort // "high"),
        maxAgents: (.codex.maxAgents // 3),
        env: {}
      }
    else empty end
  ' "$CONFIG" 2>/dev/null
}

PROFILE_JSON=$(resolve_profile_json "$AGENT_PROFILE")
if [ -z "$PROFILE_JSON" ] || [ "$PROFILE_JSON" = "null" ]; then
  echo "ERROR: Unknown agent profile '$AGENT_PROFILE'"
  exit 2
fi

AGENT_LAUNCHER=$(echo "$PROFILE_JSON" | jq -r '.launcher // "codex"')
AGENT_MODEL=$(echo "$PROFILE_JSON" | jq -r '.model // ""')
AGENT_PROVIDER=$(echo "$PROFILE_JSON" | jq -r '.provider // ""')
AGENT_THINKING=$(echo "$PROFILE_JSON" | jq -r '.thinking // ""')
AGENT_FALLBACK_MODEL=$(echo "$PROFILE_JSON" | jq -r '.fallbackModel // ""')
AGENT_EFFORT=$(echo "$PROFILE_JSON" | jq -r '.effort // ""')
AGENT_MAX_AGENTS=$(echo "$PROFILE_JSON" | jq -r '.maxAgents // 1')
AGENT_FALLBACK_PROFILE=$(echo "$PROFILE_JSON" | jq -r '.fallbackProfile // ""')
AGENT_ENV_JSON=$(echo "$PROFILE_JSON" | jq -c '.env // {}')

RUNNING_PROFILE=$(jq --arg profile "$AGENT_PROFILE" '[.[] | select(.status == "running" and (.agentProfile // .agent) == $profile)] | length' "$REGISTRY" 2>/dev/null || echo 0)

if [ "$RUNNING_PROFILE" -ge "$AGENT_MAX_AGENTS" ]; then
  if [ -n "$AGENT_FALLBACK_PROFILE" ]; then
    echo "Agent profile '$AGENT_PROFILE' slots full ($RUNNING_PROFILE/$AGENT_MAX_AGENTS), falling back to '$AGENT_FALLBACK_PROFILE'..."
    AGENT_PROFILE="$AGENT_FALLBACK_PROFILE"
    PROFILE_JSON=$(resolve_profile_json "$AGENT_PROFILE")
    AGENT_LAUNCHER=$(echo "$PROFILE_JSON" | jq -r '.launcher // "codex"')
    AGENT_MODEL=$(echo "$PROFILE_JSON" | jq -r '.model // ""')
    AGENT_PROVIDER=$(echo "$PROFILE_JSON" | jq -r '.provider // ""')
    AGENT_THINKING=$(echo "$PROFILE_JSON" | jq -r '.thinking // ""')
    AGENT_FALLBACK_MODEL=$(echo "$PROFILE_JSON" | jq -r '.fallbackModel // ""')
    AGENT_EFFORT=$(echo "$PROFILE_JSON" | jq -r '.effort // ""')
    AGENT_MAX_AGENTS=$(echo "$PROFILE_JSON" | jq -r '.maxAgents // 1')
    AGENT_ENV_JSON=$(echo "$PROFILE_JSON" | jq -c '.env // {}')
  else
    echo "ERROR: Agent profile '$AGENT_PROFILE' is full ($RUNNING_PROFILE/$AGENT_MAX_AGENTS)"
    exit 2
  fi
fi

TMUX_SESSION="${AGENT_PROFILE}-${TASK_ID}"

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
CRG_BIN="$MC_HOME/venv-3.12/bin/code-review-graph"
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

case "$AGENT_LAUNCHER" in
  claude)
    LAUNCHER="$SWARM_DIR/run-claude.sh"
    ;;
  codex)
    LAUNCHER="$SWARM_DIR/run-codex.sh"
    ;;
  pi)
    LAUNCHER="$SWARM_DIR/run-pi.sh"
    ;;
  *)
    echo "ERROR: Unsupported launcher '$AGENT_LAUNCHER' for profile '$AGENT_PROFILE'"
    exit 2
    ;;
esac

# Build env vars for the tmux session as discrete `-e KEY=VALUE` arguments.
# These are passed as argv elements (not interpolated into a shell command
# string), so values may contain quotes, spaces, or shell metacharacters
# without breaking out — and secrets never appear on a process command line.
TMUX_ENV_ARGS=()
add_session_env() { [ -n "${2:-}" ] && TMUX_ENV_ARGS+=( -e "$1=$2" ); }
add_session_env MAX_BUDGET_USD     "${MAX_BUDGET_USD:-}"
add_session_env MAX_TURNS          "${MAX_TURNS:-}"
add_session_env FALLBACK_MODEL     "${FALLBACK_MODEL:-}"
add_session_env AGENTS_JSON        "${AGENTS_JSON:-}"
add_session_env MAX_AGENT_RETRIES  "${MAX_AGENT_RETRIES:-}"
add_session_env AGENT_PROFILE      "${AGENT_PROFILE:-}"
add_session_env AGENT_MODEL        "${AGENT_MODEL:-}"
add_session_env AGENT_PROVIDER     "${AGENT_PROVIDER:-}"
add_session_env AGENT_THINKING     "${AGENT_THINKING:-}"
add_session_env AGENT_FALLBACK_MODEL "${AGENT_FALLBACK_MODEL:-}"
add_session_env AGENT_EFFORT       "${AGENT_EFFORT:-}"
while IFS= read -r entry; do
  [ -z "$entry" ] && continue
  key=$(echo "$entry" | jq -r '.key')
  value=$(echo "$entry" | jq -r '.value')
  [ -z "$key" ] || [ "$key" = "null" ] && continue
  TMUX_ENV_ARGS+=( -e "$key=$value" )
done < <(echo "$AGENT_ENV_JSON" | jq -c 'to_entries[]?')

# Pass the launcher path and task id through the session environment too, so
# the command string below is fully static — nothing dynamic is interpolated
# into a shell command line.
TMUX_ENV_ARGS+=( -e "MC_LAUNCHER=$LAUNCHER" -e "MC_TASK_ARG=$TASK_ID" )

# Spawn tmux session. The command is a fixed literal; MC_LAUNCHER and
# MC_TASK_ARG are resolved from the session env (set via -e above).
tmux new-session -d -s "$TMUX_SESSION" -c "$WORKTREE_PATH" "${TMUX_ENV_ARGS[@]}" \
  'exec "$MC_LAUNCHER" "$MC_TASK_ARG"'

# Register task
BUDGET_DISPLAY="${MAX_BUDGET_USD:-unlimited}"
TURNS_DISPLAY="${MAX_TURNS:-unlimited}"
AGENTS_DISPLAY="${AGENTS_JSON:-none}"

TASK_JSON=$(jq -n \
  --arg id "$TASK_ID" \
  --arg session "$TMUX_SESSION" \
  --arg agent "$AGENT_PROFILE" \
  --arg launcher "$AGENT_LAUNCHER" \
  --arg model "$AGENT_MODEL" \
  --arg provider "$AGENT_PROVIDER" \
  --arg thinking "$AGENT_THINKING" \
  --arg effort "$AGENT_EFFORT" \
  --arg desc "$DESCRIPTION" \
  --arg repo "$REPO_PATH" \
  --arg worktree "$WORKTREE_PATH" \
  --arg branch "$BRANCH_NAME" \
  --arg baseBranch "$WORKTREE_BASE_REF" \
  --arg mcTaskId "${MC_TASK_ID:-}" \
  --arg fallbackModel "${AGENT_FALLBACK_MODEL:-${FALLBACK_MODEL:-}}" \
  --argjson startedAt "$(date +%s)000" \
  --argjson agentTeams "$([ -n "${AGENTS_JSON:-}" ] && echo true || echo false)" \
  --argjson maxBudgetUsd "${MAX_BUDGET_USD:-null}" \
  --argjson maxTurns "${MAX_TURNS:-null}" \
  --argjson agentEnv "$AGENT_ENV_JSON" \
  '{
    id: $id,
    tmuxSession: $session,
    agent: $agent,
    agentProfile: $agent,
    launcher: $launcher,
    agentModel: (if $model == "" then null else $model end),
    agentProvider: (if $provider == "" then null else $provider end),
    agentThinking: (if $thinking == "" then null else $thinking end),
    agentEffort: (if $effort == "" then null else $effort end),
    agentEnv: $agentEnv,
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
echo "  Profile:  $AGENT_PROFILE ($AGENT_LAUNCHER)"
echo "  Provider: ${AGENT_PROVIDER:-default}"
echo "  Model:    ${AGENT_MODEL:-default}"
echo "  Budget:   \$$BUDGET_DISPLAY | Turns: $TURNS_DISPLAY"
echo "  Agents:   $AGENTS_DISPLAY"
echo "  View:     tmux attach -t $TMUX_SESSION"
