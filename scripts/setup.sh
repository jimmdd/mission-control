#!/usr/bin/env bash
#
# Mission Control setup — one command to get a working local install.
#
# Idempotent: safe to re-run. Safe/universal steps run automatically; anything
# invasive (creating a Python venv, installing & loading the always-on launchd
# services) is prompted for first. Non-macOS hosts skip the launchd step.
#
#   bash scripts/setup.sh          # interactive
#   bash scripts/setup.sh --yes    # assume "yes" to every prompt
#   bash scripts/setup.sh --no-services   # skip the launchd services step
#
set -euo pipefail

# --- locate the repo (this script lives in <repo>/scripts) ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MC_HOME="${MC_HOME:-$HOME/.mission-control}"

ASSUME_YES=0
WANT_SERVICES=1
for arg in "$@"; do
  case "$arg" in
    --yes|-y) ASSUME_YES=1 ;;
    --no-services) WANT_SERVICES=0 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

# --- pretty output ---
if [ -t 1 ]; then B="\033[1m"; G="\033[32m"; Y="\033[33m"; R="\033[31m"; D="\033[2m"; N="\033[0m"; else B=""; G=""; Y=""; R=""; D=""; N=""; fi
step() { printf "\n${B}==> %s${N}\n" "$1"; }
ok()   { printf "  ${G}✓${N} %s\n" "$1"; }
warn() { printf "  ${Y}!${N} %s\n" "$1"; }
err()  { printf "  ${R}✗${N} %s\n" "$1"; }
info() { printf "  ${D}%s${N}\n" "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }
confirm() { # confirm "question" -> returns 0 for yes
  [ "$ASSUME_YES" = 1 ] && return 0
  local reply
  printf "  ${B}?${N} %s [y/N] " "$1"
  read -r reply </dev/tty || return 1
  [[ "$reply" =~ ^[Yy] ]]
}

printf "${B}Mission Control setup${N}\n"
info "repo:    $REPO_DIR"
info "MC_HOME: $MC_HOME"

# ---------------------------------------------------------------------------
step "Checking prerequisites"
missing=0
if have node; then
  NODE_BIN="$(command -v node)"
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  want_major="$(tr -dc '0-9' < "$REPO_DIR/.nvmrc" 2>/dev/null || echo 22)"
  if [ "${NODE_MAJOR:-0}" -ge "${want_major:-22}" ]; then
    ok "node $(node -v) ($NODE_BIN)"
  else
    warn "node $(node -v) is older than v${want_major} (.nvmrc) — the server may not run"
  fi
else
  err "node not found — install Node.js ${want_major:-22}+ (see .nvmrc)"; missing=1
fi
if have python3; then ok "python3 $(python3 -V 2>&1 | awk '{print $2}')"; else err "python3 not found (needed for the swarm/bridge)"; missing=1; fi
have gh    && ok "gh (GitHub CLI) present" || warn "gh not found — PR-aware dispatch will fall back to Linear-only detection"
have git   && ok "git present" || { err "git not found"; missing=1; }
if [ "$missing" = 1 ]; then err "Install the missing prerequisites above, then re-run."; exit 1; fi

# ---------------------------------------------------------------------------
step "Installing Node dependencies (npm install)"
if [ -d "$REPO_DIR/node_modules" ] && [ "$ASSUME_YES" != 1 ] && ! confirm "node_modules already exists — run npm install again?"; then
  info "skipped"
else
  ( cd "$REPO_DIR" && npm install )
  ok "npm install complete"
fi
info "note: better-sqlite3 is a native module — it must be built with the same"
info "      node that runs the server. This script uses '$NODE_BIN' for both."

# ---------------------------------------------------------------------------
step "Creating MC_HOME layout"
for d in swarm swarm/prompts swarm/logs librarian librarian/indexes data logs; do
  mkdir -p "$MC_HOME/$d"
done
ok "created $MC_HOME/{swarm,librarian,data,logs}"

# ---------------------------------------------------------------------------
step "Installing swarm runtime scripts into MC_HOME/swarm"
# The bridge and spawn-agent.sh resolve their launchers via \$MC_HOME/swarm.
# Symlink the repo copies so they always track your checkout (no drift).
linked=0
for f in spawn-agent.sh run-claude.sh run-codex.sh run-pi.sh pre-review.sh swarm-state.py knowledge-distill.py; do
  if [ -e "$REPO_DIR/swarm/$f" ]; then
    ln -sfn "$REPO_DIR/swarm/$f" "$MC_HOME/swarm/$f"
    linked=$((linked+1))
  else
    warn "repo is missing swarm/$f (skipped)"
  fi
done
ok "linked $linked launcher/helper scripts (symlinks track the repo)"

# ---------------------------------------------------------------------------
step "Scaffolding config (.env)"
if [ -f "$MC_HOME/.env" ]; then
  ok ".env already exists at $MC_HOME/.env (left untouched)"
else
  cp "$REPO_DIR/.env.example" "$MC_HOME/.env"
  ok "wrote $MC_HOME/.env from .env.example — edit it to add keys"
fi

# ---------------------------------------------------------------------------
step "Python interpreter for the swarm"
MC_PYTHON="$(command -v python3)"
VENV_PY="$MC_HOME/venv-3.12/bin/python3"
if [ -x "$VENV_PY" ]; then
  MC_PYTHON="$VENV_PY"; ok "using existing venv: $VENV_PY"
elif confirm "Create an isolated Python venv at $MC_HOME/venv-3.12 and install fastembed?"; then
  python3 -m venv "$MC_HOME/venv-3.12"
  "$VENV_PY" -m pip install --quiet --upgrade pip
  "$VENV_PY" -m pip install --quiet fastembed || warn "fastembed install failed (embeddings optional) — continuing"
  MC_PYTHON="$VENV_PY"; ok "venv ready: $VENV_PY"
  info "for knowledge memory later: $VENV_PY -m pip install context-fabrica"
else
  info "using system python3: $MC_PYTHON"
fi

# ---------------------------------------------------------------------------
# launchd always-on services (macOS only)
NODE_DIR="$(dirname "$NODE_BIN")"
PY_DIR="$(dirname "$MC_PYTHON")"
SVC_PATH="$PY_DIR:$NODE_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
LA_DIR="$HOME/Library/LaunchAgents"
UID_NUM="$(id -u)"

emit_plist() { # emit_plist LABEL WORKDIR LOGFILE SCHEDULE_XML  <program-arg-lines-on-stdin>
  local label="$1" workdir="$2" logfile="$3" schedule="$4"; shift 4
  cat > "$LA_DIR/$label.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
$(cat)
  </array>
  <key>WorkingDirectory</key><string>$workdir</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MC_HOME</key><string>$MC_HOME</string>
    <key>MC_PYTHON_BIN</key><string>$MC_PYTHON</string>
    <key>PATH</key><string>$SVC_PATH</string>
  </dict>
  <key>StandardOutPath</key><string>$logfile</string>
  <key>StandardErrorPath</key><string>$logfile</string>
  <key>RunAtLoad</key><true/>
$schedule
</dict>
</plist>
PLIST
}
arg() { printf '    <string>%s</string>\n' "$1"; }

load_service() { # load_service LABEL
  local label="$1"
  launchctl bootout "gui/$UID_NUM/$label" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$UID_NUM" "$LA_DIR/$label.plist" 2>/dev/null || launchctl load -w "$LA_DIR/$label.plist" 2>/dev/null || true
  launchctl enable "gui/$UID_NUM/$label" >/dev/null 2>&1 || true
  launchctl kickstart -k "gui/$UID_NUM/$label" >/dev/null 2>&1 || true
}

step "Always-on services (launchd)"
if [ "$WANT_SERVICES" = 0 ]; then
  info "skipped (--no-services). Run manually with: npm start"
elif [ "$(uname)" != "Darwin" ]; then
  warn "not macOS — launchd services skipped. Run the server with: npm start"
  info "(bridge/linear-sync/repo-watcher can be run under systemd/cron on Linux)"
elif ! have launchctl; then
  warn "launchctl not available — skipping services. Run: npm start"
elif confirm "Install & start the 5 background services (server, bridge, linear-sync, repo-watcher, check-agents)?"; then
  mkdir -p "$LA_DIR"
  KEEPALIVE='  <key>KeepAlive</key><true/>'

  # server — run tsx via --import (single process; avoids the CLI wrapper spawning
  # an orphan worker that survives restarts).
  emit_plist ai.mission-control.server "$REPO_DIR" "$MC_HOME/logs/mc-server.launchd.log" "$KEEPALIVE" <<EOF
$(arg "$NODE_BIN")
$(arg "--import")
$(arg "tsx")
$(arg "server.ts")
EOF

  emit_plist ai.mission-control.bridge "$REPO_DIR/swarm" "$MC_HOME/logs/bridge.log" "$KEEPALIVE" <<EOF
$(arg "$MC_PYTHON")
$(arg "$REPO_DIR/swarm/bridge.py")
$(arg "--daemon")
$(arg "--interval")
$(arg "60")
EOF

  emit_plist ai.mission-control.linear-sync "$REPO_DIR/integrations/linear" "$MC_HOME/logs/linear-sync.launchd.log" '  <key>StartInterval</key><integer>300</integer>' <<EOF
$(arg "$MC_PYTHON")
$(arg "$REPO_DIR/integrations/linear/linear-sync.py")
EOF

  emit_plist ai.mission-control.repo-watcher "$REPO_DIR/swarm" "$MC_HOME/logs/repo-watcher.launchd.log" '  <key>StartInterval</key><integer>1800</integer>' <<EOF
$(arg "$MC_PYTHON")
$(arg "$REPO_DIR/swarm/repo-watcher.py")
EOF

  emit_plist ai.mission-control.check-agents "$REPO_DIR/swarm" "$MC_HOME/logs/check-agents.launchd.log" '  <key>StartInterval</key><integer>600</integer>' <<EOF
$(arg "/bin/bash")
$(arg "$REPO_DIR/swarm/check-agents.sh")
EOF

  for s in server bridge linear-sync repo-watcher check-agents; do
    load_service "ai.mission-control.$s"
    ok "ai.mission-control.$s installed & started"
  done
else
  info "skipped. You can run the server in the foreground with: npm start"
fi

# ---------------------------------------------------------------------------
step "Done"
ok "Mission Control is set up."
printf "\nNext steps:\n"
info "• Dashboard:    open http://127.0.0.1:18900/"
info "• Add API keys: edit $MC_HOME/.env  (or the ⚙ Settings panel in the UI)"
info "• Runtimes:     ./mc setup   (log in claude/codex/pi, connect sources)"
info "• Foreground:   npm start    (if you skipped the launchd services)"
