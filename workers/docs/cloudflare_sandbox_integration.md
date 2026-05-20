# Cloudflare Sandbox integration — handoff notes

A working doc for whoever picks up the multi-phase Cloudflare Sandbox
integration after Phase 3. Captures decisions, surprises, and gotchas
that aren't already in the original build plan.

> **Where the plan lives:** the original phased build plan is in the
> conversation that produced PR
> [`markoinla/symphony#136`](https://github.com/markoinla/symphony/pull/136),
> branch `claude/cloudflare-sandbox-integration-7HHFs`. Read it before
> Phase 4. This file is a *delta* on top of that plan.

## Status

| Phase | Status   | Lands |
| ----- | -------- | ----- |
| 1. Pluggable `Worker.Backend` behaviour (Elixir)             | ✅ shipped | `1a76c32`, `230c023` (review fixes) |
| 2. `sandbox-dispatcher` Worker scaffold + `/health` + HMAC   | ✅ shipped | `9f79a7e` |
| 3. `/auth/bootstrap` + `/auth/snapshot` routes + Mix tasks   | ✅ shipped + validated end-to-end on `sandbox.marko.la` (2026-05-10) | `592d963`, this branch |
| 4. `/run` route (engine: `pi`)                               | ✅ scaffolded — pending smoke test | this branch |
| 4b. `workers/linear-agent` (Linear OAuth + webhook + Activity SDK) | ✅ scaffolded | this branch |
| 5. `Worker.Backend.CloudflareSandbox` Elixir impl            | pending — may be skipped if we go fully Worker-driven | — |
| 6. Cron snapshot refresh                                     | ✅ shipped — daily cron + `/auth/refresh` admin route, validated on prod | this branch |
| 7. Cloudflare Workflow per agent session                     | pending — replaces inline `runSession` in linear-agent | — |
| 8. D1 multi-tenant schema (orgs/projects/workflows)          | pending    | — |

All commits are on PR #136 against `main`.

## Where everything lives

| Concern                             | Path |
| ----------------------------------- | ---- |
| Backend behaviour + Lease           | `lib/symphony_elixir/worker/{backend,backend/local,backend/ssh_static,lease}.ex` |
| Backend tests                       | `test/symphony_elixir/worker/` |
| Worker (TypeScript)                 | `workers/sandbox-dispatcher/src/` |
| Worker tests                        | `workers/sandbox-dispatcher/test/` |
| HTTP client (HMAC signer)           | `lib/symphony_elixir/cloudflare/dispatcher_client.ex` |
| Mix tasks                           | `lib/mix/tasks/symphony.auth.{bootstrap,snapshot}.ex` |
| D1 schema                           | `workers/sandbox-dispatcher/migrations/0001_init.sql` |
| Container image                     | `docker.io/cloudflare/sandbox:0.10.0` (referenced directly in `wrangler.jsonc`; **no local Dockerfile** — see gotcha "Direct Docker Hub image" below) |
| Wrangler config                     | `workers/sandbox-dispatcher/wrangler.jsonc` |
| Workflow config                     | `WORKFLOW.md` front matter (`worker.backend` field) |

## Pre-flight before any deploy works

Once per environment. **Five steps**: R2 bucket, D1 database, secrets,
custom domain + ACM cert, deploy. The first three are wrangler. The
fourth is dashboard / Cloudflare API — `.workers.dev` cannot host the
sandbox preview URLs at all (see "Custom domain + ACM" gotcha below).

```bash
# 1. R2 bucket + D1 database (production)
cd workers/sandbox-dispatcher
npx wrangler r2 bucket create symphony-sandbox-backups
npx wrangler d1 create symphony-dispatcher
# → paste the printed database_id into wrangler.jsonc top-level
#   d1_databases[0].database_id
npx wrangler d1 migrations apply symphony-dispatcher --remote

# 2. Five secrets (use --env="" if you've defined env.dev — without it,
#    wrangler warns and you may target the wrong env. Verify with
#    `wrangler secret list`.)
HMAC=$(openssl rand -hex 32)
echo "$HMAC" | npx wrangler secret put DISPATCH_HMAC_SECRET
echo "$HMAC"  # ← stash this; Symphony's SYMPHONY_DISPATCHER_HMAC_SECRET must match exactly
echo "<account-id>"   | npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
echo "symphony-sandbox-backups" | npx wrangler secret put BACKUP_BUCKET_NAME
# R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY: create in dashboard at
#   R2 → Manage R2 API Tokens → Create API Token → Object Read & Write
# (only shown once)
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY

# 3. Custom domain + wildcard DNS (REQUIRED — sandbox preview URLs do not
#    work on .workers.dev). Pick a subdomain you own on a Cloudflare zone.
#    Add two AAAA records pointing at the placeholder 100:: with proxy
#    enabled (orange cloud):
#      <subdomain>.<zone>           AAAA  100::  proxied
#      *.<subdomain>.<zone>         AAAA  100::  proxied
#    Then add `routes` to wrangler.jsonc (already wired for sandbox.marko.la):
#      { "pattern": "<subdomain>.<zone>/*",   "zone_name": "<zone>" },
#      { "pattern": "*.<subdomain>.<zone>/*", "zone_name": "<zone>" }

# 4. Advanced Certificate Manager (REQUIRED for the wildcard cert —
#    Universal SSL only covers <zone> + *.<zone>, not *.<subdomain>.<zone>).
#    Subscribe to ACM in dashboard ($10/mo) under SSL/TLS → Edge
#    Certificates → Advanced Certificate Manager. Then order an advanced
#    certificate covering both <subdomain>.<zone> and *.<subdomain>.<zone>.
#    Issuance via Google Trust Services takes ~5 min.

# 5. Deploy + smoke test
npx wrangler deploy
curl https://<subdomain>.<zone>/health   # → {"ok":true,"sandbox_class":"standard-2"}
```

**Note on container image**: `wrangler.jsonc` references
`docker.io/cloudflare/sandbox:0.10.0` directly — Cloudflare pulls from
Docker Hub during deploy. There's no local Dockerfile build/push step.
See "Direct Docker Hub image" gotcha. `wrangler containers list` shows
the registered application; image isn't a separate artifact.

## Open notes (decide before Phase 4)

These are the items I'd flag for review *now* — they're small but they
shape Phase 4 contracts:

### 1. Bootstrap PTY auth

Today `ttyd` is launched as `ttyd -p 7681 -W bash -l` — anyone who
knows the Sandbox preview-URL token can attach. The token is long and
random, but there's no in-app password. For internal/single-operator
use this is fine.

If you want a belt-and-suspenders password, change the bootstrap
handler in `workers/sandbox-dispatcher/src/auth.ts` to:

1. Generate a random `pty_password`.
2. Launch `ttyd -p 7681 -W -c symphony:<pty_password> bash -l`.
3. Return `pty_password` in the bootstrap response so the operator can
   paste it into the browser's basic-auth prompt.

### 2. R2 lifecycle rule for backup GC

`sandbox.createBackup({...ttl: SNAPSHOT_TTL_SECONDS})` records a TTL in
the backup metadata but **does not delete the R2 object on expiry** —
that's documented behaviour in the v0.10 SDK (see "NOTE: Expired
backups are not automatically deleted from R2" in
`@cloudflare/sandbox/dist/sandbox-*.d.ts:3432`).

