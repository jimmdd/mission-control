#!/bin/bash
# Pre-push Greptile and Codex reviews on the committed branch diff.
# Called by the agent's ralph loop before PR creation.
#
# Usage: pre-review.sh <worktree-path> [base-branch]
# Output: Review feedback as text to stdout
# Exit: 0 = review passed, 1 = issues found, 2 = review failed
set -euo pipefail

WORKTREE=$1
BASE_BRANCH=${2:-origin/main}
MC_HOME="${MC_HOME:-$HOME/.mission-control}"
SWARM_DIR="$MC_HOME/swarm"
CONFIG="$SWARM_DIR/swarm-config.json"

# Model is optional — if not configured, use codex's own default (a bogus default
# like "gpt-5.4" makes the CLI reject the run).
CODEX_MODEL=$(jq -r '.codex.model // ""' "$CONFIG" 2>/dev/null || echo "")

# Resolve before cd: this script may be invoked by its installed symlink.
EVIDENCE_GATE="$(python3 -c 'import pathlib,sys; print(pathlib.Path(sys.argv[1]).resolve().with_name("check_review_evidence.py"))' "${BASH_SOURCE[0]}")"
python3 "$EVIDENCE_GATE" "$WORKTREE" "$BASE_BRANCH"

cd "$WORKTREE"
REVIEW_HEAD=$(git rev-parse HEAD)
REVIEW_BASE=$(git rev-parse "$BASE_BRANCH")
READINESS_GATE="$(dirname "$EVIDENCE_GATE")/pr_readiness.py"
# Starting a fresh review supersedes any previous result for this commit.
rm -f "$SWARM_DIR/pr-review-state/$REVIEW_HEAD.json"

# Get the diff
DIFF=$(git diff "$BASE_BRANCH" -- . 2>/dev/null)

if [ -z "$DIFF" ]; then
  echo "No changes to review."
  exit 0
fi

# Findings and unavailable reviews block before Codex can issue a PASS receipt.
# Both reviews are bound to the same clean head/base and stored outside Git.
GREPTILE_RESULT="$SWARM_DIR/pr-review-state/greptile/$REVIEW_HEAD-$REVIEW_BASE.json"
python3 "$(dirname "$EVIDENCE_GATE")/greptile_review.py" \
  "$WORKTREE" "$BASE_BRANCH" "$REVIEW_HEAD" "$REVIEW_BASE" "$GREPTILE_RESULT" \
  --timeout "${PRE_REVIEW_TIMEOUT_SECONDS:-900}"

# Get changed file list
CHANGED_FILES=$(git diff --name-only "$BASE_BRANCH" -- . 2>/dev/null)
FILE_COUNT=$(echo "$CHANGED_FILES" | wc -l | tr -d ' ')

# Build blast radius context if code-review-graph is available
CRG_BIN="$MC_HOME/venv-3.12/bin/code-review-graph"
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
7. Inspect the complete diff with git and relevant files/tests in this worktree; the excerpt below may be truncated. Confirm real-surface QA evidence for behavior changes, not just green unit tests.
8. Review evidence is deliberately outside Git. Inspect .codex-evidence/ directly (including ticket README files, stamped check outputs, browser probes, screenshots and recordings); ignored files are absent from git ls-files and ordinary repository searches. Verify evidence against this head and the changed component content, and state any actual remaining gap.
9. This reviewer runs in a read-only sandbox. Distinguish inability to create test temporary files from a code defect; inspect the recorded check output and report the execution limitation accurately. Do not invoke the pre-review gate recursively from this review.

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
- VERDICT: WARN (unresolved issues; fix or document disposition and rerun review)"

# Retry transient runner failures once, within one shared timeout budget. The
# helper owns only its spawned process group and never changes security settings.
REVIEW_RESULT=$(mktemp "${TMPDIR:-/tmp}/mc-pre-review-result.XXXXXX")
trap 'rm -f "$REVIEW_RESULT"' EXIT
REVIEW_RC=0
printf '%s' "$REVIEW_PROMPT" | python3 "$(dirname "$EVIDENCE_GATE")/codex_review.py" \
  "$REVIEW_RESULT" --timeout "${PRE_REVIEW_TIMEOUT_SECONDS:-900}" \
  --model "$CODEX_MODEL" || REVIEW_RC=$?
[ "$REVIEW_RC" -eq 0 ] || exit "$REVIEW_RC"
REVIEW_OUTPUT=$(cat "$REVIEW_RESULT" 2>/dev/null || true)
echo "$REVIEW_OUTPUT"

# Parse only explicit verdict lines. LGTM in an echoed prompt or a mixed
# FAIL/PASS result must never authorize delivery.
if grep -q '^VERDICT: FAIL' "$REVIEW_RESULT"; then
  exit 1
fi
python3 "$READINESS_GATE" record "$WORKTREE" "$BASE_BRANCH" "$REVIEW_HEAD" "$REVIEW_BASE" "$REVIEW_RESULT" "$GREPTILE_RESULT"
