#!/usr/bin/env bash
# Smoke-test the linear-agent → sandbox-dispatcher SSE wire (HMAC + SSE
# round-trip). Hits /admin/smoke on the linear-agent, which signs a
# /run request to the dispatcher with `scope: smoke-test-no-such-scope`
# expecting a quick `error` + `result` event pair (the dispatcher 401s
# the bogus scope, but the wire works → sse_wire_ok=true).
#
# Usage:
#   LINEAR_AGENT_ADMIN_TOKEN=xxx scripts/smoke-dispatch.sh
#   scripts/smoke-dispatch.sh                          # reads .secrets/admin-token if present
#
# Exits 0 if HMAC + SSE round-trip is healthy, 1 otherwise. The exit
# code is consumable by deploy scripts as a gate.
set -euo pipefail

LINEAR_AGENT_URL="${LINEAR_AGENT_URL:-https://linear-agent.m-6bb.workers.dev}"

token="${LINEAR_AGENT_ADMIN_TOKEN:-}"
if [[ -z "$token" && -f .secrets/admin-token ]]; then
  token=$(cat .secrets/admin-token)
fi
if [[ -z "$token" ]]; then
  echo "error: LINEAR_AGENT_ADMIN_TOKEN unset and .secrets/admin-token missing" >&2
  echo "       export LINEAR_AGENT_ADMIN_TOKEN=<token>  (matches the worker's ADMIN_TOKEN secret)" >&2
  exit 2
fi

response=$(curl -fsS -H "Authorization: Bearer $token" \
  "$LINEAR_AGENT_URL/admin/smoke" 2>&1) || {
  echo "smoke FAIL: HTTP request to /admin/smoke failed" >&2
  echo "$response" >&2
  exit 1
}

ok=$(echo "$response" | jq -r '.sse_wire_ok')
err=$(echo "$response" | jq -r '.connect_error')
duration=$(echo "$response" | jq -r '.duration_ms')

if [[ "$ok" == "true" ]]; then
  echo "smoke OK (${duration}ms) — HMAC + SSE round-trip healthy"
  exit 0
fi

echo "smoke FAIL (${duration}ms)" >&2
echo "  connect_error: $err" >&2
echo "  full response:" >&2
echo "$response" | jq . >&2
if [[ "$err" == *"invalid_signature"* ]]; then
  echo "" >&2
  echo "  → DISPATCH_HMAC_SECRET drift detected. Recover with:" >&2
  echo "    scripts/rotate-dispatch-secret.sh" >&2
fi
exit 1