Configure an R2 lifecycle rule on `BACKUP_BUCKET` that deletes objects
under the `backups/` prefix after ~14 days. Phase 6's cron refresh
keeps the *active* snapshot's `refreshed_at` rolling forward, so a
14-day rule (with a 7-day TTL) gives a comfortable safety margin.

You can do it in the dashboard under R2 → Bucket → Lifecycle, or with
`wrangler r2 bucket lifecycle add`. Documented in the README's deploy
section is the recommended placement.

### 3. Scope granularity

`scope` is opaque on the wire. Today the Mix tasks suggest a per-user
default (`--scope alice`). Per-project (`--scope alice:proj-42`) works
without any code changes — pass the desired string. Regex on the
dispatcher side is `^[a-zA-Z0-9._:@-]+$` (so colons are allowed).

If you decide to enforce a particular shape later, do it at the Mix-task
layer — keeping the dispatcher format-agnostic lets us iterate without
breaking the wire contract.

## Gotchas discovered during Phase 1-3

These tripped me up — flagging so they don't trip you.

### `@cloudflare/sandbox` SDK pin

The plan referenced `sandbox.createBackup({...})`/`restoreBackup(handle)`/
`DirectoryBackup`. **These only exist in `@cloudflare/sandbox` v0.10+.**
The original Phase 2 scaffold used `^0.4.0` which silently resolved to
0.4.18 and lacked the API entirely. I bumped to `^0.10.0` in Phase 3.

Watch for this if a Phase 4+ feature looks like it should exist and
doesn't — the SDK is on a fast cadence and the public docs sometimes
lag the published types.

### `BackupOptions` field shape

The plan said `useGitignore: false`. The actual field is `gitignore`
(default `false` anyway, so we omit it). Other actual fields:

```ts
{
  dir: string;        // must be under /workspace, /home, /tmp,
                      // /var/tmp, or /app — anything else throws
  name?: string;
  ttl?: number;       // seconds, default 259200 (3 days)
  gitignore?: boolean;
  excludes?: string[];
  localBucket?: boolean;   // see below
  compression?: BackupCompressionOptions;
  multipart?: boolean;     // default true
}
```

### `localBucket: true` in wrangler dev

