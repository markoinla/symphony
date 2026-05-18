# sandbox-dispatcher

Cloudflare Worker that owns the Symphony agent-runtime sandbox pool. It
exposes a small HTTPS API (HMAC-signed, JSON) that the linear-agent
Worker calls to acquire per-issue ephemeral sandboxes, restore a baseline
engine snapshot, inject per-tenant credentials, and run agents inside.

## Architecture

```
linear-agent ──HTTPS+HMAC──▶ sandbox-dispatcher ──▶ @cloudflare/sandbox
                                      │                       │
                                      ├── R2: BACKUP_BUCKET   ▼
                                      │   (baseline snapshots  Sandbox DO
                                      │    per engine)         ─────────
                                      │                        Container
                                      └── D1: DB               (pi, codex,
                                          engine_baselines      claude,
                                          (engine → handle)     git, jq…)
```

### Baseline snapshot model

Each supported engine (pi, codex, claude) has exactly one baseline snapshot
stored in R2 + D1. Baselines contain the engine binary and base toolchain
(git, gh CLI, jq) but **no credentials**. Per-tenant secrets arrive on every
`/run` request via the `credentials` block.

### Per-issue `/run` flow

1. Look up the baseline snapshot for the requested `engine`.
2. Restore baseline into a fresh per-issue sandbox.
3. Clone repo using the `GITHUB_TOKEN`-authed URL from `credentials`.
4. Write per-tenant env vars + MCP config from `credentials`.
5. Execute the engine command. For `engine: "pi"`, optional `thinking_level` values (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`) are passed as `pi --thinking <level>`.
6. Destroy the sandbox.

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
wrangler secret put DISPATCH_HMAC_SECRET     # shared with linear-agent for request signing
wrangler secret put R2_ACCESS_KEY_ID         # R2 S3-compatible access key
wrangler secret put R2_SECRET_ACCESS_KEY     # R2 S3-compatible secret key
wrangler secret put CLOUDFLARE_ACCOUNT_ID    # for R2 endpoint construction
wrangler secret put BACKUP_BUCKET_NAME       # informational; matches R2 bucket above
```

Dev (append `--env dev` to each).

### 4. Deploy and verify

```bash
npm install
npm test               # vitest
npm run deploy
curl https://sandbox.marko.la/health
# → {"ok":true,"sandbox_class":"standard-2"}
```

## Baseline build procedure

Before the first `/run`, build a baseline snapshot for each engine. The
`POST /baselines/build` route installs the engine + toolchain in a
sandbox and snapshots the result.

### Using curl

```bash
SECRET="$(cat /tmp/dispatcher-secret)"
URL="https://sandbox.marko.la"

# Build baseline for pi
BODY='{"engine":"pi"}'
SIG="$(printf %s "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')"
curl -X POST "$URL/baselines/build" \
  -H "Content-Type: application/json" \
  -H "X-Symphony-Signature: $SIG" \
  -d "$BODY"
# → {"ok":true,"engine":"pi","version":null,"baseline_id":"…","created_at":…}
```

Supported engines: `pi`, `codex`, `claude`.

Optionally pass `"version": "1.2.3"` to tag the baseline with a version.

### Check baseline status

```bash
BODY=''
SIG="$(printf %s "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')"
curl "$URL/baselines/pi" \
  -H "X-Symphony-Signature: $SIG"
# → {"exists":true,"engine":"pi","baseline_id":"…","version":null,…}

# List all baselines
curl "$URL/baselines" \
  -H "X-Symphony-Signature: $SIG"
```

### Rebuild on engine version bumps

When a new engine version is released, rebuild the baseline:

```bash
BODY='{"engine":"pi","version":"2.0.0"}'
SIG="$(printf %s "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')"
curl -X POST "$URL/baselines/build" \
  -H "Content-Type: application/json" \
  -H "X-Symphony-Signature: $SIG" \
  -d "$BODY"
```

The old baseline is replaced atomically in D1; the orphaned R2 object
expires on the 14-day lifecycle rule.

### Baseline refresh (R2 retention)

R2's lifecycle rule GCs objects after 14 days. A daily cron (04:00 UTC)
refreshes any baseline older than 5 days to keep it alive. Manual trigger:

```bash
BODY='{"force":true}'
SIG="$(printf %s "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | awk '{print $2}')"
curl -X POST "$URL/baselines/refresh" \
  -H "Content-Type: application/json" \
  -H "X-Symphony-Signature: $SIG" \
  -d "$BODY"
```

## Local development

```bash
npm install
npm run dev   # boots wrangler dev on http://localhost:8787
curl http://localhost:8787/health
```

The HMAC middleware is enforced in dev too (everything except `/health`).

## Tests

```bash
npm test          # vitest run
npm run typecheck # tsc --noEmit
```
