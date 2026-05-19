# CLAUDE.md — sandbox-dispatcher

> **This is a TypeScript Cloudflare Worker, not the Elixir app.** The repo root is an
> Elixir/Phoenix codebase with its own toolchain and conventions; the root `CLAUDE.md`
> does **not** apply here. See the "Repository layout" banner in `../CLAUDE.md`.

## What this is

Cloudflare Worker that receives HMAC-signed `/run` requests from `linear-agent`, restores
an engine baseline snapshot into a fresh per-run Cloudflare Sandbox container, clones the
target repo, executes the engine, streams events back to the caller, and destroys the
sandbox.

## Stack

- **Runtime:** Cloudflare Workers, Hono HTTP framework
- **Sandboxes:** `@cloudflare/sandbox` (Durable Object-backed containers)
- **Storage:** R2 for baseline snapshots; D1 (`engine_baselines`) for engine→handle mapping
- **Language:** TypeScript 5.9, ESM (`"type": "module"`)
- **Tests:** vitest

## Commands

Run from `workers/sandbox-dispatcher/`:

```bash
npm run dev         # wrangler dev → http://localhost:8787
npm test            # vitest run
npm run typecheck   # tsc --noEmit
```

**Deploy via the shared helper, not `npm run deploy` directly** — the helper pushes
this worker and `linear-agent` together and runs an HMAC smoke gate, which is what keeps
the shared secret from drifting:

```bash
workers/scripts/deploy-workers.sh dispatcher
```

## Layout

```
src/
  index.ts            # Hono app + route mounting
  hmac.ts             # request signature verification
  run.ts              # /run flow: restore baseline → clone → execute → destroy
  forwarder.ts        # event streaming back to the caller
  baselines.ts        # baseline build / status / refresh
  baseline-alias.ts   # maps requested engine → baseline row (all engines share `pi` today)
  baseline-edit.ts    # interactive PTY edit sessions
  refresh.ts          # cron (04:00 UTC): keep R2 baselines alive past the 14-day GC
  engines/            # per-engine adapters (pi, claude) + shared types
  storage.ts          # R2 + D1 helpers
  sandbox-helpers.ts
migrations/           # D1 migrations (symphony-dispatcher)
test/                 # vitest suites
```

## Gotchas

- **`DISPATCH_HMAC_SECRET` is shared with `linear-agent`.** This worker *verifies*
  signatures; the agent *signs*. If the two secrets drift, every Linear session 401s with
  `invalid_signature`. Never `wrangler secret put` it on one worker alone — rotate with
  `workers/scripts/rotate-dispatch-secret.sh`.
- HMAC is enforced in dev too — every route except `/health` requires a valid signature.
- Baseline snapshots hold engine binaries + base toolchain (git, gh, jq) but **no
  credentials**; per-run secrets arrive in the `/run` request's `credentials` block.
- Editing a baseline interactively is driven by the Elixir mix tasks
  `mix symphony.baseline.edit` / `.save` from the repo root — see the root `CLAUDE.md`
  section "Editing an engine baseline snapshot".

`README.md` is the deeper reference (architecture, baseline build procedure, deploy).
