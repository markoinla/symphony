# linear-agent

This directory is a TypeScript Cloudflare Worker, not the Elixir/Phoenix app at the repository root. Root Elixir conventions (`mix`, `@spec`, Ecto, `WORKFLOW.md` front matter) do not apply here.

`linear-agent` is the in-progress replacement for Symphony's Elixir `Orchestrator`, `Tracker`, and `Linear.*` modules (migration SYM-386). It installs into Linear as an `actor=app` agent via OAuth, receives Agent Session webhooks, acknowledges within Linear's SLAs, and calls `sandbox-dispatcher`'s `/run` endpoint to execute an engine inside a Cloudflare Sandbox.

## Stack

- Runtime: Cloudflare Workers with `nodejs_compat`, Hono HTTP framework.
- Storage: D1 (SQLite) via Drizzle ORM; KV for OAuth tokens.
- Auth: better-auth for the dashboard; Linear OAuth (`actor=app`) for agent installation.
- Language: TypeScript 5.9, ESM (`"type": "module"`), Zod for validation.
- Tests: vitest.
- Bundled dashboard: `dashboard/` is a separate React 19 + Vite SPA (`linear-agent-dashboard`) with its own `package.json`, `tsconfig`, and eslint config.

## Commands

Run from `workers/linear-agent/`:

```bash
npm run dev
npm test
npm run typecheck
npm run build
```

`npm run build` builds the dashboard and performs a dry-run Wrangler bundle into `dist/`.

Deploy from the repository root with the shared helper, not `npm run deploy` directly:

```bash
scripts/deploy-workers.sh linear-agent
```

The helper deploys this worker with `sandbox-dispatcher` coordination and runs the HMAC smoke gate that prevents shared secret drift.

## Layout

```text
src/
  index.ts        # Hono app, Env types, route mounting
  routes/         # oauth, webhook, dashboard, github, admin, api-v1
  lib/            # oauth helper, Linear signature, dispatcher HMAC client, activities
  workflows/      # trigger-fired workflow definitions + dispatch
  db/             # Drizzle schema + queries
  schemas/        # Zod request/response schemas
  types/          # AgentSessionEvent / AgentActivityContent shapes
migrations/       # D1 migrations (symphony-linear-agent)
dashboard/        # embedded React SPA
test/             # vitest suites
```

## Conventions

- Keep orchestration changes in this worker when they replace Elixir `Orchestrator`, `Tracker`, or `Linear.*` behavior.
- Keep webhook handlers fast enough to acknowledge within Linear's SLAs; push expensive execution into dispatch/background paths.
- Use Zod schemas at request/response boundaries.
- Keep D1 schema changes in `migrations/` as new numbered `.sql` files.
- Apply migrations with `wrangler d1 migrations apply symphony-linear-agent --local` for dev or `--remote` for prod.
- The `projects` table's `engine`, `model`, and `max_turns` columns are dead; runner resolution uses workflow overrides, org `settings`, `wrangler.jsonc` env defaults, then baked-in literals.
- Workflow CRUD only accepts runtime-policy fields the dispatcher honors: `allowed_tools`, `disallowed_tools`, and `permission_mode`. Reject unsupported policy-like fields instead of silently storing them.

## HMAC and Deploy Safety

`DISPATCH_HMAC_SECRET` is shared with `sandbox-dispatcher`. This worker signs dispatch requests; `sandbox-dispatcher` verifies them. If secrets drift, Linear sessions fail with `invalid_signature`.

- Never run `wrangler secret put DISPATCH_HMAC_SECRET` for this worker alone.
- Rotate with `scripts/rotate-dispatch-secret.sh` from the repository root.
- Smoke-check with `scripts/smoke-dispatch.sh` when needed.
- Use `README.md` for the deeper reference on setup, D1 schema, engine resolution, and settings API.
