# linear-agent

Cloudflare Worker that:

1. Installs into a Linear workspace as an `actor=app` agent via OAuth.
2. Receives Linear **Agent Session** webhooks (`AgentSessionEvent`).
3. Acks Linear within its 5s/10s SLAs and posts an immediate `thought`
   activity.
4. Calls `sandbox-dispatcher`'s `/run` endpoint (HMAC-signed) to execute
   `pi` inside a Cloudflare Sandbox container.
5. Posts the result back to the session as a `response` or `error`
   activity.

This is the walking-skeleton replacement for Symphony's Elixir
`Orchestrator` + `Tracker` + `Linear.*` modules. Single-org for now;
multi-tenant config (orgs, projects, workflow defs) lands in D1 in a
later phase.

## Layout

```
src/
  index.ts                # Hono app, env types, route mounting
  routes/
    oauth.ts              # /oauth/{authorize,callback,revoke}
    webhook.ts            # /webhook (Linear AgentSessionEvent receiver)
  lib/
    oauth-helper.ts       # Linear OAuth (actor=app)
    signature.ts          # Linear webhook HMAC verification
    dispatcher.ts         # HMAC-signed client for sandbox-dispatcher
    activities.ts         # createAgentActivity wrappers (5 types)
  types/
    agent-session.ts      # AgentSessionEvent + AgentActivityContent shapes
test/
  dispatcher.test.ts      # HMAC wire-compat with Elixir + dispatcher worker
  webhook.test.ts         # signature, dedupe, routing, runSession
```

## Setup (production)

```bash
# 1. Create the KV namespace and paste the id into wrangler.jsonc.
wrangler kv namespace create LINEAR_TOKENS

# 2. Create a Linear OAuth app at
#    https://linear.app/settings/api/applications/new with:
#    - Authorization callback URL:
#        https://linear-agent.<your-subdomain>.workers.dev/oauth/callback
#    - Webhooks enabled, category: "Agent session events"
#    Note the Client ID, Client Secret, and Webhook Signing Secret.

# 3. Set secrets.
wrangler secret put LINEAR_CLIENT_ID
wrangler secret put LINEAR_CLIENT_SECRET
wrangler secret put LINEAR_WEBHOOK_SECRET
wrangler secret put DISPATCH_HMAC_SECRET   # MUST match the dispatcher worker's

# 4. Update wrangler.jsonc:
#    - URL  → your deployed origin
#    - DISPATCHER_URL → the sandbox-dispatcher origin

# 5. Deploy and apply D1 migrations.
wrangler deploy
wrangler d1 migrations apply symphony-linear-agent --remote

# 6. Seed your project(s) via the admin API:
#    curl -H "Authorization: Bearer $ADMIN_TOKEN" \
#      -H "Content-Type: application/json" \
#      -d '{"org_id":"<org-id>","linear_team_id":"<team-id>","repo_url":"https://github.com/<owner>/<repo>.git"}' \
#      https://<your-worker>/admin/projects
open https://linear-agent.<your-subdomain>.workers.dev/oauth/authorize
```

After OAuth, mention the agent or assign it an issue in Linear.

## D1 migrations

The D1 database schema lives in `migrations/`. Apply migrations with:

```bash
# Local development (uses local SQLite file, no credentials needed)
wrangler d1 migrations apply symphony-linear-agent --local

# Production (requires Cloudflare auth)
wrangler d1 migrations apply symphony-linear-agent --remote
```

Tables (v1 multi-tenant schema in `0002_multi_tenant.sql`):

| Table | Purpose |
|---|---|
| `organizations` | One row per Linear workspace install |
| `installations` | Per-org `actor=app` OAuth tokens |
| `users` | Dashboard logins with per-user `actor=user` OAuth tokens |
| `dashboard_sessions` | Session tokens mapping to users (httpOnly cookie storage) |
| `projects` | Per-team config (repo URL, branch). `engine`/`model`/`max_turns` columns still exist but the runner no longer reads them — see the resolution chain below. |
| `org_credentials` | Envelope-encrypted per-org secrets |
| `sessions` | Agent session runs with status and cost |
| `usage` | Aggregated turns/minutes per org per billing period |
| `workflows` | Trigger-fired workflow rows (engine, model, max_turns, prompt template, tool policy). See `0002_workflows.sql`. |
| `settings` | Org-scoped key/value settings. Backs the Agent tab on the dashboard. See `0004_settings.sql`. |
| `webhook_sources` | Registered inbound webhook sources such as GitHub. Each row owns a copy-once HMAC secret and powers `POST /webhook/source/:id`. |

