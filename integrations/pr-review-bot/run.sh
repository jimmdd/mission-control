#!/bin/bash
# Wrapper for the PR review bot on the Mac mini: load env (secrets + repo list),
# put gh (Homebrew) on PATH, then run the bot once. Scheduled by launchd.
set -euo pipefail

ENV_FILE="${PR_BOT_ENV_FILE:-$HOME/.pr-review-bot.env}"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

exec /usr/bin/python3 "$(dirname "$0")/pr-review-bot.py" "$@"
