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
#   MC_MAX_CONCURRENT_AGENTS — ceiling on running agents across all profiles
#                              (default: .agents.maxConcurrent in swarm-config.json, 0 = off)
#   MC_TASK_ID        — Mission Control task ID (for monitor → webhook callback)
#   BASE_BRANCH       — PR/review base branch (default: origin/main)
#   WORKTREE_BASE_REF — ref used to create a new worktree (existing-PR handoffs use origin/<head>)
# -E so the ERR trap below is inherited by functions, subshells and command
# substitutions. Without it the trap covers only top-level commands, and the first
# attempt at this diagnostic stayed silent through a failure that was inside one of
# them — the silence being the only clue that it was.
set -euEo pipefail

# bridge.py logs only this script's stderr when it exits non-zero. MET-680 produced
# "spawn-agent.sh failed:" followed by nothing but git-fetch and bun noise — four
# times — while the tmux session, the registry entry and the spawn history had all
# been written successfully, and the agent went on to do the work. Name the line
# that actually failed, so the next such spawn is one log line to diagnose.
trap 'rc=$?; echo "spawn-agent.sh: FAILED at line $LINENO (exit $rc): $BASH_COMMAND" >&2' ERR

# ERR cannot see a death by signal, nor an exit status the script never chose. This
# reports the real code on every non-zero exit, so "no ERR line but still non-zero"
# is distinguishable from "exited cleanly and bridge misread it".
trap 'rc=$?; [ "$rc" -eq 0 ] || echo "spawn-agent.sh: EXIT rc=$rc" >&2' EXIT

# A death by signal trips neither ERR nor EXIT, which is the remaining blind spot:
# the spawn that actually created the session still returned non-zero while staying
# silent through both. Name the signal so that case is not another guess.
for _sig in HUP INT TERM PIPE QUIT; do
  trap "echo \"spawn-agent.sh: died on SIG${_sig} at line \$LINENO: \$BASH_COMMAND\" >&2; exit 1" "$_sig"
done

# launchd/cron hand us a minimal PATH; make common per-user tool dirs (bun, etc.)
# discoverable both here and — via the -e PATH passed to the agent session below.
export PATH="$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

TASK_ID=$1
REPO_PATH=$2
BRANCH_NAME=$3
DESCRIPTION=${5:-$1}
MC_HOME="${MC_HOME:-$HOME/.mission-control}"
SWARM_DIR="$MC_HOME/swarm"
if [ -f "$MC_HOME/.env" ]; then set -a; source "$MC_HOME/.env"; set +a; fi
MC_URL="${MISSION_CONTROL_URL:-http://localhost:18900}"
WORKTREE_BASE="$(dirname "$REPO_PATH")/worktrees"
WORKTREE_PATH="$WORKTREE_BASE/$TASK_ID"
REGISTRY="$SWARM_DIR/active-tasks.json"
STATE_TOOL="$SWARM_DIR/swarm-state.py"
SCRIPT_DIR="$(python3 -c 'from pathlib import Path; import sys; print(Path(sys.argv[1]).resolve().parent)' "${BASH_SOURCE[0]}")"
source "$SCRIPT_DIR/mc-api.sh"

# Serialize this logical task before checking capacity or touching a worktree.
if [ "${MC_LAUNCH_LOCK:-}" != "$TASK_ID" ]; then
  exec python3 "$SCRIPT_DIR/launch_state.py" lock "${BASH_SOURCE[0]}" "$@"
fi
if python3 "$SCRIPT_DIR/launch_state.py" prepare "$TASK_ID" "${MC_TASK_ID:-}" "$REPO_PATH" "$BRANCH_NAME"; then
  echo "Adopted existing agent for $TASK_ID"
  exit 0
else
  probe_rc=$?
  [ "$probe_rc" -eq 1 ] || exit "$probe_rc"
fi

CONFIG="$SWARM_DIR/swarm-config.json"
DEFAULT_PROFILE=$(jq -r '.agents.defaultProfile // "codex"' "$CONFIG" 2>/dev/null || echo codex)
AGENT_PROFILE=${4:-$DEFAULT_PROFILE}

if [ -z "$TASK_ID" ] || [ -z "$REPO_PATH" ] || [ -z "$BRANCH_NAME" ]; then
  echo "Usage: spawn-agent.sh <task-id> <repo-path> <branch-name> [agent-profile] [description]"
  echo ""
  echo "Env vars: MAX_BUDGET_USD, MAX_TURNS, FALLBACK_MODEL, AGENTS_JSON, MAX_AGENT_RETRIES"
  exit 1
fi

