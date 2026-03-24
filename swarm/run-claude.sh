#!/bin/bash
# Claude Code agent launcher with PTY wrapper, cost controls, and retry logic.
set -euo pipefail

TASK_NAME=$1
SWARM_DIR="$HOME/.openclaw/swarm"
CONFIG="$SWARM_DIR/swarm-config.json"
STATE_TOOL="$SWARM_DIR/swarm-state.py"

CFG_MODEL=$(jq -r '.claude.model // "claude-opus-4-6"' "$CONFIG" 2>/dev/null || echo "claude-opus-4-6")
CFG_FALLBACK=$(jq -r '.claude.fallbackModel // ""' "$CONFIG" 2>/dev/null || echo "")

MODEL=${2:-$CFG_MODEL}
MAX_RETRIES=${MAX_AGENT_RETRIES:-3}
PROMPT_FILE="${PROMPT_OVERRIDE:-$SWARM_DIR/prompts/${TASK_NAME}.md}"
LOG="$SWARM_DIR/logs/agent-${TASK_NAME}.log"
MC_URL="${MISSION_CONTROL_URL:-http://localhost:18789/ext/mission-control}"
HEARTBEAT_INTERVAL_SECONDS="${HEARTBEAT_INTERVAL_SECONDS:-90}"

MC_TASK_ID="${MC_TASK_ID:-}"
if [ -z "$MC_TASK_ID" ]; then
  MC_TASK_ID=$(jq -r ".[] | select(.id == \"$TASK_NAME\" and (.status == \"running\" or .status == \"ready\")) | .mcTaskId // empty" "$SWARM_DIR/active-tasks.json" 2>/dev/null | head -1 || true)
fi

BUDGET=${MAX_BUDGET_USD:-}
TURNS=${MAX_TURNS:-}
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

AUTONOMY_SUFFIX='

CRITICAL: You are running in FULLY AUTONOMOUS mode. There is NO human to respond.
- Do NOT ask questions. Do NOT ask for confirmation. Do NOT say "shall I" or "would you like".
- Execute the ENTIRE workflow: write code, run tests, commit, push, create PR, report to MC.
- If unsure about a decision, make the best choice and proceed.
- Your session ends when you stop outputting. Nothing happens after you ask a question.
- COMPLETE ALL STEPS before stopping.'

run_claude() {
  local cmd=(claude -p --model "$MODEL" --dangerously-skip-permissions --max-turns "${TURNS:-200}")

  [ -n "$BUDGET" ] && cmd+=(--max-budget-usd "$BUDGET")
  [ -n "$FALLBACK" ] && cmd+=(--fallback-model "$FALLBACK")

  if [ -n "$AGENTS_DEF" ]; then
    export CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1
    cmd+=(--agents "$AGENTS_DEF")
  fi

  { cat "$PROMPT_FILE"; echo "$AUTONOMY_SUFFIX"; } | "${cmd[@]}" 2>&1 | tee -a "$LOG"
  return ${PIPESTATUS[0]}
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
  echo "=== Claude Agent starting: $TASK_NAME | Model: $MODEL | Attempt: $attempt/$MAX_RETRIES | $(date) ===" | tee -a "$LOG"
  [ -n "$BUDGET" ] && echo "  Budget: \$${BUDGET} | Turns: ${TURNS:-unlimited} | Fallback: ${FALLBACK:-none}" | tee -a "$LOG"
  update_registry "retryCount" "$attempt"
  update_registry "lastAttemptAt" "$(date +%s)000"
  update_registry_json '{"completionSyncedAt": null}'

  set +e
  start_heartbeat
  run_claude
  exit_code=$?
  stop_heartbeat
  set -e

  if [ "$exit_code" -eq 0 ]; then
    echo "=== Claude Agent completed successfully: $TASK_NAME | Attempt: $attempt | $(date) ===" | tee -a "$LOG"
    update_registry "status" '"completed_by_agent"'

    if [ -n "$MC_TASK_ID" ]; then
      TASK_TYPE=$(curl -s "$MC_URL/api/tasks/$MC_TASK_ID" 2>/dev/null | jq -r '.task_type // "implementation"' 2>/dev/null)
      if [ "$TASK_TYPE" = "investigation" ]; then
        HAS_FINDINGS=$(curl -s "$MC_URL/api/tasks/$MC_TASK_ID/activities" 2>/dev/null | jq '[.[] | select(.activity_type == "investigation_findings")] | length' 2>/dev/null)
        if [ "${HAS_FINDINGS:-0}" = "0" ]; then
          FINDINGS=$(sed -n '/^=== Claude Agent starting/,/^=== Claude Agent completed/{/^===/d;p}' "$LOG" | tail -200)
          if [ -n "$FINDINGS" ]; then
            ESCAPED=$(echo "$FINDINGS" | python3 -c 'import sys,json; print(json.dumps(sys.stdin.read()))')
            curl -s -X POST "$MC_URL/api/tasks/$MC_TASK_ID/activities" \
              -H "Content-Type: application/json" \
              -d "{\"activity_type\": \"investigation_findings\", \"message\": $ESCAPED}" > /dev/null 2>&1
            echo "  Posted investigation findings to MC" | tee -a "$LOG"
          fi
        fi
        curl -s -X POST "$MC_URL/api/webhooks/agent-completion" \
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
update_registry "status" '"failed"'
update_registry "failedAt" "$(date +%s)000"
exit "$exit_code"
