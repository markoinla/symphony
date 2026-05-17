# CLAUDE.md — linear-agent

> **This is a TypeScript Cloudflare Worker, not the Elixir app.** The repo root is an
> Elixir/Phoenix codebase with its own toolchain and conventions; the root `CLAUDE.md`
> does **not** apply here (no mix, no `@spec`, no Ecto, no `WORKFLOW.md`). See the
> "Repository layout" banner in `../../CLAUDE.md` for how the two stacks relate.

## What this is

Cloudflare Worker that is the in-progress **replacement** for Symphony's Elixir
`Orchestrator` + `Tracker` + `Linear.*` modules (migration SYM-386). It installs into a
Linear workspace as an `actor=app` agent via OAuth, receives Agent Session webhooks,
acks within Linear's SLAs, and calls `sandbox-dispatcher`'s `/run` endpoint to execute
the engine inside a Cloudflare Sandbox.

## Stack

- **Runtime:** Cloudflare Workers (`nodejs_compat`), Hono HTTP framework
- **Storage:** D1 (SQLite) via Drizzle ORM; KV for OAuth tokens
- **Auth:** better-auth for the dashboard; Linear OAuth (`actor=app`) for the agent install
- **Language:** TypeScript 5.9, ESM (`"type": "module"`); Zod for request validation
- **Tests:** vitest
- **Bundled dashboard:** `dashboard/` is a separate React 19 + Vite SPA
  (`linear-agent-dashboard`) with its own `package.json` and `tsconfig`; it is built and
  embedded into the worker at deploy time.

## Commands

Run from `workers/linear-agent/`:

```bash
npm run dev         # wrangler dev
npm test            # vitest run
npm run typecheck   # tsc --noEmit
npm run build       # build dashboard + dry-run wrangler bundle into dist/
```

**Deploy via the repo-root helper, not `npm run deploy` directly** — the helper pushes
this worker and `sandbox-dispatcher` together and runs an HMAC smoke gate, which is what
keeps the shared secret from drifting:

```bash
scripts/deploy-workers.sh linear-agent     # run from repo root
```

## Layout

```
src/
  index.ts        # Hono app, Env types, route mounting
  routes/         # oauth, webhook, dashboard, github, admin, api-v1
  lib/            # oauth-helper, signature (Linear webhook HMAC), dispatcher (HMAC client), activities
  workflows/      # trigger-fired workflow definitions + dispatch
  db/             # Drizzle schema + queries
  schemas/        # Zod request/response schemas
  types/          # AgentSessionEvent / AgentActivityContent shapes
migrations/       # D1 migrations (symphony-linear-agent)
dashboard/        # embedded React SPA — own package.json, own tsconfig, own eslint
test/             # vitest suites
```

## Gotchas

- **`DISPATCH_HMAC_SECRET` is shared with `sandbox-dispatcher`.** This worker *signs*
  dispatch requests; the dispatcher *verifies* them. If the two secrets drift, every
  Linear session 401s with `invalid_signature`. Never `wrangler secret put` it on one
  worker alone — rotate with `scripts/rotate-dispatch-secret.sh` from the repo root.
- **D1 migrations:** schema changes go in `migrations/` as a new numbered `.sql` file.
  Apply with `wrangler d1 migrations apply symphony-linear-agent --local` (dev) or
  `--remote` (prod).
- **`engine` / `model` / `max_turns`** resolve through a precedence chain (workflow
  overrides → org `settings` → `wrangler.jsonc` env defaults → baked-in literals). The
  `projects` table's `engine`/`model`/`max_turns` columns are **dead** — the runner does
  not read them. Full table in `README.md`.
- Workflow CRUD only accepts runtime-policy fields the dispatcher actually honors
  (`allowed_tools`, `disallowed_tools`, `permission_mode`); other policy-looking fields
  are rejected rather than silently stored. See `README.md`.

`README.md` is the deeper reference (setup, full D1 schema, engine resolution, settings API).
