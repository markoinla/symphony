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
#    - PROJECT_MAPPINGS_JSON → {"<linear-team-id>": "<repo-url>"}

# 5. Deploy and install.
wrangler deploy
open https://linear-agent.<your-subdomain>.workers.dev/oauth/authorize
```

After OAuth, mention the agent or assign it an issue in Linear.

## Development

```bash
cp .dev.vars.example .dev.vars   # fill in real secrets
npm install
npm test                         # vitest run
npm run typecheck                # tsc --noEmit
npm run dev                      # wrangler dev → http://localhost:8788
```

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
