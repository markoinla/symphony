# CLAUDE.md — workers monorepo

> **Repository layout.** This tree contains the Cloudflare-side stack: a small set of
> TypeScript Workers deployed via Wrangler. Each worker is independent (own
> `package.json`, `package-lock.json`, `tsconfig.json`, `wrangler.*`, tests). They
> communicate over HTTP; there is no shared library between them.
>
> While this tree lives inside the Symphony Elixir repo today, it is structured to
> stand on its own. The intended split is documented in
> [`docs/EXTRACTION.md`](docs/EXTRACTION.md). When that split happens, this file
> becomes the new repo's root `CLAUDE.md`; everything below already assumes that
> framing.

## Workers

- [`linear-agent/`](linear-agent/CLAUDE.md) — Hono Worker that terminates Linear
  Agent Session + Issue webhooks, drives long-running engine runs via a Cloudflare
  Workflow (`SessionRunner`), and HMAC-signs requests to `sandbox-dispatcher`.
  Replacement for the Symphony Elixir `Orchestrator` + `Tracker` + `Linear.*`
  modules (migration SYM-386).
- [`sandbox-dispatcher/`](sandbox-dispatcher/CLAUDE.md) — Hono Worker that receives
  HMAC-signed `/run` requests from `linear-agent`, restores an engine baseline
  snapshot into a fresh per-run Cloudflare Sandbox, clones the target repo, runs
  the engine, streams events back, and tears the sandbox down.

`linear-agent` and `sandbox-dispatcher` form an HMAC-signed pair sharing
`DISPATCH_HMAC_SECRET`. They must be deployed and rotated together — see ops
scripts below.

## Ops scripts

All under [`scripts/`](scripts/). They resolve worker dirs relative to themselves,
so the working directory you invoke them from does not matter for locating worker
code. The `.secrets/admin-token` lookup is still CWD-relative — keep your token
at the same root you invoke from.

```bash
scripts/deploy-workers.sh                 # deploy both + smoke gate (use instead of `npm run deploy`)
scripts/deploy-workers.sh dispatcher      # just sandbox-dispatcher
scripts/deploy-workers.sh linear-agent    # just linear-agent
scripts/rotate-dispatch-secret.sh         # recover from a 401 storm (rotates + verifies)
scripts/smoke-dispatch.sh                 # standalone HMAC + SSE wire check
scripts/debug-session.sh <session-id>     # fetch linear-agent session row + event timeline
scripts/debug-sandbox.sh <run-id> [turn]  # inspect dispatcher sandbox/process/log tail
```

The smoke / debug scripts need the linear-agent's `ADMIN_TOKEN`. Either
`export LINEAR_AGENT_ADMIN_TOKEN=…` or write it to `.secrets/admin-token`
(gitignored). Without it the smoke step in deploys skips with a warning rather
than failing the deploy.

Full failure-mode postmortem for `DISPATCH_HMAC_SECRET` drift:
[`docs/cloudflare_sandbox_integration.md`](docs/cloudflare_sandbox_integration.md).

## Docs

- [`docs/cloudflare_sandbox_integration.md`](docs/cloudflare_sandbox_integration.md)
  — sandbox-dispatcher architecture, ops, and failure modes.
- [`docs/linear_agent_api_v1.md`](docs/linear_agent_api_v1.md) — linear-agent
  external API contract.
- [`docs/architecture.json`](docs/architecture.json) /
  [`architecture.html`](docs/architecture.html) — full architectural map of
  `linear-agent`.
- [`docs/EXTRACTION.md`](docs/EXTRACTION.md) — how this tree was carved out of
  the Symphony monorepo / how to extract it again.

## Relationship to the Symphony Elixir app

While this tree still lives inside `markoinla/symphony`, the Elixir app under the
parent repo root only talks to these workers over HTTP:

- `SymphonyElixir.Cloudflare.DispatcherClient` → `sandbox-dispatcher` (HMAC-signed
  POST `/run` etc.)
- `SymphonyElixir.ProxyClient` → the sibling `workers/oauth-proxy` Worker (OAuth
  brokering — **not part of this split**; oauth-proxy stays with the Elixir app)
- `linear-agent` is what Symphony Elixir's orchestrator is being replaced by, so
  there is no production caller from Elixir into `linear-agent`.

No worker imports from outside its own directory. The cross-stack contract is
the HMAC algorithm in `sandbox-dispatcher/src/hmac.ts` (mirrored on the Elixir
side in `lib/symphony_elixir/cloudflare/dispatcher_client.ex`).