Wrangler dev has no presigned URL infrastructure, so the SDK's default
backup path (container streams to R2 via presigned PUT URL) doesn't
work. We set `USE_LOCAL_BACKUP_BUCKET=true` in `env.dev.vars` and pass
`localBucket: true` to `createBackup` in dev mode. In production
(`wrangler deploy`) leave it unset — the default presigned-URL flow is
significantly faster.

The `useLocalBackupBucket(env)` helper in `src/auth.ts` reads this var.

### `proxyToSandbox` must be at top of `fetch`

Sandbox preview URLs (returned by `sandbox.exposePort()`) route back
through the worker that owns the DO namespace. If the worker doesn't
call `proxyToSandbox(request, env)` first, those subdomain requests
404. The current `src/index.ts` has it wired correctly:

```ts
async fetch(request, env, ctx) {
  const proxyResponse = await proxyToSandbox(request, env);
  if (proxyResponse) return proxyResponse;
  return app.fetch(request, env, ctx);
}
```

Don't add HMAC verification *before* `proxyToSandbox` — the proxy
needs to handle browser requests that won't carry our signature
header.

### `exposePort` signature changed in 0.10

The Sandbox class's `exposePort` (the one we call from the auth route)
takes `(port, { hostname, name?, token? })` and returns `{ url, port,
name }`. There's a *different* signature on `SandboxClient` and
`PortClient` that takes `(port, sessionId, name?)` — don't confuse them.
Type-check will catch this.

We pass `hostname: new URL(c.req.url).host`. That works for both
wrangler dev (`localhost:8787`) and deployed
(`sandbox-dispatcher.<account>.workers.dev`) because the dispatcher
itself is the proxy target.

### HMAC signing — exact contract

Both sides must agree:

| Property         | Value |
| ---------------- | ----- |
| Algorithm        | HMAC-SHA256 |
| Key              | `DISPATCH_HMAC_SECRET` |
| Body             | Raw request body bytes (empty string for GET) |
| Encoding         | Lowercase hex |
| Header           | `X-Symphony-Signature` |
| Comparison       | Constant-time, **case-sensitive** (uppercase hex is rejected) |

Test vector pinned in `test/symphony_elixir/cloudflare/dispatcher_client_test.exs`:

```
secret = "test-secret-do-not-use-in-prod"
body   = '{"scope":"alice"}'
sig    = "1628b1de2425d3d72af853cd72a18a7cdadda178157642d42411d70760b15b46"
```

### Hono catches errors → 500

`buildAuthRouter()` uses Hono. Any thrown error inside a route handler
is caught by Hono's default error handler and turned into a 500
response — it does **not** propagate up to the `fetch` export. This
broke one test I wrote (was expecting `.rejects.toThrow(...)`); the
correct pattern is to assert on `res.status === 500` and verify the
side-effect (e.g. sandbox was destroyed by the `safeDestroy` cleanup).

### Hex.pm TLS in headless envs

