#!/bin/bash
# Release Mission Control-managed worktrees after their linked ticket is done.
set -u

MC_HOME="${MC_HOME:-$HOME/.mission-control}"
SCRIPT_SRC="${BASH_SOURCE[0]}"
while [ -L "$SCRIPT_SRC" ]; do
  LINK_TARGET="$(readlink "$SCRIPT_SRC")"
  case "$LINK_TARGET" in
    /*) SCRIPT_SRC="$LINK_TARGET" ;;
    *) SCRIPT_SRC="$(dirname "$SCRIPT_SRC")/$LINK_TARGET" ;;
  esac
done
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_SRC")" && pwd)"
PYTHON_BIN="${MC_PYTHON_BIN:-python3}"

exec "$PYTHON_BIN" "$SCRIPT_DIR/worktree_cleanup.py" \
  --registry "$MC_HOME/swarm/active-tasks.json" \
  --state-tool "$MC_HOME/swarm/swarm-state.py" \
  "$@"