## Engine / model / max_turns resolution

Every agent session resolves three runtime fields — `engine`, `model`,
`max_turns` — through the same precedence chain. Higher entries win.

| Source | When it applies | Notes |
|---|---|---|
| `workflow_overrides` on the runner params | Trigger-fired runs only | `dispatch-trigger.ts` snapshots `workflow.engine` / `.model` / `.max_turns` plus dispatcher-supported runtime policy (`allowed_tools`, `disallowed_tools`, `permission_mode`) from the resolved workflow row onto the session params at queue time. Frozen at dispatch — edits to the workflow row mid-run don't perturb in-flight sessions. NULL on `workflow.model` means "inherit", so dispatch-trigger omits the field in that case. |
| `settings('agent.default_engine')` / `('agent.default_model')` / `('agent.max_turns')` | All runs | Per-org overrides set via the Agent tab on the dashboard. Stored in the `settings` D1 table; one row per `(organization_id, key)`. |
| `env.DEFAULT_ENGINE` / `DEFAULT_MODEL` / `DEFAULT_MAX_TURNS` | All runs | Worker-wide floor configured in `wrangler.jsonc`. |
| Baked-in literal | Last resort | `engine = "pi"`, `model = null`, `max_turns = 10`. |

The `projects` table's `engine` / `model` / `max_turns` columns are
**not** consulted. They remain in D1 to avoid a destructive migration
but the runner ignores them; per-team customization should live on
workflow rows (the workflow editor exposes `team_id` scope) or org
settings.

Workflow CRUD accepts only runtime policy fields that the current dispatcher
request honors: `allowed_tools`, `disallowed_tools`, and `permission_mode`.
Policy-looking fields that are not wired into dispatched sessions yet
(`allowed_domains`, `mcp_servers`, `additional_read_paths`,
`additional_write_paths`, `hook_after_create`, `hook_before_remove`) are
rejected with `validation_failed` when set to a non-empty value, rather than
being stored and silently ignored.

### Settings API

```
GET    /dashboard/api/settings           → { settings: [{key,value}], agent_defaults: {...} }
PUT    /dashboard/api/settings/:key      body: { "value": "…" } → { setting: { key, value } }
DELETE /dashboard/api/settings/:key      → { ok: true } (404 when absent)
```

`agent_defaults` is derived server-side from `env.DEFAULT_*` and surfaced
so the dashboard can render "Default: X" when the org has no override.

Curated key validation (server-side):

- `agent.default_engine` — must equal `pi` or `claude` (`claude-code`
  is accepted for compatibility and normalized to `claude` at dispatch)
- `agent.default_model` — non-empty trimmed string
- `agent.max_turns` — positive integer in `[1, 100]`

Other keys (e.g. `tracker.api_key`, `proxy.enabled`, `domain`) are
accepted as-is — the Advanced tab on the dashboard exposes them
generically.

## GitHub PR trigger webhooks

GitHub sources are registered through `/api/v1/webhook-sources` (write scope) or
from the dashboard Integrations page. The create response returns a copy-once
`secret` plus an inbound URL (`/webhook/source/:id`). Configure that URL in
GitHub with `application/json` payloads and the HMAC secret; Symphony verifies
`X-Hub-Signature-256` before normalizing supported `pull_request` actions into
`github_pr` subjects:

- `opened` → `github.pr.opened`
- `closed` with `pull_request.merged === true` → `github.pr.merged`
- `closed` otherwise → `github.pr.closed`
- `review_requested` → `github.pr.review_requested`

GitHub source adapters stay source-pure: they do not parse branch names or look
up Linear issues automatically. Workflows that need cross-source context should
instruct the agent to query Linear via tools.

## Development

