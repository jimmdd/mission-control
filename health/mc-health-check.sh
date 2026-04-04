#!/bin/bash
# Mission Control Health Monitor
# Checks MC service health, restarts on failure, alerts after consecutive misses.

set -euo pipefail

MC_URL="${MISSION_CONTROL_URL:-http://127.0.0.1:18790}"
STATE_FILE="$HOME/.openclaw/mission-control/health-state.json"
ALERT_SCRIPT="$HOME/.openclaw/swarm/notify.sh"
MAX_FAILURES=2

ts() { date '+%Y-%m-%d %H:%M:%S'; }

# Read failure count from state
failures=0
if [ -f "$STATE_FILE" ]; then
    failures=$(python3 -c "import json; print(json.load(open('$STATE_FILE')).get('failures', 0))" 2>/dev/null || echo 0)
fi

# Health check
if curl -sf --max-time 5 "${MC_URL}/health" > /dev/null 2>&1; then
    if [ "$failures" -gt 0 ]; then
        echo "$(ts) RECOVERED after ${failures} failures"
        echo '{"failures": 0}' > "$STATE_FILE"
    fi
    exit 0
fi

# Failed
failures=$((failures + 1))
echo "$(ts) FAIL #${failures}"
echo "{\"failures\": ${failures}, \"last_fail\": \"$(date -u '+%Y-%m-%dT%H:%M:%SZ')\"}" > "$STATE_FILE"

# Attempt restart
launchctl kickstart gui/$(id -u)/ai.openclaw.mission-control 2>/dev/null || true

# Alert after consecutive failures
if [ "$failures" -ge "$MAX_FAILURES" ]; then
    echo "$(ts) ALERT Mission Control down for ${failures} consecutive checks"
    if [ -x "$ALERT_SCRIPT" ]; then
        "$ALERT_SCRIPT" "🚨 Mission Control is DOWN (${failures} consecutive failures). Attempted auto-restart." 2>/dev/null || true
    fi
fi
