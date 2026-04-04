#!/bin/bash
# Agent Monitor — checks active agents, validates GSD artifacts, runs Codex review.
# Runs every 10 minutes via cron.
#
# Lifecycle per agent:
#   tmux alive? → PR exists? → CI green? → GSD valid? → Codex review → issues? → iterate (max 3) → complete → notify Linear
SWARM_DIR="$HOME/.openclaw/swarm"
REGISTRY="$SWARM_DIR/active-tasks.json"
LOG="$SWARM_DIR/logs/monitor-$(date +%Y%m%d).log"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

if [ -f "$HOME/.openclaw/.env" ]; then
  set -a
  source "$HOME/.openclaw/.env"
  set +a
fi

MC_URL="${MISSION_CONTROL_URL:-http://localhost:18789/ext/mission-control}"
CONFIG="$SWARM_DIR/swarm-config.json"
CFG_REVIEW_EFFORT=$(jq -r '.codex.reviewEffort // "xhigh"' "$CONFIG" 2>/dev/null || echo "xhigh")
CODEX_EFFORT="${CODEX_REVIEW_EFFORT:-$CFG_REVIEW_EFFORT}"
STATE_TOOL="$SWARM_DIR/swarm-state.py"
SNAPSHOT_STAMP="$SWARM_DIR/.last-state-snapshot"
SNAPSHOT_INTERVAL_MIN="${SNAPSHOT_INTERVAL_MIN:-60}"
IDLE_WARN_MIN="${IDLE_WARN_MIN:-30}"
STUCK_ALERT_COOLDOWN_MIN="${STUCK_ALERT_COOLDOWN_MIN:-20}"
HEARTBEAT_STALE_THRESHOLD_MS="${HEARTBEAT_STALE_THRESHOLD_MS:-300000}"

echo "[$TIMESTAMP] === Monitor check ===" >> "$LOG"

state_update() {
  local task_id="$1"
  local patch_json="$2"
  local reason="${3:-check-agents}"
  python3 "$STATE_TOOL" update --task-id "$task_id" --patch-json "$patch_json" --reason "$reason" >/dev/null 2>&1 || \
    echo "[$TIMESTAMP] WARN: state update failed for $task_id ($reason)" >> "$LOG"
}

maybe_snapshot_state() {
  local now_epoch
  now_epoch=$(date +%s)
  local last_epoch=0
  if [ -f "$SNAPSHOT_STAMP" ]; then
    last_epoch=$(cat "$SNAPSHOT_STAMP" 2>/dev/null || echo 0)
  fi
  local elapsed_min=$(((now_epoch - last_epoch) / 60))
  if [ "$elapsed_min" -lt "$SNAPSHOT_INTERVAL_MIN" ]; then
    return
  fi

  if snapshot_file=$(python3 "$STATE_TOOL" snapshot-create 2>/dev/null); then
    echo "$now_epoch" > "$SNAPSHOT_STAMP"
    echo "[$TIMESTAMP] SNAPSHOT: $snapshot_file" >> "$LOG"
  else
    echo "[$TIMESTAMP] WARN: snapshot create failed" >> "$LOG"
  fi
}

maybe_snapshot_state

reconcile_non_running_sessions() {
  local ids
  ids=$(jq -r '.[] | select(.status != "running") | .id' "$REGISTRY" 2>/dev/null)
  [ -z "$ids" ] && return

  while read -r task_id; do
    [ -z "$task_id" ] && continue
    local session
    session=$(jq -r ".[] | select(.id == \"$task_id\") | .tmuxSession // empty" "$REGISTRY" 2>/dev/null)
    local status
    status=$(jq -r ".[] | select(.id == \"$task_id\") | .status // empty" "$REGISTRY" 2>/dev/null)
    local last_attempt
    last_attempt=$(jq -r ".[] | select(.id == \"$task_id\") | (.lastAttemptAt // .lastRespawnAt // .startedAt // 0)" "$REGISTRY" 2>/dev/null)
    [ -z "$session" ] && continue

    if tmux has-session -t "$session" 2>/dev/null; then
      local now_ms
      now_ms=$(($(date +%s) * 1000))
      local age_ms=$((now_ms - last_attempt))
      if [ "$age_ms" -gt 600000 ] && [[ "$status" =~ ^(completed_by_agent|ready|failed|done|merged|killed)$ ]]; then
        echo "[$TIMESTAMP] RECONCILE: $task_id terminal status $status with stale tmux session; terminating $session" >> "$LOG"
        tmux kill-session -t "$session" 2>/dev/null || true
        state_update "$task_id" '{"lastError": "stale_tmux_session_reconciled"}' "reconcile-non-running"
      else
        echo "[$TIMESTAMP] RECONCILE: $task_id has non-running status but live tmux session; observing (status=$status, ageMs=$age_ms)" >> "$LOG"
      fi
    fi
  done <<< "$ids"
}

reconcile_non_running_sessions