```bash
cp .dev.vars.example .dev.vars   # fill in real secrets
npm install
npm test                         # vitest run
npm run typecheck                # tsc --noEmit
npm run dev                      # wrangler dev → http://localhost:8788
```

**Dashboard access:** The dashboard at `/dashboard/*` requires session-based
authentication. Complete the OAuth flow at `/oauth/authorize` to log in and
create a session cookie.

To exercise webhooks against a local `wrangler dev`, expose it via a
tunnel (`cloudflared tunnel`, `ngrok`, etc.) and register the tunnel URL
as the webhook receiver in your Linear app config.

## SLA notes

Linear requires:

- **5 seconds** to ack the webhook (HTTP 2xx)
- **10 seconds** to post the first activity on a new session

`POST /webhook` honors both by:

1. Verifying signature + parsing — synchronous, fast.
2. Returning HTTP 200 immediately.
3. Posting the initial `thought` and running the dispatcher inside
   `executionCtx.waitUntil`.

The dispatcher call may take minutes (pi runs full agent turns). That is
fine for the activity timeline but Worker invocation cost / CPU limits
make this *not* a sustainable shape for production. Step 4 of the build
plan replaces the inline `runSession` body with a Cloudflare Workflow.

## Credential encryption

Per-org secrets (BYO API keys for Anthropic, OpenAI, Cloudflare Workers AI,
and custom MCP credentials) are stored in the `org_credentials` D1 table
using envelope encryption:

- A random **DEK** (AES-GCM-256) encrypts the plaintext.
- A master **KEK** (AES-GCM-256, stored in Workers Secrets) wraps the DEK.
- Both ciphertext and wrapped-DEK blobs are prefixed with a 12-byte random IV.
- The `kek_version` column tracks which KEK version was used to wrap each DEK.

Decryption happens only in `workers/linear-agent` — the dispatcher never
sees plaintext credentials.

### Setting up the KEK

Generate a 256-bit base64-encoded key and store it as a Workers secret:

```bash
# Generate a random 256-bit key
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# Store it (both dev and prod)
wrangler secret put CREDENTIAL_KEK
wrangler secret put CREDENTIAL_KEK --env production
```

### KEK rotation procedure

1. **Generate a new KEK** and note the new version number (current + 1).

2. **Store the new KEK** alongside the old one. During rollout, the worker
   must be able to decrypt rows wrapped with the old KEK. The simplest
   approach: set `CREDENTIAL_KEK` to the new key and keep the old key
   available as `CREDENTIAL_KEK_PREV` (add to `Env` when implementing
   rotation support).

3. **Re-wrap existing DEKs**: run a migration script that, for each row
   where `kek_version < new_version`:
   - Unwraps the DEK with the old KEK
   - Re-wraps the DEK with the new KEK
   - Updates `dek_ciphertext` and `kek_version` in the row
   - The plaintext and per-row DEK do **not** change — only the DEK wrapper

   ```ts
   // Pseudocode for the migration
   const rows = await db.prepare(
     "SELECT * FROM org_credentials WHERE kek_version < ?"
   ).bind(newVersion).all();

   for (const row of rows.results) {
     const dek = await unwrapDek(row.dek_ciphertext, oldKek);
     const newWrappedDek = await wrapDek(dek, newKek);
     await db.prepare(
       "UPDATE org_credentials SET dek_ciphertext = ?, kek_version = ?, updated_at = datetime('now') WHERE id = ?"
     ).bind(newWrappedDek, newVersion, row.id).run();
   }
   ```

4. **Verify**: confirm all rows now have `kek_version = new_version`.

5. **Remove the old KEK** secret once all rows are re-wrapped and the
   deploy is stable.

## Wire compat with the dispatcher

`lib/dispatcher.ts` implements the same HMAC contract as
`workers/sandbox-dispatcher/src/hmac.ts` and Elixir's
`SymphonyElixir.Cloudflare.DispatcherClient`. The pinned test vector

```
secret = "test-secret-do-not-use-in-prod"
body   = '{"scope":"alice"}'
sig    = "1628b1de2425d3d72af853cd72a18a7cdadda178157642d42411d70760b15b46"
```

is asserted in all three test suites. If any signer drifts the assertion
breaks loudly.
