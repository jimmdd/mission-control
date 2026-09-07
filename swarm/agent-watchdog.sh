#!/bin/bash
# Shared stall watchdog and profile failover for the agent launchers.
#
# A launcher process that DIES exits non-zero and rides the retry ladder in
# run-<agent>.sh. A launcher that HANGS never exits, so the ladder never engages.
# MET-680 sat 99 minutes at `_dyld_start`: a macOS Gatekeeper policy record had
# wedged the exact install path of the codex binary, so `codex exec` blocked before
# printing a single byte. check-agents.sh logged "may be stuck" three times and took
# no action, the attempt never became attempt 2, and the ticket went nowhere until a
# human looked at `ps`.
#
# The watchdog treats the attempt's own log as the liveness signal, because an agent
# that is working writes to it. Two windows, since "never started" and "went quiet
# mid-run" deserve very different patience:
#
#   STARTUP  no output at all since the attempt began. Every CLI here prints a
#            banner within seconds, so silence means it never got going.
#   STALL    output happened, then stopped growing. Generous, because a high-effort
#            reasoning block or a long test run is legitimately quiet for a while.
#
# On expiry it kills the agent and leaves a marker file, which is what lets the
# launcher tell a hang apart from an ordinary crash — and, once every attempt has
# hung, hand the task to the sibling profile instead of burning more retries on a
# CLI that cannot start on this machine.
#
# Sourced by run-codex.sh and run-claude.sh, which supply update_registry_json.

AGENT_STARTUP_TIMEOUT_SECONDS="${AGENT_STARTUP_TIMEOUT_SECONDS:-300}"
AGENT_STALL_TIMEOUT_SECONDS="${AGENT_STALL_TIMEOUT_SECONDS:-1800}"
AGENT_WATCHDOG_POLL_SECONDS="${AGENT_WATCHDOG_POLL_SECONDS:-15}"
AGENT_WATCHDOG_TERM_GRACE_SECONDS="${AGENT_WATCHDOG_TERM_GRACE_SECONDS:-10}"

WATCHDOG_PID=""
WATCHDOG_STALL_MARKER=""

watchdog_log_size() {
  wc -c < "$1" 2>/dev/null | tr -d ' ' || echo 0
}

# watchdog_kill_tree <pid> <signal>
#
# Signals the whole descendant tree, deepest first. Killing only the agent's own pid
# is not enough: the real codex forks codex-code-mode-host, and any surviving child
# keeps the inherited stdout open, so `tee` never sees EOF and the launcher goes on
# waiting for a pipeline whose agent is already dead. Children are collected before
# the parent dies, so reparenting cannot hide them.
watchdog_kill_tree() {
  local pid="$1" sig="$2" child
  for child in $(pgrep -P "$pid" 2>/dev/null); do
    watchdog_kill_tree "$child" "$sig"
  done
  kill "$sig" "$pid" 2>/dev/null
}

# start_stall_watchdog <log-file> <agent-pid-file> <label>
#
# The pid file is written by the agent's own pipeline stage as its first action, so
# the watchdog has something concrete to kill rather than having to guess which of
# the launcher's children is the agent.
start_stall_watchdog() {
  local log="$1" pid_file="$2" label="$3"

  WATCHDOG_STALL_MARKER="${pid_file}.stalled"
  rm -f "$WATCHDOG_STALL_MARKER" "$pid_file"

  (
    # Never let an unexpected non-zero take the watchdog down: a dead watchdog is
    # indistinguishable from a healthy agent, which is the failure it exists to catch.
    set +e
    trap - EXIT INT TERM

    baseline=$(watchdog_log_size "$log")
    last_size="$baseline"
    last_change_at=$(date +%s)

    while true; do
      sleep "$AGENT_WATCHDOG_POLL_SECONDS"

      agent_pid=$(cat "$pid_file" 2>/dev/null)
      if [ -n "$agent_pid" ]; then
        if ! kill -0 "$agent_pid" 2>/dev/null; then
          exit 0
        fi
      fi

      now=$(date +%s)
      current=$(watchdog_log_size "$log")
      if [ "$current" != "$last_size" ]; then
        last_size="$current"
        last_change_at="$now"
        continue
      fi

      if [ "$current" = "$baseline" ]; then
        budget="$AGENT_STARTUP_TIMEOUT_SECONDS"
        reason="produced no output at all"
      else
        budget="$AGENT_STALL_TIMEOUT_SECONDS"
        reason="stopped writing output"
      fi

      if [ $((now - last_change_at)) -lt "$budget" ]; then
        continue
      fi

      # Marker first. If killing races with the launcher reaping the pipeline, the
      # attempt must still be classified as a hang rather than a plain crash.
      touch "$WATCHDOG_STALL_MARKER"
      {
        echo ""
        echo "=== WATCHDOG: $label $reason for ${budget}s — killing it. This is a hang, not a crash. ==="
      } >> "$log"

      if [ -n "$agent_pid" ]; then
        watchdog_kill_tree "$agent_pid" -TERM
        sleep "$AGENT_WATCHDOG_TERM_GRACE_SECONDS"
        watchdog_kill_tree "$agent_pid" -KILL
      else
        # No pid file means the pipeline never reached exec. Nothing specific to
        # aim at, so take down the launcher's children and let the ladder retry.
        pkill -P $$ 2>/dev/null
      fi
      exit 0
    done
  ) &
  WATCHDOG_PID=$!
}

