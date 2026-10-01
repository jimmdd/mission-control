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

# Run Codex review — `codex exec` is the non-interactive mode (the old `-q`/`--effort`
# flags were removed); prompt is read from stdin, read-only sandbox (review only).
MODEL_FLAG=""
[ -n "$CODEX_MODEL" ] && MODEL_FLAG="--model $CODEX_MODEL"
# Bounded, because an unbounded review gate does not fail — it waits forever. A brew
# upgrade re-quarantined the codex binary mid-run and wedged it before its first
# instruction: the process stayed alive, burned no CPU and printed nothing. This call
# had no time limit, so MET-680 spent ~37 minutes across three attempts waiting on a
# process that was never going to speak, then escalated to a human for a gate that was
# never actually run. A review that cannot start must report that quickly (exit 2),
# so the caller can decide, rather than consuming the agent's review iterations.
REVIEW_TIMEOUT_SECONDS="${PRE_REVIEW_TIMEOUT_SECONDS:-900}"
REVIEW_TMP=$(mktemp "${TMPDIR:-/tmp}/mc-pre-review.XXXXXX")
REVIEW_RESULT=$(mktemp "${TMPDIR:-/tmp}/mc-pre-review-result.XXXXXX")
trap 'rm -f "$REVIEW_TMP" "$REVIEW_RESULT"' EXIT

printf '%s' "$REVIEW_PROMPT" \
  | codex exec --skip-git-repo-check --sandbox read-only --output-last-message "$REVIEW_RESULT" $MODEL_FLAG > "$REVIEW_TMP" 2>&1 &
REVIEW_PID=$!

(
  # Kill the tree, not just the pid: codex forks codex-code-mode-host, and a
  # surviving child holds the output open.
  sleep "$REVIEW_TIMEOUT_SECONDS"
  if kill -0 "$REVIEW_PID" 2>/dev/null; then
    for child in $(pgrep -P "$REVIEW_PID" 2>/dev/null); do kill -KILL "$child" 2>/dev/null; done
    kill -KILL "$REVIEW_PID" 2>/dev/null
  fi
) >/dev/null 2>&1 &
REVIEW_KILLER=$!

REVIEW_RC=0
wait "$REVIEW_PID" 2>/dev/null || REVIEW_RC=$?
for child in $(pgrep -P "$REVIEW_KILLER" 2>/dev/null); do kill "$child" 2>/dev/null || true; done
kill "$REVIEW_KILLER" 2>/dev/null || true
wait "$REVIEW_KILLER" 2>/dev/null || true

REVIEW_OUTPUT=$(cat "$REVIEW_RESULT" 2>/dev/null || true)
if [ "$REVIEW_RC" -ne 0 ]; then REVIEW_OUTPUT=$(cat "$REVIEW_TMP" 2>/dev/null || true); fi

if [ "$REVIEW_RC" -ne 0 ]; then
  if [ -z "${REVIEW_OUTPUT//[[:space:]]/}" ]; then
    echo "Codex review produced no output within ${REVIEW_TIMEOUT_SECONDS}s — the review runner is not working."
    echo "Check that the agent CLI starts at all: \`codex --version\` should answer immediately."
    echo "A Homebrew upgrade re-quarantines the binary, which wedges it at process start."
  else
    echo "Codex review failed to run"
    echo "$REVIEW_OUTPUT" | tail -8
  fi
  exit 2
fi

echo "$REVIEW_OUTPUT"

# Parse only explicit verdict lines. LGTM in an echoed prompt or a mixed
# FAIL/PASS result must never authorize delivery.
if grep -q '^VERDICT: FAIL' "$REVIEW_RESULT"; then
  exit 1
fi
python3 "$READINESS_GATE" record "$WORKTREE" "$BASE_BRANCH" "$REVIEW_HEAD" "$REVIEW_BASE" "$REVIEW_RESULT" "$GREPTILE_RESULT"
