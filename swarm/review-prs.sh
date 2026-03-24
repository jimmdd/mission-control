#!/bin/bash
set -euo pipefail

SWARM_DIR="$HOME/.openclaw/swarm"
CONFIG="$SWARM_DIR/swarm-config.json"
STATE_DIR="$SWARM_DIR/pr-review-state"
STATE_FILE="$STATE_DIR/reviewed-prs.json"
STATE_LOCK="$STATE_DIR/reviewed-prs.lock"
LOG="$SWARM_DIR/logs/pr-reviewer.log"
REPOS_DIR="$HOME/GitProjects/your-org"
WORKTREE_BASE="$REPOS_DIR/worktrees/reviews"

mkdir -p "$STATE_DIR" "$SWARM_DIR/logs" "$WORKTREE_BASE"

ENABLED=$(jq -r '.reviewer.enabled // false' "$CONFIG" 2>/dev/null)
if [ "$ENABLED" != "true" ]; then
  exit 0
fi

ORG=$(jq -r '.reviewer.org // "YourOrg"' "$CONFIG")
BOT_USER=$(jq -r '.reviewer.botUser // "your-bot-user"' "$CONFIG")
REVIEW_ON_PUSH=$(jq -r '.reviewer.reviewOnPush // true' "$CONFIG")
REVIEW_EFFORT=$(jq -r '.codex.reviewEffort // "high"' "$CONFIG")
REPOS=()
while IFS= read -r r; do REPOS+=("$r"); done < <(jq -r '.reviewer.repos[]' "$CONFIG" 2>/dev/null)

[ -f "$STATE_FILE" ] || echo '{}' > "$STATE_FILE"
[ -f "$STATE_LOCK" ] || : > "$STATE_LOCK"

log() { echo "[$(date +%H:%M:%S)] $*" >> "$LOG"; }
log "=== PR Reviewer started ==="

state_release_owned_leases() {
  python3 - "$STATE_FILE" "$STATE_LOCK" <<'PYEOF'
import json, fcntl, os, sys
from pathlib import Path

state_file = Path(sys.argv[1])
lock_file = Path(sys.argv[2])
owner = str(os.getpid())

if not state_file.exists():
    raise SystemExit(0)

lock_file.parent.mkdir(parents=True, exist_ok=True)
lock_file.touch(exist_ok=True)

with lock_file.open("a+") as lock:
    fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
    try:
        state = json.loads(state_file.read_text())
    except Exception:
        state = {}

    changed = False
    for key, entry in list(state.items()):
        if not isinstance(entry, dict):
            continue
        lease = entry.get("review_in_progress")
        if isinstance(lease, dict) and str(lease.get("owner") or "") == owner:
            entry.pop("review_in_progress", None)
            state[key] = entry
            changed = True

    if changed:
        tmp = state_file.with_suffix(state_file.suffix + ".tmp")
        with tmp.open("w") as f:
            json.dump(state, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, state_file)
PYEOF
}

trap 'state_release_owned_leases' EXIT INT TERM

run_with_timeout() {
  local seconds="$1"
  shift

  if command -v timeout >/dev/null 2>&1; then
    timeout "$seconds" "$@"
    return $?
  fi

  if command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$seconds" "$@"
    return $?
  fi

  perl -e 'alarm shift; exec @ARGV' "$seconds" "$@"
}

state_get_last_sha() {
  local repo="$1"
  local pr_num="$2"
  python3 - "$STATE_FILE" "$STATE_LOCK" "$repo" "$pr_num" <<'PYEOF'
import json, fcntl, sys
from pathlib import Path

state_file = Path(sys.argv[1])
lock_file = Path(sys.argv[2])
repo = sys.argv[3]
pr_num = sys.argv[4]
key = f"{repo}/{pr_num}"

lock_file.parent.mkdir(parents=True, exist_ok=True)
lock_file.touch(exist_ok=True)

with lock_file.open("a+") as lock:
    fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
    try:
        if state_file.exists():
            state = json.loads(state_file.read_text())
        else:
            state = {}
    except Exception:
        state = {}
    print((state.get(key) or {}).get("last_review_sha", ""))
PYEOF
}

