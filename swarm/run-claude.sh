#!/bin/bash
# Claude Code agent launcher with PTY wrapper, cost controls, and retry logic.
set -euo pipefail

TASK_NAME=$1
MC_HOME="${MC_HOME:-$HOME/.mission-control}"
SWARM_DIR="$MC_HOME/swarm"
if [ -f "$MC_HOME/.env" ]; then set -a; source "$MC_HOME/.env"; set +a; fi
CONFIG="$SWARM_DIR/swarm-config.json"
STATE_TOOL="$SWARM_DIR/swarm-state.py"
SCRIPT_SRC="${BASH_SOURCE[0]}"
while [ -L "$SCRIPT_SRC" ]; do
  LINK_TARGET="$(readlink "$SCRIPT_SRC")"
  case "$LINK_TARGET" in
    /*) SCRIPT_SRC="$LINK_TARGET" ;;
    *) SCRIPT_SRC="$(dirname "$SCRIPT_SRC")/$LINK_TARGET" ;;
  esac
done
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_SRC")" && pwd)"
RATE_LIMIT_POLICY="$SCRIPT_DIR/rate_limit_policy.py"
source "$SCRIPT_DIR/mc-api.sh"
source "$SCRIPT_DIR/agent-watchdog.sh"

CFG_MODEL=${AGENT_MODEL:-$(jq -r '.claude.model // "claude-opus-4-6"' "$CONFIG" 2>/dev/null || echo "claude-opus-4-6")}
CFG_FALLBACK=${AGENT_FALLBACK_MODEL:-$(jq -r '.claude.fallbackModel // ""' "$CONFIG" 2>/dev/null || echo "")}

MODEL=${2:-$CFG_MODEL}
MAX_RETRIES=${MAX_AGENT_RETRIES:-3}
PROMPT_FILE="${PROMPT_OVERRIDE:-$SWARM_DIR/prompts/${TASK_NAME}.md}"
LOG="$SWARM_DIR/logs/agent-${TASK_NAME}.log"
AGENT_PID_FILE="$SWARM_DIR/logs/.agent-${TASK_NAME}.pid"
MC_URL="${MISSION_CONTROL_URL:-http://localhost:18900}"
HEARTBEAT_INTERVAL_SECONDS="${HEARTBEAT_INTERVAL_SECONDS:-90}"
AGENT_LIMIT_INITIAL_BACKOFF_SECONDS="${AGENT_LIMIT_INITIAL_BACKOFF_SECONDS:-300}"
AGENT_LIMIT_MAX_BACKOFF_SECONDS="${AGENT_LIMIT_MAX_BACKOFF_SECONDS:-7200}"
AGENT_LIMIT_RETRY_WINDOW_SECONDS="${AGENT_LIMIT_RETRY_WINDOW_SECONDS:-43200}"

MC_TASK_ID="${MC_TASK_ID:-}"
if [ -z "$MC_TASK_ID" ]; then
  MC_TASK_ID=$(jq -r ".[] | select(.id == \"$TASK_NAME\" and (.status == \"running\" or .status == \"ready\")) | .mcTaskId // empty" "$SWARM_DIR/active-tasks.json" 2>/dev/null | head -1 || true)
fi

BUDGET=${MAX_BUDGET_USD:-}
TURNS=${MAX_TURNS:-}
# The budget this attempt actually runs with. Raised when an attempt stops ON the
# turn limit, because that is direct evidence the ticket needs more turns than the
# default — retrying the same ceiling just walks into the same wall. Capped so a
# genuinely looping agent still terminates.
EFFECTIVE_TURNS=${TURNS:-200}
TURN_CEILING=${MAX_TURNS_CEILING:-800}
FALLBACK=${FALLBACK_MODEL:-$CFG_FALLBACK}
AGENTS_DEF=${AGENTS_JSON:-}

if [ ! -f "$PROMPT_FILE" ]; then
  echo "ERROR: No prompt file found at $PROMPT_FILE"
  exit 1
fi

update_registry() {
  local field="$1"
  local value="$2"
  python3 "$STATE_TOOL" update \
    --task-id "$TASK_NAME" \
    --patch-json "{\"$field\": $value}" \
    --reason "run-claude" >/dev/null 2>&1 || true
}

update_registry_json() {
  local patch_json="$1"
  python3 "$STATE_TOOL" update \
    --task-id "$TASK_NAME" \
    --patch-json "$patch_json" \
    --reason "run-claude" >/dev/null 2>&1 || true
}

preserved_work_note() {
  local ahead_count dirty_count
  ahead_count=$(git rev-list --count "${BASE_BRANCH:-origin/main}..HEAD" 2>/dev/null || echo 0)
  dirty_count=$(git status --porcelain 2>/dev/null | awk 'END {print NR+0}')
  if [ "${ahead_count:-0}" -gt 0 ] || [ "${dirty_count:-0}" -gt 0 ]; then
    printf 'Partial work is preserved (%s commit(s) ahead, %s dirty path(s)).' \
      "${ahead_count:-0}" "${dirty_count:-0}"
  else
    printf 'No repository changes were detected.'
  fi
}

AUTONOMY_SUFFIX='

CRITICAL: You are running in FULLY AUTONOMOUS mode. There is NO human to respond.
- Do NOT ask questions. Do NOT ask for confirmation. Do NOT say "shall I" or "would you like".
- Execute the ENTIRE workflow: write code, run tests, commit, push, and report to MC.
- Create the required PR unless the task prompt identifies an existing PR handoff; for a handoff,
  update that same PR and NEVER create another one.
- If unsure about a decision, make the best choice and proceed.
- Your session ends when you stop outputting. Nothing happens after you ask a question.
- COMPLETE ALL STEPS before stopping.'

run_claude() {
  local cmd=(claude -p --model "$MODEL" --dangerously-skip-permissions --max-turns "$EFFECTIVE_TURNS")

  [ -n "$BUDGET" ] && cmd+=(--max-budget-usd "$BUDGET")
  [ -n "$FALLBACK" ] && cmd+=(--fallback-model "$FALLBACK")

  if [ -n "$AGENTS_DEF" ]; then
    export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
    cmd+=(--agents "$AGENTS_DEF")
  fi

  # Index 1, not 0: this is a three-stage pipeline and stage 0 is the prompt feeder,
  # which succeeds whatever claude does. Reading [0] reported every crashed, killed
  # or non-zero claude run as exit 0, so the attempt was marked
  # `completed_by_agent` and the ticket moved to review on an empty worktree.
  { cat "$PROMPT_FILE"; echo "$AUTONOMY_SUFFIX"; } \
    | run_with_pidfile "$AGENT_PID_FILE" "${cmd[@]}" 2>&1 \
    | tee -a "$LOG"
  return ${PIPESTATUS[1]}
}

start_heartbeat() {
  if [ -z "$MC_TASK_ID" ]; then
    HEARTBEAT_PID=""
    return
  fi

  (
    # A heartbeat that dies looks exactly like a healthy agent to check-agents.sh,
    # which reads heartbeat freshness to decide whether a task is stuck. MET-680's
    # heartbeat never advanced past the spawn timestamp, so the staleness check that
    # should have flagged it was fed a value that never moved.
    set +e
    while true; do
      now_ms=$(($(date +%s) * 1000))
      update_registry_json "{\"lastHeartbeatAt\": $now_ms, \"heartbeatIntervalSec\": $HEARTBEAT_INTERVAL_SECONDS}"
      msg="Agent heartbeat: task $TASK_NAME running (attempt $attempt/$MAX_RETRIES)."
      mc_curl POST "/api/tasks/$MC_TASK_ID/activities" -s \
        -H "Content-Type: application/json" \
        -d "{\"activity_type\":\"updated\",\"message\":$(printf '%s' "$msg" | jq -Rs .)}" \
        > /dev/null 2>&1 || true
      sleep "$HEARTBEAT_INTERVAL_SECONDS"
    done
  ) &
  HEARTBEAT_PID=$!
}

stop_heartbeat() {
  if [ -n "${HEARTBEAT_PID:-}" ]; then
    kill "$HEARTBEAT_PID" >/dev/null 2>&1 || true
    wait "$HEARTBEAT_PID" 2>/dev/null || true
    HEARTBEAT_PID=""
  fi
}

trap 'stop_heartbeat; stop_stall_watchdog; rm -f "$AGENT_PID_FILE" "${AGENT_PID_FILE}.stalled"' EXIT INT TERM

attempt=0
exit_code=1
hung_attempts=0

while [ "$attempt" -lt "$MAX_RETRIES" ]; do
  attempt=$((attempt + 1))
  echo "=== Claude Agent starting: $TASK_NAME | Profile: ${AGENT_PROFILE:-claude} | Model: $MODEL | Attempt: $attempt/$MAX_RETRIES | $(date) ===" | tee -a "$LOG"
  [ -n "$BUDGET" ] && echo "  Budget: \$${BUDGET} | Turns: ${EFFECTIVE_TURNS} | Fallback: ${FALLBACK:-none}" | tee -a "$LOG"
  update_registry "retryCount" "$attempt"
  update_registry "lastAttemptAt" "$(date +%s)000"
  update_registry_json '{"completionSyncedAt": null}'

  # Where this attempt's output starts, so the checks below read only its own log.
  log_mark=$(wc -c < "$LOG" 2>/dev/null || echo 0)

  set +e
  start_heartbeat
  start_stall_watchdog "$LOG" "$AGENT_PID_FILE" "claude -p"
  run_claude
  exit_code=$?
  stop_stall_watchdog
  stop_heartbeat
  set -e

  if watchdog_killed_attempt; then
    echo "  Killed by the watchdog — the agent never made progress in its log." | tee -a "$LOG"
    update_registry "lastError" '"agent_hang"'
    hung_attempts=$((hung_attempts + 1))
    if [ "$exit_code" -eq 0 ]; then exit_code=75; fi
  fi

  # `claude -p` exits 0 when it stops because it ran out of turns, printing
  # "Error: Reached max turns (200)" and nothing else. Reading that as success is how
  # MET-640 was declared "completed successfully" mid-plan: two of its three plans
  # committed, the third's work left uncommitted, nothing pushed, no PR, no
  # deliverables — and the ticket moved on to review as though it were finished.
  #
  # An interrupted run is not a finished one. Failing it here puts the attempt on the
  # retry ladder (the repo keeps the commits already made, so a retry resumes rather
  # than restarts) and, if the ladder runs out, leaves the agent marked `failed`
  # instead of complete — which is the state a human can act on.
  attempt_output=$(tail -c "+$((log_mark + 1))" "$LOG" 2>/dev/null || true)

  # The same exit-0 trap, for the account rather than the run. MET-642 printed
  # "You've hit your session limit · resets 3pm" and exited 0 after seven seconds,
  # and was logged "completed successfully" with an empty worktree, no commits, no
  # PR — the ticket then moved to review as finished work.
  #
  # Unlike a normal process failure, this must not spend three retries thirty seconds
  # apart or become a permanent human question. Release the slot, retain the worktree,
  # and let the monitor retry exponentially for up to twelve hours.
  if printf '%s' "$attempt_output" \
       | grep -qiE "hit your (session|usage) limit|usage limit reached|rate limit reached"; then
    limit_line=$(printf '%s' "$attempt_output" | grep -iEm1 "hit your (session|usage) limit|usage limit reached|rate limit reached" | tr -d '\r')
    echo "  Stopped by the account limit, not by finishing: ${limit_line}" | tee -a "$LOG"
    now_ms=$(($(date +%s) * 1000))
    first_at=$(jq -r --arg id "$TASK_NAME" '.[] | select(.id == $id) | .rateLimitFirstAt // 0' "$SWARM_DIR/active-tasks.json" 2>/dev/null | head -1)
    limit_retries=$(jq -r --arg id "$TASK_NAME" '.[] | select(.id == $id) | .rateLimitRetryCount // 0' "$SWARM_DIR/active-tasks.json" 2>/dev/null | head -1)
    schedule=$(python3 "$RATE_LIMIT_POLICY" \
      --now-ms "$now_ms" --first-at-ms "${first_at:-0}" --retry-count "${limit_retries:-0}" \
      --initial-seconds "$AGENT_LIMIT_INITIAL_BACKOFF_SECONDS" \
      --max-seconds "$AGENT_LIMIT_MAX_BACKOFF_SECONDS" \
      --window-seconds "$AGENT_LIMIT_RETRY_WINDOW_SECONDS")
    repo_note=$(preserved_work_note)

    if [ "$(printf '%s' "$schedule" | jq -r '.exhausted')" = "true" ]; then
      echo "  Account limit persisted for the full retry window; escalating." | tee -a "$LOG"
      patch=$(jq -cn --arg message "$limit_line" --argjson failedAt "$now_ms" \
        '{status:"failed",lastError:"session_limit_retry_window_exhausted",rateLimitMessage:$message,failedAt:$failedAt,nextRateLimitRetryAt:null}')
      update_registry_json "$patch"
      if [ -n "$MC_TASK_ID" ]; then
        msg="Agent account limit did not clear within 12 hours. $repo_note Manual intervention is now required."
        payload=$(jq -cn --arg message "$msg" '{activity_type:"needs_human",message:$message}')
        mc_curl POST "/api/tasks/$MC_TASK_ID/activities" -s \
          -H "Content-Type: application/json" -d "$payload" > /dev/null 2>&1 || true
      fi
      exit 75
    fi

    next_retry_at=$(printf '%s' "$schedule" | jq -r '.nextRetryAt')
    retry_number=$(printf '%s' "$schedule" | jq -r '.retryCount')
    delay_seconds=$(printf '%s' "$schedule" | jq -r '.delaySeconds')
    first_at=$(printf '%s' "$schedule" | jq -r '.firstAt')
    deadline_at=$(printf '%s' "$schedule" | jq -r '.deadlineAt')
    patch=$(jq -cn --arg message "$limit_line" \
      --argjson firstAt "$first_at" --argjson deadlineAt "$deadline_at" \
      --argjson retryCount "$retry_number" --argjson nextRetryAt "$next_retry_at" \
      '{status:"rate_limited",lastError:"session_limit_reached",rateLimitMessage:$message,
        rateLimitFirstAt:$firstAt,rateLimitDeadlineAt:$deadlineAt,
        rateLimitRetryCount:$retryCount,nextRateLimitRetryAt:$nextRetryAt,failedAt:null}')
    update_registry_json "$patch"
    echo "  Retry $retry_number scheduled in ${delay_seconds}s; worktree preserved and slot released." | tee -a "$LOG"
    if [ -n "$MC_TASK_ID" ]; then
      msg="Agent account limit reached; retry $retry_number is scheduled with exponential backoff. $repo_note"
      payload=$(jq -cn --arg message "$msg" '{activity_type:"updated",message:$message}')
      mc_curl POST "/api/tasks/$MC_TASK_ID/activities" -s \
        -H "Content-Type: application/json" -d "$payload" > /dev/null 2>&1 || true
    fi
    exit 75
  fi

  # Any non-limit response proves the account recovered. Do not let an old retry
  # deadline survive and reclassify a later ordinary failure as quota exhaustion.
  if jq -e --arg id "$TASK_NAME" '.[] | select(.id == $id and .rateLimitFirstAt != null)' \
       "$SWARM_DIR/active-tasks.json" >/dev/null 2>&1; then
    update_registry_json '{"rateLimitFirstAt":null,"rateLimitDeadlineAt":null,"rateLimitRetryCount":0,"nextRateLimitRetryAt":null,"rateLimitMessage":null}'
  fi

  if [ "$exit_code" -eq 0 ] && printf '%s' "$attempt_output" | grep -q "Reached max turns"; then
    echo "  Stopped on the turn limit ($EFFECTIVE_TURNS) with work still in progress — not a completion" | tee -a "$LOG"
    update_registry "lastError" '"max_turns_reached"'
    exit_code=75
    # The ladder escalates the model on retry; escalate the limit that actually
    # stopped it too. MET-640 needed three plans and 200 turns covered two, so a
    # same-ceiling retry would have stopped in the same place.
    if [ "$EFFECTIVE_TURNS" -lt "$TURN_CEILING" ]; then
      EFFECTIVE_TURNS=$(( EFFECTIVE_TURNS * 2 ))
      [ "$EFFECTIVE_TURNS" -gt "$TURN_CEILING" ] && EFFECTIVE_TURNS=$TURN_CEILING
      echo "  Next attempt gets $EFFECTIVE_TURNS turns" | tee -a "$LOG"
    else
      echo "  Already at the turn ceiling ($TURN_CEILING) — not raising further" | tee -a "$LOG"
    fi
  fi

  if [ "$exit_code" -eq 0 ]; then
    echo "=== Claude Agent completed successfully: $TASK_NAME | Attempt: $attempt | $(date) ===" | tee -a "$LOG"
    update_registry_json '{"status":"completed_by_agent","lastError":null,"rateLimitFirstAt":null,"rateLimitDeadlineAt":null,"rateLimitRetryCount":0,"nextRateLimitRetryAt":null,"rateLimitMessage":null}'

    if [ -n "$MC_TASK_ID" ]; then
      TASK_TYPE=$(mc_curl GET "/api/tasks/$MC_TASK_ID" -s 2>/dev/null | jq -r '.task_type // "implementation"' 2>/dev/null)
      if [ "$TASK_TYPE" = "investigation" ]; then
        HAS_FINDINGS=$(mc_curl GET "/api/tasks/$MC_TASK_ID/activities" -s 2>/dev/null | jq '[.[] | select(.activity_type == "investigation_findings")] | length' 2>/dev/null)
        if [ "${HAS_FINDINGS:-0}" = "0" ]; then
          FINDINGS=$(sed -n '/^=== Claude Agent starting/,/^=== Claude Agent completed/{/^===/d;p}' "$LOG" | tail -200)
          if [ -n "$FINDINGS" ]; then
            ESCAPED=$(echo "$FINDINGS" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')
            mc_curl POST "/api/tasks/$MC_TASK_ID/activities" -s \
              -H "Content-Type: application/json" \
              -d "{\"activity_type\": \"investigation_findings\", \"message\": $ESCAPED}" > /dev/null 2>&1
            echo "  Posted investigation findings to MC" | tee -a "$LOG"
          fi
        fi
        mc_curl POST "/api/webhooks/agent-completion" -s \
          -H "Content-Type: application/json" \
          -d "{\"task_id\": \"$MC_TASK_ID\", \"status\": \"review\", \"summary\": \"Investigation complete\"}" > /dev/null 2>&1
      fi
    fi

    exit 0
  fi

  echo "=== Claude Agent failed (exit $exit_code): $TASK_NAME | Attempt: $attempt/$MAX_RETRIES | $(date) ===" | tee -a "$LOG"
  update_registry "lastError" "\"exit_code_$exit_code\""

  if [ "$attempt" -lt "$MAX_RETRIES" ]; then
    backoff=$((attempt * 30))
    echo "  Retrying in ${backoff}s..." | tee -a "$LOG"
    sleep "$backoff"
  fi
done

echo "=== Claude Agent exhausted retries: $TASK_NAME | $(date) ===" | tee -a "$LOG"

# Every attempt hung is not a flaky run: it is a CLI that cannot start on this
# machine, and a fourth attempt on the same binary cannot help. The sibling profile
# runs a different CLI entirely, so hand the task over rather than parking it for a
# human. agent_failover exec's on success; reaching the next line means it declined.
if [ "$hung_attempts" -gt 0 ] && [ "$hung_attempts" -eq "$attempt" ]; then
  agent_failover "${AGENT_PROFILE:-claude}" "$TASK_NAME" "$CONFIG" "$SWARM_DIR" "$LOG" || true
fi

update_registry "status" '"failed"'
update_registry "failedAt" "$(date +%s)000"
exit "$exit_code"