# run_with_pidfile <pid-file> <command...>
#
# Runs the command having first recorded the pid it will occupy, so the watchdog has
# an exact process to kill rather than having to guess which of the launcher's
# children is the agent. Use only as a pipeline stage: the `exec` replaces the
# pipeline's subshell, which is precisely the process that becomes the agent.
#
# `sh -c` rather than $BASHPID because macOS ships bash 3.2 as /bin/bash, and
# BASHPID did not arrive until bash 4 — under `set -u` it aborts the attempt.
run_with_pidfile() {
  local pid_file="$1"
  shift
  exec sh -c 'echo $$ > "$1"; shift; exec "$@"' _ "$pid_file" "$@"
}

stop_stall_watchdog() {
  if [ -n "${WATCHDOG_PID:-}" ]; then
    kill "$WATCHDOG_PID" >/dev/null 2>&1 || true
    wait "$WATCHDOG_PID" 2>/dev/null || true
    WATCHDOG_PID=""
  fi
}

# True when the watchdog, not the agent itself, ended the last attempt.
watchdog_killed_attempt() {
  [ -n "${WATCHDOG_STALL_MARKER:-}" ] && [ -f "$WATCHDOG_STALL_MARKER" ]
}

# agent_failover <current-profile> <task-name> <config> <swarm-dir> <log>
#
# Replaces this launcher with the one for the profile configured as its
# fallbackProfile, keeping the same task, worktree and tmux session. Returns
# non-zero (and changes nothing) when no handoff is possible, so the caller can
# carry on marking the task failed.
#
# Depth-capped: codex and claude name each other as fallbacks, so an unguarded
# handoff would ping-pong forever whenever the machine, rather than one CLI, is what
# is broken.
agent_failover() {
  local profile="$1" task="$2" config="$3" swarm_dir="$4" log="$5"
  local depth="${MC_FAILOVER_DEPTH:-0}"
  local fallback launcher launcher_path fallback_model

  if [ "$depth" -ge "${MC_MAX_FAILOVER_DEPTH:-1}" ]; then
    echo "  Already failed over once; not handing off again." | tee -a "$log"
    return 1
  fi

  fallback=$(jq -r --arg p "$profile" '.agents.profiles[$p].fallbackProfile // ""' "$config" 2>/dev/null)
  if [ -z "$fallback" ] || [ "$fallback" = "null" ] || [ "$fallback" = "$profile" ]; then
    echo "  No fallback profile configured for '$profile'." | tee -a "$log"
    return 1
  fi

  launcher=$(jq -r --arg p "$fallback" '.agents.profiles[$p].launcher // $p' "$config" 2>/dev/null)
  launcher_path="$swarm_dir/run-${launcher}.sh"
  if [ ! -x "$launcher_path" ]; then
    echo "  Fallback launcher $launcher_path is missing or not executable." | tee -a "$log"
    return 1
  fi

  fallback_model=$(jq -r --arg p "$fallback" '.agents.profiles[$p].model // ""' "$config" 2>/dev/null)

  echo "=== Failing over: '$profile' hung on every attempt; handing $task to '$fallback' | $(date) ===" | tee -a "$log"

  # Keep the board honest about who is actually running the task now.
  if declare -F update_registry_json >/dev/null 2>&1; then
    update_registry_json "$(jq -cn \
      --arg profile "$fallback" --arg launcher "$launcher" --arg model "$fallback_model" \
      '{agentProfile:$profile,agent:$profile,launcher:$launcher,agentModel:$model,
        retryCount:0,lastError:"failed_over_after_hang",failedAt:null}')"
  fi

  # These were exported by spawn-agent.sh for the profile being replaced. Leaving
  # them set would hand gpt-5.6-sol to `claude --model`.
  unset AGENT_MODEL AGENT_EFFORT AGENT_FALLBACK_MODEL AGENT_PROVIDER AGENT_THINKING

  export AGENT_PROFILE="$fallback"
  export MC_FAILOVER_DEPTH=$((depth + 1))

  exec "$launcher_path" "$task"
}
