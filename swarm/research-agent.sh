#!/bin/bash
# Lightweight Claude Code research agent — read-only codebase exploration.
# No worktree, no branch, no PR, no GSD. Just grep/read/trace and write findings.
# Usage: research-agent.sh <question-id> <repo-path>
set -euo pipefail

QUESTION_ID=${1:?"Usage: research-agent.sh <question-id> <repo-path>"}
REPO_PATH=${2:?"Usage: research-agent.sh <question-id> <repo-path>"}
SWARM_DIR="$HOME/.openclaw/swarm"
PROMPT_FILE="$SWARM_DIR/prompts/research-${QUESTION_ID}.md"
LOG="$SWARM_DIR/logs/research-${QUESTION_ID}.log"

mkdir -p "$SWARM_DIR/research" "$SWARM_DIR/logs"

if [ ! -f "$PROMPT_FILE" ]; then
  echo "ERROR: No prompt file at $PROMPT_FILE" | tee -a "$LOG"
  exit 1
fi

if [ ! -d "$REPO_PATH" ]; then
  echo "ERROR: Repo path not found: $REPO_PATH" | tee -a "$LOG"
  exit 1
fi

echo "=== Research Agent starting: $QUESTION_ID | $(date) ===" | tee -a "$LOG"
echo "  Repo: $REPO_PATH" | tee -a "$LOG"

cd "$REPO_PATH"

# Run Claude Code in read-only research mode.
# Uses script(1) for PTY wrapper (macOS).
if script -q /dev/null claude \
  --model claude-sonnet-4-20250514 \
  --dangerously-skip-permissions \
  --max-turns 30 \
  --prompt-file "$PROMPT_FILE" \
  >> "$LOG" 2>&1; then
  echo "=== Research Agent completed: $QUESTION_ID | $(date) ===" >> "$LOG"
else
  echo "=== Research Agent failed (exit $?): $QUESTION_ID | $(date) ===" >> "$LOG"
  exit 1
fi
