# CLAUDE.md — oauth-proxy

> **This is a TypeScript Cloudflare Worker, not the Elixir app.** The root `CLAUDE.md`
> (Elixir/Phoenix conventions) does **not** apply here. See the "Repository layout"
> banner in `../../CLAUDE.md`.

## What this is

Small Cloudflare Worker that brokers OAuth for Linear and GitHub on behalf of registered
Symphony instances. It holds the OAuth client secrets centrally so self-hosted instances
never need them, and stores pending PKCE challenges and issued tokens in KV.

## Stack

- **Runtime:** Cloudflare Workers
- **Storage:** KV (`OAUTH_KV`)
- **Language:** TypeScript 5.9, ESM (`"type": "module"`)
- Single file: `src/index.ts`. No build step, no test suite.

## Commands

Run from `workers/oauth-proxy/`:

```bash
npm run dev         # wrangler dev
npm run typecheck   # tsc --noEmit
```

Config lives in `wrangler.toml` — note `.toml`, unlike the other two workers' `.jsonc`.
Secrets (`wrangler secret put`): `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`,
`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `LINEAR_WEBHOOK_SIGNING_SECRET`,
`REGISTRATION_SECRET`. A `dev` environment (`oauth-proxy-dev`) is defined for
`--env dev`.

## Note

This worker is **not** part of the `linear-agent` ↔ `sandbox-dispatcher` HMAC pair — it
does not use `DISPATCH_HMAC_SECRET`. `scripts/deploy-workers.sh` does not cover it;
deploy with `wrangler deploy` from this directory.
