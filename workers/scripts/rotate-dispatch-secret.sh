#!/usr/bin/env bash
# Rotate DISPATCH_HMAC_SECRET on both Workers atomically and verify the
# wire still works.
#
# This is the ONLY supported way to change the dispatcher secret. Doing
# it manually is how we drift: `wrangler secret put` on one worker but
# not the other, or without `--env=""` (which silently targets the
# wrong env when wrangler.jsonc has multiple envs), produces a 401
# `invalid_signature` storm that's invisible until a real run hits it.
# See workers/docs/cloudflare_sandbox_integration.md:486-501 for the
# full postmortem.
#
# Usage:
#   workers/scripts/rotate-dispatch-secret.sh                  # generates a fresh 32-byte hex secret
#   workers/scripts/rotate-dispatch-secret.sh "<known value>"  # use an explicit value (e.g. matching a non-Worker consumer)
#
# After success this script also runs workers/scripts/smoke-dispatch.sh
# as a gate. If the smoke fails, you have a drifted state — re-run the
# rotation, don't deploy.
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
workers_root="$(cd "$script_dir/.." && pwd)"

if [[ $# -gt 1 ]]; then
  echo "usage: $0 [secret_value]" >&2
  exit 2
fi

if [[ $# -eq 1 ]]; then
  secret="$1"
  echo "Using provided secret value (last 4 chars: …${secret: -4})"
else
  secret=$(openssl rand -hex 32)
  echo "Generated new secret (last 4 chars: …${secret: -4})"
fi

set_on() {
  local name="$1"
  local dir="$workers_root/$name"
  echo "  → setting on $name ($dir)"
  ( cd "$dir" && echo "$secret" | npx --no-install wrangler secret put DISPATCH_HMAC_SECRET --env="" ) >/dev/null
}

set_on sandbox-dispatcher
set_on linear-agent

echo ""
echo "Both workers updated. Running smoke check…"
echo ""

# Cloudflare's secret store is eventually consistent across the edge —
# give it a moment before we validate.
sleep 3

if "$script_dir/smoke-dispatch.sh"; then
  echo ""
  echo "✓ rotation complete and verified"
  exit 0
fi

echo ""
echo "✗ rotation set both secrets but smoke FAILED" >&2
echo "  Either the secret-store propagation needs longer, or one of the" >&2
echo "  put calls silently no-op'd. Wait 30s and re-run" >&2
echo "  workers/scripts/smoke-dispatch.sh; if still failing, re-run this script." >&2
exit 1
