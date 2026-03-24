#!/bin/bash
set -euo pipefail

SWARM_DIR="$HOME/.openclaw/swarm"
REGISTRY="$SWARM_DIR/active-tasks.json"
EVENTS="$SWARM_DIR/events.jsonl"

echo "=== Swarm Board ==="
jq -r '
  def count($s): [ .[] | select(.status == $s) ] | length;
  "running=" + (count("running")|tostring)
  + " ready=" + (count("ready")|tostring)
  + " completed=" + (count("completed_by_agent")|tostring)
  + " failed=" + (count("failed")|tostring)
' "$REGISTRY" 2>/dev/null || echo "running=0 ready=0 completed=0 failed=0"

echo ""
echo "=== Active Agents (tmux) ==="
tmux ls 2>/dev/null || echo "No tmux sessions"

echo ""
echo "=== Tasks ==="
jq -r '.[] | "\(.status)\t\(.agent)\t\(.id)\t\(.retryCount // 0)\t\(.reviewCycles // 0)\t\(.description)"' "$REGISTRY" 2>/dev/null | \
  awk 'BEGIN{print "status\tagent\tid\tretries\treview\tdescription"}1' | column -t || echo "Empty"

echo ""
echo "=== Last State Events ==="
if [ -f "$EVENTS" ]; then
  python3 - <<'PY'
import json
from pathlib import Path
events = Path.home() / ".openclaw" / "swarm" / "events.jsonl"
for line in events.read_text().splitlines()[-10:]:
    try:
        e = json.loads(line)
    except Exception:
        continue
    print(f"{e.get('at','')}\t{e.get('type','')}\t{e.get('taskId','')}\t{e.get('reason','')}")
PY
else
  echo "No events"
fi

echo ""
echo "=== Open PRs ==="
gh pr list --limit 10 2>/dev/null || echo "Not in a repo"

echo ""
echo "=== System ==="
top -l 1 -n 0 2>/dev/null | grep PhysMem || true
