#!/usr/bin/env bash
set -euo pipefail

# Activate mise so Elixir, Erlang, and Node are on PATH
eval "$("${HOME}/.local/bin/mise" activate bash)"

cd "$(dirname "$0")"

# Load environment variables from .env if present
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

mix setup
mix build

cleanup() {
  echo "Shutting down..."
  kill $VITE_PID 2>/dev/null || true
  wait $VITE_PID 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Start Vite dev server for the React dashboard
echo "Starting Vite dev server on :5173 ..."
(cd dashboard && npm run dev) &
VITE_PID=$!

echo ""
echo "Dashboard: http://localhost:5173"
echo "API:       http://localhost:4000/api/v1"
echo ""

# Start Symphony (blocks in foreground)
./bin/symphony --port 4000 WORKFLOW.md ENRICHMENT.md TRIAGE.md MENTION.md REVIEW.md EPIC_SPLITTER.md MERGING.md --i-understand-that-this-will-be-running-without-the-usual-guardrails "$@"
