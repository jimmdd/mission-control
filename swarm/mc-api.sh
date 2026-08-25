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
  local auth=()
  [ -n "$token" ] && auth=(-H "Authorization: Bearer $token")
  curl -X "$method" "${auth[@]}" "$@" "${MC_URL%/}$path"
}
