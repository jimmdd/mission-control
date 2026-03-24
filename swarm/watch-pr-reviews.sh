#!/bin/bash
# watch-pr-reviews.sh — Polls GitHub PRs for new human review comments.
# When found, relaunches the agent with the feedback.

set -euo pipefail

SWARM_DIR="$HOME/.openclaw/swarm"
REGISTRY="$SWARM_DIR/active-tasks.json"
STATE_TOOL="$SWARM_DIR/swarm-state.py"
LOG="$SWARM_DIR/logs/pr-reviews.log"
STATE_DIR="$SWARM_DIR/pr-review-state"
MC_URL="${MISSION_CONTROL_URL:-http://localhost:18789/ext/mission-control}"
LAUNCHER="$SWARM_DIR/run-claude.sh"
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Bot markers — comments from our system to ignore
BOT_MARKERS=("Mission Control" "mc-bot" "TASK_COMPLETE" "codex-review")

mkdir -p "$SWARM_DIR/logs" "$STATE_DIR"

log() { echo "[$TIMESTAMP] $*" >> "$LOG"; }

state_update() {
  local task_id="$1"
  local patch_json="$2"
  local reason="${3:-watch-pr-reviews}"
  python3 "$STATE_TOOL" update --task-id "$task_id" --patch-json "$patch_json" --reason "$reason" >/dev/null 2>&1 || \
    log "WARN: state update failed for $task_id ($reason)"
}

write_state_file() {
  local target="$1"
  local value="$2"
  local tmp="${target}.tmp"
  printf '%s' "$value" > "$tmp"
  mv "$tmp" "$target"
}

mc_post_activity() {
  local task_id="$1" type="$2" msg="$3"
  curl -s -X POST "$MC_URL/api/tasks/$task_id/activities" \
    -H "Content-Type: application/json" \
    -d "{\"activity_type\":\"$type\",\"message\":$(echo "$msg" | jq -Rs .)}" > /dev/null 2>&1 || true
}

is_bot_comment() {
  local body="$1"
  for marker in "${BOT_MARKERS[@]}"; do
    if echo "$body" | grep -qi "$marker"; then
      return 0
    fi
  done
  return 1
}

get_gh_owner_repo() {
  local repo_dir="$1"
  cd "$repo_dir" && gh repo view --json nameWithOwner -q '.nameWithOwner' 2>/dev/null || echo ""
}