state_is_seeded() {
  local repo="$1"
  local pr_num="$2"
  python3 - "$STATE_FILE" "$STATE_LOCK" "$repo" "$pr_num" <<'PYEOF'
import json, fcntl, sys
from pathlib import Path

state_file = Path(sys.argv[1])
lock_file = Path(sys.argv[2])
repo = sys.argv[3]
pr_num = sys.argv[4]
key = f"{repo}/{pr_num}"

lock_file.parent.mkdir(parents=True, exist_ok=True)
lock_file.touch(exist_ok=True)

with lock_file.open("a+") as lock:
    fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
    try:
        if state_file.exists():
            state = json.loads(state_file.read_text())
        else:
            state = {}
    except Exception:
        state = {}
    seeded = bool((state.get(key) or {}).get("seeded", False))
    print("true" if seeded else "false")
PYEOF
}

state_try_acquire_review_lease() {
  local repo="$1"
  local pr_num="$2"
  local head_sha="$3"
  python3 - "$STATE_FILE" "$STATE_LOCK" "$repo" "$pr_num" "$head_sha" <<'PYEOF'
import json, fcntl, os, sys
from datetime import datetime, timezone
from pathlib import Path

state_file = Path(sys.argv[1])
lock_file = Path(sys.argv[2])
repo = sys.argv[3]
pr_num = int(sys.argv[4])
head_sha = sys.argv[5]
key = f"{repo}/{pr_num}"

lock_file.parent.mkdir(parents=True, exist_ok=True)
lock_file.touch(exist_ok=True)
state_file.parent.mkdir(parents=True, exist_ok=True)

now = datetime.now(timezone.utc)
lease_ttl_seconds = 900
owner = str(os.getpid())

with lock_file.open("a+") as lock:
    fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
    try:
        if state_file.exists():
            state = json.loads(state_file.read_text())
        else:
            state = {}
    except Exception:
        state = {}

    entry = state.get(key) or {}
    lease = entry.get("review_in_progress")
    if isinstance(lease, dict):
        lease_sha = str(lease.get("sha") or "")
        lease_owner = str(lease.get("owner") or "")
        started_at = str(lease.get("started_at") or "")
        owner_alive = False
        if lease_owner.isdigit():
            try:
                os.kill(int(lease_owner), 0)
                owner_alive = True
            except Exception:
                owner_alive = False

        if started_at:
            try:
                started = datetime.fromisoformat(started_at.replace("Z", "+00:00"))
                age = (now - started).total_seconds()
            except Exception:
                age = lease_ttl_seconds + 1
        else:
            age = lease_ttl_seconds + 1

        if age < lease_ttl_seconds and owner_alive and lease_owner != owner and lease_sha == head_sha:
            print("busy")
            raise SystemExit(0)

    entry["review_in_progress"] = {
        "owner": owner,
        "sha": head_sha,
        "started_at": now.isoformat(),
    }
    state[key] = entry

    tmp = state_file.with_suffix(state_file.suffix + ".tmp")
    with tmp.open("w") as f:
        json.dump(state, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, state_file)
    dir_fd = os.open(str(state_file.parent), os.O_DIRECTORY)
    try:
        os.fsync(dir_fd)
    finally:
        os.close(dir_fd)
    print("ok")
PYEOF
}

