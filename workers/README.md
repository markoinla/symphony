# Symphony Workers

Cloudflare-side stack for Symphony — a small set of independent TypeScript Workers
deployed via Wrangler.

| Worker | Purpose |
| --- | --- |
| [`linear-agent/`](linear-agent/) | Hono Worker terminating Linear Agent Session + Issue webhooks; drives engine runs via a Cloudflare Workflow and HMAC-signs requests to `sandbox-dispatcher`. |
| [`sandbox-dispatcher/`](sandbox-dispatcher/) | Hono Worker receiving HMAC-signed `/run` requests; restores an engine baseline into a fresh Cloudflare Sandbox, executes the engine, streams events back, tears the sandbox down. |

`linear-agent` and `sandbox-dispatcher` form an HMAC pair sharing
`DISPATCH_HMAC_SECRET` — always deploy / rotate them together via
[`scripts/deploy-workers.sh`](scripts/deploy-workers.sh) and
[`scripts/rotate-dispatch-secret.sh`](scripts/rotate-dispatch-secret.sh).

## Per-worker docs

- [`linear-agent/README.md`](linear-agent/README.md) · [`CLAUDE.md`](linear-agent/CLAUDE.md) · [`AGENTS.md`](linear-agent/AGENTS.md)
- [`sandbox-dispatcher/README.md`](sandbox-dispatcher/README.md) · [`CLAUDE.md`](sandbox-dispatcher/CLAUDE.md) · [`AGENTS.md`](sandbox-dispatcher/AGENTS.md)

## Architecture docs

- [`docs/cloudflare_sandbox_integration.md`](docs/cloudflare_sandbox_integration.md)
- [`docs/linear_agent_api_v1.md`](docs/linear_agent_api_v1.md)
- [`docs/architecture.html`](docs/architecture.html) (rendered from `architecture.json`)

## Repository status

This tree currently lives inside the Symphony Elixir monorepo
(`markoinla/symphony`). It is structured so that everything needed to operate the
workers — code, scripts, CI, docs — sits under this directory. The standalone
split is planned per [`docs/EXTRACTION.md`](docs/EXTRACTION.md).
