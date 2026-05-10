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
| 3. `/auth/bootstrap` + `/auth/snapshot` routes + Mix tasks   | ✅ shipped | `592d963` |
| 4. `/run` route (engine: `pi`)                               | ✅ scaffolded — pending smoke test | this branch |
| 4b. `workers/linear-agent` (Linear OAuth + webhook + Activity SDK) | ✅ scaffolded | this branch |
| 5. `Worker.Backend.CloudflareSandbox` Elixir impl            | pending — may be skipped if we go fully Worker-driven | — |
| 6. Cron snapshot refresh                                     | pending    | — |
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
| Dockerfile (sandbox image)          | `workers/sandbox-dispatcher/Dockerfile` |
| Wrangler config                     | `workers/sandbox-dispatcher/wrangler.jsonc` |
| Spec doc (workflow config schema)   | `docs/SPEC.md` (`worker.backend` field documented) |

## Pre-flight before any deploy works

The Phase 2/3 scaffold ships with placeholder D1 ids that wrangler will
reject. Once per environment:

```bash
# Production
wrangler r2 bucket create symphony-sandbox-backups
wrangler d1 create symphony-dispatcher
# → paste the printed database_id into wrangler.jsonc
#   (top-level `d1_databases[0].database_id`)
wrangler d1 migrations apply symphony-dispatcher

wrangler secret put DISPATCH_HMAC_SECRET
wrangler secret put R2_ACCESS_KEY_ID
wrangler secret put R2_SECRET_ACCESS_KEY
wrangler secret put CLOUDFLARE_ACCOUNT_ID
wrangler secret put BACKUP_BUCKET_NAME

wrangler deploy
curl https://sandbox-dispatcher.<account>.workers.dev/health   # should return ok

# Dev (mirror, with --env dev appended)
wrangler r2 bucket create symphony-sandbox-backups-dev
wrangler d1 create symphony-dispatcher-dev
# → paste into env.dev.d1_databases[0].database_id
wrangler d1 migrations apply symphony-dispatcher-dev --env dev
# (set the same five secrets with --env dev)
```

After deploying, confirm the container image built:

```bash
wrangler containers list
```

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

### Wrangler dry-run requires Docker

`wrangler deploy --dry-run` builds the container image as part of
validation. Without a running Docker daemon it fails with
"The Docker CLI could not be launched". The TypeScript bundling step
runs first and prints `Total Upload: ... KiB` — if you see that line,
the JS-side validation passed and only the container build is missing.

CI doesn't currently have a Worker job. If you want one, copy the
existing `dashboard` job in `.github/workflows/pr-check.yml` and run
`npm test` + `npm run typecheck` (skip the build step until CI has
Docker available).

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
its auth) must be present in `/root` before the snapshot is taken.

Pi follows the same convention as `gh`/`claude`/`codex`: install
*inside* the bootstrap PTY, snapshot, restore on each `/run`. Do **not**
add pi to the Dockerfile — global npm installs land outside `/root` and
won't be captured.

In the bootstrap PTY:

```bash
# Persist npm globals under /root so they make it into the snapshot.
mkdir -p /root/.npm-global
npm config set prefix /root/.npm-global
echo 'export PATH=/root/.npm-global/bin:$PATH' >> /root/.bashrc
export PATH=/root/.npm-global/bin:$PATH

# Install pi.
npm install -g @mariozechner/pi-coding-agent
pi --version

# Authenticate provider(s). `/login` opens a browser-style flow inside
# the PTY; pi stores credentials under /root/.pi/ (in the snapshot).
pi /login                # interactive Anthropic login (Claude Pro/Max)
# or set provider keys for non-subscription routes:
#   export ANTHROPIC_API_KEY=...        ; pi /login api-key
#   export CLOUDFLARE_AI_GATEWAY=...    ; pi config provider cloudflare-workers-ai
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
