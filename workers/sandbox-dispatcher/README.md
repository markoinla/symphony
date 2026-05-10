# sandbox-dispatcher

Cloudflare Worker that owns the Symphony agent-runtime sandbox pool. It
exposes a small HTTPS API (HMAC-signed, JSON) that Symphony's
`Worker.Backend.CloudflareSandbox` Elixir backend (added in Phase 5) calls
to acquire per-issue ephemeral sandboxes, restore the auth snapshot, and
run agents inside.

> **Status:** Phase 3. The dispatcher exposes `/health` plus the
> `POST /auth/bootstrap`, `POST /auth/snapshot`, `GET /auth/snapshot`,
> and `DELETE /auth/snapshot` routes. `/run` lands in Phase 4 and the
> cron snapshot refresh in Phase 6.

## Architecture

```
Symphony (Elixir) ──HTTPS+HMAC──▶ sandbox-dispatcher ──▶ @cloudflare/sandbox
                                          │                       │
                                          ├── R2: BACKUP_BUCKET   ▼
                                          │   (DirectoryBackup    Sandbox DO
                                          │    snapshots of       ─────────
                                          │    /home/node)         Container
                                          │                        (codex,
                                          └── D1: DB                 claude,
                                              auth_backups           gh, …)
                                              (scope → handle)
```

Per-issue sandboxes are addressed as `getSandbox(env.Sandbox, "issue:" + id)`.
Each sandbox restores its auth state from a `DirectoryBackup` keyed by `scope`
(`"<user_id>"` or `"<user_id>:<project_id>"`) before the agent starts.

## Deploy

You need a Cloudflare account with Workers Containers enabled.

### 1. Create the R2 bucket

```bash
wrangler r2 bucket create symphony-sandbox-backups
# For dev:
wrangler r2 bucket create symphony-sandbox-backups-dev
```

### 2. Create the D1 database

```bash
wrangler d1 create symphony-dispatcher
# Copy the printed `database_id` into wrangler.jsonc → d1_databases[0].database_id
wrangler d1 migrations apply symphony-dispatcher
```

For dev:

```bash
wrangler d1 create symphony-dispatcher-dev
# Copy the printed `database_id` into env.dev.d1_databases[0].database_id
wrangler d1 migrations apply symphony-dispatcher-dev --env dev
```

### 3. Set the secrets

Production:

```bash
wrangler secret put DISPATCH_HMAC_SECRET     # shared with Symphony for request signing
wrangler secret put R2_ACCESS_KEY_ID         # R2 S3-compatible access key
wrangler secret put R2_SECRET_ACCESS_KEY     # R2 S3-compatible secret key
wrangler secret put CLOUDFLARE_ACCOUNT_ID    # for R2 endpoint construction
wrangler secret put BACKUP_BUCKET_NAME       # informational; matches R2 bucket above
```

Dev (append `--env dev` to each):

```bash
wrangler secret put DISPATCH_HMAC_SECRET --env dev
# … etc
```

The `DISPATCH_HMAC_SECRET` is the only secret Symphony itself uses; the others
are for the dispatcher's own R2 inspection paths (snapshot refresh, Phase 6).

### 4. Deploy and verify

```bash
npm install
npm test               # vitest — exercises the HMAC middleware
npm run build          # wrangler deploy --dry-run
npm run deploy         # → https://sandbox-dispatcher.<account>.workers.dev
curl https://sandbox-dispatcher.<account>.workers.dev/health
# → {"ok":true,"sandbox_class":"standard-2"}
```

After the first deploy, confirm the container image built:

```bash
wrangler containers list
```

## Auth bootstrap flow

To capture an auth snapshot you log into each CLI inside a one-shot sandbox,
then ask the dispatcher to persist `/home/node` as a `DirectoryBackup` in
R2 (handle stored in D1).

The easiest way to drive the flow is the Symphony Mix tasks (run from the
Symphony repo, with `SYMPHONY_DISPATCHER_URL` and
`SYMPHONY_DISPATCHER_HMAC_SECRET` set in your environment):

```bash
# 1) Boot a bootstrap sandbox + ttyd PTY for `scope=alice`.
mix symphony.auth.bootstrap --scope alice
# Prints a one-time pty_url like:
#   https://7681-bootstrap-alice-<random>.<dispatcher-host>

# 2) Open the pty_url in a browser, then inside the PTY run:
#      claude login
#      codex auth login
#      gh auth login
#    The CLIs write tokens into ~/.claude, ~/.codex, ~/.config/gh — all
#    under /home/node, which is what the snapshot will capture.

# 3) Persist the snapshot and tear the bootstrap sandbox down.
mix symphony.auth.snapshot --scope alice
# Prints {"ok":true,"backup_id":"…","scope":"alice","created_at":…}.
```

Inspect or remove a snapshot:

```bash
mix symphony.auth.snapshot --scope alice --check     # GET /auth/snapshot
mix symphony.auth.snapshot --scope alice --delete    # DELETE /auth/snapshot
```

Without the Mix task, you can also drive the same flow with `curl`:

```bash
SECRET="$(cat /tmp/dispatcher-secret)"
URL="https://sandbox-dispatcher.<account>.workers.dev"

# Bootstrap.
BODY='{"scope":"alice"}'
SIG="$(printf %s "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')"
curl -X POST "$URL/auth/bootstrap" \
  -H "Content-Type: application/json" \
  -H "X-Symphony-Signature: $SIG" \
  -d "$BODY"

# (open pty_url in a browser, do the logins, then …)

# Snapshot.
curl -X POST "$URL/auth/snapshot" \
  -H "Content-Type: application/json" \
  -H "X-Symphony-Signature: $SIG" \
  -d "$BODY"
```

`scope` is opaque — Symphony chooses the granularity. Use `<user_id>` for
shared per-user credentials or `<user_id>:<project_id>` if a project needs
its own isolated snapshot.

## Local development

```bash
npm install
npm run dev   # boots wrangler dev on http://localhost:8787
curl http://localhost:8787/health
```

The HMAC middleware is enforced in `npm run dev` too (everything except
`/health` requires `X-Symphony-Signature`). To exercise a signed request
locally, compute the signature with the same secret you configured via
`wrangler secret put`:

```bash
SECRET="$(cat /tmp/local-secret)"
BODY='{"scope":"alice"}'
SIG="$(printf %s "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')"
curl -X POST http://localhost:8787/auth/bootstrap \
  -H "Content-Type: application/json" \
  -H "X-Symphony-Signature: $SIG" \
  -d "$BODY"
# (Will 404 until Phase 3 lands /auth/bootstrap.)
```

## Tests

```bash
npm test          # vitest run
npm run typecheck # tsc --noEmit
```

Vitest only covers the HMAC middleware and other pure-TS pieces today.
Integration coverage (real `getSandbox()` flows, `restoreBackup`, `/run`
end-to-end) is added in Phase 4.
