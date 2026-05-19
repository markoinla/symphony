#!/usr/bin/env bash
# Fetch an ADMIN_TOKEN-gated linear-agent session debug payload.
#
# Usage:
#   workers/scripts/debug-session.sh <session-id>
#   LINEAR_AGENT_URL=https://... LINEAR_AGENT_ADMIN_TOKEN=... workers/scripts/debug-session.sh <session-id>
set -euo pipefail

session_id="${1:-}"
if [[ -z "$session_id" ]]; then
  echo "usage: workers/scripts/debug-session.sh <session-id>" >&2
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

response=$(curl -fsS \
  -H "Authorization: Bearer $token" \
  "$LINEAR_AGENT_URL/admin/sessions/$session_id/debug")

if command -v jq >/dev/null 2>&1; then
  echo "$response" | jq .
else
  echo "$response"
fi
