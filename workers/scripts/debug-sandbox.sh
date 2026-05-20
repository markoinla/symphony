#!/usr/bin/env bash
# Fetch dispatcher sandbox/process/log-tail debug data through linear-agent.
#
# Usage:
#   workers/scripts/debug-sandbox.sh <run-id> [turn]
set -euo pipefail

run_id="${1:-}"
turn="${2:-1}"
if [[ -z "$run_id" ]]; then
  echo "usage: workers/scripts/debug-sandbox.sh <run-id> [turn]" >&2
  exit 2
fi

LINEAR_AGENT_URL="${LINEAR_AGENT_URL:-https://linear-agent.m-6bb.workers.dev}"

token="${LINEAR_AGENT_ADMIN_TOKEN:-}"
if [[ -z "$token" && -f .secrets/admin-token ]]; then
  token=$(cat .secrets/admin-token)
fi
if [[ -z "$token" ]]; then
  echo "error: LINEAR_AGENT_ADMIN_TOKEN unset and .secrets/admin-token missing" >&2
  exit 2
fi

body=$(jq -nc \
  --arg run_id "$run_id" \
  --argjson turn "$turn" \
  '{run_id:$run_id, turn:$turn, tail_bytes:32768}')

response=$(curl -fsS \
  -H "Authorization: Bearer $token" \
  -H "Content-Type: application/json" \
  -d "$body" \
  "$LINEAR_AGENT_URL/admin/sandbox/debug")

echo "$response" | jq .