If you're working in an env where `mix deps.get` fails with `unknown_ca`
TLS errors, set `HEX_CACERTS_PATH=/etc/ssl/certs/ca-certificates.crt`
(or your distro's equivalent). Erlang's bundled CA store is empty by
default.

### `mix test` in this sandbox

A subset of tests use `SymphonyElixir.DataCase` and assume the OTP app
is started before tests run. In some sandbox environments the app
exits during `mix test` startup and DataCase tests fail with "could
not lookup Ecto repo SymphonyElixir.Repo because it was not started".
Tests using `SymphonyElixir.TestSupport` work because they call
`Application.ensure_all_started(:symphony_elixir)` themselves.

If you see ~195 baseline failures, this is probably it — not a
regression. Validate by running a `TestSupport`-using subset
(`core_test`, `orchestrator_status_test`, `worker/`) and CI.

### Wrangler dry-run requires Docker (legacy — not relevant since the Direct Docker Hub image switch)

This used to be a problem when the dispatcher built a custom image
locally. We now reference `docker.io/cloudflare/sandbox:0.10.0` directly
in `wrangler.jsonc` (see gotcha below) so deploys are pure config edits
— no Docker daemon, no build, no registry push. **A deploy is now
~3 seconds instead of ~10 minutes.**

CI doesn't currently have a Worker job. If you want one, copy the
existing `dashboard` job in `.github/workflows/pr-check.yml` and run
`npm test` + `npm run typecheck` — no `npm run build` needed.

## Gotchas discovered during Phase 3 deploy + end-to-end test (2026-05-09 → 2026-05-10)

These are *additional* surprises that came out of actually deploying
the Phase 3 scaffold to a real Cloudflare account, end-to-end-testing
the bootstrap → snapshot → restore loop, and watching `wrangler tail`
during failures. Many cost real time; the mitigation column tells you
how to avoid them.

### Custom domain + ACM cert is required (you cannot use `.workers.dev`)

`sandbox.exposePort()` returns URLs like
`https://<port>-<sandbox-id>-<token>.<hostname>` — that's a
**second-level wildcard**. Cloudflare's free Universal SSL covers a
zone and its first-level wildcard (`marko.la` + `*.marko.la`) but **not
deeper** (`*.sandbox.marko.la`). And `.workers.dev` doesn't support
wildcard subdomains at all — the SDK explicitly throws
`CustomDomainRequiredError` if `hostname.endsWith(".workers.dev")`.

There is no free path. You need:

1. A domain on a Cloudflare zone.
2. Two proxied AAAA DNS records (`<subdomain>` + `*.<subdomain>`,
   both pointing at `100::`).
3. **Advanced Certificate Manager subscription** (`$10/mo` per zone)
   covering `<subdomain>.<zone>` + `*.<subdomain>.<zone>`. Order via
   dashboard or `POST /zones/{zone}/ssl/certificate_packs/order` with
   `{"type":"advanced","hosts":[...],"validation_method":"txt",
   "certificate_authority":"google"}`. Issuance ~5 min.
4. Worker `routes` in `wrangler.jsonc`:
   ```jsonc
   "routes": [
     { "pattern": "<subdomain>.<zone>/*",   "zone_name": "<zone>" },
     { "pattern": "*.<subdomain>.<zone>/*", "zone_name": "<zone>" }
   ]
   ```

Do **not** add `*.<zone>/*` (top-level wildcard) — it captures every
proxied subdomain on the zone (including unrelated apps you host).
Stay under the dedicated subdomain.

### `SNAPSHOT_DIR` must be under `/workspace`, `/home`, `/tmp`, `/var/tmp`, or `/app`

The SDK's `validateBackupDir` rejects anything else with
`InvalidBackupConfigError: BackupOptions.dir must be inside one of the
supported backup roots`. Notably **`/root` is not allowed** — even
though that's the default `HOME` for root inside `cloudflare/sandbox`'s
Ubuntu base.

We use `SNAPSHOT_DIR = "/home/symphony"` and route the bootstrap PTY's
`HOME` there via:

```ts
await sandbox.startProcess(
  `env HOME=${SANDBOX_HOME} ${TTYD_PATH} -p 7681 -W bash -l`,
  ...
);
```

…plus a `.bashrc`/`.bash_profile` written into `/home/symphony` that
sets `HOME`, `PATH`, and `NPM_CONFIG_PREFIX` so npm globals also land
in the snapshot.

### `process.waitForPort()` is required after `startProcess()` for exposePort to work

If you call `sandbox.exposePort(port, ...)` immediately after
`sandbox.startProcess(...)`, the bootstrap call returns a `pty_url`
that returns 503 the moment a browser hits it: the SDK probes
`10.0.0.1:7681` from the worker side, can't see the port (because
`startProcess` returns before the bound socket is registered against
the SDK's external probe path), times out at 90s, and 503s.

The SDK docs say this clearly:

```ts
const proc = await sandbox.startProcess('npm run dev');
await proc.waitForPort(3000);   // ← required
```

Our `auth.ts` now does:

```ts
const ttydProc = await sandbox.startProcess(`... ttyd ... bash -l`);
await ttydProc.waitForPort(7681, {
  mode: "http", path: "/", status: { min: 200, max: 399 }, timeout: 30_000,
});
const exposed = await sandbox.exposePort(7681, { hostname });
```

Without the `waitForPort`, the failure surfaces 30+ seconds later as a
proxy 503 instead of immediately as a bootstrap error.

### Sandbox IDs go into DNS hostnames — colons silently break the URL

`sandboxId = "bootstrap:marko"` *passes* the SDK's `sanitizeSandboxId`
checks (length, hyphens, reserved names). But when the SDK builds the
preview URL via `baseUrl.hostname = "${port}-${sandboxId}-${token}.${hostname}"`,
the JS `URL.hostname` setter silently rejects strings containing `:`
(or `@`, `.` mid-label, etc) — leaving the hostname at its prior value.
Result: `exposePort` returns `https://sandbox.marko.la/` instead of
`https://7681-bootstrap-marko-…sandbox.marko.la/`. Browsers then 401 or
404.

Fix in our `bootstrapSandboxId()`:

```ts
return `bootstrap-${scope.replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase()}`;
```

Anywhere you derive a sandbox ID, sanitize down to `[a-zA-Z0-9-]+`.

### Bash login shells read `.bash_profile`, not `.bashrc`

ttyd is launched as `bash -l` (login shell). Login shells skip
`.bashrc` and read `.bash_profile`/`.bash_login`/`.profile` in that
order. The first time this bit us we wrote env exports to `.bashrc` and
the operator's PTY had no `PATH=/home/symphony/.local/bin:...`, so
`gh`, `claude`, `codex` all looked uninstalled even though they were
on disk.

`auth.ts` now writes both:

```bash
.bashrc          # exports + cd /home/symphony
.bash_profile    # [ -f ~/.bashrc ] && . ~/.bashrc
```

…idempotently so user customizations to `.bashrc` (extra `export FOO=…`
lines etc) are not clobbered by the next bootstrap. This mirrors how
upstream Linux distros usually wire the two files.

### Direct Docker Hub image — no Dockerfile, no build, no push

`wrangler.jsonc`'s `containers[].image` accepts a fully-qualified
registry image, not just a Dockerfile path. Cloudflare pulls
`docker.io/cloudflare/sandbox:0.10.0` directly during deploy. **No
local Docker daemon needed; no registry push; deploy is ~3 seconds
instead of ~10 minutes.**

This works because the entire toolchain (gh, claude-code, codex, ttyd,
mise, etc.) lives **inside the snapshot at `/home/symphony`** rather
than baked into the image. ttyd is the only chicken-and-egg piece,
and we install it idempotently from `BOOTSTRAP_PREP_CMD` on the very
first bootstrap (`mkdir -p ~/.local/bin && curl ... -o ~/.local/scripts/ttyd`).
After the first snapshot, every bootstrap restores ttyd for free.

If you ever do need a custom image (e.g. for Phase 4 to bake a fixed
git/jq version), the slim pattern is:

```dockerfile
FROM docker.io/cloudflare/sandbox:0.10.0
RUN curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.x86_64" \
        -o /usr/local/scripts/ttyd && chmod +x /usr/local/scripts/ttyd
```

But don't add one prematurely. We deleted the original Dockerfile
because it was unused and confusing.

### `wrangler secret put` may target wrong env without `--env=""`

When `wrangler.jsonc` defines an `env.dev` block, `wrangler secret put
NAME` (no `--env`) prints a warning and falls back to top-level. The
warning is easy to miss in noisy output and the silent fallback is the
*right* behaviour — but at one point in our session the production
worker's `DISPATCH_HMAC_SECRET` no longer matched the value we'd set
(every signed request 401'd). Verify with `wrangler secret list` and
re-set with explicit `--env=""` if you ever see surprise 401s.

### `safeDestroy(sandbox)` on `createBackup` failure deletes the operator's auth state

Our original `/auth/snapshot` flow had a `try { createBackup() } catch
{ safeDestroy() }` shape. When the backup raised
`InvalidBackupConfigError` (because we'd configured `SNAPSHOT_DIR =
"/root"` — illegal), the catch ran, destroyed the sandbox, and **wiped
the operator's `claude login` / `codex auth login` / `gh auth login`
state** — forcing them to redo every device-flow auth.

Mitigations going forward:

- Validate `dir` upfront against the allow-list before calling
  `createBackup`; return 400 immediately rather than discovering it
  inside the SDK.
- Keep `safeDestroy` only in code paths where teardown is unambiguously
  the right action (success, explicit user request).

### `/auth/exec` debug endpoint

We added `POST /auth/exec` (HMAC-signed, body `{ scope, cmd }`) that
runs an arbitrary command inside the bootstrap sandbox and returns
`{exit_code, stdout, stderr}`. Saved us an enormous amount of debug
time once we hit the "ttyd not listening on 7681" failure — we could
poke `/proc/net/tcp`, `ldd`, `ttyd --version`, `ls /home/symphony` etc
without needing a working PTY.

Treat it as an operator/debug endpoint. Phase 4 should consider whether
it belongs in production at all (probably yes for ops, but maybe gate
it behind an additional auth check).

### `wrangler secret put` may be reset by deploys that change `triggers`

Empirically observed twice: deploying a change to `wrangler.jsonc`'s
`triggers` block (e.g. adding `triggers.crons`) is enough to make the
prod Worker stop matching the previously-set `DISPATCH_HMAC_SECRET`.
Diagnostic: every signed request 401s with `{"error":"invalid_signature"}`
even though `wrangler secret list` claims the secret is set.

Mitigation (automated): use `workers/scripts/deploy-workers.sh` instead of running
`npm run deploy` directly. It deploys the targeted Worker(s), waits
for edge propagation, and runs `workers/scripts/smoke-dispatch.sh` as a gate — a
post-deploy 401 storm fails the script loudly instead of being
discovered by the next user-triggered Linear session.

When drift is detected (the smoke check returns
`connect_error: dispatcher_401: invalid_signature`), recover with:

```bash
workers/scripts/rotate-dispatch-secret.sh                     # generate fresh value, push to both workers
workers/scripts/rotate-dispatch-secret.sh "<known value>"     # or set a specific value (e.g. matching Symphony Elixir)
```

The script bakes in `--env=""` and pushes to both workers in one shot
so the "set on one but not the other" failure mode is impossible. It
runs `workers/scripts/smoke-dispatch.sh` afterwards as a verification gate.

The smoke script needs `LINEAR_AGENT_ADMIN_TOKEN` set (matches the
`ADMIN_TOKEN` secret on the linear-agent Worker). Either export it or
write it to `.secrets/admin-token` (gitignored).

This may be a wrangler 4.x quirk where named-env semantics confuse
secret targeting. Either way, the recovery is cheap once you know to
look for it — and the deploy-workers.sh gate makes it self-healing.

## Phase 6 — cron snapshot refresh (shipped)

The R2 lifecycle rule (14 days, prefix `backups/`) and the SDK's
`createBackup` TTL (7 days) together leave a window of ~7 days for
something to refresh active snapshots before they age out. Phase 6 is
that something.

**How it works.**

- A `triggers.crons` entry in `wrangler.jsonc` fires the dispatcher's
  `scheduled()` handler at `0 4 * * *` (4 AM UTC daily).
- `scheduled()` calls `refreshStaleSnapshots(env, now)` which:
  1. `SELECT *` from `auth_backups`.
  2. For each row whose `refreshed_at < now - DEFAULT_REFRESH_AGE_SECONDS`
     (5 days), spin up a `refresh-<sanitized-scope>` sandbox.
  3. `restoreBackup(handle)` to load the existing state.
  4. `createBackup({ dir: "/home/symphony", ttl: 7 days })` to write a
     fresh R2 object with today's timestamp.
  5. Update the D1 row's handle + `refreshed_at` (atomic via the
     `INSERT ... ON CONFLICT DO UPDATE` shape in `AuthBackupStore.upsert`).
  6. `safeDestroy` the sandbox.
- The 14-day R2 lifecycle rule then GCs the orphaned old object on its
  normal cadence. The active scope stays "young" indefinitely.

**Manual trigger / recovery / testing.**

`POST /auth/refresh` is the same logic exposed over HTTP, HMAC-signed
through the standard middleware:

```bash
# Dry run — refresh anything older than the default 5 days.
curl -sS -X POST https://sandbox.marko.la/auth/refresh \
  -H "X-Symphony-Signature: $(sign '{}')" \
  --data '{}'

# Force-refresh a single scope, regardless of age (useful for testing).
curl -sS -X POST https://sandbox.marko.la/auth/refresh \
  -H "X-Symphony-Signature: $(sign '{"scope":"alice","force":true}')" \
  --data '{"scope":"alice","force":true}'
```

Body fields (all optional): `{ age_seconds?: number, force?: boolean,
scope?: string }`. Returns aggregate counts (`checked`, `refreshed`,
`skipped`, `failed`) plus per-scope outcomes with old/new backup ids
and per-row `error_message` on failure.

**Failure isolation.** Per-row exceptions are caught and surfaced in
the result objects rather than bubbled out — one busted scope can't
poison the whole cron run. Failures end up in the `scheduled()`
handler's `console.log` so they're visible via `wrangler tail`.

**What this does NOT do.** It does not re-validate that the
restored auth tokens are still good (Anthropic / OpenAI / GitHub may
have rotated/revoked them). The bytes get rotated; the tokens inside
them might still be expired. That's fine for the retention case
(R2 keeps holding bytes), but `/run` will still fail if the tokens
themselves have lapsed. A future Phase could add a per-CLI liveness
probe (e.g. `gh auth status`) inside the refresh sandbox before
re-snapshotting.

**Tests.** `test/refresh.test.ts` covers the threshold logic, force
flag, single-scope filter, per-row failure isolation, and HMAC
enforcement on the HTTP endpoint. The HTTP-handler tests use
`vi.useFakeTimers()` because the handler reads `Date.now()`
internally — without that, seed timestamps drift relative to wall
clock as the suite ages.

## Setting persistent env vars for CLIs (e.g. `CLOUDFLARE_ACCOUNT_ID` for pi)

For env vars that should persist across bootstraps + Phase 4 sandbox
restores, append to `/home/symphony/.bashrc` (which is sourced by
`/home/symphony/.bash_profile` for ttyd's login shell) and re-snapshot:

```bash
# inside the bootstrap PTY:
echo 'export CLOUDFLARE_ACCOUNT_ID=…' >> ~/.bashrc
# or via /auth/exec from outside the PTY.
```

Then `mix symphony.auth.snapshot --scope <scope>` to capture. Future
restores from this snapshot will have the export ready.

## Backend abstraction recap (Phase 1)

The Elixir side of Symphony now goes through:

```
Orchestrator.spawn_issue_on_worker_host
  └── build_dispatch_lease(issue, worker_host)
        └── Worker.Backend.current().acquire(issue, host: worker_host)
              ↳ Worker.Backend.Local      → lease.host = "local"
              ↳ Worker.Backend.SSHStatic  → lease.host = "<host>[:port]"
              ↳ Worker.Backend.CloudflareSandbox  (Phase 5, not yet)
  └── Task.Supervisor.start_child → AgentRunner.run(issue, …, lease: lease)

AgentRunner.candidate_leases(issue, opts)
  ↳ when given a single SSHStatic lease, expands it back into
    [preferred, ...rest_of_ssh_hosts] for intra-attempt failover
  ↳ when given a Local (or future cloud) lease, returns [lease]
```

Today `lease.host` is converted back to the legacy `worker_host`
(`nil` for local, binary for SSH) when calling into Workspace and the
engines via `lease_worker_host(lease)`. **Workspace and the
Codex/Claude AppServers were intentionally *not* refactored** to call
`Backend.exec`. The plan mentions doing so; we deferred to Phase 5
when CloudflareSandbox actually needs it. Keeping Workspace
worker_host-based for Phase 1 cut the diff by ~10 files and 0
behavioural changes for SSH/local users.

If a Phase 4 reviewer asks why Workspace still branches on
`worker_host` — that's the answer. Phase 5 should land the
Workspace/Engine refactor alongside `Worker.Backend.CloudflareSandbox`.

## Phase 4 setup checklist

When you start Phase 4 (`/run` route):

1. **Re-read the original plan's Phase 4 section** for the contract
   shape. Body fields: `scope`, `issue_id`, `repo_url`, `prompt`,
   `engine`, `timeout_ms?`, `max_turns?`. Returns: `{exit_code, stdout,
   stderr, duration_ms}`.

2. **Look up backup handle for `scope`.** Use
   `AuthBackupStore.get(scope)` from `src/storage.ts`. Return
   **412 Precondition Failed** if absent (the plan was specific about
   this status code — not 404).

3. **Sandbox lifecycle:**
   ```ts
   const sandbox = getSandbox(env.Sandbox, "issue:" + issueId);
   try {
     await sandbox.restoreBackup(record.handle);
     await sandbox.exec("mkdir -p /workspace/" + issueId);
     await sandbox.exec("cd /workspace/" + issueId + " && git clone " + repoUrl + " .");
     // launch engine — start with `codex exec` (one-shot), not app-server
     // (the plan explicitly defers app-server mode to Phase 5+)
     return await sandbox.exec(engineCmd, { timeout: timeoutMs });
   } finally {
     await safeDestroy(sandbox);   // already in src/auth.ts — extract to a helper
   }
   ```
   `safeDestroy` lives in `src/auth.ts` today; promote it to
   `src/sandbox-helpers.ts` if you find yourself repeating.

4. **Add `POST /run/stop`** that does
   `getSandbox(env.Sandbox, "issue:" + issueId).destroy()` directly.

5. **Add `GET /run/:issue_id/status`.** The SDK doesn't expose live
   sandbox state. Easiest path: stash the most recent run state on the
   DO via `sandbox.exec("...")` results, then read on status. Or just
   stub it (return `{ alive: true|false }` based on whether
   `sandbox.exec("true")` succeeds) — the plan acknowledges this is
   best-effort.

6. **Vitest**: extend `test/auth.test.ts`'s `FakeSandbox` (or split it
   to `test/fakes.ts`) so `/run` tests can reuse the same
   restore/exec/destroy mocks. Cover happy path, missing-backup → 412,
   and `destroy` on both success and failure.

7. **Manual smoke test** per the plan's acceptance criterion: tiny
   public repo + trivial prompt ("add today's date to README"). Verify
   sandbox restore < ~10s, codex reads `~/.codex/auth.json`, sandbox
   destroyed within a minute (`wrangler containers list`).

## Phase 5 setup checklist

(For when you get there.)

- `lib/symphony_elixir/worker/backend/cloudflare_sandbox.ex` already
  has a stub reference in `lib/symphony_elixir/worker/backend.ex`
  (`resolve_backend(:cloudflare_sandbox)` returns the module name even
  though the module doesn't exist — Elixir resolves at call time, not
  compile time). Update `Config.Schema.Worker`'s `@backends` list to
  add `:cloudflare_sandbox` as a valid value.

- `Worker.Backend.CloudflareSandbox.HMAC` is unnecessary —
  `SymphonyElixir.Cloudflare.DispatcherClient` already does HMAC
  signing and exposes a clean `post/get/delete` surface. Reuse it.

- `lease.host` for the CF backend should look like `sandbox:<issue_id>`
  so the dashboard, Store column, and presenter rendering all "just
  work" without further refactor.

- Workspace.create_for_issue_with_status will need a real refactor for
  this backend — the workspace is *inside* the sandbox, not on the
  current OTP node's filesystem. This is the Workspace/Engine refactor
  that Phase 1 deferred.

- The `Worker.Backend` callbacks are designed for this:
  `acquire(issue, opts)` → POST `/run` (or split into `/run/prepare`
  + `exec`); `release(lease, opts)` → POST `/run/stop`. Reuse them.

## Pi inside the snapshot

Phase 4 added `engine: "pi"` to `/run`. The dispatcher just exec's
`pi --print --mode json --model <model> '<prompt>'` inside the per-issue
sandbox after restoring the operator's snapshot — so pi (the binary +
its auth) must be present in `/home/symphony` before the snapshot is
taken.

Pi follows the same convention as `gh`/`claude`/`codex`: install
*inside* the bootstrap PTY, snapshot, restore on each `/run`. There is
no Dockerfile to bake into anymore (we use the upstream cloudflare/sandbox
image directly), and even if there were, npm globals there would land
outside `/home/symphony` and not be captured.

In the bootstrap PTY (the `auth.ts` `BOOTSTRAP_PREP_CMD` already wires
`HOME=/home/symphony`, `NPM_CONFIG_PREFIX=/home/symphony/.npm-global`,
and `PATH=/home/symphony/.local/bin:/home/symphony/.npm-global/bin:...`
in `.bashrc` + `.bash_profile`):

```bash
# Sanity check: PATH/HOME should be wired up via .bash_profile → .bashrc.
echo $HOME           # /home/symphony
which npm            # /usr/local/scripts/npm (system) is fine — npm-prefix routes -g installs
npm config get prefix  # /home/symphony/.npm-global

# Install pi.
npm install -g @mariozechner/pi-coding-agent
pi --version

# Authenticate provider(s). `/login` opens a browser-style flow inside
# the PTY; pi stores credentials under /home/symphony/.pi/ (in the snapshot).
pi /login                # interactive Anthropic login (Claude Pro/Max)
# or set provider keys for non-subscription routes:
#   export ANTHROPIC_API_KEY=...        ; pi /login api-key
#   pi config provider cloudflare-workers-ai
#   export CLOUDFLARE_ACCOUNT_ID=...    # required for cf-workers-ai; persist via .bashrc
```

After exiting the PTY, run `mix symphony.auth.snapshot --scope <scope>`
(or the equivalent dispatcher request) to capture the new state.

`DEFAULT_MODEL` in `workers/linear-agent/wrangler.jsonc` selects which
model pi targets at run time. Format is pi's `provider/id` shape:

```
anthropic/claude-sonnet-4-6                          # via /login or ANTHROPIC_API_KEY
cloudflare-workers-ai/@cf/qwen/qwq-32b-preview       # via Workers AI
openai/gpt-5                                         # via OPENAI_API_KEY
```

If pi reports a missing model/provider, re-bootstrap and configure it
before re-running.

## linear-agent worker

`workers/linear-agent/` is the Cloudflare-side replacement for the
Elixir `Orchestrator` + `Tracker` + `Linear.*` modules. It owns:

- Linear OAuth (`actor=app`) at `/oauth/{authorize,callback,revoke}`.
- Linear webhook receiver at `/webhook` for `AgentSessionEvent`s.
- HMAC-signed calls to `sandbox-dispatcher` `/run` (same wire format as
  `SymphonyElixir.Cloudflare.DispatcherClient` — pinned vector tested
  in three places now).
- Posting `thought` / `response` / `error` activities back to the
  session via `linearClient.createAgentActivity`.

For the walking-skeleton phase the worker is single-org, with project
mappings in a JSON env var (`PROJECT_MAPPINGS_JSON`). D1 multi-tenant
config is Phase 8.

The webhook handler honors Linear's 5s ack and 10s first-activity SLAs
by responding 200 immediately and running `runSession` inside
`executionCtx.waitUntil`. Phase 7 swaps that body for a Cloudflare
Workflow so the dispatcher call survives Worker restarts. The webhook
contract itself doesn't change.

## Tooling quick-reference

```bash
# Elixir toolchain
mise install                                          # Elixir 1.19 + OTP 28
export ELIXIR_ERL_OPTIONS="+fnu"                      # silence latin1 warning
export HEX_CACERTS_PATH=/etc/ssl/certs/ca-certificates.crt
mix deps.get && MIX_ENV=test mix ecto.create && mix ecto.migrate

# Elixir validation
mix compile --warnings-as-errors
mix format --check-formatted
mix lint
mix test test/symphony_elixir/worker/ test/symphony_elixir/cloudflare/

# Worker validation — sandbox-dispatcher
cd workers/sandbox-dispatcher
npm install
npm test                  # vitest run (auth + run + hmac suites)
npm run typecheck         # tsc --noEmit
npm run build             # wrangler bundle (skip if no Docker)
npm run dev               # wrangler dev → http://localhost:8787

# Worker validation — linear-agent
cd ../linear-agent
npm install
npm test                  # vitest run (dispatcher + webhook suites)
npm run typecheck
npm run dev               # wrangler dev → http://localhost:8788
```