# The ceiling is machine memory, so memory is what is checked — measured, not
# guessed at with a count. Checked before any profile is resolved: falling back to
# another profile does not create more memory.
RESOURCES_PY="$(dirname "$(readlink "${BASH_SOURCE[0]}" 2>/dev/null || echo "${BASH_SOURCE[0]}")")/resources.py"
if [ -f "$RESOURCES_PY" ]; then
  if ! python3 "$RESOURCES_PY" >/dev/null 2>&1; then
    echo "ERROR: machine memory is at the ceiling ($(python3 "$RESOURCES_PY" 2>/dev/null)) — retry when it frees"
    exit 3
  fi
fi

# An explicit count cap is still honoured when one is configured, for a machine
# shared with something else. 0 = off, and off is the default.
MAX_CONCURRENT=${MC_MAX_CONCURRENT_AGENTS:-$(jq -r '.agents.maxConcurrent // 0' "$CONFIG" 2>/dev/null || echo 0)}
if [ "${MAX_CONCURRENT:-0}" -gt 0 ]; then
  # Only agents that are actually alive count. Agents run in tmux, so a live tmux
  # session is the liveness signal; a dead one left marked running used to hold its
  # slot forever, and the machine idled while work queued.
  RUNNING_TOTAL=$(jq -r '.[] | select(.status == "running") | .tmuxSession // empty' "$REGISTRY" 2>/dev/null \
    | while read -r sess; do tmux has-session -t "$sess" 2>/dev/null && echo x; done | wc -l | tr -d ' ')
  if [ "${RUNNING_TOTAL:-0}" -ge "$MAX_CONCURRENT" ]; then
    echo "ERROR: at global agent limit ($RUNNING_TOTAL/$MAX_CONCURRENT) — retry once a slot frees"
    exit 3
  fi
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
    exit 3
  fi
fi

