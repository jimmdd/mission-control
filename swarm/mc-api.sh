#!/bin/bash
# Shared Mission Control API authentication for shell runtime clients.

mc_token_for() {
  local method path="$2" fallback=""
  method="$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]')"
  fallback="${MISSION_CONTROL_ACCESS_TOKEN:-${MISSION_CONTROL_READ_ACCESS_TOKEN:-}}"
  if [ "${MISSION_CONTROL_AUTH_MODE:-simple}" != "scoped" ]; then
    printf '%s' "$fallback"
    return
  fi
  if [[ "$path" == /api/webhooks/* ]]; then
    printf '%s' "${MISSION_CONTROL_WEBHOOK_SECRET:-${MISSION_CONTROL_WRITE_TOKEN:-$fallback}}"
  elif [[ "$method" =~ ^(GET|HEAD|OPTIONS)$ ]]; then
    printf '%s' "${MISSION_CONTROL_READ_TOKEN:-$fallback}"
  elif [ "$method" = "DELETE" ]; then
    printf '%s' "${MISSION_CONTROL_ADMIN_TOKEN:-${MISSION_CONTROL_WRITE_TOKEN:-$fallback}}"
  else
    printf '%s' "${MISSION_CONTROL_WRITE_TOKEN:-$fallback}"
  fi
}

mc_curl() {
  local method="$1" path="$2" token
  shift 2
  token="$(mc_token_for "$method" "$path")"
  # macOS bash 3.2 treats an empty array as unbound under set -u, even inside
  # `command || true`. That used to abort a successfully started agent while
  # merely posting its optional prompt activity, with stderr redirected away.
  if [ -n "$token" ]; then
    curl -X "$method" -H "Authorization: Bearer $token" "$@" "${MC_URL%/}$path"
  else
    curl -X "$method" "$@" "${MC_URL%/}$path"
  fi
}