prune_state_artifacts() {
  local events_file="$SWARM_DIR/events.jsonl"
  if [ -f "$events_file" ]; then
    python3 - <<'PY'
from pathlib import Path
path = Path.home() / ".openclaw" / "swarm" / "events.jsonl"
lines = path.read_text().splitlines()
if len(lines) > 20000:
    path.write_text("\n".join(lines[-20000:]) + "\n")
PY
  fi

  local snapshots_dir="$SWARM_DIR/state-snapshots"
  if [ -d "$snapshots_dir" ]; then
    python3 - <<'PY'
from pathlib import Path
snapshots = sorted((Path.home() / ".openclaw" / "swarm" / "state-snapshots").glob("snapshot-*.json"), reverse=True)
for stale in snapshots[50:]:
    stale.unlink(missing_ok=True)
PY
  fi
}

prune_state_artifacts

reconcile_completed_agents_to_mc() {
  local completed_ids
  completed_ids=$(jq -r '.[] | select(.status == "completed_by_agent") | .id' "$REGISTRY" 2>/dev/null)
  [ -z "$completed_ids" ] && return

  while read -r task_id; do
    [ -z "$task_id" ] && continue
    local mc_task_id
    mc_task_id=$(jq -r ".[] | select(.id == \"$task_id\") | .mcTaskId // empty" "$REGISTRY" 2>/dev/null)
    [ -z "$mc_task_id" ] && continue

    local synced_at
    synced_at=$(jq -r ".[] | select(.id == \"$task_id\") | .completionSyncedAt // empty" "$REGISTRY" 2>/dev/null)

    local task_json
    task_json=$(curl -s "$MC_URL/api/tasks/$mc_task_id" 2>/dev/null)
    [ -z "$task_json" ] && continue

    local task_type mc_status
    task_type=$(echo "$task_json" | jq -r '.task_type // "implementation"' 2>/dev/null)
    mc_status=$(echo "$task_json" | jq -r '.status // "unknown"' 2>/dev/null)

    if [ "$task_type" = "investigation" ] && [[ "$mc_status" =~ ^(in_progress|assigned|planning|inbox)$ ]]; then
      if [ -n "$synced_at" ]; then
        echo "[$TIMESTAMP] RECONCILE: $task_id — stale completionSyncedAt detected while MC is active ($mc_status), forcing resync" >> "$LOG"
      fi
      if mc_complete_task "$mc_task_id" "Investigation complete" "review"; then
        mc_post_activity "$mc_task_id" "updated" "Monitor reconciled investigation completion from agent status"
        echo "[$TIMESTAMP] RECONCILE: $task_id — synced completed_by_agent to MC review" >> "$LOG"
        state_update "$task_id" "{\"status\": \"ready\", \"completionSyncedAt\": \"$TIMESTAMP\"}" "completion-reconcile"
      else
        echo "[$TIMESTAMP] WARN: $task_id — failed to sync completed_by_agent to MC (will retry)" >> "$LOG"
      fi
      continue
    fi

    if [ -n "$synced_at" ]; then
      continue
    fi

    if [[ "$mc_status" =~ ^(review|done|testing|merged)$ ]]; then
      state_update "$task_id" "{\"status\": \"ready\", \"completionSyncedAt\": \"$TIMESTAMP\"}" "completion-already-synced"
    fi
  done <<< "$completed_ids"
}

mc_post_activity() {
  local task_id="$1"
  local activity_type="$2"
  local message="$3"
  curl -s -X POST "$MC_URL/api/tasks/$task_id/activities" \
    -H "Content-Type: application/json" \
    -d "{\"activity_type\": \"$activity_type\", \"message\": \"$message\"}" \
    > /dev/null 2>&1
}

mc_add_deliverable() {
  local task_id="$1"
  local title="$2"
  local url="$3"
  curl -s -X POST "$MC_URL/api/tasks/$task_id/deliverables" \
    -H "Content-Type: application/json" \
    -d "{\"deliverable_type\": \"url\", \"title\": \"$title\", \"path\": \"$url\"}" \
    > /dev/null 2>&1
}

mc_complete_task() {
  local task_id="$1"
  local summary="$2"
  local status="${3:-review}"
  curl -s -X POST "$MC_URL/api/webhooks/agent-completion" \
    -H "Content-Type: application/json" \
    -d "{\"task_id\": \"$task_id\", \"summary\": \"$summary\", \"status\": \"$status\"}" \
    > /dev/null 2>&1
}

reconcile_completed_agents_to_mc