# A fallback profile has its own ceiling. Re-check it after switching; otherwise a
# full Codex pool could overflow the Claude pool (or vice versa) and the configured
# 8/5 split would only be a label, not an enforced capacity boundary.
RUNNING_PROFILE=$(jq --arg profile "$AGENT_PROFILE" '[.[] | select(.status == "running" and (.agentProfile // .agent) == $profile)] | length' "$REGISTRY" 2>/dev/null || echo 0)
if [ "$RUNNING_PROFILE" -ge "$AGENT_MAX_AGENTS" ]; then
  echo "ERROR: Agent profile '$AGENT_PROFILE' is full ($RUNNING_PROFILE/$AGENT_MAX_AGENTS)"
  exit 3
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
WORKTREE_BASE_REF="${WORKTREE_BASE_REF:-${BASE_BRANCH:-origin/main}}"
# Resolve through the symlink at $MC_HOME/swarm to reach the helper in the repo.
SCRIPT_SRC="${BASH_SOURCE[0]}"
while [ -L "$SCRIPT_SRC" ]; do
  LINK_TARGET="$(readlink "$SCRIPT_SRC")"
  case "$LINK_TARGET" in
    /*) SCRIPT_SRC="$LINK_TARGET" ;;
    *)  SCRIPT_SRC="$(dirname "$SCRIPT_SRC")/$LINK_TARGET" ;;
  esac
done
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_SRC")" && pwd)"

# Redispatch is also recovery. A prior attempt may have committed work or left dirty
# files before hitting a quota/turn boundary; deleting that worktree would silently
# turn a recoverable interruption into data loss. The helper only rebuilds a clean
# branch and otherwise returns the existing branch holder for the new session.
WORKTREE_REPORT=$(python3 "$SCRIPT_DIR/worktree_prepare.py" \
  --repo "$REPO_PATH" --worktree "$WORKTREE_PATH" \
  --branch "$BRANCH_NAME" --base "$WORKTREE_BASE_REF")
WORKTREE_PATH=$(printf '%s' "$WORKTREE_REPORT" | jq -r '.path')
if [ "$(printf '%s' "$WORKTREE_REPORT" | jq -r '.reused')" = "true" ]; then
  echo "  Reusing preserved worktree: $WORKTREE_PATH"
  echo "  Preserved $(printf '%s' "$WORKTREE_REPORT" | jq -r '.ahead') commit(s) and $(printf '%s' "$WORKTREE_REPORT" | jq -r '.dirty') dirty path(s)"
fi

# A worktree carries tracked files only, so local `.env` config does not come with
# it and anything that compiles or boots the app fails on missing environment —
# which reads as the agent's work being broken. Mirror it in from the source clone.
if [ -f "$SCRIPT_DIR/worktree_env.py" ]; then
  python3 "$SCRIPT_DIR/worktree_env.py" "$REPO_PATH" "$WORKTREE_PATH" \
    || echo "  warning: env seeding failed (agent may hit missing environment)"
fi

# Carry in the plan that was already written for this task. Planning ran as its own
# stage before any agent was spawned; without copying its output here the agent
# starts from a bare worktree and plans the same phase again — paying twice, and
# building against a spec nobody approved. Copied rather than shared: the agent
# commits its own progress against the plan, and must not write into the worktree a
# retry will re-plan from.
if [ -n "${MC_PLANNING_DIR:-}" ] && [ -d "${MC_PLANNING_DIR}/.planning" ] && [ ! -e "$WORKTREE_PATH/.planning" ]; then
  if cp -R "${MC_PLANNING_DIR}/.planning" "$WORKTREE_PATH/.planning" 2>/dev/null; then
    # Plans are authored in a temporary planning worktree. Older planners also used
    # MC's former `phase-1-*` example, which GSD cannot resolve. Repair both handoff
    # details before the execution agent sees the plan.
    python3 - "$SCRIPT_DIR" "$WORKTREE_PATH" "$MC_PLANNING_DIR" "$MC_HOME" "${MC_TASK_ID:-}" <<'PY'
import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
import gsd_backend
import gsd_plan_import

worktree, planning_worktree, mc_home, mc_task_id = sys.argv[2:6]
gsd_backend.normalize_plan_layout(worktree)
gsd_backend.rebase_plan_paths(worktree, planning_worktree, worktree)
if mc_task_id:
    plan_files = sorted(Path(worktree).rglob("*PLAN.md"))
    gsd_plan_import.write_mc_plan(Path(mc_home), mc_task_id, plan_files)
PY
    echo "  Carried in the plan from ${MC_PLANNING_DIR}"
  else
    echo "  warning: could not carry in .planning (agent will plan for itself)"
  fi
fi

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

# Install dependencies (best-effort — never abort the spawn on a dep hiccup;
# the agent can install/repair deps itself as its first step).
if [ -f "pnpm-lock.yaml" ]; then
  pnpm install || echo "  warning: pnpm install failed (agent will handle deps)"
elif [ -f "bun.lock" ] || [ -f "bun.lockb" ]; then
  bun install || echo "  warning: bun install failed (agent will handle deps)"
elif [ -f "yarn.lock" ]; then
  yarn install || echo "  warning: yarn install failed (agent will handle deps)"
elif [ -f "package-lock.json" ]; then
  npm install || echo "  warning: npm install failed (agent will handle deps)"
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
add_session_env() { if [ -n "${2:-}" ]; then TMUX_ENV_ARGS+=( -e "$1=$2" ); fi; }
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
add_session_env BASE_BRANCH        "${BASE_BRANCH:-}"
add_session_env WORKTREE_BASE_REF  "${WORKTREE_BASE_REF:-}"
# MC_TASK_ID/MC_URL are required for run-claude.sh's heartbeat loop and completion
# webhook — without MC_TASK_ID the heartbeat early-exits, so the agent runs but never
# shows up as live in Swarm Ops. PR_BASE_BRANCH carries the PR target through.
add_session_env MC_TASK_ID         "${MC_TASK_ID:-}"
add_session_env MC_URL             "${MC_URL:-}"
add_session_env PR_BASE_BRANCH     "${PR_BASE_BRANCH:-}"
add_session_env MC_NO_PR_MODE      "${MC_NO_PR_MODE:-}"
add_session_env MC_EXISTING_PR_URL "${MC_EXISTING_PR_URL:-}"

# Optional: give agents a SEPARATE git identity (a bot) so their commits and PRs
# aren't attributed to your local user. Read only these keys from MC_HOME/.env and
# pass them into the agent session ONLY — your shell, global git config, and gh
# login are never touched.
env_value() {  # env_value KEY -> value of KEY= from .env (strips surrounding quotes)
  local f="$MC_HOME/.env" line val
  [ -f "$f" ] || return 0
  line="$(grep -E "^$1=" "$f" | tail -1 || true)"
  [ -n "$line" ] || return 0
  val="${line#*=}"; val="${val%\"}"; val="${val#\"}"
  printf '%s' "$val"
}
BOT_GIT_NAME="$(env_value MC_AGENT_GIT_NAME)"
BOT_GIT_EMAIL="$(env_value MC_AGENT_GIT_EMAIL)"
BOT_GH_TOKEN="$(env_value MC_AGENT_GH_TOKEN)"
add_session_env GIT_AUTHOR_NAME     "$BOT_GIT_NAME"
add_session_env GIT_AUTHOR_EMAIL    "$BOT_GIT_EMAIL"
add_session_env GIT_COMMITTER_NAME  "$BOT_GIT_NAME"
add_session_env GIT_COMMITTER_EMAIL "$BOT_GIT_EMAIL"
add_session_env GH_TOKEN            "$BOT_GH_TOKEN"

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
TMUX_ENV_ARGS+=( -e "MC_LAUNCHER=$LAUNCHER" -e "MC_TASK_ARG=$TASK_ID" -e "PATH=$PATH" )

# Spawn tmux session. The command is a fixed literal; MC_LAUNCHER and
# MC_TASK_ARG are resolved from the session env (set via -e above).


# Register task
BUDGET_DISPLAY="${MAX_BUDGET_USD:-unlimited}"
TURNS_DISPLAY="${MAX_TURNS:-unlimited}"
AGENTS_DISPLAY="${AGENTS_JSON:-none}"

LAUNCH_ATTEMPT=$(python3 -c 'import uuid; print(uuid.uuid4())')
TASK_JSON=$(jq -n \
  --arg attempt "$LAUNCH_ATTEMPT" \
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
  --argjson noPrMode "$([ "${MC_NO_PR_MODE:-0}" = "1" ] && echo true || echo false)" \
  --arg fallbackModel "${AGENT_FALLBACK_MODEL:-${FALLBACK_MODEL:-}}" \
  --argjson startedAt "$(date +%s)000" \
  --argjson agentTeams "$([ -n "${AGENTS_JSON:-}" ] && echo true || echo false)" \
  --argjson maxBudgetUsd "${MAX_BUDGET_USD:-null}" \
  --argjson maxTurns "${MAX_TURNS:-null}" \
  --argjson agentEnv "$AGENT_ENV_JSON" \
  '{
    id: $id,
    launchAttemptId: $attempt,
    launchState: "starting",
    launchAcknowledgedAt: null,
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
    noPrMode: $noPrMode,
    startedAt: $startedAt,
    status: "running",
    deliveryPending: false,
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

# Register before the child can update its heartbeat or completion. A launcher
# acknowledgement is durable even if this parent dies before returning to bridge.
TMUX_ENV_ARGS+=( -e "MC_LAUNCH_ATTEMPT=$LAUNCH_ATTEMPT" -e "MC_LAUNCH_HELPER=$SCRIPT_DIR/launch_state.py" -e "MC_HOME=$MC_HOME" )
# Close the inherited flock descriptor in tmux; its daemon must not own our lock.
# The descriptor is allocated by launch_state.py and restricted to digits.
case "${MC_LAUNCH_LOCK_FD:-}" in
  ''|*[!0-9]*) echo "Invalid launch lock descriptor" >&2; exit 2 ;;
esac
if ! python3 - "$MC_LAUNCH_LOCK_FD" "$TMUX_SESSION" "$WORKTREE_PATH" "${TMUX_ENV_ARGS[@]}" <<'PYLAUNCH'
import os, sys
os.close(int(sys.argv[1]))
os.execvp("tmux", ["tmux", "new-session", "-d", "-s", sys.argv[2], "-c", sys.argv[3],
                  *sys.argv[4:], 'exec python3 "$MC_LAUNCH_HELPER" exec "$MC_LAUNCHER" "$MC_TASK_ARG"'])
PYLAUNCH
then
  python3 "$STATE_TOOL" update --task-id "$TASK_ID" --attempt-id "$LAUNCH_ATTEMPT" \
    --patch-json '{"status":"failed","launchState":"failed"}' --reason launch-failed || true
  exit 1
fi
python3 "$SCRIPT_DIR/launch_state.py" wait "$TASK_ID" "$LAUNCH_ATTEMPT" "${MC_LAUNCH_ACK_TIMEOUT_SECONDS:-20}"


# Append to spawn history log (append-only JSONL backup)
HISTORY_FILE="$SWARM_DIR/spawn-history.jsonl"
echo "$TASK_JSON" | jq -c '. + {"spawnedAt": "'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'"}' >> "$HISTORY_FILE" || echo "warning: could not append spawn history" >&2

if [ -n "${MC_TASK_ID:-}" ]; then
  PROMPT_CONTENT=$(head -c 4000 "$SWARM_DIR/prompts/${TASK_ID}.md" 2>/dev/null || true)
  if [ -n "$PROMPT_CONTENT" ]; then
    mc_curl POST "/api/tasks/$MC_TASK_ID/activities" -s --max-time 5 \
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
