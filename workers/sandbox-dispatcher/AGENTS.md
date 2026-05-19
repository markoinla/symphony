# sandbox-dispatcher

This directory is a TypeScript Cloudflare Worker, not the Elixir/Phoenix app at the repository root. Root Elixir conventions (`mix`, `@spec`, Ecto, `WORKFLOW.md` front matter) do not apply here.

`sandbox-dispatcher` receives HMAC-signed `/run` requests from `linear-agent`, restores an engine baseline snapshot into a fresh per-run Cloudflare Sandbox container, clones the target repository, executes the engine, streams events back to the caller, and destroys the sandbox.

## Stack

- Runtime: Cloudflare Workers, Hono HTTP framework.
- Sandboxes: `@cloudflare/sandbox` with Durable Object-backed containers.
- Storage: R2 for baseline snapshots; D1 (`engine_baselines`) for engine-to-handle mapping.
- Language: TypeScript 5.9, ESM (`"type": "module"`).
- Tests: vitest.

## Commands

Run from `workers/sandbox-dispatcher/`:

```bash
npm run dev
npm test
npm run typecheck
```

Deploy with the shared helper, not `npm run deploy` directly:

```bash
workers/scripts/deploy-workers.sh dispatcher
```

The helper deploys this worker with `linear-agent` coordination and runs the HMAC smoke gate that prevents shared secret drift.

## Layout

```text
src/
  index.ts            # Hono app + route mounting
  hmac.ts             # request signature verification
  run.ts              # /run flow: restore baseline -> clone -> execute -> destroy
  forwarder.ts        # event streaming back to caller
  baselines.ts        # baseline build / status / refresh
  baseline-alias.ts   # maps requested engine -> baseline row
  baseline-edit.ts    # interactive PTY edit sessions
  refresh.ts          # cron at 04:00 UTC to keep R2 baselines alive
  engines/            # per-engine adapters and shared types
  storage.ts          # R2 + D1 helpers
  sandbox-helpers.ts
migrations/           # D1 migrations (symphony-dispatcher)
test/                 # vitest suites
```

## Conventions

- Keep `/run` behavior isolated, deterministic, and cleanup-safe: restore baseline, clone repo, execute engine, stream events, then destroy the sandbox.
- Preserve HMAC verification on every route except `/health`, including dev.
- Keep baseline snapshots free of credentials. Per-run secrets must arrive through the `/run` request `credentials` block.
- Put D1 schema changes in `migrations/` as new numbered `.sql` files.
- All engines currently share the `pi` baseline row through `src/baseline-alias.ts`; edit that file if engines need separate snapshots.
- Prefer the existing engine adapter pattern under `src/engines/` for engine-specific behavior.

## HMAC, Baselines, and Deploy Safety

`DISPATCH_HMAC_SECRET` is shared with `linear-agent`. This worker verifies dispatch requests; `linear-agent` signs them. If secrets drift, Linear sessions fail with `invalid_signature`.

- Never run `wrangler secret put DISPATCH_HMAC_SECRET` for this worker alone.
- Rotate with `workers/scripts/rotate-dispatch-secret.sh`.
- Smoke-check with `workers/scripts/smoke-dispatch.sh` when needed.
- Deploy with `workers/scripts/deploy-workers.sh dispatcher`.

Interactive baseline editing is driven by root Elixir mix tasks:

```bash
mise exec -- mix symphony.baseline.edit --engine pi
mise exec -- mix symphony.baseline.save --engine pi
```

Use `README.md` for the deeper reference on architecture, baseline build procedure, and deploy.
