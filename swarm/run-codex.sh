#!/bin/bash
# Codex agent launcher with prompt file handling and retry logic.
set -euo pipefail

TASK_NAME=$1
SWARM_DIR="$HOME/.openclaw/swarm"
CONFIG="$SWARM_DIR/swarm-config.json"
STATE_TOOL="$SWARM_DIR/swarm-state.py"

CFG_MODEL=$(jq -r '.codex.model // "codex-mini"' "$CONFIG" 2>/dev/null || echo "codex-mini")
CFG_EFFORT=$(jq -r '.codex.effort // "high"' "$CONFIG" 2>/dev/null || echo "high")

MODEL=${2:-$CFG_MODEL}
EFFORT=${3:-$CFG_EFFORT}
MAX_RETRIES=${MAX_AGENT_RETRIES:-3}
PROMPT_FILE="$SWARM_DIR/prompts/${TASK_NAME}.md"
LOG="$SWARM_DIR/logs/agent-${TASK_NAME}.log"
MC_URL="${MISSION_CONTROL_URL:-http://localhost:18789/ext/mission-control}"
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
    while true; do
      now_ms=$(($(date +%s) * 1000))
      update_registry_json "{\"lastHeartbeatAt\": $now_ms, \"heartbeatIntervalSec\": $HEARTBEAT_INTERVAL_SECONDS}"
      msg="Agent heartbeat: task $TASK_NAME running (attempt $attempt/$MAX_RETRIES)."
      curl -s -X POST "$MC_URL/api/tasks/$MC_TASK_ID/activities" \
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

trap 'stop_heartbeat' EXIT INT TERM

attempt=0
exit_code=1

while [ "$attempt" -lt "$MAX_RETRIES" ]; do
  attempt=$((attempt + 1))
  echo "=== Codex Agent starting: $TASK_NAME | Model: $MODEL | Effort: $EFFORT | Attempt: $attempt/$MAX_RETRIES | $(date) ===" | tee -a "$LOG"
  update_registry "retryCount" "$attempt"
  update_registry "lastAttemptAt" "$(date +%s)000"
  update_registry_json '{"completionSyncedAt": null}'

  set +e
  start_heartbeat
  codex --model "$MODEL" \
    -c "model_reasoning_effort=$EFFORT" \
    --dangerously-bypass-approvals-and-sandbox \
    "$PROMPT" 2>&1 | tee -a "$LOG"
  exit_code=${PIPESTATUS[0]}
  stop_heartbeat
  set -e

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
update_registry "status" '"failed"'
update_registry "failedAt" "$(date +%s)000"
exit "$exit_code"
