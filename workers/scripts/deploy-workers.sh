#!/usr/bin/env bash
# Deploy one or both Cloudflare Workers and gate on a post-deploy smoke
# check. Use this instead of `npm run deploy` directly — it catches the
# documented failure mode where a deploy that touches wrangler.jsonc
# triggers/bindings can silently invalidate DISPATCH_HMAC_SECRET on
# prod (see workers/docs/cloudflare_sandbox_integration.md:486-501).
#
# Usage:
#   workers/scripts/deploy-workers.sh                  # deploys both workers
#   workers/scripts/deploy-workers.sh dispatcher       # just sandbox-dispatcher
#   workers/scripts/deploy-workers.sh linear-agent     # just linear-agent
#   workers/scripts/deploy-workers.sh both             # explicit "both" (same as no arg)
#
# Exit codes:
#   0   deploys + smoke succeeded
#   1   a deploy or the smoke failed
#   2   bad arguments
set -euo pipefail

script_dir="$(cd "$(dirname "$0")" && pwd)"
workers_root="$(cd "$script_dir/.." && pwd)"

target="${1:-both}"

deploy_dispatcher() {
  echo "─── deploying sandbox-dispatcher ───"
  ( cd "$workers_root/sandbox-dispatcher" && npm run deploy )
}

deploy_linear_agent() {
  echo "─── deploying linear-agent ───"
  ( cd "$workers_root/linear-agent" && npm run deploy )
}

case "$target" in
  dispatcher)
    deploy_dispatcher
    ;;
  linear-agent)
    deploy_linear_agent
    ;;
  both|"")
    deploy_dispatcher
    deploy_linear_agent
    ;;
  *)
    echo "usage: $0 [dispatcher|linear-agent|both]" >&2
    exit 2
    ;;
esac

echo ""
echo "─── post-deploy smoke check ───"
# Edge propagation is eventually consistent; give the new code a moment
# before validating.
sleep 5

if "$script_dir/smoke-dispatch.sh"; then
  echo ""
  echo "✓ deploy(s) complete and HMAC + SSE wire verified"
  exit 0
fi

echo ""
echo "✗ deploy completed but post-deploy smoke FAILED" >&2
echo "  Inspect the smoke output above. If connect_error mentions" >&2
echo "  invalid_signature, it's the wrangler-resets-secret bug —" >&2
echo "  recover with:  workers/scripts/rotate-dispatch-secret.sh" >&2
exit 1
