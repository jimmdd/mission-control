#!/bin/bash
# Cleans up merged/done worktrees and task registry entries
SWARM_DIR="$HOME/.openclaw/swarm"
REGISTRY="$SWARM_DIR/active-tasks.json"
TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
STATE_TOOL="$SWARM_DIR/swarm-state.py"
COMPLETED_TTL_HOURS="${COMPLETED_TTL_HOURS:-72}"

echo "[$TIMESTAMP] Cleanup starting..."

NOW_MS=$(($(date +%s) * 1000))
TTL_MS=$((COMPLETED_TTL_HOURS * 60 * 60 * 1000))

jq -r --argjson now "$NOW_MS" --argjson ttl "$TTL_MS" '
  .[]
  | select(
      .status == "merged"
      or .status == "done"
      or .status == "killed"
      or (
        .status == "completed_by_agent"
        and ($now - (.startedAt // .lastAttemptAt // .lastRespawnAt // 0)) > $ttl
      )
    )
  | .id
' "$REGISTRY" 2>/dev/null | while read -r TASK_ID; do
  WORKTREE=$(jq -r ".[] | select(.id == \"$TASK_ID\") | .worktree" "$REGISTRY")
  REPO=$(jq -r ".[] | select(.id == \"$TASK_ID\") | .repo" "$REGISTRY")
  BRANCH=$(jq -r ".[] | select(.id == \"$TASK_ID\") | .branch" "$REGISTRY")
  SESSION=$(jq -r ".[] | select(.id == \"$TASK_ID\") | .tmuxSession" "$REGISTRY")

  echo "  Cleaning: $TASK_ID"

  # Kill tmux session if still alive
  tmux kill-session -t "$SESSION" 2>/dev/null || true

  # Remove worktree
  if [ -d "$WORKTREE" ]; then
    cd "$REPO" 2>/dev/null
    git worktree remove "$WORKTREE" --force 2>/dev/null || true
  fi

  # Delete local branch
  cd "$REPO" 2>/dev/null
  git branch -D "$BRANCH" 2>/dev/null || true

  python3 "$STATE_TOOL" remove --task-id "$TASK_ID" --reason "cleanup-worktrees" >/dev/null 2>&1 || true

  echo "  ✓ Cleaned: $TASK_ID"
done

echo "[$TIMESTAMP] Cleanup complete."
