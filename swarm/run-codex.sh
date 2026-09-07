#!/bin/bash
# Codex agent launcher with prompt file handling and retry logic.
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
source "$SCRIPT_DIR/mc-api.sh"
source "$SCRIPT_DIR/agent-watchdog.sh"

CFG_MODEL=${AGENT_MODEL:-$(jq -r '.codex.model // "codex-mini"' "$CONFIG" 2>/dev/null || echo "codex-mini")}
CFG_EFFORT=${AGENT_EFFORT:-$(jq -r '.codex.effort // "high"' "$CONFIG" 2>/dev/null || echo "high")}

MODEL=${2:-$CFG_MODEL}
EFFORT=${3:-$CFG_EFFORT}
MAX_RETRIES=${MAX_AGENT_RETRIES:-3}
PROMPT_FILE="${PROMPT_OVERRIDE:-$SWARM_DIR/prompts/${TASK_NAME}.md}"
LOG="$SWARM_DIR/logs/agent-${TASK_NAME}.log"
AGENT_PID_FILE="$SWARM_DIR/logs/.agent-${TASK_NAME}.pid"
MC_URL="${MISSION_CONTROL_URL:-http://localhost:18900}"
HEARTBEAT_INTERVAL_SECONDS="${HEARTBEAT_INTERVAL_SECONDS:-90}"

MC_TASK_ID="${MC_TASK_ID:-}"
if [ -z "$MC_TASK_ID" ]; then
  MC_TASK_ID=$(jq -r ".[] | select(.id == \"$TASK_NAME\" and (.status == \"running\" or .status == \"ready\")) | .mcTaskId // empty" "$SWARM_DIR/active-tasks.json" 2>/dev/null | head -1 || true)
fi

if [ ! -f "$PROMPT_FILE" ]; then
  echo "ERROR: No prompt file found at $PROMPT_FILE"
  exit 1
fi

PROMPT=$(cat "$PROMPT_FILE")

update_registry() {
  local field="$1"
  local value="$2"
  python3 "$STATE_TOOL" update \
    --task-id "$TASK_NAME" \
    --patch-json "{\"$field\": $value}" \
    --reason "run-codex" >/dev/null 2>&1 || true
}

update_registry_json() {
  local patch_json="$1"
  python3 "$STATE_TOOL" update \
    --task-id "$TASK_NAME" \
    --patch-json "$patch_json" \
    --reason "run-codex" >/dev/null 2>&1 || true
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
  echo "=== Codex Agent starting: $TASK_NAME | Profile: ${AGENT_PROFILE:-codex} | Model: $MODEL | Effort: $EFFORT | Attempt: $attempt/$MAX_RETRIES | $(date) ===" | tee -a "$LOG"
  update_registry "retryCount" "$attempt"
  update_registry "lastAttemptAt" "$(date +%s)000"
  update_registry_json '{"completionSyncedAt": null}'

  set +e
  start_heartbeat
  start_stall_watchdog "$LOG" "$AGENT_PID_FILE" "codex exec"
  # `codex exec`, not bare `codex`: the interactive TUI aborts with "stdout is not
  # a terminal" the moment its output is piped, and this pipes into tee. Bare codex
  # failed every attempt in ~0s and burned all three retries without starting work.
  run_with_pidfile "$AGENT_PID_FILE" \
    codex exec --model "$MODEL" \
      -c "model_reasoning_effort=$EFFORT" \
      --dangerously-bypass-approvals-and-sandbox \
      "$PROMPT" 2>&1 | tee -a "$LOG"
  exit_code=${PIPESTATUS[0]}
  stop_stall_watchdog
  stop_heartbeat
  set -e

  if watchdog_killed_attempt; then
    echo "  Killed by the watchdog — the agent never made progress in its log." | tee -a "$LOG"
    update_registry "lastError" '"agent_hang"'
    hung_attempts=$((hung_attempts + 1))
    if [ "$exit_code" -eq 0 ]; then exit_code=75; fi
  fi

  if [ "$exit_code" -eq 0 ]; then
    echo "=== Codex Agent completed successfully: $TASK_NAME | Attempt: $attempt | $(date) ===" | tee -a "$LOG"
    update_registry "status" '"completed_by_agent"'
    exit 0
  fi

  echo "=== Codex Agent failed (exit $exit_code): $TASK_NAME | Attempt: $attempt/$MAX_RETRIES | $(date) ===" | tee -a "$LOG"
  update_registry "lastError" "\"exit_code_$exit_code\""

  if [ "$attempt" -lt "$MAX_RETRIES" ]; then
    backoff=$((attempt * 30))
    echo "  Retrying in ${backoff}s..." | tee -a "$LOG"
    sleep "$backoff"
  fi
done

echo "=== Codex Agent exhausted retries: $TASK_NAME | $(date) ===" | tee -a "$LOG"

# Every attempt hung is not a flaky run: it is a CLI that cannot start on this
# machine, and a fourth attempt on the same binary cannot help. The sibling profile
# runs a different CLI entirely, so hand the task over rather than parking it for a
# human. agent_failover exec's on success; reaching the next line means it declined.
if [ "$hung_attempts" -gt 0 ] && [ "$hung_attempts" -eq "$attempt" ]; then
  agent_failover "${AGENT_PROFILE:-codex}" "$TASK_NAME" "$CONFIG" "$SWARM_DIR" "$LOG" || true
fi

update_registry "status" '"failed"'
update_registry "failedAt" "$(date +%s)000"
exit "$exit_code"
