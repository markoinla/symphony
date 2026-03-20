#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

mix setup
mix build
./bin/symphony --port 4000 WORKFLOW.md ENRICHMENT.md TRIAGE.md --i-understand-that-this-will-be-running-without-the-usual-guardrails "$@"