linear_post_completion() {
  local task_id="$1"
  local pr_url="$2"
  local summary="$3"

  local api_key="${LINEAR_API_KEY:-}"
  [ -z "$api_key" ] && return

  local task_data
  task_data=$(curl -s "$MC_URL/api/tasks/$task_id" 2>/dev/null)

  local linear_url
  linear_url=$(echo "$task_data" | jq -r '.external_url // .linear_issue_url // empty' 2>/dev/null)

  if [ -z "$linear_url" ]; then
    local parent_id
    parent_id=$(echo "$task_data" | jq -r '.parent_task_id // empty' 2>/dev/null)
    [ -n "$parent_id" ] && linear_url=$(curl -s "$MC_URL/api/tasks/$parent_id" | jq -r '.external_url // .linear_issue_url // empty' 2>/dev/null)
  fi

  [ -z "$linear_url" ] && return

  local issue_tag
  issue_tag=$(echo "$linear_url" | grep -oE '[A-Z]+-[0-9]+' | tail -1)
  [ -z "$issue_tag" ] && return

  local team_key issue_num
  team_key=$(echo "$issue_tag" | grep -oE '^[A-Z]+')
  issue_num=$(echo "$issue_tag" | grep -oE '[0-9]+$')

  local lookup_result
  lookup_result=$(curl -s "https://api.linear.app/graphql" \
    -H "Content-Type: application/json" \
    -H "Authorization: $api_key" \
    -d "{\"query\": \"query { issues(filter: { number: { eq: $issue_num }, team: { key: { eq: \\\"$team_key\\\" } } }) { nodes { id } } }\"}" 2>/dev/null)

  local linear_id
  linear_id=$(echo "$lookup_result" | jq -r '.data.issues.nodes[0].id // empty' 2>/dev/null)
  [ -z "$linear_id" ] && return

  local is_change_request
  is_change_request=$(jq -r ".[] | select(.mcTaskId == \"$task_id\" or .id == \"$task_id\") | .changeRequestAt // empty" "$SWARM_DIR/active-tasks.json" 2>/dev/null)

  local body
  if [ -n "$is_change_request" ]; then
    body="**Agent updated the PR:**\\n\\nPR: $pr_url\\n\\n$summary"
  else
    body="**Agent completed work:**\\n\\nPR: $pr_url\\n\\n$summary"
  fi

  curl -s "https://api.linear.app/graphql" \
    -H "Content-Type: application/json" \
    -H "Authorization: $api_key" \
    -d "{\"query\": \"mutation(\$id: String!, \$body: String!) { commentCreate(input: { issueId: \$id, body: \$body }) { success } }\", \"variables\": {\"id\": \"$linear_id\", \"body\": \"$body\"}}" \
    > /dev/null 2>&1

  echo "[$TIMESTAMP] LINEAR: Posted completion comment to $issue_id" >> "$LOG"
}

# Validate GSD artifacts in worktree. Returns 0 if valid, 1 if missing/failed.
# Sets GSD_STATUS to "passed", "gaps_found", "missing", or "no_planning".
validate_gsd_artifacts() {
  local worktree="$1"
  local planning_dir="$worktree/.planning"

  if [ ! -d "$planning_dir" ]; then
    GSD_STATUS="no_planning"
    return 1
  fi

  local plan_count
  plan_count=$(ls "$planning_dir"/phases/*/*-PLAN.md 2>/dev/null | wc -l | tr -d ' ')
  if [ "$plan_count" -eq 0 ]; then
    GSD_STATUS="missing"
    return 1
  fi

  local verification_file
  verification_file=$(ls -t "$planning_dir"/phases/*/*-VERIFICATION.md 2>/dev/null | head -1)
  if [ -z "$verification_file" ]; then
    GSD_STATUS="missing"
    return 1
  fi

  local status
  status=$(grep -m1 "^status:" "$verification_file" 2>/dev/null | sed 's/status: *//')
  if [ "$status" = "passed" ] || [ "$status" = "human_needed" ]; then
    GSD_STATUS="$status"
    return 0
  fi

  GSD_STATUS="${status:-unknown}"
  return 1
}

