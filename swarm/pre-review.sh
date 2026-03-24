#!/bin/bash
# Pre-PR Codex review on branch diff.
# Called by the agent's ralph loop before PR creation.
#
# Usage: pre-review.sh <worktree-path> [base-branch]
# Output: Review feedback as text to stdout
# Exit: 0 = review passed, 1 = issues found, 2 = review failed
set -euo pipefail

WORKTREE=$1
BASE_BRANCH=${2:-origin/main}
SWARM_DIR="$HOME/.openclaw/swarm"
CONFIG="$SWARM_DIR/swarm-config.json"

CODEX_MODEL=$(jq -r '.codex.model // "gpt-5.4"' "$CONFIG" 2>/dev/null || echo "gpt-5.4")
REVIEW_EFFORT=$(jq -r '.codex.reviewEffort // "high"' "$CONFIG" 2>/dev/null || echo "high")

cd "$WORKTREE"

# Get the diff
DIFF=$(git diff "$BASE_BRANCH" -- . ":(exclude)*.lock" ":(exclude)package-lock.json" ":(exclude)pnpm-lock.yaml" ":(exclude).mcp.json" 2>/dev/null)

if [ -z "$DIFF" ]; then
  echo "No changes to review."
  exit 0
fi

# Get changed file list
CHANGED_FILES=$(git diff --name-only "$BASE_BRANCH" -- . ":(exclude)*.lock" 2>/dev/null)
FILE_COUNT=$(echo "$CHANGED_FILES" | wc -l | tr -d ' ')

# Build blast radius context if code-review-graph is available
CRG_BIN="$HOME/.openclaw/venv-3.12/bin/code-review-graph"
BLAST_RADIUS=""
if [ -x "$CRG_BIN" ]; then
  # Update graph for changed files
  $CRG_BIN update --repo "$WORKTREE" 2>/dev/null || true

  # Get impact radius for each changed file (capture first 2000 chars)
  for f in $CHANGED_FILES; do
    IMPACT=$($CRG_BIN status --repo "$WORKTREE" 2>/dev/null | head -20) || true
    if [ -n "$IMPACT" ]; then
      BLAST_RADIUS="$IMPACT"
      break
    fi
  done
fi

# Truncate diff if too large (Codex has context limits)
DIFF_LEN=${#DIFF}
if [ "$DIFF_LEN" -gt 30000 ]; then
  DIFF="${DIFF:0:30000}

... (truncated, $DIFF_LEN total chars)"
fi

# Build review prompt
REVIEW_PROMPT="You are a senior code reviewer. Review this diff for:
1. Bugs, logic errors, edge cases
2. Security issues (injection, auth, data exposure)
3. Missing error handling
4. Test coverage gaps (functions that should have tests but don't)
5. Style/pattern violations relative to the existing codebase
6. Performance concerns

Changed files ($FILE_COUNT):
$CHANGED_FILES
"

if [ -n "$BLAST_RADIUS" ]; then
  REVIEW_PROMPT="$REVIEW_PROMPT

## Impact Analysis (code-review-graph)
$BLAST_RADIUS
"
fi

REVIEW_PROMPT="$REVIEW_PROMPT

## Diff
\`\`\`diff
$DIFF
\`\`\`

## Response Format
If issues found, list each as:
- **[severity: critical|major|minor]** file:line — description

If no issues, respond with: LGTM

End with one of:
- VERDICT: PASS (no blocking issues)
- VERDICT: FAIL (has critical or major issues that must be fixed)
- VERDICT: WARN (minor issues, can proceed but should be addressed)"

# Run Codex review
REVIEW_OUTPUT=$(echo "$REVIEW_PROMPT" | codex -q --model "$CODEX_MODEL" --effort "$REVIEW_EFFORT" 2>&1) || {
  echo "Codex review failed to run"
  exit 2
}

echo "$REVIEW_OUTPUT"

# Parse verdict
if echo "$REVIEW_OUTPUT" | grep -q "VERDICT: PASS\|LGTM"; then
  exit 0
elif echo "$REVIEW_OUTPUT" | grep -q "VERDICT: FAIL"; then
  exit 1
elif echo "$REVIEW_OUTPUT" | grep -q "VERDICT: WARN"; then
  exit 0  # warnings don't block
else
  # No clear verdict — treat as needs review
  exit 1
fi
