#!/bin/bash
set -euo pipefail

MC_HOME="${MC_HOME:-$HOME/.mission-control}"
METRICS_LOG="$MC_HOME/metrics/repo-watcher.log"
STATE_FILE="$MC_HOME/swarm/repo-watcher-state.json"
GITPROJECTS="$HOME/GitProjects"
VENV_PYTHON="${MC_PYTHON_BIN:-$MC_HOME/venv-3.12/bin/python3}"

mkdir -p "$(dirname "$METRICS_LOG")"
ts() { date '+%Y-%m-%d %H:%M:%S'; }

if [ ! -f "$STATE_FILE" ]; then
    echo "$(ts) TRIGGER no_state_file" >> "$METRICS_LOG"
    exec "$VENV_PYTHON" "$MC_HOME/swarm/repo-watcher.py"
fi

changed=0
for project_dir in "$GITPROJECTS"/*/; do
    [ -d "$project_dir" ] || continue
    project=$(basename "$project_dir")
    for repo_dir in "$project_dir"*/; do
        [ -d "$repo_dir/.git" ] || continue
        repo=$(basename "$repo_dir")
        key="${project}/${repo}"
        current_sha=$(git -C "$repo_dir" rev-parse HEAD 2>/dev/null) || continue
        stored_sha=$(python3 -c "import json; print(json.load(open('$STATE_FILE')).get('$key',{}).get('sha',''))" 2>/dev/null || echo "")
        if [ "$current_sha" != "$stored_sha" ]; then
            changed=1
            break 2
        fi
    done
done

if [ $changed -eq 0 ]; then
    echo "$(ts) SKIP no_changes" >> "$METRICS_LOG"
    exit 0
fi

echo "$(ts) TRIGGER repos_changed" >> "$METRICS_LOG"
exec "$VENV_PYTHON" "$MC_HOME/swarm/repo-watcher.py"