extract_agent_summary() {
  local task_id="$1"
  local worktree="$2"
  local log_file="$SWARM_DIR/logs/agent-${task_id}.log"
  AGENT_SUMMARY=""

  local parts=()

  # File changes from worktree (git diff --stat against main)
  if [ -d "$worktree/.git" ] || [ -f "$worktree/.git" ]; then
    local diff_stat
    diff_stat=$(cd "$worktree" && git diff --stat main 2>/dev/null | tail -1)
    [ -n "$diff_stat" ] && parts+=("Changes: $diff_stat")
  fi

  # Test results from agent log
  if [ -f "$log_file" ]; then
    local test_line
    test_line=$(grep -E '(Tests?:?\s+\d+\s+(passed|failed))|(PASS|FAIL)\s+\d+' "$log_file" 2>/dev/null | tail -1)
    [ -n "$test_line" ] && parts+=("Tests: $(echo "$test_line" | sed 's/^[[:space:]]*//' | head -c 120)")

    local features
    features=$(grep -oE '(feat|feature|add|implement|create)[^.]*\.' "$log_file" 2>/dev/null | tail -3 | sed 's/^/  - /')
    [ -n "$features" ] && parts+=("Features:
$features")
  fi

  if [ ${#parts[@]} -gt 0 ]; then
    AGENT_SUMMARY=$(printf '%s\n' "${parts[@]}")
  fi
}

HEALTH_LOG="$SWARM_DIR/spawn-history.jsonl"

log_health_check() {
  local task_id="$1"
  local session="$2"
  local started_at="$3"
  local mc_task_id="$4"

  local now_ms=$(($(date +%s) * 1000))
  local last_attempt_at
  last_attempt_at=$(jq -r ".[] | select(.id == \"$task_id\") | (.lastAttemptAt // .lastRespawnAt // .startedAt // 0)" "$REGISTRY" 2>/dev/null)
  local last_heartbeat_at
  last_heartbeat_at=$(jq -r ".[] | select(.id == \"$task_id\") | (.lastHeartbeatAt // 0)" "$REGISTRY" 2>/dev/null)
  local heartbeat_interval_sec
  heartbeat_interval_sec=$(jq -r ".[] | select(.id == \"$task_id\") | (.heartbeatIntervalSec // 0)" "$REGISTRY" 2>/dev/null)
  local last_stuck_warn_at
  last_stuck_warn_at=$(jq -r ".[] | select(.id == \"$task_id\") | (.lastStuckWarnAt // 0)" "$REGISTRY" 2>/dev/null)

  local reference_at="$started_at"
  if [ "$last_attempt_at" -gt "$reference_at" ] 2>/dev/null; then
    reference_at="$last_attempt_at"
  fi
  if [ "$last_heartbeat_at" -gt "$reference_at" ] 2>/dev/null; then
    reference_at="$last_heartbeat_at"
  fi

  local elapsed_ms=$((now_ms - reference_at))
  local elapsed_min=$((elapsed_ms / 60000))

  local last_lines=""
  local pane_activity="unknown"
  if tmux has-session -t "$session" 2>/dev/null; then
    last_lines=$(tmux capture-pane -t "$session" -p -l 5 2>/dev/null | tr '\n' '|' | tail -c 300)
    if [ -n "$last_lines" ] && [ "$last_lines" != "|||||" ]; then
      pane_activity="active"
    else
      pane_activity="idle"
    fi
  else
    pane_activity="dead"
  fi

  local pr_exists="false"
  local repo branch pr_num
  repo=$(jq -r ".[] | select(.id == \"$task_id\") | .repo" "$REGISTRY")
  branch=$(jq -r ".[] | select(.id == \"$task_id\") | .branch" "$REGISTRY")
  pr_num=$(cd "$repo" && gh pr list --head "$branch" --json number -q '.[0].number' 2>/dev/null)
  [ -n "$pr_num" ] && pr_exists="true"

  printf '{"type":"health","id":"%s","at":"%s","elapsedMin":%d,"paneActivity":"%s","prExists":%s,"mcTaskId":"%s","lastOutput":"%s"}\n' \
    "$task_id" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$elapsed_min" "$pane_activity" "$pr_exists" "$mc_task_id" \
    "$(echo "$last_lines" | sed 's/"/\\"/g' | head -c 200)" \
    >> "$HEALTH_LOG"

  echo "[$TIMESTAMP] HEALTH: $task_id — ${elapsed_min}min elapsed, pane=$pane_activity, pr=$pr_exists" >> "$LOG"

  local heartbeat_age_ms=$((now_ms - last_heartbeat_at))
  local heartbeat_threshold_ms="$HEARTBEAT_STALE_THRESHOLD_MS"
  if [ "$heartbeat_interval_sec" -gt 0 ] 2>/dev/null; then
    local derived_hb_threshold=$((heartbeat_interval_sec * 3000))
    if [ "$derived_hb_threshold" -gt "$heartbeat_threshold_ms" ]; then
      heartbeat_threshold_ms="$derived_hb_threshold"
    fi
  fi

  local heartbeat_fresh="false"
  if [ "$last_heartbeat_at" -gt 0 ] 2>/dev/null && [ "$heartbeat_age_ms" -le "$heartbeat_threshold_ms" ]; then
    heartbeat_fresh="true"
  fi

  local cooldown_ms=$((STUCK_ALERT_COOLDOWN_MIN * 60000))
  local since_last_warn=$((now_ms - last_stuck_warn_at))
  local cooldown_ok="true"
  if [ "$last_stuck_warn_at" -gt 0 ] 2>/dev/null && [ "$since_last_warn" -lt "$cooldown_ms" ]; then
    cooldown_ok="false"
  fi

  if [ "$pane_activity" = "idle" ] && [ "$elapsed_min" -gt "$IDLE_WARN_MIN" ] && [ "$heartbeat_fresh" = "false" ] && [ "$cooldown_ok" = "true" ]; then
    echo "[$TIMESTAMP] WARN: $task_id — idle for ${elapsed_min}min, may be stuck (heartbeatAgeMs=$heartbeat_age_ms)" >> "$LOG"
    state_update "$task_id" "{\"lastStuckWarnAt\": $now_ms}" "stuck-warn"
    [ -n "$mc_task_id" ] && mc_post_activity "$mc_task_id" "updated" "Agent possibly stuck — idle for ${elapsed_min}min"
  fi
}

MAX_REVIEW_CYCLES="${MAX_REVIEW_CYCLES:-3}"
CFG_CI_FIX_ENABLED=$(jq -r '.ciAutoFix.enabled // true' "$CONFIG" 2>/dev/null || echo "true")
CFG_MAX_CI_FIX=$(jq -r '.ciAutoFix.maxCycles // 2' "$CONFIG" 2>/dev/null || echo "2")
MAX_CI_FIX_CYCLES="${MAX_CI_FIX_CYCLES:-$CFG_MAX_CI_FIX}"

extract_ci_failures() {
  local repo="$1"
  local pr_num="$2"
  CI_FAILURE_DETAILS=""

  local checks_json
  checks_json=$(cd "$repo" && gh pr checks "$pr_num" --json name,state,detailsUrl 2>/dev/null) || return 1

  local failed_names
  failed_names=$(echo "$checks_json" | jq -r '.[] | select(.state == "FAILURE") | .name' 2>/dev/null)
  [ -z "$failed_names" ] && return 1

  local details="Failed CI checks for PR #$pr_num:\n"

  while IFS= read -r check_name; do
    details+="\\n## $check_name\\n"
    local run_id
    run_id=$(cd "$repo" && gh run list --json databaseId,name,status -q ".[] | select(.name == \"$check_name\" and .status == \"completed\") | .databaseId" 2>/dev/null | head -1)
    if [ -n "$run_id" ]; then
      local log_output
      log_output=$(cd "$repo" && gh run view "$run_id" --log-failed 2>/dev/null | tail -80)
      if [ -n "$log_output" ]; then
        details+="$log_output\\n"
      else
        details+="(No log output available — check GitHub Actions manually)\\n"
      fi
    else
      details+="(Could not find run ID — check GitHub Actions manually)\\n"
    fi
  done <<< "$failed_names"

  CI_FAILURE_DETAILS="$details"
  return 0
}

relaunch_agent_for_ci_fix() {
  local task_id="$1"
  local worktree="$2"
  local ci_details="$3"
  local cycle="$4"

  local agent_type
  agent_type=$(jq -r ".[] | select(.id == \"$task_id\") | .agent // \"claude\"" "$REGISTRY")
  local session
  session=$(jq -r ".[] | select(.id == \"$task_id\") | .tmuxSession" "$REGISTRY")

  local fix_prompt="$SWARM_DIR/prompts/${task_id}-cifix-${cycle}.md"
  cat > "$fix_prompt" <<CIFIXEOF
# CI Fix — Iteration $cycle

GitHub Actions CI checks are failing on your PR. Fix the issues and push.

## CI Failure Details
$(echo -e "$ci_details")

## Instructions
1. Read the CI failure output above carefully
2. Identify the root cause of each failure
3. Fix the code — focus on build errors, type errors, lint issues, and test failures
4. Run the same checks locally to verify your fix before pushing:
   - Check \`.github/workflows/\` to understand what CI runs
   - Run the equivalent commands (e.g. tsc, lint, test)
5. Commit fixes with message: "fix: resolve CI failures (ci-fix cycle $cycle)"
6. Push to update the existing PR

Do NOT create a new PR. Fix the existing code and push.
CIFIXEOF

  if [ "$agent_type" = "codex" ]; then
    LAUNCHER="$SWARM_DIR/run-codex.sh"
  else
    LAUNCHER="$SWARM_DIR/run-claude.sh"
  fi

  tmux kill-session -t "$session" 2>/dev/null || true
  tmux new-session -d -s "$session" -c "$worktree" \
    "PROMPT_OVERRIDE=$fix_prompt $LAUNCHER $task_id"

  state_update "$task_id" "{\"status\": \"running\", \"ciFixCycles\": $cycle}" "ci-fix-relaunch"

  echo "[$TIMESTAMP] CI-FIX: $task_id — relaunched for CI fix cycle $cycle" >> "$LOG"
}

run_codex_review() {
  local repo="$1"
  local branch="$2"
  local pr_num="$3"
  local review_log="$SWARM_DIR/logs/codex-review-${pr_num}.log"

  if ! command -v codex &> /dev/null; then
    echo "Codex CLI not found, skipping review" >> "$LOG"
    return 1
  fi

  echo "[$TIMESTAMP] Running Codex review on PR #$pr_num..." >> "$LOG"

  local base_branch
  base_branch=$(jq -r ".[] | select(.id == \"$TASK_ID\") | .baseBranch // \"origin/main\"" "$REGISTRY" 2>/dev/null)
  local worktree_dir
  worktree_dir=$(jq -r ".[] | select(.id == \"$TASK_ID\") | .worktree // empty" "$REGISTRY" 2>/dev/null)
  local review_dir="${worktree_dir:-$repo}"

  local review_output
  review_output=$(cd "$review_dir" && codex review --base "$base_branch" 2>&1) || {
    echo "[$TIMESTAMP] Codex review failed for PR #$pr_num" >> "$LOG"
    return 1
  }

  echo "$review_output" > "$review_log"
  echo "[$TIMESTAMP] Codex review saved to $review_log" >> "$LOG"
  CODEX_REVIEW="$review_output"
  return 0
}

review_has_blocking_issues() {
  local review="$1"
  if echo "$review" | grep -qE "\[P1\]|\[P0\]"; then
    return 0
  fi
  if echo "$review" | grep -qi "VERDICT: FAIL"; then
    return 0
  fi
  if echo "$review" | grep -qi "critical"; then
    return 0
  fi
  return 1
}

relaunch_agent_with_review() {
  local task_id="$1"
  local worktree="$2"
  local review="$3"
  local cycle="$4"

  local agent_type
  agent_type=$(jq -r ".[] | select(.id == \"$task_id\") | .agent // \"claude\"" "$REGISTRY")
  local session
  session=$(jq -r ".[] | select(.id == \"$task_id\") | .tmuxSession" "$REGISTRY")

  local iteration_prompt="$SWARM_DIR/prompts/${task_id}-review-${cycle}.md"
  cat > "$iteration_prompt" <<REVIEWEOF
# Code Review Feedback — Iteration $cycle

The Codex reviewer found issues with your changes. Fix them and update the PR.

## Review Output
$review

## Instructions
1. Read the review feedback above carefully
2. Fix ALL critical and warning issues in your code
3. Run tests to verify your fixes
4. Commit the fixes with message: "fix: address review feedback (cycle $cycle)"
5. Push to update the existing PR

Do NOT create a new PR. Fix the existing code and push.
REVIEWEOF

  if [ "$agent_type" = "codex" ]; then
    LAUNCHER="$SWARM_DIR/run-codex.sh"
  else
    LAUNCHER="$SWARM_DIR/run-claude.sh"
  fi

  tmux kill-session -t "$session" 2>/dev/null || true
  tmux new-session -d -s "$session" -c "$worktree" \
    "PROMPT_OVERRIDE=$iteration_prompt $LAUNCHER $task_id"

  state_update "$task_id" "{\"status\": \"running\", \"reviewCycles\": $cycle}" "review-relaunch"

  echo "[$TIMESTAMP] ITERATE: $task_id — relaunched for review cycle $cycle" >> "$LOG"
}

RUNNING_IDS=$(jq -r '.[] | select(.status == "running") | .id' "$REGISTRY" 2>/dev/null)

if [ -z "$RUNNING_IDS" ]; then
  echo "[$TIMESTAMP] No active agents." >> "$LOG"
  exit 0
fi

echo "$RUNNING_IDS" | while read -r TASK_ID; do
  SESSION=$(jq -r ".[] | select(.id == \"$TASK_ID\") | .tmuxSession" "$REGISTRY")
  BRANCH=$(jq -r ".[] | select(.id == \"$TASK_ID\") | .branch" "$REGISTRY")
  REPO=$(jq -r ".[] | select(.id == \"$TASK_ID\") | .repo" "$REGISTRY")
  WORKTREE=$(jq -r ".[] | select(.id == \"$TASK_ID\") | .worktree" "$REGISTRY")
  MC_TASK_ID=$(jq -r ".[] | select(.id == \"$TASK_ID\") | .mcTaskId // empty" "$REGISTRY")

  STARTED_AT=$(jq -r ".[] | select(.id == \"$TASK_ID\") | .startedAt // .lastAttemptAt // .lastRespawnAt // 0" "$REGISTRY")
  if [ "$STARTED_AT" -eq 0 ] 2>/dev/null; then
    echo "[$TIMESTAMP] SKIP HEALTH: $TASK_ID — no start timestamp available" >> "$LOG"
  else
    log_health_check "$TASK_ID" "$SESSION" "$STARTED_AT" "$MC_TASK_ID"
  fi

  if ! tmux has-session -t "$SESSION" 2>/dev/null; then
    RETRY_COUNT=$(jq -r ".[] | select(.id == \"$TASK_ID\") | .retryCount // 0" "$REGISTRY")
    MAX_RETRIES=3

    if [ "$RETRY_COUNT" -lt "$MAX_RETRIES" ]; then
      NEW_RETRY=$((RETRY_COUNT + 1))
      echo "[$TIMESTAMP] DEAD: $TASK_ID — respawning (attempt $NEW_RETRY/$MAX_RETRIES)" >> "$LOG"

      AGENT_TYPE=$(jq -r ".[] | select(.id == \"$TASK_ID\") | .agent // \"claude\"" "$REGISTRY")
      WORKTREE_DIR=$(jq -r ".[] | select(.id == \"$TASK_ID\") | .worktree // empty" "$REGISTRY")

      if [ "$AGENT_TYPE" = "codex" ]; then
        LAUNCHER="$SWARM_DIR/run-codex.sh"
      else
        LAUNCHER="$SWARM_DIR/run-claude.sh"
      fi

      WORK_DIR="${WORKTREE_DIR:-$REPO}"
      if [ -d "$WORK_DIR" ]; then
        tmux new-session -d -s "$SESSION" -c "$WORK_DIR" "$LAUNCHER $TASK_ID"
        state_update "$TASK_ID" "{\"retryCount\": $NEW_RETRY, \"status\": \"running\", \"lastRespawnAt\": $(date +%s)000}" "dead-session-respawn"
        [ -n "$MC_TASK_ID" ] && mc_post_activity "$MC_TASK_ID" "updated" "Agent respawned (attempt $NEW_RETRY/$MAX_RETRIES)"
      else
        echo "[$TIMESTAMP] DEAD: $TASK_ID — worktree $WORK_DIR missing, cannot respawn" >> "$LOG"
        state_update "$TASK_ID" "{\"status\": \"failed\", \"lastError\": \"worktree_missing\"}" "worktree-missing"
        [ -n "$MC_TASK_ID" ] && mc_post_activity "$MC_TASK_ID" "updated" "Agent failed — worktree missing, cannot respawn"
      fi
    else
      echo "[$TIMESTAMP] DEAD: $TASK_ID — exhausted $MAX_RETRIES retries, marking failed" >> "$LOG"
      state_update "$TASK_ID" "{\"status\": \"failed\", \"lastError\": \"max_retries_exhausted\"}" "max-retries-exhausted"
      [ -n "$MC_TASK_ID" ] && mc_post_activity "$MC_TASK_ID" "updated" "Agent failed after $MAX_RETRIES retries — manual intervention needed"
    fi
    continue
  fi

  PR_NUM=$(cd "$REPO" && gh pr list --head "$BRANCH" --json number -q '.[0].number' 2>/dev/null)

  # Check if this is an investigation task (no PR expected)
  TASK_TYPE=""
  if [ -n "$MC_TASK_ID" ]; then
    TASK_TYPE=$(curl -s "$MC_URL/api/tasks/$MC_TASK_ID" 2>/dev/null | jq -r '.task_type // "implementation"' 2>/dev/null)
  fi

  if [ "$TASK_TYPE" = "investigation" ]; then
    # Investigation tasks don't produce PRs — check if agent completed via webhook
    MC_STATUS=$(curl -s "$MC_URL/api/tasks/$MC_TASK_ID" 2>/dev/null | jq -r '.status // "unknown"' 2>/dev/null)
    if [ "$MC_STATUS" = "done" ] || [ "$MC_STATUS" = "review" ]; then
      echo "[$TIMESTAMP] INVESTIGATION DONE: $TASK_ID — agent reported findings" >> "$LOG"
      state_update "$TASK_ID" '{"status": "ready"}' "investigation-ready"
      linear_post_completion "$MC_TASK_ID" "" "Investigation completed — findings posted to Mission Control"
    else
      echo "[$TIMESTAMP] RUNNING: $TASK_ID — investigation in progress (no PR expected)" >> "$LOG"
    fi
    continue
  fi

  if [ -z "$PR_NUM" ]; then
    echo "[$TIMESTAMP] RUNNING: $TASK_ID — no PR yet" >> "$LOG"
    continue
  fi

  PR_URL=$(cd "$REPO" && gh pr view "$PR_NUM" --json url -q '.url' 2>/dev/null)
  FAILED_CHECKS=$(cd "$REPO" && gh pr checks "$PR_NUM" 2>/dev/null | grep -c "fail" || true)
  PENDING_CHECKS=$(cd "$REPO" && gh pr checks "$PR_NUM" 2>/dev/null | grep -c "pending" || true)

  if [ "$FAILED_CHECKS" -gt 0 ]; then
    CI_FIX_CYCLES=$(jq -r ".[] | select(.id == \"$TASK_ID\") | .ciFixCycles // 0" "$REGISTRY" 2>/dev/null)
    echo "[$TIMESTAMP] CI FAIL: $TASK_ID — PR #$PR_NUM has $FAILED_CHECKS failing checks (fix cycle $CI_FIX_CYCLES/$MAX_CI_FIX_CYCLES)" >> "$LOG"

    if [ "$CFG_CI_FIX_ENABLED" != "true" ]; then
      echo "[$TIMESTAMP] CI-FIX: $TASK_ID — auto-fix disabled in config, skipping" >> "$LOG"
      [ -n "$MC_TASK_ID" ] && mc_post_activity "$MC_TASK_ID" "updated" "PR #$PR_NUM has $FAILED_CHECKS failing CI checks (auto-fix disabled)"
      continue
    fi

    if [ "$CI_FIX_CYCLES" -lt "$MAX_CI_FIX_CYCLES" ]; then
      NEXT_FIX_CYCLE=$((CI_FIX_CYCLES + 1))

      if extract_ci_failures "$REPO" "$PR_NUM"; then
        echo "[$TIMESTAMP] CI-FIX: $TASK_ID — extracting failures and relaunching agent (cycle $NEXT_FIX_CYCLE/$MAX_CI_FIX_CYCLES)" >> "$LOG"
        [ -n "$MC_TASK_ID" ] && mc_post_activity "$MC_TASK_ID" "updated" "CI failing — auto-fixing (cycle $NEXT_FIX_CYCLE/$MAX_CI_FIX_CYCLES)"
        relaunch_agent_for_ci_fix "$TASK_ID" "$WORKTREE" "$CI_FAILURE_DETAILS" "$NEXT_FIX_CYCLE"
      else
        echo "[$TIMESTAMP] CI-FIX: $TASK_ID — could not extract CI failure details, waiting" >> "$LOG"
        [ -n "$MC_TASK_ID" ] && mc_post_activity "$MC_TASK_ID" "updated" "PR #$PR_NUM has $FAILED_CHECKS failing CI checks — could not extract details"
      fi
    else
      echo "[$TIMESTAMP] CI-FIX: $TASK_ID — exhausted $MAX_CI_FIX_CYCLES CI fix cycles, needs manual intervention" >> "$LOG"
      [ -n "$MC_TASK_ID" ] && mc_post_activity "$MC_TASK_ID" "updated" "CI still failing after $MAX_CI_FIX_CYCLES auto-fix cycles — manual intervention needed"
    fi
    continue
  fi

  if [ "$PENDING_CHECKS" -gt 0 ]; then
    echo "[$TIMESTAMP] PENDING: $TASK_ID — PR #$PR_NUM has $PENDING_CHECKS pending checks" >> "$LOG"
    continue
  fi

  if ! validate_gsd_artifacts "$WORKTREE"; then
    echo "[$TIMESTAMP] GSD INCOMPLETE: $TASK_ID — status=$GSD_STATUS (PR #$PR_NUM exists but GSD not satisfied)" >> "$LOG"
    GSD_MARKER="$SWARM_DIR/logs/.gsd-warned-${TASK_ID}"
    if [ -n "$MC_TASK_ID" ] && [ ! -f "$GSD_MARKER" ]; then
      mc_post_activity "$MC_TASK_ID" "updated" "PR #$PR_NUM created but GSD verification $GSD_STATUS — agent may have skipped planning/verification"
      touch "$GSD_MARKER"
    fi
  fi

  REVIEW_CYCLES=$(jq -r ".[] | select(.id == \"$TASK_ID\") | .reviewCycles // 0" "$REGISTRY" 2>/dev/null)

  CODEX_REVIEW=""
  if run_codex_review "$REPO" "$BRANCH" "$PR_NUM"; then
    echo "[$TIMESTAMP] REVIEWED: $TASK_ID — Codex review complete for PR #$PR_NUM (cycle $REVIEW_CYCLES)" >> "$LOG"
    if [ -n "$MC_TASK_ID" ]; then
      review_summary=$(echo "$CODEX_REVIEW" | head -c 500)
      mc_post_activity "$MC_TASK_ID" "updated" "Codex review cycle $REVIEW_CYCLES ($CODEX_EFFORT): $review_summary"
    fi

    if review_has_blocking_issues "$CODEX_REVIEW" && [ "$REVIEW_CYCLES" -lt "$MAX_REVIEW_CYCLES" ]; then
      NEXT_CYCLE=$((REVIEW_CYCLES + 1))
      echo "[$TIMESTAMP] BLOCKING ISSUES: $TASK_ID — sending back to agent (cycle $NEXT_CYCLE/$MAX_REVIEW_CYCLES)" >> "$LOG"
      [ -n "$MC_TASK_ID" ] && mc_post_activity "$MC_TASK_ID" "updated" "Review found blocking issues — relaunching agent for iteration $NEXT_CYCLE/$MAX_REVIEW_CYCLES"
      relaunch_agent_with_review "$TASK_ID" "$WORKTREE" "$CODEX_REVIEW" "$NEXT_CYCLE"
      continue
    fi

    if review_has_blocking_issues "$CODEX_REVIEW"; then
      echo "[$TIMESTAMP] MAX REVIEW CYCLES: $TASK_ID — still has issues after $MAX_REVIEW_CYCLES cycles, completing with warning" >> "$LOG"
      [ -n "$MC_TASK_ID" ] && mc_post_activity "$MC_TASK_ID" "updated" "Review still has issues after $MAX_REVIEW_CYCLES cycles — completing with manual review needed"
    fi
  fi

  AGENT_SUMMARY=""
  extract_agent_summary "$TASK_ID" "$WORKTREE"

  echo "[$TIMESTAMP] READY: $TASK_ID — PR #$PR_NUM CI passed, GSD=$GSD_STATUS, reviews=$REVIEW_CYCLES" >> "$LOG"
  state_update "$TASK_ID" "{\"status\": \"ready\", \"pr\": $PR_NUM}" "ready-with-pr"

  if [ -n "$MC_TASK_ID" ]; then
    gsd_note=""
    [ "$GSD_STATUS" != "passed" ] && gsd_note=" (GSD: $GSD_STATUS — review manually)"
    review_note=""
    [ "$REVIEW_CYCLES" -gt 0 ] && review_note=" ($REVIEW_CYCLES review cycles)"

    summary_text="PR #$PR_NUM — CI passed, Codex reviewed${review_note}${gsd_note}"
    [ -n "$AGENT_SUMMARY" ] && summary_text+=$'\n'"$AGENT_SUMMARY"

    mc_add_deliverable "$MC_TASK_ID" "Pull Request #$PR_NUM" "$PR_URL"
    mc_complete_task "$MC_TASK_ID" "$summary_text"
    linear_post_completion "$MC_TASK_ID" "$PR_URL" "$summary_text"
  fi

  # Distill knowledge from task artifacts into Context Fabrica
  if [ -f "$SWARM_DIR/knowledge-distill.py" ]; then
    echo "[$TIMESTAMP] DISTILL: $TASK_ID — extracting knowledge..." >> "$LOG"
    "$HOME/.openclaw/venv-3.12/bin/python3" "$SWARM_DIR/knowledge-distill.py" \
      --task-id "$TASK_ID" \
      --repo "$REPO" \
      --branch "$BRANCH" \
      --worktree "${WORKTREE:-}" \
      --mc-task-id "${MC_TASK_ID:-}" \
      --codex-review "${CODEX_REVIEW:-}" \
      --agent-summary "${AGENT_SUMMARY:-}" \
      >> "$LOG" 2>&1 &
    echo "[$TIMESTAMP] DISTILL: $TASK_ID — launched in background" >> "$LOG"
  fi
done

echo "[$TIMESTAMP] === Monitor complete ===" >> "$LOG"