state_release_review_lease() {
  local repo="$1"
  local pr_num="$2"
  python3 - "$STATE_FILE" "$STATE_LOCK" "$repo" "$pr_num" <<'PYEOF'
import json, fcntl, os, sys
from pathlib import Path

state_file = Path(sys.argv[1])
lock_file = Path(sys.argv[2])
repo = sys.argv[3]
pr_num = int(sys.argv[4])
key = f"{repo}/{pr_num}"
owner = str(os.getpid())

lock_file.parent.mkdir(parents=True, exist_ok=True)
lock_file.touch(exist_ok=True)
state_file.parent.mkdir(parents=True, exist_ok=True)

with lock_file.open("a+") as lock:
    fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
    try:
        if state_file.exists():
            state = json.loads(state_file.read_text())
        else:
            state = {}
    except Exception:
        state = {}

    entry = state.get(key) or {}
    lease = entry.get("review_in_progress")
    if isinstance(lease, dict) and str(lease.get("owner") or "") == owner:
        entry.pop("review_in_progress", None)
        state[key] = entry

        tmp = state_file.with_suffix(state_file.suffix + ".tmp")
        with tmp.open("w") as f:
            json.dump(state, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, state_file)
        dir_fd = os.open(str(state_file.parent), os.O_DIRECTORY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
PYEOF
}

state_set_review() {
  local repo="$1"
  local pr_num="$2"
  local head_sha="$3"
  python3 - "$STATE_FILE" "$STATE_LOCK" "$repo" "$pr_num" "$head_sha" <<'PYEOF'
import json, fcntl, os, sys
from datetime import datetime, timezone
from pathlib import Path

state_file = Path(sys.argv[1])
lock_file = Path(sys.argv[2])
repo = sys.argv[3]
pr_num = int(sys.argv[4])
head_sha = sys.argv[5]
key = f"{repo}/{pr_num}"

lock_file.parent.mkdir(parents=True, exist_ok=True)
lock_file.touch(exist_ok=True)
state_file.parent.mkdir(parents=True, exist_ok=True)

with lock_file.open("a+") as lock:
    fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
    try:
        if state_file.exists():
            state = json.loads(state_file.read_text())
        else:
            state = {}
    except Exception:
        state = {}

    state[key] = {
        "last_review_sha": head_sha,
        "reviewed_at": datetime.now(timezone.utc).isoformat(),
        "pr_num": pr_num,
        "repo": repo,
    }

    tmp = state_file.with_suffix(state_file.suffix + ".tmp")
    with tmp.open("w") as f:
        json.dump(state, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, state_file)
    dir_fd = os.open(str(state_file.parent), os.O_DIRECTORY)
    try:
        os.fsync(dir_fd)
    finally:
        os.close(dir_fd)
PYEOF
}

review_pr() {
  local repo="$1" pr_num="$2" head_sha="$3" base_ref="$4" title="$5" is_rereview="$6" last_sha="$7"
  local repo_path="$REPOS_DIR/$repo"
  local review_log="$SWARM_DIR/logs/pr-review-${repo}-${pr_num}.log"
  local wt_dir="$WORKTREE_BASE/${repo}-pr${pr_num}"

  if [ ! -d "$repo_path/.git" ]; then
    log "  Repo $repo not found at $repo_path — skipping"
    return 1
  fi

  log "  Reviewing $ORG/$repo PR #$pr_num (sha=${head_sha:0:8}, base=$base_ref, rereview=$is_rereview)"

  cd "$repo_path"
  git fetch origin --quiet 2>/dev/null || true

  if [ -d "$wt_dir" ]; then
    cd "$wt_dir"
    git fetch origin --quiet 2>/dev/null || true
    git checkout -f "origin/$(gh pr view "$pr_num" --repo "$ORG/$repo" --json headRefName -q .headRefName)" --quiet 2>/dev/null || {
      log "  Failed to checkout PR branch in worktree — cleaning up"
      cd "$repo_path"
      git worktree remove "$wt_dir" --force 2>/dev/null || rm -rf "$wt_dir"
      return 1
    }
  else
    local head_branch
    head_branch=$(gh pr view "$pr_num" --repo "$ORG/$repo" --json headRefName -q .headRefName 2>/dev/null)
    git fetch origin "pull/$pr_num/head:pr-review-$pr_num" --quiet 2>/dev/null || true
    git worktree add "$wt_dir" "pr-review-$pr_num" --quiet 2>/dev/null || {
      git worktree add "$wt_dir" --detach --quiet 2>/dev/null || { log "  Failed to create worktree"; return 1; }
      cd "$wt_dir"
      git fetch origin "pull/$pr_num/head" --quiet 2>/dev/null
      git checkout FETCH_HEAD --quiet 2>/dev/null
    }
    cd "$wt_dir"
  fi

  local codex_base="origin/$base_ref"
  local review_prefix=""
  if [ "$is_rereview" = "true" ] && [ -n "$last_sha" ]; then
    codex_base="$last_sha"
    review_prefix=$'**Re-review** (changes since last review):\n\n'
  fi

  local review_output
  review_output=$(run_with_timeout 300 /opt/homebrew/bin/codex review \
    --base "$codex_base" \
    --title "PR #${pr_num}: ${title}" \
    -c "reasoning.effort=$REVIEW_EFFORT" \
    2>&1) || {
    local exit_code=$?
    if [ "$exit_code" -eq 124 ] || [ "$exit_code" -eq 142 ]; then
      log "  Codex review timed out for PR #$pr_num"
    else
      log "  Codex review failed (exit $exit_code) for PR #$pr_num"
    fi
    echo "$review_output" > "$review_log" 2>/dev/null
    return 1
  }

  review_output=$(python3 -c "import sys
text = sys.stdin.read()
# Codex may output runtime transcript + final review; keep only the final review section.
marker = '\ncodex\n'
idx = text.rfind(marker)
if idx != -1:
    text = text[idx + len(marker):]
text = text.strip()
print(text)
" <<< "$review_output")

  echo "$review_output" > "$review_log"

  if [ -z "$review_output" ] || [ ${#review_output} -lt 20 ]; then
    log "  Empty review output — skipping post"
    return 1
  fi

  local inline_json general_body parser_json
  parser_json=$(python3 - "$review_log" "$review_prefix" << 'PYEOF'
import re, sys, json
from pathlib import Path

review_text = open(sys.argv[1]).read() if len(sys.argv) > 1 else ""
prefix = sys.argv[2] if len(sys.argv) > 2 else ""
cwd = str(Path.cwd())

def sanitize(text: str) -> str:
    marker = "\ncodex\n"
    idx = text.rfind(marker)
    if idx != -1:
        text = text[idx + len(marker):]

    noise_prefixes = (
        "OpenAI Codex", "--------", "workdir:", "model:", "provider:",
        "approval:", "sandbox:", "reasoning effort:", "reasoning summaries:",
        "session id:", "user", "exec", "mcp startup:", "warning:",
    )

    cleaned = []
    for line in text.splitlines():
        s = line.strip()
        if not s:
            cleaned.append("")
            continue
        if s.startswith(noise_prefixes):
            continue
        cleaned.append(line)
    return "\n".join(cleaned).strip()

def normalize_path(raw_path: str) -> str:
    raw = raw_path.strip()
    marker = "/worktrees/reviews/"
    if marker in raw:
        tail = raw.split(marker, 1)[1]
        if "/" in tail:
            return tail.split("/", 1)[1]
        return tail
    if raw.startswith(cwd + "/"):
        return raw[len(cwd) + 1:]
    return raw

def parse_findings(text: str):
    findings = []
    lines = text.split("\n")
    i = 0

    header = re.compile(r'^\s*-\s*\[(P\d|NIT|INFO)\]\s*(.*?)\s+—\s+(.+?):(\d+)(?:-\d+)?\s*$')
    while i < len(lines):
        m = header.match(lines[i])
        if not m:
            i += 1
            continue

        severity, title, path, line_no = m.group(1), m.group(2), normalize_path(m.group(3)), int(m.group(4))
        i += 1
        detail = []
        while i < len(lines) and not header.match(lines[i]):
            if lines[i].strip():
                detail.append(lines[i].strip())
            i += 1

        body = f"[{severity}] {title}" if not detail else f"[{severity}] {title}\n\n{' '.join(detail)}"
        findings.append({"path": path, "line": line_no, "side": "RIGHT", "body": body[:6000]})

    return findings

review_text = sanitize(review_text)
inline_comments = parse_findings(review_text)

if inline_comments:
    details = []
    for c in inline_comments[:3]:
        body = (c.get("body") or "").splitlines()[0].strip()
        path = c.get("path") or ""
        line = c.get("line") or ""
        if body:
            details.append(f"- {body} ({path}:{line})")
    summary = f"I found {len(inline_comments)} issue(s)."
    if details:
        summary = summary + "\n\n" + "\n".join(details)
else:
    summary = "✅ Looks good. I did not identify a discrete regression in this diff."

general = prefix + summary

if len(general) > 65000:
    general = general[:65000] + "\n\n_(truncated)_"

print(json.dumps({"inline": inline_comments, "general": general}))
PYEOF
)

  inline_json=$(echo "$parser_json" | python3 -c "import sys,json; print(json.dumps(json.load(sys.stdin).get('inline', [])))" 2>/dev/null || echo "[]")
  general_body=$(echo "$parser_json" | python3 -c "import sys,json; print(json.dumps(json.load(sys.stdin).get('general', '')))" 2>/dev/null || echo '""')

  if [ -z "$general_body" ] || [ "$general_body" = '""' ]; then
    general_body=$(python3 -c "import json; print(json.dumps(open('$review_log').read()[:65000]))")
  fi

  local inline_count
  inline_count=$(echo "$inline_json" | python3 -c "import sys,json; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")

  maybe_auto_resolve_threads() {
    local decoded
    decoded=$(echo "$general_body" | python3 -c "import json,sys; print(json.loads(sys.stdin.read()))" 2>/dev/null || echo "")

    if [ "$is_rereview" != "true" ]; then
      return
    fi

    local clean_pass="false"
    if [ "$inline_count" -eq 0 ]; then
      case "$decoded" in
        *"No actionable issues found in this pass."*|*"✅ Looks good."*) clean_pass="true" ;;
      esac
    fi

    local threads_json
    threads_json=$(gh api graphql \
      -f query='query($owner:String!, $repo:String!, $number:Int!) { repository(owner:$owner, name:$repo) { pullRequest(number:$number) { reviewThreads(first:100) { nodes { id isResolved isOutdated comments(first:20) { nodes { author { login } } } } } } } }' \
      -F owner="$ORG" -F repo="$repo" -F number="$pr_num" 2>/dev/null || true)

    [ -z "$threads_json" ] && return

    local outdated_ids
    outdated_ids=$(echo "$threads_json" | python3 -c "import json,sys
data=json.load(sys.stdin)
nodes=(((data or {}).get('data') or {}).get('repository') or {}).get('pullRequest')
nodes=(nodes or {}).get('reviewThreads',{}).get('nodes',[])
for n in nodes:
    if n.get('isResolved'): continue
    if not n.get('isOutdated'): continue
    comments=((n.get('comments') or {}).get('nodes') or [])
    if any(((c.get('author') or {}).get('login')=='$BOT_USER') for c in comments):
        print(n.get('id',''))
" 2>/dev/null || true)

    local thread_ids
    thread_ids=$(echo "$threads_json" | python3 -c "import json,sys
data=json.load(sys.stdin)
nodes=(((data or {}).get('data') or {}).get('repository') or {}).get('pullRequest')
nodes=(nodes or {}).get('reviewThreads',{}).get('nodes',[])
for n in nodes:
    if n.get('isResolved'): continue
    comments=((n.get('comments') or {}).get('nodes') or [])
    if any(((c.get('author') or {}).get('login')=='$BOT_USER') for c in comments):
        print(n.get('id',''))
" 2>/dev/null || true)

    local resolved=0
    if [ -n "$outdated_ids" ]; then
      while read -r tid; do
        [ -z "$tid" ] && continue
        gh api graphql -f query='mutation($threadId:ID!) { resolveReviewThread(input:{threadId:$threadId}) { thread { id isResolved } } }' -F threadId="$tid" > /dev/null 2>&1 && resolved=$((resolved + 1)) || true
      done <<< "$outdated_ids"
    fi

    if [ "$clean_pass" != "true" ]; then
      if [ "$resolved" -gt 0 ]; then
        log "  Auto-resolved $resolved outdated bot review thread(s)"
      fi
      return
    fi

    [ -z "$thread_ids" ] && return

    while read -r tid; do
      [ -z "$tid" ] && continue
      gh api graphql -f query='mutation($threadId:ID!) { resolveReviewThread(input:{threadId:$threadId}) { thread { id isResolved } } }' -F threadId="$tid" > /dev/null 2>&1 && resolved=$((resolved + 1)) || true
    done <<< "$thread_ids"

    if [ "$resolved" -gt 0 ]; then
      log "  Auto-resolved $resolved prior bot review thread(s)"
    fi
  }

  if [ "$inline_count" -gt 0 ]; then
    python3 -c "
import json, sys
inline = json.loads(sys.argv[1])
general = json.loads(sys.argv[2])
review = {'event': 'COMMENT', 'body': general, 'comments': inline}
json.dump(review, sys.stdout)
" "$inline_json" "$general_body" | \
    gh api -X POST "/repos/$ORG/$repo/pulls/$pr_num/reviews" --input - > /dev/null 2>&1 && \
    log "  Posted review with $inline_count inline comments" || {
      log "  Inline review failed — falling back to general comment"
      echo "$general_body" | python3 -c "import sys,json; sys.stdout.write(json.loads(sys.stdin.read()))" > "$review_log.body"
      gh pr review "$pr_num" --repo "$ORG/$repo" --comment --body-file "$review_log.body" 2>/dev/null && \
        log "  Posted general comment" || log "  Failed to post review"
      rm -f "$review_log.body"
    }
  else
    echo "$general_body" | python3 -c "import sys,json; sys.stdout.write(json.loads(sys.stdin.read()))" > "$review_log.body"
    gh pr review "$pr_num" --repo "$ORG/$repo" --comment --body-file "$review_log.body" 2>/dev/null && \
      log "  Posted general comment (no inline comments parsed)" || log "  Failed to post review"
    rm -f "$review_log.body"
  fi

  maybe_auto_resolve_threads

  state_set_review "$repo" "$pr_num" "$head_sha"
  log "  Review complete for $ORG/$repo PR #$pr_num"
}

total_reviewed=0

for repo in "${REPOS[@]}"; do
  processed_keys=""

  mark_processed() {
    local key="$1"
    processed_keys+="${key}|"
  }

  is_processed() {
    local key="$1"
    [[ "$processed_keys" == *"${key}|"* ]]
  }

  requested=$(gh api --paginate "/repos/$ORG/$repo/pulls?state=open" --jq ".[] | select(.requested_reviewers[]?.login == \"$BOT_USER\") | {number, head_sha: .head.sha, base_ref: .base.ref, title}" 2>/dev/null || echo "")

  if [ -n "$requested" ]; then
    while read -r pr; do
      pr_num=$(echo "$pr" | jq -r '.number')
      head_sha=$(echo "$pr" | jq -r '.head_sha')
      base_ref=$(echo "$pr" | jq -r '.base_ref')
      title=$(echo "$pr" | jq -r '.title')
      key="$repo/$pr_num"
      mark_processed "$key"

      last_sha=$(state_get_last_sha "$repo" "$pr_num")
      seeded=$(state_is_seeded "$repo" "$pr_num")

      if [ "$seeded" = "true" ]; then
        last_sha=""
      fi

      [ "$last_sha" = "$head_sha" ] && continue

      lease_result=$(state_try_acquire_review_lease "$repo" "$pr_num" "$head_sha")
      if [ "$lease_result" != "ok" ]; then
        log "  Skipping $ORG/$repo PR #$pr_num — review lease busy"
        continue
      fi

      if [ -n "$last_sha" ] && [ "$REVIEW_ON_PUSH" = "true" ]; then
        review_pr "$repo" "$pr_num" "$head_sha" "$base_ref" "$title" "true" "$last_sha" && total_reviewed=$((total_reviewed + 1)) || true
      elif [ -z "$last_sha" ]; then
        review_pr "$repo" "$pr_num" "$head_sha" "$base_ref" "$title" "false" "" && total_reviewed=$((total_reviewed + 1)) || true
      fi
      state_release_review_lease "$repo" "$pr_num"
    done < <(echo "$requested" | jq -c '.')
  fi

  if [ "$REVIEW_ON_PUSH" = "true" ]; then
    open_prs=$(gh pr list --repo "$ORG/$repo" --state open --json number,headRefOid,baseRefName,title 2>/dev/null || echo "[]")
    while read -r pr; do
      pr_num=$(echo "$pr" | jq -r '.number')
      key="$repo/$pr_num"
      if is_processed "$key"; then
        continue
      fi

      head_sha=$(echo "$pr" | jq -r '.headRefOid')
      base_ref=$(echo "$pr" | jq -r '.baseRefName')
      title=$(echo "$pr" | jq -r '.title')
      last_sha=$(state_get_last_sha "$repo" "$pr_num")

      [ -z "$last_sha" ] && continue
      [ "$last_sha" = "$head_sha" ] && continue

      seeded=$(state_is_seeded "$repo" "$pr_num")
      [ "$seeded" = "true" ] && continue

      lease_result=$(state_try_acquire_review_lease "$repo" "$pr_num" "$head_sha")
      if [ "$lease_result" != "ok" ]; then
        log "  Skipping $ORG/$repo PR #$pr_num — review lease busy"
        continue
      fi

      log "  Re-review fallback: $ORG/$repo PR #$pr_num has new commits since last bot review"
      review_pr "$repo" "$pr_num" "$head_sha" "$base_ref" "$title" "true" "$last_sha" && total_reviewed=$((total_reviewed + 1)) || true
      state_release_review_lease "$repo" "$pr_num"
    done < <(echo "$open_prs" | jq -c '.[]')
  fi
done

log "=== PR Reviewer complete: reviewed $total_reviewed PRs ==="