process_pr() {
  local task_id="$1" repo_dir="$2" pr_num="$3" mc_task_id="$4" branch="$5" worktree="$6"

  local owner_repo
  owner_repo=$(get_gh_owner_repo "$repo_dir")
  if [ -z "$owner_repo" ]; then
    log "SKIP: Could not determine owner/repo for $repo_dir"
    return
  fi

  local state_file="$STATE_DIR/${task_id}.last_checked"
  local last_checked=""
  [ -f "$state_file" ] && last_checked=$(cat "$state_file")

  # Fetch PR review comments (inline on files)
  local review_comments
  review_comments=$(gh api "repos/$owner_repo/pulls/$pr_num/comments" \
    --jq '.[] | {id, user: .user.login, body, path, line: .line, created_at}' 2>/dev/null) || return

  # Fetch PR issue comments (general)
  local issue_comments
  issue_comments=$(gh api "repos/$owner_repo/issues/$pr_num/comments" \
    --jq '.[] | {id, user: .user.login, body, created_at}' 2>/dev/null) || return

  # Filter to new human comments only
  local new_feedback=""
  local newest_ts="$last_checked"
  local found_new=false

  while IFS= read -r comment; do
    [ -z "$comment" ] && continue
    local created_at body user path
    created_at=$(echo "$comment" | jq -r '.created_at // ""')
    body=$(echo "$comment" | jq -r '.body // ""')
    user=$(echo "$comment" | jq -r '.user // ""')
    path=$(echo "$comment" | jq -r '.path // ""')

    # Skip if before last check
    if [ -n "$last_checked" ] && [[ "$created_at" < "$last_checked" || "$created_at" == "$last_checked" ]]; then
      continue
    fi

    # Skip bot comments
    if is_bot_comment "$body"; then
      continue
    fi

    found_new=true
    if [ -n "$path" ] && [ "$path" != "null" ]; then
      new_feedback+="**@${user}** on \`${path}\`:"$'\n'"${body}"$'\n\n'
    else
      new_feedback+="**@${user}** (general):"$'\n'"${body}"$'\n\n'
    fi

    # Track newest timestamp
    if [ -z "$newest_ts" ] || [[ "$created_at" > "$newest_ts" ]]; then
      newest_ts="$created_at"
    fi
  done < <(echo "$review_comments" "$issue_comments" | jq -c '.' 2>/dev/null)

  # Check for PR review state changes (approvals, changes_requested)
  local review_state_file="$STATE_DIR/${task_id}.last_review_state"
  local last_review_state=""
  [ -f "$review_state_file" ] && last_review_state=$(cat "$review_state_file")

  local latest_review
  latest_review=$(gh api "repos/$owner_repo/pulls/$pr_num/reviews" \
    --jq '[.[] | select(.state == "APPROVED" or .state == "CHANGES_REQUESTED")] | sort_by(.submitted_at) | last // empty' 2>/dev/null) || true

  if [ -n "$latest_review" ]; then
    local review_state review_user review_at review_id
    review_state=$(echo "$latest_review" | jq -r '.state')
    review_user=$(echo "$latest_review" | jq -r '.user.login')
    review_at=$(echo "$latest_review" | jq -r '.submitted_at')
    review_id=$(echo "$latest_review" | jq -r '.id')

    if [ "$review_id" != "$last_review_state" ]; then
      write_state_file "$review_state_file" "$review_id"

      if [ "$review_state" = "APPROVED" ]; then
        log "PR #$pr_num APPROVED by $review_user"
        [ -n "$mc_task_id" ] && mc_post_activity "$mc_task_id" "updated" "PR #${pr_num} approved by @${review_user} on GitHub"
      elif [ "$review_state" = "CHANGES_REQUESTED" ]; then
        log "PR #$pr_num CHANGES REQUESTED by $review_user"
        [ -n "$mc_task_id" ] && mc_post_activity "$mc_task_id" "updated" "PR #${pr_num} changes requested by @${review_user} on GitHub"
      fi
    fi
  fi

  if [ "$found_new" = false ]; then
    return
  fi

  # Update last checked timestamp
  write_state_file "$state_file" "$newest_ts"

  log "NEW REVIEW on PR #$pr_num ($owner_repo): relaunching agent $task_id"

  # Create review prompt
  local prompt_file="$SWARM_DIR/prompts/${task_id}-gh-review.md"
  cat > "$prompt_file" <<PROMPT
# GitHub PR Review Feedback

A reviewer left comments on PR #${pr_num}. Address all feedback and push updates.

## Review Comments

${new_feedback}

## Instructions
1. Read each review comment carefully
2. Make the requested changes in the codebase
3. If a comment is about naming, rename as requested
4. If a comment questions test quality, improve the test to actually verify behavior
5. Commit with message: "fix: address PR review feedback"
6. Push to update the existing PR

Do NOT create a new PR. Fix the existing code and push.
Do NOT reply to the PR comments — just fix the code.
PROMPT

  # Check if agent is already running
  local session="claude-${task_id}"
  if tmux has-session -t "$session" 2>/dev/null; then
    log "Agent $task_id already running in tmux, skipping relaunch"
    return
  fi

  # Relaunch agent
  local work_dir="${worktree:-$repo_dir}"
  tmux new-session -d -s "$session" -c "$work_dir" \
    "PROMPT_OVERRIDE=$prompt_file $LAUNCHER $task_id"

  # Update registry
  state_update "$task_id" "{\"status\": \"running\", \"changeRequestAt\": \"$TIMESTAMP\", \"completionSyncedAt\": null}" "review-feedback-relaunch"

  # Update MC
  mc_post_activity "$mc_task_id" "updated" "GitHub PR review detected — reviewer feedback on PR #${pr_num}. Agent relaunched to address comments."
  curl -s -X PATCH "$MC_URL/api/tasks/$mc_task_id" \
    -H "Content-Type: application/json" \
    -d '{"status":"in_progress"}' > /dev/null 2>&1 || true

  # Log to spawn history
  local history_file="$SWARM_DIR/spawn-history.jsonl"
  printf '{"type":"gh_review_relaunch","id":"%s","pr":%d,"at":"%s","mcTaskId":"%s"}\n' \
    "$task_id" "$pr_num" "$TIMESTAMP" "$mc_task_id" >> "$history_file"
}

# Main
if [ ! -f "$REGISTRY" ]; then
  log "No registry found, exiting"
  exit 0
fi

log "Checking PRs for review comments..."

# Process each entry that has a PR
jq -c '.[] | select(.pr != null and .pr != 0)' "$REGISTRY" | while IFS= read -r entry; do
  task_id=$(echo "$entry" | jq -r '.id')
  repo=$(echo "$entry" | jq -r '.repo')
  pr=$(echo "$entry" | jq -r '.pr')
  mc_task_id=$(echo "$entry" | jq -r '.mcTaskId // ""')
  branch=$(echo "$entry" | jq -r '.branch // ""')
  worktree=$(echo "$entry" | jq -r '.worktree // ""')
  status=$(echo "$entry" | jq -r '.status // ""')

  # Only check completed or review-state tasks (not currently running)
  if [ "$status" = "running" ]; then
    continue
  fi

  process_pr "$task_id" "$repo" "$pr" "$mc_task_id" "$branch" "$worktree"
done

log "PR review check complete"
