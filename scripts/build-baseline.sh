#!/usr/bin/env bash
# Build a baseline-per-engine snapshot for the sandbox-dispatcher.
#
# SYM-268 retires per-tenant snapshots (which carried CLI auth state)
# in favor of one binaries-only snapshot per engine. Every tenant's
# /run restores the same baseline; credentials arrive in the request
# body and are injected as env vars at exec time.
#
# Usage:
#   scripts/build-baseline.sh pi
#   scripts/build-baseline.sh codex      # future engines
#
# Required env:
#   DISPATCH_HMAC_SECRET  shared secret with the dispatcher (must match
#                         `wrangler secret get DISPATCH_HMAC_SECRET`).
# Optional env:
#   DISPATCHER_URL        defaults to https://sandbox.marko.la
#
# The script:
#   1. POSTs /auth/bootstrap { scope: "baseline-<engine>" } — gets PTY URL.
#   2. Prints the PTY URL for the operator to open in a browser.
#   3. Operator installs the engine binary inside the PTY (no auth!),
#      e.g. for pi:  `npm install -g @anthropic-ai/pi-cli` (or whatever
#      the upstream install command is at the time you run this).
#   4. Operator hits Enter on the terminal running this script.
#   5. POSTs /auth/snapshot { scope: "baseline-<engine>" } — captures
#      the filesystem state.
#
# Re-run when the engine version bumps. The snapshot's R2 lifecycle
# rule will GC the old object once it ages past 14 days; the daily
# cron refresh job keeps the baseline alive until then.

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <engine>" >&2
  echo "       $0 pi" >&2
  exit 2
fi
engine="$1"
case "$engine" in
  pi|codex|claude) ;;
  *)
    echo "error: unknown engine '$engine' (expected pi|codex|claude)" >&2
    exit 2
    ;;
esac

if [[ -z "${DISPATCH_HMAC_SECRET:-}" ]]; then
  if [[ -f .secrets/dispatch-hmac-secret ]]; then
    DISPATCH_HMAC_SECRET=$(cat .secrets/dispatch-hmac-secret)
  else
    echo "error: DISPATCH_HMAC_SECRET unset and .secrets/dispatch-hmac-secret missing" >&2
    exit 2
  fi
fi
DISPATCHER_URL="${DISPATCHER_URL:-https://sandbox.marko.la}"

scope="baseline-${engine}"

sign_body() {
  local body="$1"
  printf '%s' "$body" | openssl dgst -sha256 -hmac "$DISPATCH_HMAC_SECRET" -hex | awk '{print $NF}'
}

post_signed() {
  local path="$1"
  local body="$2"
  local sig
  sig=$(sign_body "$body")
  curl -fsS -X POST \
    -H "Content-Type: application/json" \
    -H "X-Symphony-Signature: $sig" \
    -d "$body" \
    "${DISPATCHER_URL}${path}"
}

echo "==> bootstrap PTY for scope=$scope"
bootstrap_body="$(printf '{"scope":"%s"}' "$scope")"
bootstrap_resp=$(post_signed "/auth/bootstrap" "$bootstrap_body")
pty_url=$(echo "$bootstrap_resp" | jq -r '.pty_url')
expires_at=$(echo "$bootstrap_resp" | jq -r '.expires_at')

cat <<EOF

  PTY URL:    $pty_url
  Expires:    $expires_at

  Open the URL above in a browser and install the $engine binary.
  Examples (run these as appropriate for the engine):
    pi:     npm install -g @anthropic-ai/pi-cli       # check upstream docs for current name
    codex:  npm install -g @openai/codex-cli
    claude: npm install -g @anthropic-ai/claude-cli

  DO NOT run any auth commands (claude login / gh auth login / codex
  auth login). Baseline snapshots are binaries-only — credentials are
  injected per /run in the request body.

EOF
read -rp "Press Enter when you're done installing the binary (and have closed the PTY tab)... " _

echo "==> snapshot scope=$scope"
snapshot_body="$(printf '{"scope":"%s"}' "$scope")"
snapshot_resp=$(post_signed "/auth/snapshot" "$snapshot_body")
echo "$snapshot_resp" | jq .

echo
echo "baseline-${engine} snapshot built. /run lookups for engine=${engine}"
echo "will now resolve via scope='baseline-${engine}' until 14d expiry."
echo "Schedule a re-run on engine version bumps; the daily cron job"
echo "(triggers.crons in workers/sandbox-dispatcher/wrangler.jsonc)"
echo "refreshes existing snapshots before they age out."
